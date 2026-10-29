import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@sdes/db";
import { AuditService } from "../src/audit/audit.service.js";
import { PRISMA } from "../src/prisma.js";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, login, ownerDb } from "./helpers.js";

describe.skipIf(!hasDatabase)("admin users + audit trail", () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  describe("5.5 User administration", () => {
    it("สร้างผู้ใช้ได้รหัสชั่วคราว ผู้ใช้ใหม่ต้องเปลี่ยนรหัส และ audit ไม่มีรหัสผ่าน", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const h = await authed(app, admin.email);
      const email = `new-${Date.now()}@test.local`;
      const res = await http().post("/admin/users").set(h).send({ email, displayName: "สมชาย ทดสอบ", roles: ["AP_CLERK"] }).expect(201);
      expect(res.body.temporaryPassword).toHaveLength(16);
      const first = await login(app, email, res.body.temporaryPassword);
      expect(first.res.body.user.mustChangePassword).toBe(true);

      const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "user.created", entityId: res.body.user.id } });
      expect(JSON.stringify(ev.details)).not.toContain(res.body.temporaryPassword);
      expect(ev.actorUserId).toBe(admin.id);
    });

    it("ต้องเลือกอย่างน้อยหนึ่ง role และอีเมลห้ามซ้ำ", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const h = await authed(app, admin.email);
      await http().post("/admin/users").set(h).send({ email: "x@test.local", displayName: "x", roles: [] }).expect(400);
      await http().post("/admin/users").set(h).send({ email: admin.email, displayName: "x", roles: ["AP_CLERK"] }).expect(409);
    });

    it("เปลี่ยน role บันทึกค่าก่อน/หลังลง audit", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const u = await createUser(db, ["AP_CLERK"]);
      await http().patch(`/admin/users/${u.id}/roles`).set(await authed(app, admin.email)).send({ roles: ["AP_LEAD"] }).expect(200);
      const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "user.roles_changed", entityId: u.id } });
      expect(ev.details).toEqual({ field: "roles", before: ["AP_CLERK"], after: ["AP_LEAD"] });
    });

    it("ปิดใช้งาน: ต่ออายุ session ไม่ได้ ล็อกอินไม่ได้ และประวัติยังอยู่", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const u = await createUser(db, ["AP_CLERK"]);
      const { cookie } = await login(app, u.email);
      await http().post(`/admin/users/${u.id}/deactivate`).set(await authed(app, admin.email)).expect(200);
      await http().post("/auth/refresh").set("Cookie", cookie!).expect(401);
      expect((await login(app, u.email)).res.status).toBe(401);
      expect(await db.auditEvent.count({ where: { action: "auth.login", entityId: u.id } })).toBeGreaterThan(0);
      await http().post(`/admin/users/${u.id}/activate`).set(await authed(app, admin.email)).expect(200);
      expect((await login(app, u.email)).res.status).toBe(200);
    });

    it("รีเซ็ตรหัสผ่าน: ได้รหัสชั่วคราวใหม่ และ audit ไม่มีรหัสผ่าน", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const u = await createUser(db, ["AP_CLERK"]);
      const res = await http().post(`/admin/users/${u.id}/reset-password`).set(await authed(app, admin.email)).expect(200);
      expect((await login(app, u.email)).res.status).toBe(401);
      expect((await login(app, u.email, res.body.temporaryPassword)).res.body.user.mustChangePassword).toBe(true);
      const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "user.password_reset", entityId: u.id } });
      expect(JSON.stringify(ev.details ?? {})).not.toContain(res.body.temporaryPassword);
    });

    it("ห้ามปิดใช้งานหรือถอด SYS_ADMIN ของ Admin คนสุดท้าย", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const h = await authed(app, admin.email);
      // ทำให้ admin นี้เป็นคนเดียวที่ active ในฐานทดสอบ
      await db.user.updateMany({ where: { id: { not: admin.id }, roles: { some: { role: "SYS_ADMIN" } } }, data: { isActive: false } });
      await http().post(`/admin/users/${admin.id}/deactivate`).set(h).expect(409);
      await http().patch(`/admin/users/${admin.id}/roles`).set(h).send({ roles: ["AP_CLERK"] }).expect(409);
      expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).isActive).toBe(true);
    });

    it("SYS_ADMIN ไม่ได้สิทธิ์งานบัญชี แต่ Clerk จัดการผู้ใช้ไม่ได้", async () => {
      const clerk = await createUser(db, ["AP_CLERK"]);
      await http().post("/admin/users").set(await authed(app, clerk.email)).send({ email: "y@test.local", displayName: "y", roles: ["AP_CLERK"] }).expect(403);
    });
  });

  describe("4.1 Atomic audit", () => {
    it("เขียน audit ไม่สำเร็จ → การกระทำ rollback", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const u = await createUser(db, ["AP_CLERK"]);
      const h = await authed(app, admin.email);
      const spy = vi.spyOn(app.get(AuditService), "recordChanges").mockRejectedValueOnce(new Error("audit down"));
      await http().patch(`/admin/users/${u.id}/roles`).set(h).send({ roles: ["AP_LEAD"] }).expect(500);
      spy.mockRestore();
      const roles = await db.userRole.findMany({ where: { userId: u.id } });
      expect(roles.map((r) => r.role)).toEqual(["AP_CLERK"]);
    });

    it("แอปเชื่อมต่อด้วย sdes_app ซึ่งแก้ audit ไม่ได้", async () => {
      const prisma = app.get<PrismaClient>(PRISMA);
      const [{ current_user }] = await prisma.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
      expect(current_user).toBe("sdes_app");
      await expect(prisma.auditEvent.deleteMany({})).rejects.toThrow();
    });
  });

  describe("4.2 GET /audit-events", () => {
    it("Exec ค้นตามผู้ใช้และช่วงเวลา เรียงใหม่ → เก่า", async () => {
      const exec = await createUser(db, ["FINANCE_EXEC"]);
      const u = await createUser(db, ["AP_CLERK"]);
      await login(app, u.email, "wrong");
      await login(app, u.email);
      const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const res = await http()
        .get("/audit-events")
        .query({ entityId: u.id, from })
        .set(await authed(app, exec.email))
        .expect(200);
      expect(res.body.items.map((i: { action: string }) => i.action)).toEqual(["auth.login", "auth.login_failed"]);
      expect(typeof res.body.items[0].id).toBe("string");
    });

    it("Admin ค้นได้ และมีการแบ่งหน้า", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const h = await authed(app, admin.email);
      const page1 = await http().get("/audit-events").query({ limit: 2 }).set(h).expect(200);
      expect(page1.body.items).toHaveLength(2);
      const page2 = await http().get("/audit-events").query({ limit: 2, before: page1.body.nextBefore }).set(h).expect(200);
      expect(BigInt(page2.body.items[0].id)).toBeLessThan(BigInt(page1.body.items[1].id));
    });

    it("ไม่มี endpoint แก้ไขหรือลบ", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      const h = await authed(app, admin.email);
      await http().put("/audit-events/1").set(h).send({}).expect(404);
      await http().delete("/audit-events/1").set(h).expect(404);
      await http().delete("/audit-events").set(h).expect(404);
    });
  });
});
