// IP ของผู้ใช้หลัง reverse proxy (spec platform-security "Client IP behind a reverse proxy", phase 4 task 1.3)
// supertest ต่อมาจาก 127.0.0.1 — ใช้แทน Caddy ใน production (TRUST_PROXY เป็น IP เดียวของ proxy ไม่ใช่ทั้ง subnet)
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import Redis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@sdes/db";
import { loadConfig } from "../src/config.js";
import { hasDatabase } from "./test-db.js";
import { bootApp, createUser, ownerDb } from "./helpers.js";

const randomIp = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const saved = { RATE_LIMIT_AUTH: process.env.RATE_LIMIT_AUTH, TRUST_PROXY: process.env.TRUST_PROXY };

async function bootWithProxy(trustProxy: string) {
  process.env.RATE_LIMIT_AUTH = "10";
  process.env.TRUST_PROXY = trustProxy;
  return bootApp();
}

function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe.skipIf(!hasDatabase)("IP จริงหลัง reverse proxy (TRUST_PROXY = IP ของ proxy เท่านั้น)", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerDb();
  });
  afterAll(async () => {
    restoreEnv();
    await db?.$disconnect();
  });

  describe("คำขอมาจาก proxy ที่เชื่อถือได้", () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await bootWithProxy("127.0.0.1");
    });
    afterAll(async () => {
      await app?.close();
    });

    it("ผู้ใช้ปลอม X-Forwarded-For ทุกครั้ง แต่ proxy ต่อ IP จริงท้ายสุด → นับเป็น IP จริง คำขอที่ 11 ได้ 429", async () => {
      const real = randomIp();
      const email = `nobody-${randomUUID()}@test.local`;
      const login = () =>
        request(app.getHttpServer()).post("/auth/login").set("X-Forwarded-For", `${randomIp()}, ${real}`).send({ email, password: "wrong-password" });
      for (let i = 0; i < 10; i++) expect((await login()).status).toBe(401);
      expect((await login()).status).toBe(429);
    });

    it("audit ของการล็อกอินบันทึก IP ของผู้ใช้ ไม่ใช่ IP ของ proxy", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      const real = randomIp();
      await request(app.getHttpServer()).post("/auth/login").set("X-Forwarded-For", real).send({ email: u.email, password: u.password }).expect(200);
      const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "auth.login", entityId: u.id }, orderBy: { occurredAt: "desc" } });
      expect(ev.ip).toBe(real);
    });
  });

  describe("header จากต้นทางที่ไม่ใช่ proxy ที่กำหนด", () => {
    let app: INestApplication;
    beforeAll(async () => {
      // proxy จริงอยู่ที่ IP อื่น — คำขอจาก 127.0.0.1 จึงเป็นผู้ใช้ที่ต่อตรง
      app = await bootWithProxy("172.30.0.10");
      // ไฟล์ทดสอบอื่นล็อกอินจาก 127.0.0.1 ด้วย (เพดานสูง) — ล้างตัวนับของ auth ให้ข้อนี้เริ่มนับจากศูนย์
      const redis = new Redis(loadConfig().redisUrl);
      const keys = await redis.keys("throttle:auth:*");
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    });
    afterAll(async () => {
      await app?.close();
    });

    it("X-Forwarded-For สุ่มทุกครั้งไม่ถูกใช้ → นับเป็น IP ต้นทางเดียว คำขอที่ 11 ได้ 429 และ audit ไม่ใช้ค่าที่ปลอม", async () => {
      const u = await createUser(db, ["AP_CLERK"]);
      const spoofed = randomIp();
      await request(app.getHttpServer()).post("/auth/login").set("X-Forwarded-For", spoofed).send({ email: u.email, password: u.password }).expect(200);
      const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "auth.login", entityId: u.id }, orderBy: { occurredAt: "desc" } });
      expect(ev.ip).not.toBe(spoofed);
      expect(ev.ip).toMatch(/127\.0\.0\.1$/);

      const email = `nobody-${randomUUID()}@test.local`;
      const codes: number[] = [];
      // ล็อกอินสำเร็จด้านบนนับไปแล้ว 1 ครั้ง
      for (let i = 0; i < 10; i++)
        codes.push((await request(app.getHttpServer()).post("/auth/login").set("X-Forwarded-For", randomIp()).send({ email, password: "wrong-password" })).status);
      expect(codes.slice(0, 9).every((c) => c === 401)).toBe(true);
      expect(codes[9]).toBe(429);
    });
  });
});
