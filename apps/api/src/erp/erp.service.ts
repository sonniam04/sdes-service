// ตั้งค่า ทดสอบ และเปิด/ปิดการเชื่อมต่อ ERP (spec erp-connection, design D5)
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { SyncError, createOdooClient, signWebhook, type OdooClient } from "@sdes/core";
import {
  ERP_CONNECTION_ID,
  Prisma,
  SecretKeyError,
  encryptSecret,
  loadErpConnection,
  loadErpConnectionWithSecret,
  loadSecretKey,
  type ErpConnection,
  type PrismaClient,
} from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import type { Principal } from "../auth/decorators.js";
import { QueueService } from "../documents/queue.service.js";
import { PRISMA } from "../prisma.js";

const url = z
  .string()
  .trim()
  .refine((v) => /^https?:\/\/[^\s/]+/.test(v), "URL ต้องขึ้นต้นด้วย http:// หรือ https://")
  .transform((v) => v.replace(/\/+$/, ""));
const id = (label: string) => z.number({ error: `ต้องระบุ${label}` }).int(`${label}ต้องเป็นตัวเลข`).positive(`${label}ต้องเป็นตัวเลขที่มากกว่า 0`);
const secret = z.string().max(500).nullish();

const OdooBody = z
  .object({
    adapter: z.literal("odoo"),
    url,
    database: z.string().trim().max(100).nullish(),
    apiMode: z.enum(["json2", "jsonrpc"]).default("json2"),
    login: z.string().trim().max(200).nullish(),
    journalId: id("journal ซื้อ"),
    purchaseTaxId: id("รหัสภาษีซื้อ"),
    expenseAccountId: id("บัญชีค่าใช้จ่าย"),
    secret,
  })
  .superRefine((v, ctx) => {
    if (v.apiMode === "jsonrpc" && !v.login) ctx.addIssue({ code: "custom", path: ["login"], message: "โหมด JSON-RPC ต้องระบุชื่อผู้ใช้" });
    if (v.apiMode === "jsonrpc" && !v.database) ctx.addIssue({ code: "custom", path: ["database"], message: "โหมด JSON-RPC ต้องระบุฐานข้อมูล" });
  });
const WebhookBody = z.object({ adapter: z.literal("webhook"), url, secret });
export const ConnectionBody = z.discriminatedUnion("adapter", [OdooBody, WebhookBody], { error: "ชนิดการเชื่อมต่อต้องเป็น odoo หรือ webhook" });

export type ConnectionCheck = { key: "reach" | "auth" | "journal" | "tax" | "account"; label: string; ok: boolean | null; message: string };

/** มุมมองที่ส่งกลับให้หน้าเว็บ — ไม่มี secret (spec "Secret protection") */
function view(c: ErpConnection | null) {
  if (!c) return { configured: false as const, autoSync: false };
  return {
    configured: true as const,
    adapter: c.adapter,
    url: c.url,
    database: c.database,
    ...c.config,
    hasSecret: c.hasSecret,
    autoSync: c.autoSync,
    testedAt: c.testedAt,
    testPassed: c.testedHash !== null && c.testedHash === c.currentHash,
  };
}

const LABEL: Record<ConnectionCheck["key"], string> = {
  reach: "เข้าถึงปลายทาง",
  auth: "ยืนยันตัวตนด้วย API key",
  journal: "Journal ซื้อ",
  tax: "ภาษีซื้อ 7%",
  account: "บัญชีค่าใช้จ่าย",
};

@Injectable()
export class ErpService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async get() {
    return view(await loadErpConnection(this.prisma));
  }

  async save(body: unknown, user: Principal, ip?: string) {
    const parsed = ConnectionBody.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestException({ message: issue?.message ?? "ข้อมูลไม่ถูกต้อง", field: issue?.path.join(".") ?? null, issues: parsed.error.issues });
    }
    const v = parsed.data;
    const before = await loadErpConnection(this.prisma);
    if (!before?.hasSecret && !v.secret)
      throw new BadRequestException({ message: v.adapter === "odoo" ? "ต้องระบุ API key ของ Odoo" : "ต้องระบุ secret ของ webhook", field: "secret" });

    const config = v.adapter === "odoo"
      ? { apiMode: v.apiMode, login: v.login ?? null, journalId: v.journalId, purchaseTaxId: v.purchaseTaxId, expenseAccountId: v.expenseAccountId }
      : {};
    const enc = v.secret ? encryptSecret(v.secret, this.key()) : null;
    const data = {
      adapter: v.adapter,
      url: v.url,
      database: v.adapter === "odoo" ? (v.database || null) : null,
      config: config as Prisma.InputJsonValue,
      ...(enc ? { secretCiphertext: new Uint8Array(enc.ciphertext), secretIv: new Uint8Array(enc.iv), secretTag: new Uint8Array(enc.tag) } : {}),
      updatedById: user.userId,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.erpConnection.upsert({ where: { id: ERP_CONNECTION_ID }, create: { id: ERP_CONNECTION_ID, ...data }, update: data });
      const after = (await loadErpConnection(tx))!;
      const actor = { kind: "user" as const, userId: user.userId };
      const fields: [string, unknown, unknown][] = [
        ["adapter", before?.adapter ?? null, after.adapter],
        ["url", before?.url ?? null, after.url],
        ["database", before?.database ?? null, after.database],
        ["config", before?.config ?? null, after.config],
      ];
      for (const [field, b, a] of fields)
        if (JSON.stringify(b) !== JSON.stringify(a))
          await this.audit.record(tx, { actor, action: "erp.connection_updated", entityType: "erp_connection", ip, details: { field, before: b, after: a } });
      // บันทึกแค่ว่าเปลี่ยน — ไม่มีค่าเก่า/ใหม่ของ secret (spec "Secret protection")
      if (enc) await this.audit.record(tx, { actor, action: "erp.secret_changed", entityType: "erp_connection", ip, details: { field: "secret" } });
      // แก้การตั้งค่าใด ๆ = ต้องทดสอบใหม่ก่อนส่งอัตโนมัติ (spec "Automatic sync switch")
      if (after.autoSync && after.testedHash !== after.currentHash) {
        await tx.erpConnection.update({ where: { id: ERP_CONNECTION_ID }, data: { autoSync: false } });
        await this.audit.record(tx, { actor, action: "erp.auto_sync_changed", entityType: "erp_connection", ip, details: { field: "autoSync", before: true, after: false, reason: "แก้การตั้งค่าการเชื่อมต่อ" } });
      }
    });
    return this.get();
  }

  /** ทดสอบแบบอ่านอย่างเดียว ไม่สร้างข้อมูลใน ERP (spec "Connection test") */
  async test(user: Principal, ip?: string) {
    const conn = await loadErpConnectionWithSecret(this.prisma, () => this.key());
    if (!conn) throw new BadRequestException({ message: "ยังไม่ได้ตั้งค่าการเชื่อมต่อ ERP" });
    const checks = conn.adapter === "odoo" ? await this.testOdoo(conn) : await this.testWebhook(conn);
    const ok = checks.every((c) => c.ok === true);
    await this.prisma.$transaction(async (tx) => {
      if (ok) await tx.erpConnection.update({ where: { id: ERP_CONNECTION_ID }, data: { testedAt: new Date(), testedHash: conn.currentHash } });
      await this.audit.record(tx, {
        actor: { kind: "user", userId: user.userId },
        action: "erp.connection_tested",
        entityType: "erp_connection",
        ip,
        details: { ok, checks: checks.map((c) => ({ key: c.key, ok: c.ok })) },
      });
    });
    return { ok, checks };
  }

  async setAutoSync(enabled: boolean, user: Principal, ip?: string) {
    const conn = await loadErpConnection(this.prisma);
    if (enabled && (!conn || conn.testedHash !== conn.currentHash))
      throw new ConflictException({ code: "NOT_TESTED", message: "ทดสอบการเชื่อมต่อให้ผ่านก่อนเปิดการส่งอัตโนมัติ" });
    if (!conn) return this.get();
    if (conn.autoSync !== enabled) {
      await this.prisma.$transaction(async (tx) => {
        await tx.erpConnection.update({ where: { id: ERP_CONNECTION_ID }, data: { autoSync: enabled } });
        await this.audit.record(tx, {
          actor: { kind: "user", userId: user.userId },
          action: "erp.auto_sync_changed",
          entityType: "erp_connection",
          ip,
          details: { field: "autoSync", before: conn.autoSync, after: enabled },
        });
      });
    }
    if (enabled) {
      // เอกสารที่รออยู่ระหว่างปิด ถูกส่งเมื่อเปิด (spec erp-sync "When documents are sent")
      const ready = await this.prisma.document.findMany({ where: { status: { in: ["VERIFIED", "APPROVED"] } }, select: { id: true }, take: 1000 });
      await this.queue.enqueueSync(ready.map((d) => d.id)).catch(() => {});
    }
    return this.get();
  }

  private key() {
    try {
      return loadSecretKey();
    } catch (e) {
      if (e instanceof SecretKeyError) throw new BadRequestException({ message: e.message });
      throw e;
    }
  }

  private async testOdoo(conn: ErpConnection & { secret: string | null }): Promise<ConnectionCheck[]> {
    const checks: ConnectionCheck[] = (["reach", "auth", "journal", "tax", "account"] as const).map((key) => ({ key, label: LABEL[key], ok: null, message: "ไม่ได้ตรวจ" }));
    const set = (key: ConnectionCheck["key"], ok: boolean, message: string) => Object.assign(checks.find((c) => c.key === key)!, { ok, message });
    let client: OdooClient;
    try {
      client = createOdooClient({ url: conn.url, database: conn.database, apiMode: conn.config.apiMode ?? "json2", login: conn.config.login, apiKey: conn.secret ?? "", timeoutMs: 15_000 });
      await client.searchRead("res.users", [["share", "=", false]], ["id"], 1);
      set("reach", true, "เข้าถึงได้");
      set("auth", true, "ยืนยันตัวตนผ่าน");
    } catch (e) {
      const err = e instanceof SyncError ? e : null;
      if (err?.code === "network" || err?.code === "unavailable") set("reach", false, err.message);
      else {
        set("reach", true, "เข้าถึงได้");
        set("auth", false, err?.message ?? "ยืนยันตัวตนไม่ผ่าน");
      }
      return checks;
    }
    const find = async <T>(model: string, id: number | null | undefined, fields: string[]) =>
      id ? ((await client.read<T>(model, [id], fields).catch(() => []))[0] ?? null) : null;
    const journal = await find<{ name: string; type: string }>("account.journal", conn.config.journalId, ["name", "type"]);
    set("journal", journal?.type === "purchase", journal ? (journal.type === "purchase" ? journal.name : `${journal.name} ไม่ใช่ journal ซื้อ`) : "ไม่พบ journal ที่ตั้งไว้");
    const tax = await find<{ name: string; type_tax_use: string; amount: number }>("account.tax", conn.config.purchaseTaxId, ["name", "type_tax_use", "amount"]);
    set(
      "tax",
      tax?.type_tax_use === "purchase" && Number(tax.amount) === 7,
      tax ? (tax.type_tax_use !== "purchase" ? `${tax.name} ไม่ใช่ภาษีซื้อ` : Number(tax.amount) !== 7 ? `${tax.name} อัตรา ${tax.amount}% ไม่ใช่ 7%` : tax.name) : "ไม่พบรหัสภาษีที่ตั้งไว้",
    );
    const account = await find<{ name: string }>("account.account", conn.config.expenseAccountId, ["name"]);
    set("account", !!account, account ? account.name : "ไม่พบบัญชีที่ตั้งไว้");
    return checks;
  }

  /** webhook: ส่ง ping ที่ลงลายเซ็น — ปลายทางต้องตอบ 2xx และไม่สร้างข้อมูล */
  private async testWebhook(conn: ErpConnection & { secret: string | null }): Promise<ConnectionCheck[]> {
    const body = JSON.stringify({ type: "ping", at: new Date().toISOString() });
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(conn.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SDES-Event": "ping", "X-SDES-Timestamp": ts, "X-SDES-Signature": signWebhook(conn.secret ?? "", ts, body) },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const auth = res.status !== 401 && res.status !== 403;
      return [
        { key: "reach", label: LABEL.reach, ok: true, message: `ตอบ ${res.status}` },
        { key: "auth", label: "ปลายทางรับลายเซ็น", ok: auth && res.ok, message: res.ok ? "รับลายเซ็น" : `ปลายทางตอบ ${res.status}` },
      ];
    } catch (e) {
      return [
        { key: "reach", label: LABEL.reach, ok: false, message: e instanceof Error && e.name === "TimeoutError" ? "ปลายทางไม่ตอบภายในเวลาที่กำหนด" : "เชื่อมต่อปลายทางไม่ได้" },
        { key: "auth", label: "ปลายทางรับลายเซ็น", ok: null, message: "ไม่ได้ตรวจ" },
      ];
    }
  }
}
