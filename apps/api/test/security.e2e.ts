// ความปลอดภัยระดับแพลตฟอร์ม (spec platform-security, phase 3 tasks 5.1–5.2)
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@sdes/db";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

describe.skipIf(!hasDatabase)("rate limiting (spec platform-security)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());
  const saved = { ...process.env };

  beforeAll(async () => {
    // ค่าตาม spec และใช้ X-Forwarded-For เพื่อให้ทุก test มี IP ของตัวเอง
    process.env.RATE_LIMIT_AUTH = "10";
    process.env.RATE_LIMIT_UPLOAD = "60";
    process.env.TRUST_PROXY = "true";
    app = await bootApp();
    db = ownerDb();
  });

  afterAll(async () => {
    process.env.RATE_LIMIT_AUTH = saved.RATE_LIMIT_AUTH;
    process.env.RATE_LIMIT_UPLOAD = saved.RATE_LIMIT_UPLOAD;
    if (saved.TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
    await app?.close();
    await db?.$disconnect();
  });

  const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  it("ล็อกอินครั้งที่ 11 ภายในนาทีเดียวได้ 429 + Retry-After และไม่ถึงการตรวจรหัสผ่าน", async () => {
    const from = ip();
    const email = `nobody-${randomUUID()}@test.local`;
    for (let i = 0; i < 10; i++) await http().post("/auth/login").set("X-Forwarded-For", from).send({ email, password: "wrong-password" }).expect(401);
    const r = await http().post("/auth/login").set("X-Forwarded-For", from).send({ email, password: "wrong-password" }).expect(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(r.body).toMatchObject({ code: "RATE_LIMITED", message: "ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" });
    const failed = await db.auditEvent.count({ where: { action: "auth.login_failed", details: { path: ["email"], equals: email } } });
    expect(failed).toBe(10);
  });

  it("IP อื่นยังล็อกอินได้ตามปกติ", async () => {
    const u = await createUser(db, ["AP_CLERK"]);
    await http().post("/auth/login").set("X-Forwarded-For", ip()).send({ email: u.email, password: u.password }).expect(200);
  });

  it("refresh ถูกจำกัดต่อ IP เช่นกัน", async () => {
    const from = ip();
    for (let i = 0; i < 10; i++) await http().post("/auth/refresh").set("X-Forwarded-For", from).expect(401);
    await http().post("/auth/refresh").set("X-Forwarded-For", from).expect(429);
  });

  it("อัปโหลดจำกัดต่อผู้ใช้ 60 คำขอต่อนาที", async () => {
    const u = await createUser(db, ["AP_CLERK"]);
    const h = await authed(app, u.email);
    // คำขอว่าง (ไม่มีไฟล์) ผ่าน guard แล้วตอบตามปกติ — นับเฉพาะอัตรา
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await http().post("/documents").set(h).set("X-Forwarded-For", ip())).status);
    expect(codes.slice(0, 60).every((c) => c !== 429)).toBe(true);
    expect(codes[60]).toBe(429);
  });
});

describe.skipIf(!hasDatabase)("security headers ของ API (phase 3 task 5.2)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("ทุกคำตอบมี nosniff, กัน frame, Referrer-Policy และ HSTS", async () => {
    for (const path of ["/health", "/auth/me"]) {
      const r = await request(app.getHttpServer()).get(path);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["strict-transport-security"]).toMatch(/max-age=/);
      expect(r.headers["x-powered-by"]).toBeUndefined();
    }
  });
});

