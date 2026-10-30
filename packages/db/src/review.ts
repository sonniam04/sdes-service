// ส่วนที่ worker และ api ใช้ร่วมกันเมื่อบันทึกข้อมูลเอกสาร (design D4–D7)
import {
  DEFAULT_RISK_THRESHOLDS,
  ISO_DATE_RE,
  MONEY_RE,
  DECIMAL_RE,
  isValidBranchCode,
  isValidTaxId,
  normalizeTaxId,
  type DocumentData,
  type RiskThresholds,
} from "@sdes/core";
import { type Tx } from "./audit.js";
import { Prisma, type PrismaClient } from "./generated/client/index.js";

type Db = Tx | PrismaClient;

/** สถานะที่ถือว่ายืนยันแล้ว — ตรงกับ partial unique index documents_vendor_invoice_confirmed_key */
export const CONFIRMED_STATUSES = ["VERIFIED", "PENDING_APPROVAL", "APPROVED", "SYNCING", "SYNCED", "SYNC_FAILED"] as const;

/**
 * ผู้ขายที่ "ไม่ใหม่" แล้ว = มีเอกสารในสถานะเหล่านี้อย่างน้อยหนึ่งฉบับ (ยืนยันผ่านโดยไม่ต้องอนุมัติ หรืออนุมัติแล้ว)
 * ใช้ทั้งเหตุผลความเสี่ยง NEW_VENDOR และป้าย "ผู้ขายรายใหม่" ในทะเบียนผู้ขาย (spec vendor-directory)
 */
export const ESTABLISHED_VENDOR_STATUSES = CONFIRMED_STATUSES.filter((s) => s !== "PENDING_APPROVAL");

const money = (v: string | null) => (v && MONEY_RE.test(v) ? new Prisma.Decimal(v) : null);
const rate = (v: string | null) => (v && DECIMAL_RE.test(v) && Math.abs(Number(v)) < 1000 ? new Prisma.Decimal(v) : null);
const taxId = (v: string | null) => (v && isValidTaxId(v) ? normalizeTaxId(v) : null);
const branch = (v: string | null) => (v && isValidBranchCode(v) ? v.trim() : null);

/** คัดลอกค่าที่ถูกรูปแบบจาก data ลง column typed (ค่าที่ยังผิดรูปแบบเป็น null) */
export function projectDocumentData(d: DocumentData) {
  return {
    invoiceNo: d.invoiceNo?.trim() || null,
    invoiceDate: d.invoiceDate && ISO_DATE_RE.test(d.invoiceDate) ? new Date(`${d.invoiceDate}T00:00:00Z`) : null,
    vendorName: d.vendorName?.trim() || null,
    vendorTaxId: taxId(d.vendorTaxId),
    vendorBranch: branch(d.vendorBranch),
    buyerTaxId: taxId(d.buyerTaxId),
    buyerBranch: branch(d.buyerBranch),
    subtotal: money(d.subtotal),
    discount: money(d.discount),
    vatBase: money(d.vatBase),
    vatRate: rate(d.vatRate),
    vatAmount: money(d.vatAmount),
    vatExempt: d.vatExempt,
    grandTotal: money(d.grandTotal),
    whtBase: money(d.whtBase),
    whtRate: rate(d.whtRate),
    whtAmount: money(d.whtAmount),
    netPayable: money(d.netPayable),
  };
}

export type ReviewSettings = { companyTaxId: string | null; companyName: string | null; thresholds: RiskThresholds };

export async function loadReviewSettings(tx: Db): Promise<ReviewSettings> {
  const rows = await tx.setting.findMany({
    where: { key: { in: ["company.tax_id", "company.name", "risk.confidence_threshold", "risk.high_amount_threshold"] } },
  });
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
  const confidence = get("risk.confidence_threshold");
  const high = get("risk.high_amount_threshold");
  return {
    companyTaxId: typeof get("company.tax_id") === "string" ? (get("company.tax_id") as string) : null,
    companyName: typeof get("company.name") === "string" ? (get("company.name") as string) : null,
    thresholds: {
      confidence: typeof confidence === "number" ? confidence : DEFAULT_RISK_THRESHOLDS.confidence,
      highAmount: high === null || high === undefined ? null : String(high),
    },
  };
}

/** เลขเอกสารของฉบับที่ยืนยันแล้วซึ่งมีผู้ขาย (Tax ID + สาขา) และเลขที่เดียวกัน — null ถ้าไม่ซ้ำ */
export async function findDuplicateInvoice(tx: Db, d: DocumentData, excludeId: string): Promise<string | null> {
  const vendorTaxId = taxId(d.vendorTaxId);
  const invoiceNo = d.invoiceNo?.trim();
  if (!vendorTaxId || !invoiceNo) return null;
  const dup = await tx.document.findFirst({
    where: {
      id: { not: excludeId },
      vendorTaxId,
      vendorBranch: branch(d.vendorBranch) ?? "00000",
      invoiceNo,
      status: { in: [...CONFIRMED_STATUSES] },
    },
    select: { docNo: true },
    orderBy: { createdAt: "asc" },
  });
  return dup?.docNo ?? null;
}
