// ภาพรวมคิว รายการที่ส่งไม่สำเร็จ และการส่งใหม่ (spec operations-monitoring + erp-sync, phase 3 task 4.3)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@sdes/db";
import { QueueService } from "../src/documents/queue.service.js";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

describe.skipIf(!hasDatabase)("operations monitoring (spec operations-monitoring)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  const h: Record<string, Record<string, string>> = {};
  let uploader: string;
  const http = () => request(app.getHttpServer());

  async function failedDoc(error = "Odoo ขัดข้องชั่วคราว (503)") {
    const d = await db.document.create({
      data: {
        status: "SYNC_FAILED",
        sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        fileName: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        uploadedById: uploader,
        vendorName: "ผู้ขายทดสอบ",
        syncError: error,
      },
    });
    for (const attempt of [1, 2, 3]) await db.erpSyncAttempt.create({ data: { documentId: d.id, adapter: "odoo", attempt, status: "FAILED", error } });
    return d;
  }

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    uploader = (await createUser(db, ["AP_CLERK"])).id;
    for (const role of ["SYS_ADMIN", "FINANCE_EXEC", "AP_LEAD", "AP_CLERK"] as const) {
      const u = await createUser(db, [role]);
      h[role] = await authed(app, u.email);
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  it("ภาพรวม: จำนวนต่อสถานะ งานค้างในคิว และสถานะการส่งอัตโนมัติ", async () => {
    await failedDoc();
    const before = await db.document.count({ where: { status: "SYNC_FAILED" } });
    const r = await http().get("/ops/overview").set(h.SYS_ADMIN!).expect(200);
    expect(r.body.counts.SYNC_FAILED).toBe(before);
    expect(Object.keys(r.body.counts)).toHaveLength(11);
    expect(r.body.queues).toEqual({ extract: expect.any(Number), sync: expect.any(Number) });
    expect(r.body).toHaveProperty("autoSync");
    expect(r.body).toHaveProperty("lastSyncedAt");
  });

  it("รายการ SYNC_FAILED เรียงเก่าไปใหม่ พร้อมจำนวนครั้งและเหตุผลล่าสุด", async () => {
    const d = await failedDoc("Odoo ปฏิเสธข้อมูล (422): Invalid tax");
    const r = await http().get("/ops/sync-failed").set(h.FINANCE_EXEC!).expect(200);
    const row = r.body.items.find((i: { id: string }) => i.id === d.id);
    expect(row).toMatchObject({ docNo: d.docNo, vendorName: "ผู้ขายทดสอบ", attempts: 3, syncError: "Odoo ปฏิเสธข้อมูล (422): Invalid tax" });
    const times = r.body.items.map((i: { failedAt: string }) => i.failedAt);
    expect([...times].sort()).toEqual(times);
  });

  it("ส่งใหม่หลายฉบับ: เป็น SYNCING, ล้างเหตุผล, เข้าคิว และหายจากรายการที่ล้มเหลว", async () => {
    const docs = [await failedDoc(), await failedDoc(), await failedDoc()];
    const r = await http().post("/documents/resend").set(h.SYS_ADMIN!).send({ ids: docs.map((d) => d.id) }).expect(200);
    expect(r.body.results.every((x: { ok: boolean }) => x.ok)).toBe(true);
    for (const d of docs) {
      const now = await db.document.findUniqueOrThrow({ where: { id: d.id } });
      expect(now).toMatchObject({ status: "SYNCING", syncError: null });
      expect(await app.get(QueueService).sync.getJob(d.id)).toBeTruthy();
    }
    const list = await http().get("/ops/sync-failed").set(h.SYS_ADMIN!).expect(200);
    expect(list.body.items.some((i: { id: string }) => docs.some((d) => d.id === i.id))).toBe(false);
  });

  it("ส่งใหม่เอกสารที่ไม่ได้ล้มเหลว: แจ้งผลรายฉบับโดยไม่กระทบฉบับอื่น", async () => {
    const ok = await failedDoc();
    const synced = await db.document.update({ where: { id: (await failedDoc()).id }, data: { status: "SYNCED" } });
    const r = await http().post("/documents/resend").set(h.SYS_ADMIN!).send({ ids: [ok.id, synced.id] }).expect(200);
    expect(r.body.results).toEqual([
      { id: ok.id, ok: true },
      { id: synced.id, ok: false, message: "ส่งใหม่ได้เฉพาะเอกสารที่ส่งไม่สำเร็จ" },
    ]);
  });

  it("AP Lead ส่งใหม่ไม่ได้ (403) และสถานะไม่เปลี่ยน", async () => {
    const d = await failedDoc();
    await http().post("/documents/resend").set(h.AP_LEAD!).send({ ids: [d.id] }).expect(403);
    expect((await db.document.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("SYNC_FAILED");
  });

  it("Finance Exec อ่านภาพรวมได้; Clerk ได้ 403", async () => {
    await http().get("/ops/overview").set(h.FINANCE_EXEC!).expect(200);
    await http().get("/ops/overview").set(h.AP_CLERK!).expect(403);
    await http().get("/ops/sync-failed").set(h.AP_CLERK!).expect(403);
  });

  it("รูปแบบคำขอส่งใหม่ผิดได้ 400", async () => {
    await http().post("/documents/resend").set(h.SYS_ADMIN!).send({ ids: [] }).expect(400);
    await http().post("/documents/resend").set(h.SYS_ADMIN!).send({ ids: ["not-a-uuid"] }).expect(400);
  });

  it("phase 3 task 4.4: รายละเอียดเอกสารมีเลขอ้างอิง ERP เหตุผลล่าสุด และประวัติการส่ง; รายการมีเหตุผลของ SYNC_FAILED", async () => {
    const d = await failedDoc("Odoo ปฏิเสธข้อมูล (422): Invalid tax");
    const r = await http().get(`/documents/${d.id}`).set(h.AP_CLERK!).expect(200);
    expect(r.body).toMatchObject({ status: "SYNC_FAILED", syncError: "Odoo ปฏิเสธข้อมูล (422): Invalid tax", erpTransactionId: null });
    expect(r.body.syncAttempts.map((a: { attempt: number; status: string }) => [a.attempt, a.status])).toEqual([
      [1, "FAILED"],
      [2, "FAILED"],
      [3, "FAILED"],
    ]);
    const list = await http().get(`/documents?status=SYNC_FAILED&limit=500`).set(h.AP_CLERK!).expect(200);
    expect(list.body.items.find((i: { id: string }) => i.id === d.id)).toMatchObject({ syncError: "Odoo ปฏิเสธข้อมูล (422): Invalid tax" });

    const ok = await db.document.update({ where: { id: (await failedDoc()).id }, data: { status: "SYNCED", erpTransactionId: "1532", syncedAt: new Date(), syncError: null } });
    const s = await http().get(`/documents/${ok.id}`).set(h.FINANCE_EXEC!).expect(200);
    expect(s.body).toMatchObject({ status: "SYNCED", erpTransactionId: "1532" });
    expect(s.body.syncedAt).toBeTruthy();
  });
});
