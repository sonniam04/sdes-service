import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Queue, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import {
  EXTRACT_QUEUE,
  extractJobOptions,
  FakeExtractionProvider,
  STATUS_CHANNEL,
  type ExtractionProvider,
  type ExtractJob,
  type StatusEvent,
} from "@sdes/core";
import { Prisma, StaleDocumentError, transitionDocument, type PrismaClient } from "@sdes/db";
import type { WorkerConfig } from "./config.js";

const SYSTEM = { kind: "system" } as const;

export function createProvider(name: string): ExtractionProvider {
  if (name === "fake") return new FakeExtractionProvider();
  throw new Error(`ไม่รู้จัก EXTRACTION_PROVIDER=${name}`);
}

export type Deps = {
  cfg: WorkerConfig;
  prisma: PrismaClient;
  redis: Redis;
  provider: ExtractionProvider;
  s3: S3Client;
};

export function createS3(cfg: WorkerConfig) {
  return new S3Client({
    endpoint: cfg.s3.endpoint,
    region: cfg.s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
  });
}

async function publish(redis: Redis, d: { id: string; docNo: string; status: string }) {
  const e: StatusEvent = { id: d.id, docNo: d.docNo, status: d.status, at: new Date().toISOString() };
  await redis.publish(STATUS_CHANNEL, JSON.stringify(e)).catch(() => {});
}

/** อ่านเอกสารหนึ่งฉบับ: UPLOADED → PROCESSING → EXTRACTED (ล้มเหลวครบจำนวน retry → FAILED) */
export async function processExtract(deps: Deps, documentId: string) {
  const { prisma, redis, provider, s3, cfg } = deps;
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) return { skipped: "not_found" as const };

  let current = doc;
  if (doc.status === "UPLOADED") {
    try {
      current = await prisma.$transaction((tx) => transitionDocument(tx, { documentId, to: "PROCESSING", actor: SYSTEM }));
    } catch (e) {
      if (e instanceof StaleDocumentError) return { skipped: "raced" as const };
      throw e;
    }
    await publish(redis, current);
  } else if (doc.status !== "PROCESSING") {
    // อ่านไปแล้ว หรือถูกเปลี่ยนสถานะโดยทางอื่น — ไม่ทำซ้ำ
    return { skipped: doc.status };
  }

  const obj = await s3.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: current.storageKey }));
  const file = Buffer.from(await obj.Body!.transformToByteArray());
  const result = await provider.extract({ file, mime: current.mimeType });

  const done = await prisma.$transaction(async (tx) => {
    await tx.documentExtraction.create({
      data: {
        documentId,
        provider: result.provider,
        modelVersion: result.modelVersion,
        confidence: new Prisma.Decimal(result.confidence),
        raw: result.raw as Prisma.InputJsonValue,
        items: result.items as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.document.update({
      where: { id: documentId },
      data: { provider: result.provider, modelVersion: result.modelVersion, confidence: new Prisma.Decimal(result.confidence) },
    });
    return transitionDocument(tx, { documentId, to: "EXTRACTED", actor: SYSTEM });
  });
  await publish(redis, done);
  return { status: done.status };
}

/** หลัง retry ครบ: ทำเครื่องหมาย FAILED ให้ผู้ใช้กด "อ่านใหม่" ได้ */
export async function markFailed(deps: Deps, documentId: string, error: string) {
  const doc = await deps.prisma.document.findUnique({ where: { id: documentId } });
  if (doc?.status !== "PROCESSING") return;
  const failed = await deps.prisma.$transaction((tx) =>
    transitionDocument(tx, { documentId, to: "FAILED", actor: SYSTEM, reason: error.slice(0, 500) }),
  );
  await publish(deps.redis, failed);
}

export function startExtractWorker(deps: Deps, connection: Redis) {
  const worker = new Worker<ExtractJob>(EXTRACT_QUEUE, (job: Job<ExtractJob>) => processExtract(deps, job.data.documentId), {
    connection,
    prefix: deps.cfg.queuePrefix,
    concurrency: deps.cfg.concurrency,
  });
  worker.on("failed", (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void markFailed(deps, job.data.documentId, err.message);
  });
  return worker;
}

/**
 * Reconciler (design D6): เอกสาร UPLOADED ที่ค้างเกินเวลาโดยไม่มี job → enqueue ใหม่
 * กันกรณี commit DB แล้วแต่ enqueue ไม่สำเร็จ หรือ Redis หาย
 */
export async function reconcileOnce(deps: Pick<Deps, "prisma" | "cfg">, queue: Queue<ExtractJob>) {
  const stuck = await deps.prisma.document.findMany({
    where: { status: "UPLOADED", createdAt: { lt: new Date(Date.now() - deps.cfg.stuckAfterMs) } },
    select: { id: true },
    take: 500,
  });
  let enqueued = 0;
  for (const { id } of stuck) {
    const existing = await queue.getJob(id);
    if (existing && !(await existing.isFailed())) continue;
    if (existing) await existing.remove();
    await queue.add("extract", { documentId: id }, extractJobOptions(id));
    enqueued++;
  }
  return enqueued;
}
