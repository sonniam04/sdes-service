// คิวส่ง ERP กับ Postgres + Redis จริง ด้วย adapter จำลอง (spec erp-sync, phase 3 task 3.4)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue, type Worker } from "bullmq";
import Redis from "ioredis";
import { ERP_SYNC_QUEUE, erpSyncJobOptions, syncPermanent, syncTransient, type ErpAdapter, type ErpPayload, type ErpSyncJob } from "@sdes/core";
import { Prisma, type PrismaClient } from "@sdes/db";
import { loadWorkerConfig } from "../../worker/src/config.js";
import { reconcileSync, startSyncWorker, type SyncDeps } from "../../worker/src/erp/sync.js";
import { hasDatabase, urls } from "./test-db.js";
import { createUser, ownerDb } from "./helpers.js";

type Step = "ok" | "transient" | "permanent";

/** adapter จำลอง: พฤติกรรมตามเลขเอกสาร (คิวของผลแต่ละครั้ง) */
class ScriptedAdapter implements ErpAdapter {
  readonly name = "scripted";
  readonly scripts = new Map<string, Step[]>();
  readonly calls = new Map<string, number>();
  readonly payloads: ErpPayload[] = [];
  async push(p: ErpPayload) {
    const n = this.calls.get(p.docNo) ?? 0;
    this.calls.set(p.docNo, n + 1);
    this.payloads.push(p);
    const s = this.scripts.get(p.docNo) ?? ["ok"];
    const step = s[Math.min(n, s.length - 1)]!;
    if (step === "transient") throw syncTransient("Odoo ขัดข้องชั่วคราว (503)");
    if (step === "permanent") throw syncPermanent("Odoo ปฏิเสธข้อมูล (422): Invalid tax");
    return { transactionId: `T-${p.docNo}`, reused: false, partnerId: "77" };
  }
}

const data = (invoiceNo: string) => ({
  invoiceNo,
  invoiceDate: "2026-10-15",
  vendorName: "ผู้ขาย",
  vendorTaxId: "0105536000011",
  vendorBranch: "00000",
  buyerTaxId: "0994000165617",
  buyerBranch: "00000",
  subtotal: "10000.00",
  discount: "0.00",
  vatBase: "10000.00",
  vatRate: "7",
  vatAmount: "700.00",
  vatExempt: false,
  grandTotal: "10700.00",
  whtBase: null,
  whtRate: null,
  whtAmount: null,
  netPayable: null,
  items: [{ no: 1, description: "ค่าบริการ", quantity: "1", unitPrice: "10000.00", amount: "10000.00" }],
});

describe.skipIf(!hasDatabase)("ERP sync queue (spec erp-sync)", () => {
  let db: PrismaClient;
  let worker: Worker<ErpSyncJob>;
  let queue: Queue<ErpSyncJob>;
  let deps: SyncDeps;
  let adapter: ScriptedAdapter;
  let uploader: { id: string };
  let vendorId: string;
  const connection = () => new Redis(loadWorkerConfig().redisUrl, { maxRetriesPerRequest: null });

  async function doc(status: "VERIFIED" | "APPROVED" | "PENDING_APPROVAL" | "REJECTED" = "VERIFIED") {
    const docNo = `T-${randomUUID().slice(0, 8)}`;
    return db.document.create({
      data: {
        status,
        sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        fileName: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        uploadedById: uploader.id,
        vendorId,
        data: { ...data(docNo) } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  const enqueue = (id: string) => queue.add("sync", { documentId: id }, erpSyncJobOptions(id));
  async function waitFor(id: string, status: string, ms = 30_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const d = await db.document.findUnique({ where: { id } });
      if (d?.status === status) return d;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`เอกสาร ${id} ไม่ถึงสถานะ ${status}`);
  }
  const setAutoSync = (on: boolean) =>
    db.erpConnection.upsert({
      where: { id: 1 },
      create: { id: 1, adapter: "odoo", url: "http://odoo.test", autoSync: on, updatedAt: new Date() },
      update: { autoSync: on },
    });

  beforeAll(async () => {
    db = ownerDb();
    uploader = await createUser(db, ["AP_CLERK"]);
    vendorId = (await db.vendor.create({ data: { taxId: "0105536000011", branchCode: String(Math.floor(Math.random() * 99999)).padStart(5, "0"), name: "ผู้ขาย" } })).id;
    adapter = new ScriptedAdapter();
    const cfg = loadWorkerConfig();
    deps = {
      prisma: db,
      redis: new Redis(cfg.redisUrl),
      adapterFor: () => adapter,
      loadAttachment: async (d) => ({ name: d.fileName, mimeType: d.mimeType, data: Buffer.from("%PDF") }),
      queuePrefix: `sdes-test-sync-${randomUUID().slice(0, 6)}`,
    };
    queue = new Queue<ErpSyncJob>(ERP_SYNC_QUEUE, { connection: connection(), prefix: deps.queuePrefix });
    worker = startSyncWorker(deps, connection());
    expect(urls).toBeTruthy();
  });

  beforeEach(async () => {
    await setAutoSync(true);
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    deps?.redis.disconnect();
    await db?.erpConnection.deleteMany({});
    await db?.$disconnect();
  });

  it("ส่งสำเร็จ: VERIFIED → SYNCING → SYNCED พร้อมเลขอ้างอิง, จำรหัสคู่ค้า และประวัติการส่ง", async () => {
    const d = await doc();
    await enqueue(d.id);
    const done = await waitFor(d.id, "SYNCED");
    expect(done).toMatchObject({ erpTransactionId: `T-${d.docNo}`, syncError: null });
    expect(done.syncedAt).toBeTruthy();
    expect((await db.vendor.findUniqueOrThrow({ where: { id: vendorId } })).erpPartnerId).toBe("77");
    const attempts = await db.erpSyncAttempt.findMany({ where: { documentId: d.id } });
    expect(attempts.map((a) => [a.attempt, a.status, a.transactionId])).toEqual([[1, "SUCCESS", `T-${d.docNo}`]]);
    const steps = (await db.documentStatusHistory.findMany({ where: { documentId: d.id }, orderBy: { id: "asc" } })).map((h) => h.toStatus);
    expect(steps).toEqual(["SYNCING", "SYNCED"]);
  });

  it("ERP ล่มชั่วคราวแล้วสำเร็จครั้งที่สอง → SYNCED และมีประวัติ 2 ครั้ง", async () => {
    const d = await doc("APPROVED");
    adapter.scripts.set(d.docNo, ["transient", "ok"]);
    await enqueue(d.id);
    await waitFor(d.id, "SYNCED");
    const attempts = await db.erpSyncAttempt.findMany({ where: { documentId: d.id }, orderBy: { attempt: "asc" } });
    expect(attempts.map((a) => a.status)).toEqual(["FAILED", "SUCCESS"]);
  });

  it("ล่มทั้ง 3 ครั้ง → SYNC_FAILED พร้อมเหตุผล", async () => {
    const d = await doc();
    adapter.scripts.set(d.docNo, ["transient"]);
    await enqueue(d.id);
    const failed = await waitFor(d.id, "SYNC_FAILED", 60_000);
    expect(adapter.calls.get(d.docNo)).toBe(3);
    expect(failed.syncError).toMatch(/ขัดข้องชั่วคราว/);
  });

  it("ERP ปฏิเสธข้อมูล → SYNC_FAILED ทันทีโดยไม่ลองซ้ำ พร้อมข้อความจาก ERP", async () => {
    const d = await doc();
    adapter.scripts.set(d.docNo, ["permanent"]);
    await enqueue(d.id);
    const failed = await waitFor(d.id, "SYNC_FAILED");
    await new Promise((r) => setTimeout(r, 6000)); // เลยรอบ backoff แรกแล้วต้องไม่มีการลองซ้ำ
    expect(adapter.calls.get(d.docNo)).toBe(1);
    expect(failed.syncError).toMatch(/Invalid tax/);
  });

  it("การส่งอัตโนมัติปิด → ไม่ส่งและรอที่สถานะเดิม; เปิดแล้ว reconciler ส่งงานค้าง", async () => {
    await setAutoSync(false);
    const d = await doc("APPROVED");
    await enqueue(d.id);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await db.document.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("APPROVED");
    expect(adapter.calls.get(d.docNo)).toBeUndefined();
    expect(await reconcileSync(deps, queue)).toBe(0);

    await setAutoSync(true);
    expect(await reconcileSync(deps, queue)).toBeGreaterThanOrEqual(1);
    await waitFor(d.id, "SYNCED");
  });

  it("PENDING_APPROVAL และ REJECTED ไม่ถูกส่งแม้มีงานในคิว", async () => {
    const p = await doc("PENDING_APPROVAL");
    const r = await doc("REJECTED");
    await enqueue(p.id);
    await enqueue(r.id);
    await new Promise((x) => setTimeout(x, 1500));
    expect(adapter.calls.get(p.docNo)).toBeUndefined();
    expect(adapter.calls.get(r.docNo)).toBeUndefined();
    expect((await db.document.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING_APPROVAL");
  });
});
