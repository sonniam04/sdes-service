// การตั้งค่าการเชื่อมต่อ ERP (แถวเดียว) — ใช้ร่วมกันระหว่าง api (ตั้งค่า/ทดสอบ) และ worker (ส่ง) — design D5
import { createHash } from "node:crypto";
import type { Tx } from "./audit.js";
import type { PrismaClient } from "./generated/client/index.js";
import { decryptSecret } from "./secrets.js";

type Db = Tx | PrismaClient;

export type ErpAdapterName = "odoo" | "webhook";

export type ErpConnectionOptions = {
  /** Odoo: json2 (19+) หรือ jsonrpc (17–18) */
  apiMode?: "json2" | "jsonrpc";
  /** Odoo jsonrpc: ชื่อผู้ใช้ */
  login?: string | null;
  journalId?: number | null;
  purchaseTaxId?: number | null;
  expenseAccountId?: number | null;
};

export type ErpConnection = {
  adapter: ErpAdapterName;
  url: string;
  database: string | null;
  config: ErpConnectionOptions;
  hasSecret: boolean;
  autoSync: boolean;
  testedAt: Date | null;
  testedHash: string | null;
  /** hash ของการตั้งค่าปัจจุบัน (รวม secret) — ตรงกับ testedHash = ทดสอบผ่านกับค่านี้แล้ว */
  currentHash: string;
  updatedAt: Date;
};

export const ERP_CONNECTION_ID = 1;

type Row = Awaited<ReturnType<Db["erpConnection"]["findUnique"]>>;

/** hash ของทุกค่าที่มีผลต่อการเชื่อมต่อ — secret ใช้ ciphertext (เปลี่ยน secret = hash เปลี่ยน) */
export function connectionHash(r: NonNullable<Row>): string {
  return createHash("sha256")
    .update(JSON.stringify([r.adapter, r.url, r.database ?? null, r.config ?? {}]))
    .update(r.secretCiphertext ?? Buffer.alloc(0))
    .digest("hex");
}

export function toErpConnection(r: NonNullable<Row>): ErpConnection {
  return {
    adapter: r.adapter as ErpAdapterName,
    url: r.url,
    database: r.database,
    config: (r.config ?? {}) as ErpConnectionOptions,
    hasSecret: !!r.secretCiphertext,
    autoSync: r.autoSync,
    testedAt: r.testedAt,
    testedHash: r.testedHash,
    currentHash: connectionHash(r),
    updatedAt: r.updatedAt,
  };
}

export async function loadErpConnection(db: Db): Promise<ErpConnection | null> {
  const r = await db.erpConnection.findUnique({ where: { id: ERP_CONNECTION_ID } });
  return r ? toErpConnection(r) : null;
}

/** การเชื่อมต่อพร้อม secret ที่ถอดรหัสแล้ว — ใช้ตอนส่งหรือทดสอบเท่านั้น ห้ามส่งกลับใน API/log */
export async function loadErpConnectionWithSecret(db: Db, key: () => Buffer): Promise<(ErpConnection & { secret: string | null }) | null> {
  const r = await db.erpConnection.findUnique({ where: { id: ERP_CONNECTION_ID } });
  if (!r) return null;
  const secret =
    r.secretCiphertext && r.secretIv && r.secretTag
      ? decryptSecret({ ciphertext: Buffer.from(r.secretCiphertext), iv: Buffer.from(r.secretIv), tag: Buffer.from(r.secretTag) }, key())
      : null;
  return { ...toErpConnection(r), secret };
}
