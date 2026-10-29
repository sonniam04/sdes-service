import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@sdes/db";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, login, ownerDb, PASSWORD } from "./helpers.js";

describe.skipIf(!hasDatabase)("auth (spec user-access)", () => {
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

  describe("5.1 Password sign-in + brute-force protection", () => {
    it("ล็อกอินสำเร็จ: ได้ access token + refresh cookie HttpOnly และมี audit", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      const { res, cookie } = await login(app, u.email.toUpperCase());
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: u.email, roles: ["AP_CLERK"], mustChangePassword: false });
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/auth/);
      expect(await db.auditEvent.count({ where: { action: "auth.login", entityId: u.id } })).toBe(1);
    });

    it("รหัสผิดและอีเมลที่ไม่มีอยู่ได้ข้อความเดียวกัน", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      const wrong = await login(app, u.email, "wrong-password");
      const unknown = await login(app, "nobody@test.local", "wrong-password");
      expect(wrong.res.status).toBe(401);
      expect(unknown.res.status).toBe(401);
      expect(wrong.res.body.message).toBe("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
      expect(unknown.res.body.message).toBe(wrong.res.body.message);
    });

    it("บัญชีที่ถูกปิดใช้งานล็อกอินไม่ได้แม้รหัสถูก", async () => {
      const u = await createUser(db, ["AP_CLERK"], { isActive: false });
      expect((await login(app, u.email)).res.status).toBe(401);
    });

    it("ผิด 5 ครั้งติด → ล็อก 15 นาที แม้รหัสถูก และบันทึก audit", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      for (let i = 0; i < 5; i++) expect((await login(app, u.email, "wrong")).res.status).toBe(401);
      const locked = await login(app, u.email);
      expect(locked.res.status).toBe(423);
      const row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
      const minutes = (row.lockedUntil!.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15);
      expect(await db.auditEvent.count({ where: { action: "auth.locked", entityId: u.id } })).toBe(1);
    });
  });

  describe("5.2 Session lifetime", () => {
    it("access token อายุ 15 นาที และ refresh cookie อายุไม่เกิน 8 ชั่วโมง", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      const { token, cookie } = await login(app, u.email);
      const claims = JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString());
      expect(claims.exp - claims.iat).toBe(15 * 60);
      const expires = new Date(/Expires=([^;]+)/.exec(cookie!)![1]!).getTime();
      expect((expires - Date.now()) / 3_600_000).toBeLessThanOrEqual(8);
    });

    it("refresh ได้ access token ใหม่โดยไม่ต้องล็อกอินซ้ำ", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      const { cookie } = await login(app, u.email);
      const r = await http().post("/auth/refresh").set("Cookie", cookie!).expect(200);
      expect(r.body.accessToken).toBeTruthy();
      await http().get("/auth/me").set("Authorization", `Bearer ${r.body.accessToken}`).expect(200);
    });

    it("ใช้ refresh token ซ้ำ → ปฏิเสธ และยกเลิกทั้งชุด (token ใหม่ใช้ไม่ได้ด้วย)", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      const { cookie } = await login(app, u.email);
      const first = await http().post("/auth/refresh").set("Cookie", cookie!).expect(200);
      const rotated = ([] as string[]).concat(first.headers["set-cookie"]).find((c) => c.startsWith("sdes_rt="))!;
      await http().post("/auth/refresh").set("Cookie", cookie!).expect(401);
      await http().post("/auth/refresh").set("Cookie", rotated).expect(401);
      expect(await db.auditEvent.count({ where: { action: "auth.refresh_reuse_detected", entityId: u.id } })).toBe(1);
    });

    it("ล็อกเอาต์แล้ว refresh token เดิมใช้ไม่ได้", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      const { cookie } = await login(app, u.email);
      await http().post("/auth/logout").set("Cookie", cookie!).expect(204);
      await http().post("/auth/refresh").set("Cookie", cookie!).expect(401);
    });

    it("ไม่มี token → 401", async () => {
      await http().get("/auth/me").expect(401);
      await http().get("/auth/me").set("Authorization", "Bearer not-a-jwt").expect(401);
    });
  });

  describe("5.3 Temporary password change", () => {
    it("รหัสชั่วคราว: คำขออื่นได้ 403 จนกว่าจะเปลี่ยนรหัส", async () => {
      const u = await createUser(db, ["SYS_ADMIN"], { mustChangePassword: true });
      const headers = await authed(app, u.email);
      const blocked = await http().get("/admin/users").set(headers).expect(403);
      expect(blocked.body.code).toBe("password_change_required");
      await http().get("/auth/me").set(headers).expect(200);

      await http().post("/auth/change-password").set(headers).send({ currentPassword: PASSWORD, newPassword: "short" }).expect(400);
      const changed = await http()
        .post("/auth/change-password")
        .set(headers)
        .send({ currentPassword: PASSWORD, newPassword: "a-brand-new-password-2569" })
        .expect(200);
      await http().get("/admin/users").set("Authorization", `Bearer ${changed.body.accessToken}`).expect(200);
      expect((await login(app, u.email, "a-brand-new-password-2569")).res.body.user.mustChangePassword).toBe(false);
    });
  });

  describe("5.4 Permission guard", () => {
    it.each([
      [["AP_CLERK"], "/admin/users"],
      [["FINANCE_EXEC"], "/admin/users"],
      [["AP_LEAD"], "/audit-events"],
      [["AP_CLERK"], "/audit-events"],
    ] as const)("%s เรียก %s ได้ 403", async (roles, path) => {
      const u = await createUser(db, [...roles]);
      await http().get(path).set(await authed(app, u.email)).expect(403);
    });

    it("ผู้ใช้หลาย role ได้สิทธิ์รวม", async () => {
      const u = await createUser(db, ["AP_CLERK", "FINANCE_EXEC"]);
      await http().get("/audit-events").set(await authed(app, u.email)).expect(200);
    });
  });
});
