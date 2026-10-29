// ตั้งค่า/ทดสอบ/เปิดปิดการเชื่อมต่อ ERP (spec erp-connection, phase 3 task 4.1) — Odoo จำลองด้วย HTTP server
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@sdes/db";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

const KEY = "odoo-api-key-correct-1234";

/** Odoo จำลอง: JSON-2 เฉพาะที่การทดสอบใช้ */
let odoo: Server;
let odooUrl: string;
let odooCalls: { path: string; auth?: string }[] = [];
const records: Record<string, Record<number, Record<string, unknown>>> = {
  "account.journal": { 2: { id: 2, name: "Vendor Bills", type: "purchase" }, 3: { id: 3, name: "Sales", type: "sale" } },
  "account.tax": { 7: { id: 7, name: "ภาษีซื้อ 7%", type_tax_use: "purchase", amount: 7 } },
  "account.account": { 40: { id: 40, name: "ค่าใช้จ่ายทั่วไป" } },
};

describe.skipIf(!hasDatabase)("ERP connection (spec erp-connection)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let admin: Record<string, string>;
  let adminId: string;
  const http = () => request(app.getHttpServer());
  const odooBody = (over: Record<string, unknown> = {}) => ({
    adapter: "odoo",
    url: odooUrl,
    database: "sdes_erp",
    apiMode: "json2",
    journalId: 2,
    purchaseTaxId: 7,
    expenseAccountId: 40,
    secret: KEY,
    ...over,
  });

  beforeAll(async () => {
    odoo = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        odooCalls.push({ path: req.url ?? "", auth: req.headers.authorization });
        const send = (status: number, json: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
        if (req.headers.authorization !== `bearer ${KEY}`) return send(401, { name: "werkzeug.exceptions.Unauthorized", message: "Invalid apikey" });
        const m = /^\/json\/2\/([\w.]+)\/(\w+)$/.exec(req.url ?? "");
        if (!m) return send(404, {});
        const [, model, method] = m;
        if (method === "search_read") return send(200, [{ id: 2 }]);
        if (method === "read") {
          const ids = (JSON.parse(body) as { ids: number[] }).ids;
          return send(200, ids.map((i) => records[model!]?.[i]).filter(Boolean));
        }
        send(400, { message: `ไม่รองรับ ${method}` });
      });
    });
    await new Promise<void>((r) => odoo.listen(0, "127.0.0.1", r));
    odooUrl = `http://127.0.0.1:${(odoo.address() as AddressInfo).port}`;
    app = await bootApp();
    db = ownerDb();
    const a = await createUser(db, ["SYS_ADMIN"]);
    adminId = a.id;
    admin = await authed(app, a.email);
  });

  beforeEach(async () => {
    await db.erpConnection.deleteMany({});
    odooCalls = [];
  });

  afterAll(async () => {
    await db?.erpConnection.deleteMany({});
    await app?.close();
    await db?.$disconnect();
    await new Promise<void>((r) => odoo.close(() => r()));
  });

  it("ตั้งค่า Odoo: บันทึกได้ และคำตอบไม่มี API key", async () => {
    const r = await http().put("/erp/connection").set(admin).send(odooBody()).expect(200);
    expect(r.body).toMatchObject({ configured: true, adapter: "odoo", url: odooUrl, journalId: 2, purchaseTaxId: 7, expenseAccountId: 40, hasSecret: true, autoSync: false });
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    const g = await http().get("/erp/connection").set(admin).expect(200);
    expect(JSON.stringify(g.body)).not.toContain(KEY);
  });

  it("API key ไม่อยู่ในฐานข้อมูลในรูปข้อความเดิม และไม่อยู่ใน audit", async () => {
    await http().put("/erp/connection").set(admin).send(odooBody()).expect(200);
    const row = await db.$queryRaw<{ s: string }[]>`SELECT row_to_json(e)::text AS s FROM erp_connections e`;
    expect(row[0]!.s).not.toContain(KEY);
    expect(Buffer.from(row[0]!.s).toString("hex")).not.toContain(Buffer.from(KEY).toString("hex"));
    const events = await db.auditEvent.findMany({ where: { actorUserId: adminId, entityType: "erp_connection" } });
    expect(events.some((e) => e.action === "erp.secret_changed")).toBe(true);
    expect(JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(KEY);
  });

  it("เว้น secret ว่างตอนแก้ = คงค่าเดิม; ครั้งแรกต้องมี secret", async () => {
    const first = await http().put("/erp/connection").set(admin).send(odooBody({ secret: undefined })).expect(400);
    expect(first.body.field).toBe("secret");
    await http().put("/erp/connection").set(admin).send(odooBody()).expect(200);
    await http().put("/erp/connection").set(admin).send(odooBody({ secret: "", journalId: 2 })).expect(200);
    const t = await http().post("/erp/connection/test").set(admin).expect(200);
    expect(t.body.ok).toBe(true);
  });

  it("URL ไม่ใช่ http(s) ถูกปฏิเสธพร้อมชี้ช่อง URL", async () => {
    const r = await http().put("/erp/connection").set(admin).send(odooBody({ url: "ftp://odoo" })).expect(400);
    expect(r.body).toMatchObject({ field: "url", message: "URL ต้องขึ้นต้นด้วย http:// หรือ https://" });
  });

  it("ทดสอบผ่านทุกข้อ และไม่สร้างข้อมูลใน Odoo", async () => {
    await http().put("/erp/connection").set(admin).send(odooBody()).expect(200);
    const r = await http().post("/erp/connection/test").set(admin).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.checks.map((c: { key: string; ok: boolean }) => [c.key, c.ok])).toEqual([
      ["reach", true],
      ["auth", true],
      ["journal", true],
      ["tax", true],
      ["account", true],
    ]);
    expect(odooCalls.every((c) => /\/(search_read|read)$/.test(c.path))).toBe(true);
    expect((await http().get("/erp/connection").set(admin)).body.testPassed).toBe(true);
  });

  it("API key ผิด: ยืนยันตัวตนไม่ผ่าน และข้อที่เหลือไม่ถูกตรวจ", async () => {
    await http().put("/erp/connection").set(admin).send(odooBody({ secret: "wrong-key-xxxxxxxx" })).expect(200);
    const r = await http().post("/erp/connection/test").set(admin).expect(200);
    const by = Object.fromEntries(r.body.checks.map((c: { key: string; ok: boolean | null }) => [c.key, c.ok]));
    expect(by).toEqual({ reach: true, auth: false, journal: null, tax: null, account: null });
  });

  it("รหัสภาษีไม่มีใน Odoo: เฉพาะข้อภาษีไม่ผ่าน; journal ขายถูกแจ้งว่าไม่ใช่ journal ซื้อ", async () => {
    await http().put("/erp/connection").set(admin).send(odooBody({ purchaseTaxId: 99, journalId: 3 })).expect(200);
    const r = await http().post("/erp/connection/test").set(admin).expect(200);
    const by = Object.fromEntries(r.body.checks.map((c: { key: string; ok: boolean; message: string }) => [c.key, c]));
    expect(by.tax).toMatchObject({ ok: false, message: "ไม่พบรหัสภาษีที่ตั้งไว้" });
    expect(by.journal).toMatchObject({ ok: false, message: "Sales ไม่ใช่ journal ซื้อ" });
    expect(by.account.ok).toBe(true);
  });

  it("Odoo เข้าถึงไม่ได้: ข้อเข้าถึงไม่ผ่าน", async () => {
    await http().put("/erp/connection").set(admin).send(odooBody({ url: "http://127.0.0.1:1" })).expect(200);
    const r = await http().post("/erp/connection/test").set(admin).expect(200);
    expect(r.body.checks[0]).toMatchObject({ key: "reach", ok: false });
  });

  it("เปิดส่งอัตโนมัติก่อนทดสอบถูกปฏิเสธ; ทดสอบแล้วเปิดได้ พร้อม audit ค่าก่อน/หลัง", async () => {
    await http().put("/erp/connection").set(admin).send(odooBody()).expect(200);
    const r = await http().put("/erp/connection/auto-sync").set(admin).send({ enabled: true }).expect(409);
    expect(r.body.message).toBe("ทดสอบการเชื่อมต่อให้ผ่านก่อนเปิดการส่งอัตโนมัติ");
    await http().post("/erp/connection/test").set(admin).expect(200);
    const on = await http().put("/erp/connection/auto-sync").set(admin).send({ enabled: true }).expect(200);
    expect(on.body.autoSync).toBe(true);
    const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "erp.auto_sync_changed", actorUserId: adminId }, orderBy: { id: "desc" } });
    expect(ev.details).toMatchObject({ before: false, after: true });
  });

  it("แก้ URL ขณะเปิดส่งอัตโนมัติ → ปิดอัตโนมัติจนกว่าจะทดสอบผ่านอีกครั้ง", async () => {
    await http().put("/erp/connection").set(admin).send(odooBody()).expect(200);
    await http().post("/erp/connection/test").set(admin).expect(200);
    await http().put("/erp/connection/auto-sync").set(admin).send({ enabled: true }).expect(200);
    const r = await http().put("/erp/connection").set(admin).send(odooBody({ url: `${odooUrl}/`, database: "other" })).expect(200);
    expect(r.body).toMatchObject({ autoSync: false, testPassed: false });
    await http().put("/erp/connection/auto-sync").set(admin).send({ enabled: true }).expect(409);
  });

  it("Finance Exec และ Clerk เข้าถึงการตั้งค่าไม่ได้", async () => {
    for (const role of ["FINANCE_EXEC", "AP_CLERK"] as const) {
      const u = await createUser(db, [role]);
      const h = await authed(app, u.email);
      await http().get("/erp/connection").set(h).expect(403);
      await http().put("/erp/connection").set(h).send(odooBody()).expect(403);
    }
  });
});
