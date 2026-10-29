// ตรวจแก้ ยืนยัน อนุมัติ ตั้งค่า (spec document-review, risk-assessment; phase 2 tasks 4.1–4.7)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DocumentData, Role } from "@sdes/core";
import { Prisma, type PrismaClient } from "@sdes/db";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

const COMPANY = "0994000165617";
const VENDOR = "0105536000011";

function validData(over: Partial<DocumentData> = {}): DocumentData {
  return {
    invoiceNo: `INV-${randomUUID().slice(0, 8)}`,
    invoiceDate: new Date().toISOString().slice(0, 10),
    vendorName: "บริษัท ผู้ขาย จำกัด",
    vendorTaxId: VENDOR,
    vendorBranch: "00000",
    buyerTaxId: COMPANY,
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
    items: [{ no: 1, description: "ค่าบริการ", quantity: "2", unitPrice: "5000.00", amount: "10000.00" }],
    ...over,
  };
}

describe.skipIf(!hasDatabase)("review (spec document-review + risk-assessment)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let uploader: { id: string };
  const users: Record<string, { id: string; h: Record<string, string> }> = {};
  const http = () => request(app.getHttpServer());

  async function user(name: string, roles: Role[]) {
    const u = await createUser(db, roles);
    users[name] = { id: u.id, h: await authed(app, u.email) };
    return users[name]!;
  }

  /** สร้างเอกสาร EXTRACTED ตรงในฐานข้อมูล (ไม่ต้องผ่าน worker) */
  async function extracted(opts: { data?: DocumentData; confidence?: number; vendorTaxId?: string } = {}) {
    const data = opts.data ?? validData(opts.vendorTaxId ? { vendorTaxId: opts.vendorTaxId } : {});
    const d = await db.document.create({
      data: {
        status: "EXTRACTED",
        sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        fileName: "inv.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        storageKey: `test/${randomUUID()}.pdf`,
        uploadedById: uploader.id,
        provider: "fixture",
        modelVersion: "fixture-1",
        confidence: new Prisma.Decimal(opts.confidence ?? 0.97),
        data: data as unknown as Prisma.InputJsonValue,
        fieldMeta: { "header.invoiceNo": { confidence: 0.6, bbox: { page: 1, x: 0.6, y: 0.1, w: 0.2, h: 0.03 }, aiValue: data.invoiceNo } },
        validationIssues: [],
        invoiceNo: data.invoiceNo,
      },
    });
    return d;
  }

  const patch = (id: string, version: number, changes: Partial<DocumentData>, h = users.clerk!.h) =>
    http().patch(`/documents/${id}/data`).set(h).send({ version, changes });

  /** ยืนยันโดย Clerk อีกคน เพื่อให้ AP Lead ที่ทดสอบไม่ติดการแยกหน้าที่ */
  async function pending() {
    const d = await extracted({ vendorTaxId: newTaxId() });
    const r = await http().post(`/documents/${d.id}/verify`).set(users.clerk2!.h).send({ version: d.version }).expect(200);
    expect(r.body.status).toBe("PENDING_APPROVAL");
    return db.document.findUniqueOrThrow({ where: { id: d.id } });
  }

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    uploader = await createUser(db, ["AP_CLERK"]);
    await user("clerk", ["AP_CLERK"]);
    await user("clerk2", ["AP_CLERK"]);
    await user("lead", ["AP_LEAD"]);
    await user("lead2", ["AP_LEAD"]);
    await user("exec", ["FINANCE_EXEC"]);
    await user("admin", ["SYS_ADMIN"]);
    await http()
      .put("/settings/risk")
      .set(users.admin!.h)
      .send({ confidenceThreshold: 0.85, highAmountThreshold: null, companyTaxId: COMPANY, companyName: "บริษัททดสอบ" })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  describe("4.1 รายละเอียดเอกสาร", () => {
    it("Finance Exec อ่านได้ครบ และไม่มี storageKey หลุด", async () => {
      const d = await extracted();
      const r = await http().get(`/documents/${d.id}`).set(users.exec!.h).expect(200);
      expect(r.body).toMatchObject({ status: "EXTRACTED", data: { grandTotal: "10700.00" }, validationIssues: [], edits: [] });
      expect(r.body.fieldMeta["header.invoiceNo"].bbox.page).toBe(1);
      expect(r.body).toHaveProperty("riskFlags");
      expect(r.body).toHaveProperty("history");
      expect(r.body).not.toHaveProperty("storageKey");
    });
  });

  describe("4.2 แก้ข้อมูล", () => {
    it("แก้เลขที่เอกสาร: audit ราย field และหน้าตรวจเห็นว่าถูกแก้", async () => {
      const d = await extracted({ data: validData({ invoiceNo: "INV-2O26-001" }) });
      const r = await patch(d.id, d.version, { invoiceNo: "INV-2026-001" }).expect(200);
      expect(r.body.version).toBe(d.version + 1);
      const ev = await db.auditEvent.findFirstOrThrow({ where: { entityId: d.id, action: "document.field_edited" } });
      expect(ev.details).toMatchObject({ field: "header.invoiceNo", aiValue: "INV-2O26-001", before: "INV-2O26-001", after: "INV-2026-001" });
      expect(ev.actorUserId).toBe(users.clerk!.id);
      const g = await http().get(`/documents/${d.id}`).set(users.clerk!.h).expect(200);
      expect(g.body.edits).toEqual([expect.objectContaining({ field: "header.invoiceNo", before: "INV-2O26-001", after: "INV-2026-001" })]);
    });

    it("แก้แล้วตรวจใหม่ทันที", async () => {
      const d = await extracted();
      const bad = await patch(d.id, d.version, { grandTotal: "10070.00" }).expect(200);
      expect(bad.body.validationIssues.map((i: { code: string }) => i.code)).toContain("GRAND_TOTAL");
      const good = await patch(d.id, bad.body.version, { grandTotal: "10700.00" }).expect(200);
      expect(good.body.validationIssues).toEqual([]);
    });

    it("สองคนแก้พร้อมกัน: คนที่บันทึกทีหลังได้ 409 พร้อมค่าล่าสุด", async () => {
      const d = await extracted();
      await patch(d.id, d.version, { vendorName: "ชื่อจากคนแรก" }).expect(200);
      const r = await patch(d.id, d.version, { vendorName: "ชื่อจากคนที่สอง" }, users.clerk2!.h).expect(409);
      expect(r.body).toMatchObject({ code: "STALE", latest: { data: { vendorName: "ชื่อจากคนแรก" } } });
    });

    it("แก้หลังยืนยันถูกปฏิเสธและข้อมูลไม่เปลี่ยน", async () => {
      const d = await extracted();
      await db.document.update({ where: { id: d.id }, data: { status: "VERIFIED" } });
      await patch(d.id, d.version, { vendorName: "แก้ไม่ได้" }).expect(409);
      expect((await db.document.findUniqueOrThrow({ where: { id: d.id } })).data).toMatchObject({ vendorName: "บริษัท ผู้ขาย จำกัด" });
    });

    it("Finance Exec แก้ไม่ได้ (403) และรูปแบบคำขอผิดได้ 400", async () => {
      const d = await extracted();
      await patch(d.id, d.version, { vendorName: "x" }, users.exec!.h).expect(403);
      await http().patch(`/documents/${d.id}/data`).set(users.clerk!.h).send({ version: d.version, changes: { unknownField: "x" } }).expect(400);
    });
  });

  // Tax ID 13 หลักที่ถูกต้องตามสูตร ไม่ซ้ำกันในแต่ละ test (ผู้ขายใหม่)
  const newTaxId = () => {
    const base = String(Math.floor(Math.random() * 1e12)).padStart(12, "0");
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + ((11 - (sum % 11)) % 10);
  };

  describe("4.3 ยืนยันและประเมินความเสี่ยง", () => {
    it("ยังมี ERROR: 422 พร้อมรายการ และสถานะไม่เปลี่ยน", async () => {
      const d = await extracted({ data: validData({ grandTotal: "10070.00" }) });
      const r = await http().post(`/documents/${d.id}/verify`).set(users.clerk!.h).send({ version: d.version }).expect(422);
      expect(r.body.issues.map((i: { code: string }) => i.code)).toContain("GRAND_TOTAL");
      expect((await db.document.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("EXTRACTED");
    });

    it("ผู้ขายใหม่ → PENDING_APPROVAL + สร้างผู้ขาย + ประวัติมีทั้งผู้ใช้และระบบ", async () => {
      const taxId = newTaxId();
      const d = await extracted({ vendorTaxId: taxId });
      const r = await http().post(`/documents/${d.id}/verify`).set(users.clerk!.h).send({ version: d.version }).expect(200);
      expect(r.body).toMatchObject({ status: "PENDING_APPROVAL", riskFlags: [expect.objectContaining({ code: "NEW_VENDOR" })] });
      const vendor = await db.vendor.findFirstOrThrow({ where: { taxId } });
      const after = await db.document.findUniqueOrThrow({ where: { id: d.id }, include: { statusHistory: { orderBy: { id: "asc" } } } });
      expect(after.vendorId).toBe(vendor.id);
      expect(after.verifiedById).toBe(users.clerk!.id);
      expect(after.statusHistory.slice(-2).map((h) => [h.toStatus, h.actorType])).toEqual([
        ["VERIFIED", "USER"],
        ["PENDING_APPROVAL", "SYSTEM"],
      ]);
      expect(await db.auditEvent.count({ where: { entityId: d.id, action: "document.risk_assessed" } })).toBe(1);
    });

    it("เคสไม่เสี่ยงคงที่ VERIFIED และคืนเอกสารรอตรวจฉบับถัดไป", async () => {
      // ผู้ขายเดิม: มีเอกสารที่ผ่านแล้วหนึ่งฉบับ
      const taxId = newTaxId();
      const vendor = await db.vendor.create({ data: { taxId, branchCode: "00000", name: "ผู้ขายเดิม" } });
      const prior = await extracted({ vendorTaxId: taxId });
      await db.document.update({ where: { id: prior.id }, data: { status: "APPROVED", vendorId: vendor.id } });
      const waiting = await extracted();
      const d = await extracted({ vendorTaxId: taxId, confidence: 0.97 });
      const r = await http().post(`/documents/${d.id}/verify`).set(users.clerk!.h).send({ version: d.version }).expect(200);
      expect(r.body).toMatchObject({ status: "VERIFIED", riskFlags: [] });
      expect(r.body.next?.id).toBeTruthy();
      expect(r.body.next.id).not.toBe(d.id);
      expect(waiting.id).toBeTruthy();
    });

    it("แก้ยอดเงินแล้วยืนยัน → มีเหตุผล MONEY_EDITED", async () => {
      const taxId = newTaxId();
      const vendor = await db.vendor.create({ data: { taxId, branchCode: "00000", name: "ผู้ขายเดิม" } });
      const prior = await extracted({ vendorTaxId: taxId });
      await db.document.update({ where: { id: prior.id }, data: { status: "APPROVED", vendorId: vendor.id } });
      const d = await extracted({ data: validData({ vendorTaxId: taxId, grandTotal: "10070.00" }) });
      const p = await patch(d.id, d.version, { grandTotal: "10700.00" }).expect(200);
      const r = await http().post(`/documents/${d.id}/verify`).set(users.clerk!.h).send({ version: p.body.version }).expect(200);
      expect(r.body.riskFlags).toEqual([expect.objectContaining({ code: "MONEY_EDITED", value: ["header.grandTotal"] })]);
    });
  });

  describe("4.4 คิวอนุมัติ อนุมัติ ปฏิเสธ", () => {
    it("AP Lead เห็นคิวพร้อมเหตุผล; Clerk ได้ 403", async () => {
      const d = await pending();
      const r = await http().get("/documents/approvals").set(users.lead!.h).expect(200);
      const row = r.body.items.find((i: { id: string }) => i.id === d.id);
      expect(row.riskFlags[0].code).toBe("NEW_VENDOR");
      await http().get("/documents/approvals").set(users.clerk!.h).expect(403);
    });

    it("อนุมัติ → APPROVED และหายจากคิว", async () => {
      const d = await pending();
      await http().post(`/documents/${d.id}/approve`).set(users.lead!.h).send({ version: d.version }).expect(200);
      expect((await db.document.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("APPROVED");
      const q = await http().get("/documents/approvals").set(users.lead!.h).expect(200);
      expect(q.body.items.some((i: { id: string }) => i.id === d.id)).toBe(false);
    });

    it("ปฏิเสธต้องมีเหตุผล และประวัติแสดงเหตุผล", async () => {
      const d = await pending();
      await http().post(`/documents/${d.id}/reject`).set(users.lead!.h).send({ reason: "  " }).expect(400);
      await http().post(`/documents/${d.id}/reject`).set(users.lead!.h).send({ reason: "ผู้ขายไม่อยู่ในรายชื่อที่ทำสัญญา" }).expect(200);
      const h = await db.documentStatusHistory.findFirstOrThrow({ where: { documentId: d.id, toStatus: "REJECTED" } });
      expect(h.reason).toBe("ผู้ขายไม่อยู่ในรายชื่อที่ทำสัญญา");
    });

    it("AP Lead ที่ยืนยันเองอนุมัติไม่ได้ (SELF_APPROVAL)", async () => {
      const d = await extracted({ vendorTaxId: newTaxId() });
      await http().post(`/documents/${d.id}/verify`).set(users.lead!.h).send({ version: d.version }).expect(200);
      const r = await http().post(`/documents/${d.id}/approve`).set(users.lead!.h).send({}).expect(403);
      expect(r.body).toMatchObject({ code: "SELF_APPROVAL", message: "อนุมัติเอกสารที่คุณยืนยันหรือแก้ไขเองไม่ได้" });
      expect((await db.document.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING_APPROVAL");
    });

    it("AP Lead ที่เคยแก้ข้อมูลอนุมัติไม่ได้", async () => {
      const d = await extracted({ vendorTaxId: newTaxId() });
      const p = await patch(d.id, d.version, { vendorName: "แก้โดย Lead" }, users.lead2!.h).expect(200);
      await http().post(`/documents/${d.id}/verify`).set(users.clerk!.h).send({ version: p.body.version }).expect(200);
      await http().post(`/documents/${d.id}/approve`).set(users.lead2!.h).send({}).expect(403);
    });

    it("อนุมัติพร้อมกันสองคำขอ → สำเร็จหนึ่ง อีกหนึ่ง 409", async () => {
      const d = await pending();
      const [a, b] = await Promise.all([
        http().post(`/documents/${d.id}/approve`).set(users.lead!.h).send({ version: d.version }),
        http().post(`/documents/${d.id}/reject`).set(users.lead2!.h).send({ version: d.version, reason: "ซ้ำ" }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });
  });

  describe("4.6 ตั้งค่าความเสี่ยง", () => {
    it("ตั้งเกณฑ์ยอดสูงแล้วเอกสารที่เกินมีเหตุผล HIGH_AMOUNT พร้อม audit ค่าก่อน/หลัง", async () => {
      const r = await http()
        .put("/settings/risk")
        .set(users.admin!.h)
        .send({ confidenceThreshold: 0.85, highAmountThreshold: "5000.00", companyTaxId: COMPANY, companyName: "บริษัททดสอบ" })
        .expect(200);
      expect(r.body.highAmountThreshold).toBe("5000.00");
      const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "settings.updated" }, orderBy: { id: "desc" } });
      expect(ev.details).toMatchObject({ field: "risk.high_amount_threshold", before: null, after: "5000.00" });
      try {
        const d = await extracted({ vendorTaxId: newTaxId() });
        const v = await http().post(`/documents/${d.id}/verify`).set(users.clerk!.h).send({}).expect(200);
        expect(v.body.riskFlags.map((f: { code: string }) => f.code)).toContain("HIGH_AMOUNT");
      } finally {
        await http()
          .put("/settings/risk")
          .set(users.admin!.h)
          .send({ confidenceThreshold: 0.85, highAmountThreshold: null, companyTaxId: COMPANY, companyName: "บริษัททดสอบ" })
          .expect(200);
      }
    });

    it("เกณฑ์ความมั่นใจ 1.5 ถูกปฏิเสธพร้อมข้อความ", async () => {
      const r = await http()
        .put("/settings/risk")
        .set(users.admin!.h)
        .send({ confidenceThreshold: 1.5, highAmountThreshold: null, companyTaxId: COMPANY, companyName: null })
        .expect(400);
      expect(r.body.message).toBe("เกณฑ์ความมั่นใจต้องอยู่ระหว่าง 0 ถึง 1");
    });

    it("Tax ID บริษัทผิดถูกปฏิเสธ และ Clerk แก้เกณฑ์ไม่ได้", async () => {
      await http()
        .put("/settings/risk")
        .set(users.admin!.h)
        .send({ confidenceThreshold: 0.85, highAmountThreshold: null, companyTaxId: "0105536000014", companyName: null })
        .expect(400);
      await http().put("/settings/risk").set(users.clerk!.h).send({}).expect(403);
      await http().get("/settings/risk").set(users.clerk!.h).expect(403);
    });
  });

  describe("4.5 ไฟล์ต้นฉบับผ่าน API", () => {
    const stack = process.env.INGESTION_STACK === "1";

    it.skipIf(!stack)("PDF ได้ไฟล์เดิม มี audit และ SYS_ADMIN ได้ 403", async () => {
      const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(1024)]);
      const up = await http().post("/documents").set(users.clerk!.h).attach("files", pdf, "a.pdf").expect(201);
      const id = up.body.results[0].id as string;
      const r = await http().get(`/documents/${id}/file/content`).set(users.exec!.h).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("application/pdf");
      expect(Buffer.compare(r.body as Buffer, pdf)).toBe(0);
      expect(await db.auditEvent.count({ where: { entityId: id, action: "document.file_viewed", actorUserId: users.exec!.id } })).toBe(1);
      await http().get(`/documents/${id}/file/content`).set(users.admin!.h).expect(403);
    });

    it.skipIf(!stack)("TIFF 2 หน้าส่งเป็น PNG รายหน้าพร้อมจำนวนหน้า", async () => {
      const page = (c: string) => sharp({ create: { width: 30, height: 40, channels: 3, background: c } }).png().toBuffer();
      const tiff = await sharp(await Promise.all([page("#f00"), page("#00f")]), { join: { animated: true } }).tiff().toBuffer();
      const up = await http().post("/documents").set(users.clerk!.h).attach("files", tiff, "scan.tiff").expect(201);
      const id = up.body.results[0].id as string;
      const r = await http().get(`/documents/${id}/file/content?page=2`).set(users.clerk!.h).expect(200);
      expect(r.headers["content-type"]).toBe("image/png");
      expect(r.headers["x-page-count"]).toBe("2");
    });
  });

  it("4.7 Swagger มีทุก endpoint ใหม่", async () => {
    const r = await http().get("/docs-json").expect(200);
    for (const p of [
      "/documents/approvals",
      "/documents/{id}/data",
      "/documents/{id}/verify",
      "/documents/{id}/approve",
      "/documents/{id}/reject",
      "/documents/{id}/file/content",
      "/settings/risk",
    ])
      expect(Object.keys(r.body.paths)).toContain(p);
  });
});
