// คิวส่งเอกสารเข้า ERP + reconciler (spec erp-sync, design D1)
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type Redis from "ioredis";
import {
  ERP_SYNC_QUEUE,
  OdooErpAdapter,
  SyncError,
  WebhookErpAdapter,
  createOdooClient,
  syncPermanent,
  syncTransient,
  STATUS_CHANNEL,
  asDocumentData,
  buildErpPayload,
  erpSyncJobOptions,
  type ErpAdapter,
  type ErpAttachment,
  type ErpSyncJob,
  type StatusEvent,
} from "@sdes/core";
import {
  StaleDocumentError,
  loadErpConnection,
  loadErpConnectionWithSecret,
  loadSecretKey,
  transitionDocument,
  type ErpConnection,
  type PrismaClient,
} from "@sdes/db";

const SYSTEM = { kind: "system" } as const;
/** สถานะที่พร้อมส่ง — VERIFIED ทุกฉบับไม่มีความเสี่ยง (เคสเสี่ยงไป PENDING_APPROVAL ตั้งแต่ยืนยัน) */
export const READY_TO_SYNC = ["VERIFIED", "APPROVED"] as const;

export type SyncDeps = {
  prisma: PrismaClient;
  redis: Redis;
  /** สร้าง adapter จากการตั้งค่า (test ใส่ adapter จำลองได้) */
  adapterFor: (conn: ErpConnection & { secret: string | null }) => ErpAdapter;
  /** โหลดไฟล์ต้นฉบับเพื่อแนบใน ERP */
  loadAttachment: (doc: { storageKey: string; fileName: string; mimeType: string }) => Promise<ErpAttachment>;
  queuePrefix: string;
  /** SYNCING ที่ไม่มีงานในคิวนานกว่านี้ถูกใส่คิวใหม่ */
  stuckSyncingMs?: number;
};

export function defaultAdapterFor(conn: ErpConnection & { secret: string | null }): ErpAdapter {
  if (!conn.secret) throw syncPermanent("ยังไม่ได้ตั้ง API key/secret ของการเชื่อมต่อ ERP");
  if (conn.adapter === "webhook") return new WebhookErpAdapter({ url: conn.url, secret: conn.secret });
  const c = conn.config;
  return new OdooErpAdapter(
    createOdooClient({ url: conn.url, database: conn.database, apiMode: c.apiMode ?? "json2", login: c.login, apiKey: conn.secret }),
    { journalId: c.journalId ?? null, purchaseTaxId: c.purchaseTaxId ?? null, expenseAccountId: c.expenseAccountId ?? null },
  );
}

export function s3AttachmentLoader(s3: S3Client, bucket: string): SyncDeps["loadAttachment"] {
  return async (doc) => {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: doc.storageKey }));
    return { name: doc.fileName, mimeType: doc.mimeType, data: await obj.Body!.transformToByteArray() };
  };
}

async function publish(redis: Redis, d: { id: string; docNo: string; status: string }) {
  const e: StatusEvent = { id: d.id, docNo: d.docNo, status: d.status, at: new Date().toISOString() };
  await redis.publish(STATUS_CHANNEL, JSON.stringify(e)).catch(() => {});
}

/** ส่งเอกสารหนึ่งฉบับ: (VERIFIED|APPROVED →) SYNCING → SYNCED; ล้มเหลวชั่วคราว throw ให้ retry, ถาวร UnrecoverableError */
export async function processSync(deps: SyncDeps, documentId: string, attempt: number) {
  const { prisma, redis } = deps;
  let doc = await prisma.document.findUnique({ where: { id: documentId }, include: { vendor: true } });
  if (!doc) return { skipped: "not_found" as const };

  if ((READY_TO_SYNC as readonly string[]).includes(doc.status)) {
    const conn = await loadErpConnection(prisma);
    // ปิดการส่งอัตโนมัติ = รอไว้ที่สถานะเดิม reconciler จะใส่ใหม่เมื่อเปิด (spec "When documents are sent")
    if (!conn?.autoSync) return { skipped: "auto_sync_off" as const };
    try {
      await prisma.$transaction((tx) => transitionDocument(tx, { documentId, to: "SYNCING", actor: SYSTEM }));
    } catch (e) {
      if (e instanceof StaleDocumentError) return { skipped: "raced" as const };
      throw e;
    }
    doc = { ...doc, status: "SYNCING" };
    await publish(redis, doc);
  } else if (doc.status !== "SYNCING") {
    return { skipped: doc.status };
  }

  const conn = await loadErpConnectionWithSecret(prisma, () => loadSecretKey());
  const adapterName = conn?.adapter ?? "none";
  const row = await prisma.erpSyncAttempt.create({ data: { documentId, adapter: adapterName, attempt, status: "PENDING" } });
  try {
    if (!conn) throw syncPermanent("ยังไม่ได้ตั้งค่าการเชื่อมต่อ ERP");
    const payload = buildErpPayload({ id: doc.id, docNo: doc.docNo, data: asDocumentData(doc.data) }, { erpPartnerId: doc.vendor?.erpPartnerId });
    const attachment = await deps.loadAttachment(doc).catch((e) => {
      throw syncTransient("อ่านไฟล์ต้นฉบับไม่ได้", e);
    });
    const r = await deps.adapterFor(conn).push(payload, attachment);
    const done = await prisma.$transaction(async (tx) => {
      await tx.erpSyncAttempt.update({
        where: { id: row.id },
        data: { status: "SUCCESS", transactionId: r.transactionId, reused: r.reused, respondedAt: new Date() },
      });
      if (r.partnerId && doc.vendorId && doc.vendor?.erpPartnerId !== r.partnerId)
        await tx.vendor.update({ where: { id: doc.vendorId }, data: { erpPartnerId: r.partnerId } });
      await tx.document.update({ where: { id: documentId }, data: { erpTransactionId: r.transactionId, syncedAt: new Date(), syncError: null } });
      return transitionDocument(tx, { documentId, to: "SYNCED", actor: SYSTEM });
    });
    await publish(redis, done);
    return { status: done.status, transactionId: r.transactionId };
  } catch (e) {
    const err = e instanceof SyncError ? e : syncTransient(e instanceof Error ? e.message : "ส่งเข้า ERP ไม่สำเร็จ", e);
    await prisma.erpSyncAttempt.update({ where: { id: row.id }, data: { status: "FAILED", error: err.message.slice(0, 1000), respondedAt: new Date() } });
    await prisma.document.update({ where: { id: documentId }, data: { syncError: err.message.slice(0, 1000) } });
    throw err.permanent ? new UnrecoverableError(err.message) : err;
  }
}

/** หลังลองครบหรือล้มเหลวถาวร: SYNCING → SYNC_FAILED (เข้าคิวที่ล้มเหลว) */
export async function markSyncFailed(deps: Pick<SyncDeps, "prisma" | "redis">, documentId: string, reason: string) {
  const doc = await deps.prisma.document.findUnique({ where: { id: documentId } });
  if (doc?.status !== "SYNCING") return;
  const failed = await deps.prisma.$transaction(async (tx) => {
    await tx.document.update({ where: { id: documentId }, data: { syncError: reason.slice(0, 1000) } });
    return transitionDocument(tx, { documentId, to: "SYNC_FAILED", actor: SYSTEM, reason: reason.slice(0, 500) });
  });
  await publish(deps.redis, failed);
}

export function startSyncWorker(deps: SyncDeps, connection: Redis) {
  const worker = new Worker<ErpSyncJob>(
    ERP_SYNC_QUEUE,
    (job: Job<ErpSyncJob>) => processSync(deps, job.data.documentId, job.attemptsMade + 1),
    { connection, prefix: deps.queuePrefix, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    const finished = err instanceof UnrecoverableError || err.name === "UnrecoverableError" || (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
    if (job && finished) void markSyncFailed(deps, job.data.documentId, err.message);
  });
  return worker;
}

/** ใส่งานที่ค้าง: พร้อมส่งแต่ไม่มีงาน (เปิดส่งอัตโนมัติภายหลัง, enqueue หาย) และ SYNCING ที่ค้างโดยไม่มีงาน */
export async function reconcileSync(deps: Pick<SyncDeps, "prisma" | "stuckSyncingMs">, queue: Queue<ErpSyncJob>) {
  const conn = await loadErpConnection(deps.prisma);
  if (!conn?.autoSync) return 0;
  const stuckBefore = new Date(Date.now() - (deps.stuckSyncingMs ?? 5 * 60_000));
  const docs = await deps.prisma.document.findMany({
    where: { OR: [{ status: { in: [...READY_TO_SYNC] } }, { status: "SYNCING", updatedAt: { lt: stuckBefore } }] },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: 200,
  });
  let enqueued = 0;
  for (const { id } of docs) {
    const existing = await queue.getJob(id);
    if (existing && !(await existing.isFailed()) && !(await existing.isCompleted())) continue;
    if (existing) await existing.remove();
    await queue.add("sync", { documentId: id }, erpSyncJobOptions(id));
    enqueued++;
  }
  return enqueued;
}
