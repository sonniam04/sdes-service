// System logs: เก็บผ่าน DbLogger ลงฐานจริง, ลบเก่ากว่า 30 วัน และค้นผ่าน API (spec system-logs, tasks 3.2–3.3)
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbLogger, SystemLogSink, createPrisma, purgeSystemLogs, type PrismaClient } from "@sdes/db";
import { hasDatabase, urls } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

describe.skipIf(!hasDatabase)("system logs (spec system-logs)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let appDb: PrismaClient;
  let admin: Record<string, string>;
  let exec: Record<string, string>;
  const http = () => request(app.getHttpServer());
  const tag = randomBytes(4).toString("hex");

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    // worker เขียนด้วยบัญชีแอป (sdes_app) เหมือนตอนรันจริง
    appDb = createPrisma(urls!.app);
    admin = await authed(app, (await createUser(db, ["SYS_ADMIN"])).email);
    exec = await authed(app, (await createUser(db, ["FINANCE_EXEC"])).email);
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    await appDb?.$disconnect();
  });

  it("error ของ worker ค้นเจอผ่าน API ภายใน 10 วินาที พร้อม service = worker และเลขเอกสาร", async () => {
    const sink = new SystemLogSink(appDb, "worker", { flushMs: 500 });
    sink.start();
    const logger = new DbLogger(sink);
    const started = Date.now();
    logger.error(`อ่านเอกสาร DOC-${tag} ไม่สำเร็จ: PDF ล็อกรหัสผ่าน`, "ExtractWorker");
    let found: { service: string; level: string; context: string; message: string } | undefined;
    while (!found && Date.now() - started < 10_000) {
      const r = await http().get(`/admin/system-logs?q=${tag}&service=worker&level=error`).set(admin).expect(200);
      found = r.body.items[0];
      if (!found) await new Promise((res) => setTimeout(res, 300));
    }
    await sink.stop();
    expect(found).toMatchObject({ service: "worker", level: "error", context: "ExtractWorker" });
    expect(found!.message).toContain(`DOC-${tag}`);
  });

  it("ตัวกรองเวลา/ระดับ/บริการ/ข้อความ เรียงใหม่ไปเก่าแบบแบ่งหน้า", async () => {
    const base = Date.now() - 3_600_000;
    await db.systemLog.createMany({
      data: [
        { service: "api", level: "warn", context: "A", message: `f-${tag} 1`, createdAt: new Date(base) },
        { service: "api", level: "error", context: "A", message: `f-${tag} 2`, createdAt: new Date(base + 1000) },
        { service: "worker", level: "error", context: "W", message: `f-${tag} 3`, createdAt: new Date(base + 2000) },
        { service: "api", level: "error", context: "A", message: `f-${tag} 4`, createdAt: new Date(base + 3000) },
      ],
    });
    const errors = await http().get(`/admin/system-logs?q=f-${tag}&level=error&service=api`).set(admin).expect(200);
    expect(errors.body.items.map((i: { message: string }) => i.message)).toEqual([`f-${tag} 4`, `f-${tag} 2`]);

    const p1 = await http().get(`/admin/system-logs?q=f-${tag}&limit=2`).set(admin).expect(200);
    expect(p1.body.items.map((i: { message: string }) => i.message)).toEqual([`f-${tag} 4`, `f-${tag} 3`]);
    const p2 = await http().get(`/admin/system-logs?q=f-${tag}&limit=2&before=${p1.body.nextBefore}`).set(admin).expect(200);
    expect(p2.body.items.map((i: { message: string }) => i.message)).toEqual([`f-${tag} 2`, `f-${tag} 1`]);

    const ranged = await http()
      .get(`/admin/system-logs?q=f-${tag}&from=${new Date(base + 500).toISOString()}&to=${new Date(base + 2500).toISOString()}`)
      .set(admin)
      .expect(200);
    expect(ranged.body.items).toHaveLength(2);
    await http().get("/admin/system-logs?level=info").set(admin).expect(400);
  });

  it("Finance Exec เรียก API system logs ได้ 403", async () => {
    await http().get("/admin/system-logs").set(exec).expect(403);
  });

  it("ลบ log เก่ากว่า 30 วัน และเก็บ log ที่ใหม่กว่าไว้", async () => {
    const now = new Date();
    const old = await db.systemLog.create({ data: { service: "api", level: "warn", message: `old-${tag}`, createdAt: new Date(now.getTime() - 31 * 86_400_000) } });
    const recent = await db.systemLog.create({ data: { service: "api", level: "warn", message: `recent-${tag}`, createdAt: new Date(now.getTime() - 29 * 86_400_000) } });
    await purgeSystemLogs(appDb, 30, now);
    expect(await db.systemLog.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.systemLog.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});
