// API key ของระบบภายนอก (spec api-keys + user-access "Service accounts", tasks 2.1–2.3 ของ complete-missing-features)
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@sdes/db";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

const uploadStack = hasDatabase && process.env.INGESTION_STACK === "1";
const PDF = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(2048)]);

describe.skipIf(!hasDatabase)("API keys (spec api-keys)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let admin: Record<string, string>;
  let adminId: string;
  let clerk: Record<string, string>;
  let exec: Record<string, string>;
  const http = () => request(app.getHttpServer());
  const create = (body: Record<string, unknown>) => http().post("/admin/api-keys").set(admin).send(body);
  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    const a = await createUser(db, ["SYS_ADMIN"]);
    adminId = a.id;
    admin = await authed(app, a.email);
    clerk = await authed(app, (await createUser(db, ["AP_CLERK"])).email);
    exec = await authed(app, (await createUser(db, ["FINANCE_EXEC"])).email);
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  describe("Issue API key + storage", () => {
    it("สร้าง key แล้วได้ค่าเต็มครั้งเดียว รายการแสดงเฉพาะ prefix และไม่มีค่าเต็มในฐาน/audit", async () => {
      const r = await create({ name: `เครื่องสแกน ${randomBytes(3).toString("hex")}`, scopes: ["document.upload"], expiresInDays: 90 }).expect(201);
      const key: string = r.body.key;
      expect(key).toMatch(/^sdes_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{40,}$/);
      expect(r.body.apiKey).toMatchObject({ scopes: ["document.upload"], status: "active", prefix: key.split("_")[1] });
      const days = (new Date(r.body.apiKey.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);

      const list = await http().get("/admin/api-keys").set(admin).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(key);
      expect(list.body.find((k: { id: string }) => k.id === r.body.apiKey.id)).toMatchObject({ createdBy: expect.any(String), lastUsedAt: null });

      const row = await db.apiKey.findUniqueOrThrow({ where: { id: r.body.apiKey.id } });
      expect(JSON.stringify(row)).not.toContain(key.split("_")[2]);
      const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "apikey.created", entityId: row.id } });
      expect(ev.actorUserId).toBe(adminId);
      expect(JSON.stringify(ev.details)).not.toContain(key.split("_")[2]);
    });

    it("ค่าเริ่มต้นอายุ 90 วัน; อายุนอกช่วง 1–365 และชื่อซ้ำกับ key ที่ยังใช้ได้ถูกปฏิเสธ", async () => {
      const name = `ซ้ำ ${randomBytes(3).toString("hex")}`;
      const r = await create({ name, scopes: ["document.read"] }).expect(201);
      expect((new Date(r.body.apiKey.expiresAt).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(89.9);
      await create({ name, scopes: ["document.read"] }).expect(409);
      await create({ name: "x", scopes: ["document.read"], expiresInDays: 0 }).expect(400);
      await create({ name: "x", scopes: ["document.read"], expiresInDays: 366 }).expect(400);
    });

    it("ไม่เลือกขอบเขต หรือขอบเขตที่ไม่รู้จัก ถูกปฏิเสธ", async () => {
      const r = await create({ name: "ไม่มีขอบเขต", scopes: [] }).expect(400);
      expect(String(r.body.message)).toContain("อย่างน้อยหนึ่ง");
      await create({ name: "ผิด", scopes: ["user.manage"] }).expect(400);
    });

    it("Clerk และ Exec เรียก API จัดการ key ไม่ได้ (403)", async () => {
      await http().get("/admin/api-keys").set(clerk).expect(403);
      await http().post("/admin/api-keys").set(exec).send({ name: "x", scopes: ["document.read"] }).expect(403);
    });
  });

  describe("Authenticate with API key", () => {
    it("key อ่านสถานะ: อ่านรายการเอกสารได้ อัปโหลด/แก้/งาน admin ไม่ได้ และบันทึกเวลาใช้ล่าสุด", async () => {
      const r = await create({ name: `อ่าน ${randomBytes(3).toString("hex")}`, scopes: ["document.read"] }).expect(201);
      const h = bearer(r.body.key);
      await http().get("/documents").set(h).expect(200);
      await http().post("/documents").set(h).attach("files", PDF(), "a.pdf").expect(403);
      await http().get("/admin/users").set(h).expect(403);
      await http().get("/admin/api-keys").set(h).expect(403);
      await http().get("/audit-events").set(h).expect(403);
      const row = await db.apiKey.findUniqueOrThrow({ where: { id: r.body.apiKey.id } });
      expect(row.lastUsedAt).not.toBeNull();
    });

    it("ใช้ header X-API-Key ได้เช่นกัน", async () => {
      const r = await create({ name: `header ${randomBytes(3).toString("hex")}`, scopes: ["document.read"] }).expect(201);
      await http().get("/documents").set({ "X-API-Key": r.body.key }).expect(200);
    });

    it("key ผิด, key หมดอายุ และ key ที่แก้ค่าแล้ว ได้ 401 ข้อความเดียวกัน", async () => {
      const r = await create({ name: `หมดอายุ ${randomBytes(3).toString("hex")}`, scopes: ["document.read"] }).expect(201);
      await db.apiKey.update({ where: { id: r.body.apiKey.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await http().get("/documents").set(bearer(r.body.key)).expect(401);
      const unknown = await http().get("/documents").set(bearer(`sdes_ZZZZZZZZ_${randomBytes(32).toString("base64url")}`)).expect(401);
      const tampered = await http().get("/documents").set(bearer(r.body.key.slice(0, -2) + "xx")).expect(401);
      expect(expired.body.message).toBe(unknown.body.message);
      expect(tampered.body.message).toBe(unknown.body.message);
    });

    it.skipIf(!uploadStack)("key อัปโหลด: เอกสารถูกสร้างโดยบัญชีของ key และ audit แสดงชื่อ key", async () => {
      const name = `เครื่องสแกนชั้น 3 ${randomBytes(3).toString("hex")}`;
      const r = await create({ name, scopes: ["document.upload"] }).expect(201);
      const up = await http().post("/documents").set(bearer(r.body.key)).attach("files", PDF(), "scan.pdf").expect(201);
      const id = up.body.results[0].id as string;
      const key = await db.apiKey.findUniqueOrThrow({ where: { id: r.body.apiKey.id } });
      expect((await db.document.findUniqueOrThrow({ where: { id } })).uploadedById).toBe(key.serviceUserId);
      const audit = await http().get(`/audit-events?entityId=${id}`).set(exec).expect(200);
      const uploaded = audit.body.items.find((e: { action: string }) => e.action === "document.uploaded");
      expect(uploaded).toMatchObject({ actorName: name, actorKind: "SERVICE" });
    });
  });

  describe("Revoke API key", () => {
    it("เพิกถอนแล้ว key ใช้ไม่ได้ทันที รายการแสดงผู้เพิกถอนและเวลา และมี audit", async () => {
      const r = await create({ name: `รั่ว ${randomBytes(3).toString("hex")}`, scopes: ["document.read"] }).expect(201);
      await http().get("/documents").set(bearer(r.body.key)).expect(200);
      const rv = await http().post(`/admin/api-keys/${r.body.apiKey.id}/revoke`).set(admin).expect(200);
      expect(rv.body).toMatchObject({ status: "revoked", revokedBy: expect.any(String), revokedAt: expect.any(String) });
      await http().get("/documents").set(bearer(r.body.key)).expect(401);
      expect(await db.auditEvent.count({ where: { action: "apikey.revoked", entityId: r.body.apiKey.id, actorUserId: adminId } })).toBe(1);
      // เพิกถอนแล้วตั้งชื่อเดิมใหม่ได้
      await create({ name: r.body.apiKey.name, scopes: ["document.read"] }).expect(201);
    });
  });

  describe("Service accounts (spec user-access)", () => {
    it("บัญชีของ key ล็อกอินด้วยรหัสผ่านไม่ได้ (ข้อความเดียวกับรหัสผิด) และไม่อยู่ในรายการผู้ใช้", async () => {
      const r = await create({ name: `บริการ ${randomBytes(3).toString("hex")}`, scopes: ["document.read"] }).expect(201);
      const key = await db.apiKey.findUniqueOrThrow({ where: { id: r.body.apiKey.id }, include: { serviceUser: true } });
      expect(key.serviceUser.kind).toBe("SERVICE");
      const login = await http().post("/auth/login").send({ email: key.serviceUser.email, password: "anything-at-all-123" }).expect(401);
      expect(login.body.message).toBe("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
      const users = await http().get("/admin/users").set(admin).expect(200);
      expect(users.body.some((u: { id: string }) => u.id === key.serviceUserId)).toBe(false);
      await http().patch(`/admin/users/${key.serviceUserId}/roles`).set(admin).send({ roles: ["SYS_ADMIN"] }).expect(404);
    });
  });
});
