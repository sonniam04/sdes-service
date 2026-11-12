// หน้าภาพรวม (spec overview-dashboard, tasks 2.1–2.5 ของ overview-dashboard)
// นาฬิกาของ dashboard ถูกตั้งเป็นวันสุ่มในอดีตไกล (ต่างกันทุกรอบ) เพื่อให้ช่วงเวลาไม่ชนกับข้อมูลของ test อื่นหรือรอบก่อน
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DocumentStatus, PrismaClient } from "@sdes/db";
import { DASHBOARD_CLOCK } from "../src/dashboard/dashboard.service.js";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

const DAY = 86_400_000;
// 12:00 น. เวลาไทยของวันสุ่มระหว่างปี 1975–2004
const NOW = new Date(Date.UTC(1975, 0, 1, 5) + Math.floor(Math.random() * 365 * 30) * DAY);
const thaiDay = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
/** เวลา UTC ของ hh:mm น. เวลาไทย เมื่อ n วันก่อน NOW */
const thaiAt = (daysAgo: number, hh: number, mm = 0) =>
  new Date(Date.parse(`${thaiDay(new Date(NOW.getTime() - daysAgo * DAY))}T00:00:00Z`) + ((hh - 7) * 60 + mm) * 60_000);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

describe.skipIf(!hasDatabase)("dashboard (spec overview-dashboard)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  const h: Record<string, Record<string, string>> = {};
  let uploaderId: string;
  const http = () => request(app.getHttpServer());

  type DocInput = { status: DocumentStatus; createdAt?: Date; updatedAt?: Date; invoiceDate?: string; subtotal?: string; vat?: string; wht?: string; total?: string };
  async function doc(data: DocInput) {
    return db.document.create({
      data: {
        status: data.status,
        sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
        fileName: `${randomUUID()}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: `test/${randomUUID()}`,
        uploadedById: uploaderId,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        invoiceDate: data.invoiceDate ? new Date(`${data.invoiceDate}T00:00:00Z`) : undefined,
        subtotal: data.subtotal,
        vatAmount: data.vat,
        whtAmount: data.wht,
        grandTotal: data.total,
      },
    });
  }
  const history = (documentId: string, toStatus: DocumentStatus, createdAt: Date) =>
    db.documentStatusHistory.create({ data: { documentId, fromStatus: "UPLOADED", toStatus, actorType: "SYSTEM", createdAt } });

  beforeAll(async () => {
    app = await bootApp((b) => b.overrideProvider(DASHBOARD_CLOCK).useValue(() => new Date(NOW)));
    db = ownerDb();
    const roles = { AP_CLERK: ["AP_CLERK"], AP_LEAD: ["AP_LEAD"], FINANCE_EXEC: ["FINANCE_EXEC"], SYS_ADMIN: ["SYS_ADMIN"], LEAD_EXEC: ["AP_LEAD", "FINANCE_EXEC"] } as const;
    for (const [k, r] of Object.entries(roles)) {
      const u = await createUser(db, [...r]);
      if (k === "AP_CLERK") uploaderId = u.id;
      h[k] = await authed(app, u.email);
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const get = (who: string) =>
    http()
      .get("/dashboard")
      .set(h[who]!)
      .expect(200)
      .then((r) => r.body);

  describe("Sections follow existing permissions", () => {
    it("Clerk ได้งานค้าง ปริมาณงาน ตัวชี้วัด แต่ไม่มีการเงินและสุขภาพระบบ", async () => {
      const b = await get("AP_CLERK");
      expect(Object.keys(b).sort()).toEqual(["backlog", "generatedAt", "indicators", "throughput"]);
    });

    it("Admin ได้เฉพาะสุขภาพระบบ พร้อม error และ key ใกล้หมดอายุ", async () => {
      const b = await get("SYS_ADMIN");
      expect(Object.keys(b).sort()).toEqual(["generatedAt", "health"]);
      expect(b.health).toHaveProperty("errors24h");
      expect(b.health).toHaveProperty("expiringKeys");
    });

    it("Exec ได้สุขภาพระบบแต่ไม่มี error และ key", async () => {
      const b = await get("FINANCE_EXEC");
      expect(Object.keys(b).sort()).toEqual(["backlog", "finance", "generatedAt", "health", "indicators", "throughput"]);
      expect(b.health).not.toHaveProperty("errors24h");
      expect(b.health).not.toHaveProperty("expiringKeys");
    });

    it("Lead + Exec ได้ทุกส่วนยกเว้นของ Admin", async () => {
      const b = await get("LEAD_EXEC");
      expect(Object.keys(b).sort()).toEqual(["backlog", "finance", "generatedAt", "health", "indicators", "throughput"]);
      expect(b.health).not.toHaveProperty("errors24h");
    });

    it("API key ได้ 403", async () => {
      const created = await http()
        .post("/admin/api-keys")
        .set(h.SYS_ADMIN!)
        .send({ name: `dash-${randomUUID().slice(0, 8)}`, scopes: ["document.upload", "document.read"], expiresInDays: 30 })
        .expect(201);
      await http().get("/dashboard").set("Authorization", `Bearer ${created.body.key as string}`).expect(403);
    });
  });

  it("Swagger มี /dashboard พร้อมตัวอย่างผลลัพธ์", async () => {
    const doc = await http().get("/docs-json").expect(200);
    const op = doc.body.paths["/dashboard"]?.get;
    expect(op?.responses?.["200"]?.content?.["application/json"]?.schema?.example).toHaveProperty("backlog.waiting.count");
  });

  describe("Work backlog", () => {
    it("จำนวนแต่ละกลุ่มเพิ่มตามเอกสาร และเก่าสุดคือฉบับที่รอนานที่สุด", async () => {
      const before = (await get("AP_LEAD")).backlog;
      const oldest = new Date("1970-01-02T00:00:00Z");
      for (let i = 0; i < 4; i++) await doc({ status: "EXTRACTED", updatedAt: i === 0 ? oldest : undefined });
      await doc({ status: "UPLOADED" });
      await doc({ status: "PROCESSING" });
      await doc({ status: "FAILED" });
      await doc({ status: "PENDING_APPROVAL" });
      await doc({ status: "SYNC_FAILED" });
      const after = (await get("AP_LEAD")).backlog;
      expect(after.waiting.count - before.waiting.count).toBe(4);
      expect(after.reading.count - before.reading.count).toBe(2);
      expect(after.failed.count - before.failed.count).toBe(1);
      expect(after.approval.count - before.approval.count).toBe(1);
      expect(after.syncFailed.count - before.syncFailed.count).toBe(1);
      expect(after.waiting.oldestAt).toBe(oldest.toISOString());
    });
  });

  describe("Throughput", () => {
    it("14 วันเสมอ วันที่ไม่มีงานเป็น 0 และนับตามเวลาไทย", async () => {
      // 00:30 น. เวลาไทยของวันนี้ = 17:30 UTC ของเมื่อวาน
      await doc({ status: "UPLOADED", createdAt: thaiAt(0, 0, 30) });
      await doc({ status: "UPLOADED", createdAt: thaiAt(0, 11, 50) });
      await doc({ status: "UPLOADED", createdAt: thaiAt(3, 10) });
      // ก่อนช่วง 14 วัน — ต้องไม่ถูกนับ
      await doc({ status: "UPLOADED", createdAt: thaiAt(14, 10) });
      const days = (await get("AP_CLERK")).throughput.days as { date: string; uploaded: number; verified: number; synced: number }[];
      expect(days).toHaveLength(14);
      expect(days.at(-1)!.date).toBe(thaiDay(NOW));
      expect(days[0]!.date).toBe(thaiDay(new Date(NOW.getTime() - 13 * DAY)));
      expect(days.at(-1)!.uploaded).toBe(2);
      expect(days.at(-4)!.uploaded).toBe(1);
      expect(days.at(-2)).toMatchObject({ uploaded: 0, verified: 0, synced: 0 });
    });

    it("ตรวจแล้ว/ส่งแล้วนับครั้งแรกที่เข้าสถานะเท่านั้น", async () => {
      const d1 = await doc({ status: "SYNCED", createdAt: thaiAt(20, 9) });
      await history(d1.id, "VERIFIED", thaiAt(2, 9));
      await history(d1.id, "SYNCED", thaiAt(2, 9, 1));
      // เข้า VERIFIED ก่อนช่วง แล้วมีแถว VERIFIED ซ้ำในช่วง — ไม่นับ
      const d2 = await doc({ status: "VERIFIED", createdAt: thaiAt(30, 9) });
      await history(d2.id, "VERIFIED", thaiAt(25, 9));
      await history(d2.id, "VERIFIED", thaiAt(2, 10));
      const days = (await get("AP_CLERK")).throughput.days as { verified: number; synced: number }[];
      expect(days.at(-3)).toMatchObject({ verified: 1, synced: 1 });
    });
  });

  describe("BRD indicators", () => {
    it("ค่าเฉลี่ยและสัดส่วนของ 7 วันล่าสุด พร้อมเป้า", async () => {
      // อัปโหลด 7 วันก่อน — นอกช่วง 7 วัน (วันนี้ + 6 วันก่อนหน้า)
      const out = await doc({ status: "EXTRACTED", createdAt: thaiAt(7, 9) });
      await history(out.id, "EXTRACTED", plus(thaiAt(7, 9), 500_000));
      const a = await doc({ status: "VERIFIED", createdAt: thaiAt(1, 9) });
      await history(a.id, "EXTRACTED", plus(thaiAt(1, 9), 40_000));
      await history(a.id, "VERIFIED", plus(thaiAt(1, 9), 100_000));
      const b = await doc({ status: "PENDING_APPROVAL", createdAt: thaiAt(1, 10) });
      await history(b.id, "EXTRACTED", plus(thaiAt(1, 10), 20_000));
      await history(b.id, "VERIFIED", plus(thaiAt(1, 10), 60_000));
      await history(b.id, "PENDING_APPROVAL", plus(thaiAt(1, 10), 61_000));
      await db.auditEvent.create({
        data: { actorType: "USER", actorUserId: uploaderId, action: "document.field_edited", entityType: "document", entityId: b.id, details: { field: "header.grandTotal" } },
      });
      const ind = (await get("AP_CLERK")).indicators;
      expect(ind.windowDays).toBe(7);
      expect(ind.targets).toEqual({ seconds: 30, noEditRate: 0.92 });
      // เอกสารอื่นที่อัปโหลดในช่วง (จาก test ก่อนหน้า) ไม่มีประวัติ จึงไม่กระทบค่าเฉลี่ยและสัดส่วน
      expect(ind.avgSecondsToExtracted).toBe(30);
      expect(ind.noEditRate).toBe(0.5);
      expect(ind.approvalRate).toBe(0.5);
    });

    it("ยังไม่มีเอกสารยืนยันในช่วง → null ไม่ใช่ 0", async () => {
      const empty = new Date(NOW.getTime() - 400 * DAY);
      const other = await bootApp((b) => b.overrideProvider(DASHBOARD_CLOCK).useValue(() => new Date(empty)));
      try {
        const r = await request(other.getHttpServer()).get("/dashboard").set(h.AP_CLERK!).expect(200);
        expect(r.body.indicators).toMatchObject({ avgSecondsToExtracted: null, noEditRate: null, approvalRate: null });
      } finally {
        await other.close();
      }
    });
  });

  describe("Finance snapshot", () => {
    it("ยอดเดือนนี้เท่ากับ /reports/summary ของเดือนเดียวกัน และเดือนก่อนเป็น 0 ได้", async () => {
      const month = thaiDay(NOW).slice(0, 7);
      await doc({ status: "SYNCED", invoiceDate: `${month}-01`, subtotal: "1000.10", vat: "70.01", wht: "30.00", total: "1040.11" });
      await doc({ status: "VERIFIED", invoiceDate: `${month}-02`, subtotal: "200.00", vat: "14.00", total: "214.00" });
      await doc({ status: "REJECTED", invoiceDate: `${month}-02`, subtotal: "999.00", vat: "69.93", total: "1068.93" });
      const f = (await get("FINANCE_EXEC")).finance;
      expect(f.month).toBe(month);
      const report = await http().get(`/reports/summary?from=${month}&to=${month}`).set(h.FINANCE_EXEC!).expect(200);
      expect(f.current).toEqual(report.body.totals);
      expect(f.current.grandTotal).toBe("1254.11");
      expect(f.previous).toEqual({ documentCount: 0, subtotal: "0.00", vat: "0.00", wht: "0.00", grandTotal: "0.00" });
    });
  });

  describe("System health", () => {
    it("นับ error เฉพาะ 24 ชั่วโมงล่าสุด และ key ใกล้หมดอายุเฉพาะที่ยังใช้ได้", async () => {
      const ago = (ms: number) => new Date(NOW.getTime() - ms);
      await db.systemLog.createMany({
        data: [
          { service: "api", level: "error", message: "e1", createdAt: ago(3600_000) },
          { service: "worker", level: "error", message: "e2", createdAt: ago(60_000) },
          { service: "api", level: "error", message: "e3", createdAt: ago(23 * 3600_000) },
          { service: "api", level: "warn", message: "w", createdAt: ago(60_000) },
          { service: "api", level: "error", message: "old", createdAt: ago(25 * 3600_000) },
        ],
      });
      const creator = await createUser(db, ["SYS_ADMIN"]);
      const key = async (name: string, expiresAt: Date, revoked = false) => {
        const svc = await db.user.create({ data: { email: `svc-${randomUUID()}@test.local`, displayName: name, kind: "SERVICE" } });
        return db.apiKey.create({
          data: {
            serviceUserId: svc.id,
            name,
            prefix: randomBytes(4).toString("hex"),
            keyHash: "0".repeat(64),
            scopes: ["document.read"],
            expiresAt,
            createdById: creator.id,
            revokedAt: revoked ? NOW : null,
          },
        });
      };
      await key("soon", plus(NOW, 5 * DAY));
      await key("revoked", plus(NOW, 3 * DAY), true);
      await key("expired", plus(NOW, -DAY));
      await key("later", plus(NOW, 20 * DAY));
      const health = (await get("SYS_ADMIN")).health;
      expect(health.errors24h).toBe(3);
      expect(health.expiringKeys.map((k: { name: string }) => k.name)).toEqual(["soon"]);
      expect(health).toMatchObject({
        queues: { extract: expect.any(Number), sync: expect.any(Number) },
        syncFailed: expect.any(Number),
        connected: expect.any(Boolean),
        autoSync: expect.any(Boolean),
      });
    });
  });
});
