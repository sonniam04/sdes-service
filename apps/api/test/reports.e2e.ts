// รายงานการเงินและตัวชี้วัดกระบวนการ (spec finance-reports, tasks 4.2–4.3 ของ complete-missing-features)
// ข้อมูลทดสอบอยู่ในช่วงเวลาที่ไม่ซ้ำกับ test อื่น: วันที่ในใบกำกับปี 2031, วันที่อัปโหลดเดือน มี.ค. 2019
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DocumentStatus, PrismaClient } from "@sdes/db";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

describe.skipIf(!hasDatabase)("finance reports (spec finance-reports)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let exec: Record<string, string>;
  let execId: string;
  let clerk: Record<string, string>;
  let uploaderId: string;
  const http = () => request(app.getHttpServer());
  const vendors: string[] = [];

  type Doc = { status: DocumentStatus; vendor: number; invoiceDate: string; subtotal: string; discount?: string; vat: string; wht?: string; total: string };
  async function doc(d: Doc) {
    return db.document.create({
      data: {
        status: d.status,
        sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        fileName: `${randomUUID()}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        uploadedById: uploaderId,
        vendorId: vendors[d.vendor],
        invoiceDate: new Date(`${d.invoiceDate}T00:00:00Z`),
        subtotal: d.subtotal,
        discount: d.discount ?? "0.00",
        vatAmount: d.vat,
        whtAmount: d.wht ?? null,
        grandTotal: d.total,
      },
    });
  }

  /** เอกสารที่อัปโหลดใน มี.ค. 2019 พร้อมประวัติสถานะตามเวลาที่กำหนด (วินาทีหลังอัปโหลด) */
  async function processDoc(steps: [DocumentStatus, number][], edited = false) {
    const created = new Date("2019-03-10T03:00:00Z");
    const last = steps.at(-1)![0];
    const d = await db.document.create({
      data: {
        status: last,
        sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        fileName: `${randomUUID()}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        uploadedById: uploaderId,
        createdAt: created,
      },
    });
    let from: DocumentStatus = "UPLOADED";
    for (const [to, sec] of steps) {
      await db.documentStatusHistory.create({ data: { documentId: d.id, fromStatus: from, toStatus: to, actorType: "SYSTEM", createdAt: new Date(created.getTime() + sec * 1000) } });
      from = to;
    }
    if (edited) await db.auditEvent.create({ data: { actorType: "USER", actorUserId: uploaderId, action: "document.field_edited", entityType: "document", entityId: d.id, details: { field: "header.grandTotal" } } });
    return d;
  }

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    const e = await createUser(db, ["FINANCE_EXEC"]);
    execId = e.id;
    exec = await authed(app, e.email);
    const c = await createUser(db, ["AP_CLERK"]);
    uploaderId = c.id;
    clerk = await authed(app, c.email);
    for (let i = 0; i < 12; i++) {
      const v = await db.vendor.create({ data: { taxId: `01055${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, branchCode: String(i).padStart(5, "0"), name: `ผู้ขายรายงาน ${i}` } });
      vendors.push(v.id);
    }
    // ต.ค. 2031: นับ 2 ฉบับ; ถูกปฏิเสธและยังไม่ยืนยันไม่นับ
    await doc({ status: "SYNCED", vendor: 0, invoiceDate: "2031-10-05", subtotal: "10000.00", vat: "700.00", wht: "300.00", total: "10700.00" });
    await doc({ status: "APPROVED", vendor: 1, invoiceDate: "2031-10-31", subtotal: "1000.10", discount: "0.10", vat: "70.00", total: "1070.00" });
    await doc({ status: "REJECTED", vendor: 0, invoiceDate: "2031-10-06", subtotal: "99999.00", vat: "0.00", total: "99999.00" });
    await doc({ status: "EXTRACTED", vendor: 0, invoiceDate: "2031-10-07", subtotal: "55555.00", vat: "0.00", total: "55555.00" });
    // พ.ย. 2031: ไม่มีเอกสาร; ธ.ค. 2031: 11 ผู้ขาย (ผู้ขาย 2–11 ยอดต่างกัน + ผู้ขาย 0 อีกฉบับ)
    for (let i = 2; i < 12; i++) await doc({ status: "VERIFIED", vendor: i, invoiceDate: "2031-12-15", subtotal: `${i}00.00`, vat: "0.00", total: `${i}00.00` });
    await doc({ status: "SYNC_FAILED", vendor: 0, invoiceDate: "2031-12-31", subtotal: "0.33", vat: "0.02", total: "0.35" });

    // ตัวชี้วัดกระบวนการ มี.ค. 2019: 4 ฉบับยืนยันแล้ว (3 ไม่แก้), 1 ฉบับต้องอนุมัติ, 1 ฉบับยังรอตรวจ
    await processDoc([["PROCESSING", 1], ["EXTRACTED", 10], ["VERIFIED", 70], ["SYNCING", 71], ["SYNCED", 80]]);
    await processDoc([["PROCESSING", 1], ["EXTRACTED", 20], ["VERIFIED", 140], ["SYNCING", 141], ["SYNCED", 160]]);
    await processDoc([["PROCESSING", 1], ["EXTRACTED", 30], ["VERIFIED", 90], ["PENDING_APPROVAL", 91]]);
    await processDoc([["PROCESSING", 1], ["EXTRACTED", 40], ["VERIFIED", 100]], true);
    await processDoc([["PROCESSING", 1], ["EXTRACTED", 50]]);
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  it("สรุปรายเดือน: นับเฉพาะยืนยันแล้วขึ้นไปที่ไม่ถูกปฏิเสธ, มีเดือนที่ไม่มีเอกสาร, ยอดรวมเท่าผลรวมรายเดือน", async () => {
    const r = await http().get("/reports/summary?from=2031-10&to=2031-12").set(exec).expect(200);
    expect(r.body.period).toEqual({ from: "2031-10", to: "2031-12" });
    expect(r.body.months).toEqual([
      { month: "2031-10", documentCount: 2, subtotal: "11000.00", vat: "770.00", wht: "300.00", grandTotal: "11770.00" },
      { month: "2031-11", documentCount: 0, subtotal: "0.00", vat: "0.00", wht: "0.00", grandTotal: "0.00" },
      { month: "2031-12", documentCount: 11, subtotal: "6500.33", vat: "0.02", wht: "0.00", grandTotal: "6500.35" },
    ]);
    expect(r.body.totals).toEqual({ documentCount: 13, subtotal: "17500.33", vat: "770.02", wht: "300.00", grandTotal: "18270.35" });
  });

  it("ผู้ขาย 10 รายที่ยอดรวมสูงสุดในช่วง", async () => {
    const r = await http().get("/reports/summary?from=2031-10&to=2031-12").set(exec).expect(200);
    expect(r.body.topVendors).toHaveLength(10);
    expect(r.body.topVendors[0]).toMatchObject({ vendorId: vendors[0], name: "ผู้ขายรายงาน 0", documentCount: 2, grandTotal: "10700.35" });
    expect(r.body.topVendors[1]).toMatchObject({ vendorId: vendors[11], grandTotal: "1100.00" });
    expect(r.body.topVendors.map((v: { vendorId: string }) => v.vendorId)).not.toContain(vendors[2]);
  });

  it("ตัวชี้วัดกระบวนการตามวันที่อัปโหลด (เวลาไทย)", async () => {
    const r = await http().get("/reports/summary?from=2019-03&to=2019-03").set(exec).expect(200);
    const p = r.body.process;
    expect(p.uploaded).toBe(5);
    expect(p.statusCounts).toMatchObject({ SYNCED: 2, PENDING_APPROVAL: 1, VERIFIED: 1, EXTRACTED: 1 });
    expect(p.avgSeconds).toEqual({ toExtracted: 30, toVerified: 75, toSynced: 15 });
    expect(p.approvalRate).toBeCloseTo(0.25);
    expect(p.noEditRate).toBeCloseTo(0.75);
  });

  it("ค่าเริ่มต้นเป็นเดือนปัจจุบัน; ช่วงเกิน 24 เดือนหรือกลับด้านได้ 400", async () => {
    const now = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
    const r = await http().get("/reports/summary").set(exec).expect(200);
    expect(r.body.period).toEqual({ from: now, to: now });
    const long = await http().get("/reports/summary?from=2029-01&to=2031-06").set(exec).expect(400);
    expect(String(long.body.message)).toContain("24 เดือน");
    await http().get("/reports/summary?from=2031-06&to=2031-01").set(exec).expect(400);
    await http().get("/reports/summary?from=2031-13").set(exec).expect(400);
  });

  it("ส่งออก CSV: BOM, ส่วนรายเดือนและผู้ขาย, ภาษาไทยถูกต้อง และมี audit", async () => {
    const res = await http()
      .get("/reports/summary/export?from=2031-10&to=2031-12")
      .set(exec)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain('filename="report-2031-10-2031-12.csv"');
    const buf = res.body as Buffer;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.subarray(3).toString("utf8");
    expect(text).toContain("เดือน,จำนวนเอกสาร,ยอดก่อนภาษี,ภาษีซื้อ,ภาษีหัก ณ ที่จ่าย,ยอดรวม");
    expect(text).toContain("2031-10,2,11000.00,770.00,300.00,11770.00");
    expect(text).toContain("รวม,13,17500.33,770.02,300.00,18270.35");
    expect(text).toContain("ผู้ขายรายงาน 0");
    const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "report.exported", actorUserId: execId }, orderBy: { id: "desc" } });
    expect(ev.details).toMatchObject({ from: "2031-10", to: "2031-12" });
  });

  it("Clerk เรียก API รายงานได้ 403", async () => {
    await http().get("/reports/summary").set(clerk).expect(403);
    await http().get("/reports/summary/export").set(clerk).expect(403);
  });
});
