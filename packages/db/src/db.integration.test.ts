// integration test กับ PostgreSQL จริง (dev: docker compose, CI: service container ที่ migrate แล้ว)
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDatabase, ownerUrl } from "./test-env.js";
import { createPrisma, seed, type PrismaClient } from "./index.js";

describe.skipIf(!hasDatabase)("database (integration)", () => {
  let pg: Client;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = new Client({ connectionString: ownerUrl() });
    await pg.connect();
    prisma = createPrisma(ownerUrl());
  });

  afterAll(async () => {
    await pg?.end();
    await prisma?.$disconnect();
  });

  /** รันคำสั่งในฐานะ role แอป (sdes_app) ภายใน transaction ที่ rollback เสมอ */
  async function asApp(sql: string, params: unknown[] = []) {
    await pg.query("BEGIN");
    try {
      await pg.query("SET LOCAL ROLE sdes_app");
      return await pg.query(sql, params);
    } finally {
      await pg.query("ROLLBACK");
    }
  }

  async function insertAudit() {
    const r = await pg.query(
      "INSERT INTO audit_events (actor_type, action, entity_type, entity_id) VALUES ('SYSTEM', 'test.event', 'test', $1) RETURNING id",
      [randomUUID()],
    );
    return r.rows[0].id as string;
  }

  describe("audit_events แก้ไข/ลบไม่ได้ (2.2)", () => {
    it("sdes_app เพิ่ม audit event ได้", async () => {
      const r = await asApp(
        "INSERT INTO audit_events (actor_type, action, entity_type) VALUES ('SYSTEM', 'test.insert', 'test') RETURNING id",
      );
      expect(r.rowCount).toBe(1);
    });

    it.each(["UPDATE audit_events SET action = 'tampered' WHERE id = $1", "DELETE FROM audit_events WHERE id = $1"])(
      "sdes_app ถูกปฏิเสธ: %s",
      async (sql) => {
        const id = await insertAudit();
        await expect(asApp(sql, [id])).rejects.toThrow(/permission denied/);
      },
    );

    it("sdes_app TRUNCATE ไม่ได้", async () => {
      await expect(asApp("TRUNCATE audit_events")).rejects.toThrow(/permission denied/);
    });

    it("แม้แต่ owner ก็ UPDATE/DELETE ไม่ได้ เพราะ trigger", async () => {
      const id = await insertAudit();
      await expect(pg.query("UPDATE audit_events SET action = 'x' WHERE id = $1", [id])).rejects.toThrow(/append-only/);
      await expect(pg.query("DELETE FROM audit_events WHERE id = $1", [id])).rejects.toThrow(/append-only/);
      const still = await pg.query("SELECT action FROM audit_events WHERE id = $1", [id]);
      expect(still.rows[0].action).toBe("test.event");
    });
  });

  describe("schema guards", () => {
    it("เลขเอกสารมาจาก sequence รูปแบบ DOC-000000", async () => {
      const r = await pg.query("SELECT ('DOC-' || lpad(nextval('document_no_seq')::text, 6, '0')) AS n");
      expect(r.rows[0].n).toMatch(/^DOC-\d{6,}$/);
    });

    it("มี partial unique index กันไฟล์ซ้ำที่ไม่ใช่ FAILED", async () => {
      const r = await pg.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'documents_sha256_active_key'");
      expect(r.rows[0].indexdef).toMatch(/WHERE \(status <> 'FAILED'/);
    });

    it("sdes_app แตะตาราง _prisma_migrations ไม่ได้", async () => {
      await expect(asApp("SELECT 1 FROM _prisma_migrations LIMIT 1")).rejects.toThrow(/permission denied/);
    });
  });

  describe("seed (2.3)", () => {
    it("รันซ้ำได้โดยไม่สร้างข้อมูลซ้ำ", async () => {
      const email = `seed-${randomUUID()}@test.local`;
      const opts = { adminEmail: email, adminPassword: "temporary-pass-123" };
      const first = await seed(prisma, opts);
      const second = await seed(prisma, opts);
      expect(first.adminCreated).toBe(true);
      expect(second).toEqual({ adminCreated: false, settingsCreated: [] });

      const users = await prisma.user.findMany({ where: { email }, include: { roles: true } });
      expect(users).toHaveLength(1);
      expect(users[0]!.roles.map((r) => r.role)).toEqual(["SYS_ADMIN"]);
      expect(users[0]!.mustChangePassword).toBe(true);
      expect(users[0]!.passwordHash).toMatch(/^\$argon2id\$/);

      const threshold = await prisma.setting.findUnique({ where: { key: "risk.confidence_threshold" } });
      expect(threshold?.value).toBe(0.85);
    });

    it("ไม่เขียนทับค่าที่ Admin แก้แล้ว", async () => {
      await prisma.setting.update({ where: { key: "risk.confidence_threshold" }, data: { value: 0.9 } });
      try {
        await seed(prisma, { adminEmail: `seed-${randomUUID()}@test.local`, adminPassword: "temporary-pass-123" });
        const s = await prisma.setting.findUnique({ where: { key: "risk.confidence_threshold" } });
        expect(s?.value).toBe(0.9);
      } finally {
        await prisma.setting.update({ where: { key: "risk.confidence_threshold" }, data: { value: 0.85 } });
      }
    });

    it("ปฏิเสธรหัสผ่านสั้นเกิน", async () => {
      await expect(seed(prisma, { adminEmail: "x@test.local", adminPassword: "short" })).rejects.toThrow(/12/);
    });
  });
});
