// ทะเบียนผู้ขาย (spec vendor-directory, task 4.1 ของ complete-missing-features)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DocumentStatus, PrismaClient } from "@sdes/db";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

/** Tax ID สุ่มที่ผ่าน mod 11 */
function taxId(): string {
  let base = "0105";
  while (base.length < 12) base += String(Math.floor(Math.random() * 10));
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + ((11 - (sum % 11)) % 10);
}

describe.skipIf(!hasDatabase)("vendor directory (spec vendor-directory)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let clerk: Record<string, string>;
  let lead: Record<string, string>;
  let admin: Record<string, string>;
  let uploaderId: string;
  const http = () => request(app.getHttpServer());
  const tag = `v${randomBytes(3).toString("hex")}`;
  const established = { taxId: taxId(), name: `บริษัท เก่า ${tag} จำกัด` };
  const fresh = { taxId: taxId(), name: `บริษัท ใหม่ ${tag} จำกัด` };
  let establishedHq: string;
  let establishedBranch: string;
  let freshId: string;

  const doc = (vendorId: string, status: DocumentStatus, grandTotal: string, invoiceDate: string) =>
    db.document.create({
      data: {
        status,
        sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        fileName: `${randomUUID()}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        uploadedById: uploaderId,
        vendorId,
        invoiceNo: `IV-${randomBytes(3).toString("hex")}`,
        invoiceDate: new Date(`${invoiceDate}T00:00:00Z`),
        grandTotal,
      },
    });

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    const c = await createUser(db, ["AP_CLERK"]);
    uploaderId = c.id;
    clerk = await authed(app, c.email);
    lead = await authed(app, (await createUser(db, ["AP_LEAD"])).email);
    admin = await authed(app, (await createUser(db, ["SYS_ADMIN"])).email);
    establishedHq = (await db.vendor.create({ data: { ...established, branchCode: "00000", erpPartnerId: "77" } })).id;
    establishedBranch = (await db.vendor.create({ data: { ...established, branchCode: "00001" } })).id;
    freshId = (await db.vendor.create({ data: { ...fresh, branchCode: "00000" } })).id;
    await doc(establishedHq, "SYNCED", "1070.00", "2026-09-01");
    await doc(establishedHq, "VERIFIED", "200.50", "2026-10-15");
    await doc(establishedHq, "REJECTED", "99999.00", "2026-10-20");
    await doc(establishedHq, "EXTRACTED", "5000.00", "2026-10-21");
    await doc(freshId, "PENDING_APPROVAL", "321.00", "2026-10-02");
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  it("ค้นด้วย Tax ID เห็นผู้ขายทุกสาขา พร้อมจำนวนเอกสาร ยอดรวม (ไม่นับที่ถูกปฏิเสธ/ยังไม่ยืนยัน) และรหัสคู่ค้า ERP", async () => {
    const r = await http().get(`/vendors?q=${established.taxId}`).set(clerk).expect(200);
    expect(r.body.total).toBe(2);
    const hq = r.body.items.find((v: { id: string }) => v.id === establishedHq);
    expect(hq).toMatchObject({
      name: established.name,
      taxId: established.taxId,
      branchCode: "00000",
      documentCount: 4,
      totalAmount: "1270.50",
      lastInvoiceDate: "2026-10-21",
      erpPartnerId: "77",
      isNew: false,
    });
    expect(r.body.items.find((v: { id: string }) => v.id === establishedBranch)).toMatchObject({ branchCode: "00001", documentCount: 0, totalAmount: "0.00", isNew: true });
  });

  it("ค้นด้วยชื่อบางส่วน และผู้ขายที่มีแต่เอกสารรออนุมัติเป็นผู้ขายรายใหม่", async () => {
    const r = await http().get(`/vendors?q=${encodeURIComponent(`ใหม่ ${tag}`)}`).set(lead).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ id: freshId, isNew: true, documentCount: 1, totalAmount: "321.00" });
  });

  it("แบ่งหน้า", async () => {
    const p1 = await http().get(`/vendors?q=${tag}&pageSize=2&page=1`).set(clerk).expect(200);
    const p2 = await http().get(`/vendors?q=${tag}&pageSize=2&page=2`).set(clerk).expect(200);
    expect(p1.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(p1.body.items).toHaveLength(2);
    expect(p2.body.items).toHaveLength(1);
    expect(new Set([...p1.body.items, ...p2.body.items].map((v: { id: string }) => v.id)).size).toBe(3);
  });

  it("รายละเอียดผู้ขายแสดงเอกสารเรียงใหม่ไปเก่า พร้อมเลขเอกสาร เลขใบกำกับ วันที่ ยอด และสถานะ", async () => {
    const r = await http().get(`/vendors/${establishedHq}`).set(lead).expect(200);
    expect(r.body.vendor).toMatchObject({ id: establishedHq, documentCount: 4 });
    expect(r.body.documents.map((d: { invoiceDate: string }) => d.invoiceDate)).toEqual(["2026-10-21", "2026-10-20", "2026-10-15", "2026-09-01"]);
    expect(r.body.documents[0]).toMatchObject({ id: expect.any(String), docNo: expect.stringMatching(/^DOC-/), invoiceNo: expect.any(String), grandTotal: "5000.00", status: "EXTRACTED" });
    await http().get(`/vendors/${randomUUID()}`).set(lead).expect(404);
  });

  it("System Admin เรียก API ผู้ขายได้ 403", async () => {
    await http().get("/vendors").set(admin).expect(403);
    await http().get(`/vendors/${establishedHq}`).set(admin).expect(403);
  });
});
