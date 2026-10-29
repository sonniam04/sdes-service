// ค้นหา audit ด้วยเลขเอกสาร และส่งออก CSV (spec audit-trail "Audit trail viewer" / "Audit export", phase 3 task 4.5)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@sdes/db";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

describe.skipIf(!hasDatabase)("audit search + export (spec audit-trail)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let admin: Record<string, string>;
  let adminId: string;
  let exec: Record<string, string>;
  let clerk: Record<string, string>;
  let doc: { id: string; docNo: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    const a = await createUser(db, ["SYS_ADMIN"]);
    adminId = a.id;
    admin = await authed(app, a.email);
    exec = await authed(app, (await createUser(db, ["FINANCE_EXEC"])).email);
    clerk = await authed(app, (await createUser(db, ["AP_CLERK"])).email);
    const uploader = await createUser(db, ["AP_CLERK"]);
    doc = await db.document.create({
      data: {
        status: "EXTRACTED",
        sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        fileName: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        uploadedById: uploader.id,
      },
    });
    await db.auditEvent.create({
      data: {
        actorType: "USER",
        actorUserId: uploader.id,
        action: "document.field_edited",
        entityType: "document",
        entityId: doc.id,
        details: { field: "header.vendorName", before: "บริษัท ก, จำกัด", after: 'บริษัท "ข" จำกัด' },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  it("ค้นด้วยเลขเอกสารเห็นทุก event ของเอกสาร พร้อมชื่อผู้กระทำ", async () => {
    const r = await http().get(`/audit-events?docNo=${doc.docNo}`).set(exec).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ action: "document.field_edited", entityId: doc.id, actorName: expect.stringContaining("ผู้ทดสอบ") });
  });

  it("เลขเอกสารที่ไม่มีได้ผลว่าง", async () => {
    const r = await http().get("/audit-events?docNo=DOC-999999").set(exec).expect(200);
    expect(r.body.items).toEqual([]);
  });

  it("ส่งออก CSV: มี BOM, ภาษาไทยถูกต้อง, escape คอมมา/อัญประกาศ และมี audit ของการส่งออก", async () => {
    const res = await http()
      .get(`/audit-events/export?docNo=${doc.docNo}`)
      .set(admin)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"/);
    const buf = res.body as Buffer;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.subarray(3).toString("utf8");
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toContain("เวลา (Asia/Bangkok)");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("document.field_edited");
    // JSON ในรายละเอียดมีทั้งคอมมาและอัญประกาศ → ต้องอยู่ในเครื่องหมายคำพูดและอัญประกาศถูก escape
    expect(lines[1]).toMatch(/,"\{.*""field"":""header\.vendorName"".*\}"$/);
    expect(lines[1]).toContain('""before"":""บริษัท ก, จำกัด""');
    const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "audit.exported", actorUserId: adminId }, orderBy: { id: "desc" } });
    expect(ev.details).toMatchObject({ filters: { docNo: doc.docNo } });
  });

  it("Clerk ค้นหาหรือส่งออกไม่ได้ (403)", async () => {
    await http().get("/audit-events").set(clerk).expect(403);
    await http().get("/audit-events/export").set(clerk).expect(403);
  });
});
