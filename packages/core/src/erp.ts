// ข้อมูลที่ส่งเข้า ERP (spec erp-sync, design D2) — pure function ใช้ร่วมกันทุก adapter
import Decimal from "decimal.js";
import { normalizeTaxId } from "./taxid.js";
import type { DocumentData } from "./validation.js";

export type ErpPayload = {
  /** เท่ากันทุกครั้งที่ส่งเอกสารเดิม — ใช้กันการสร้างซ้ำที่ปลายทาง */
  idempotencyKey: string;
  documentId: string;
  /** เลขเอกสารในระบบนี้ (DOC-000123) */
  docNo: string;
  vendor: { name: string; taxId: string; branch: string; erpPartnerId: string | null };
  invoice: { number: string; date: string };
  currency: "THB";
  lines: { description: string; quantity: string; unitPrice: string; discount: string; amount: string }[];
  totals: {
    subtotal: string;
    discount: string;
    vatBase: string;
    vatRate: string;
    vatAmount: string;
    vatExempt: boolean;
    grandTotal: string;
  };
  /** ข้อมูลหัก ณ ที่จ่าย (ไม่บันทึกเป็นรายการ — ใส่ในหมายเหตุของ ERP) */
  withholding: { base: string; rate: string; amount: string; netPayable: string } | null;
};

/** ไฟล์ต้นฉบับที่แนบไปกับเอกสารใน ERP */
export type ErpAttachment = { name: string; mimeType: string; data: Uint8Array };

export type ErpPushResult = {
  transactionId: string;
  /** ปลายทางมีรายการของเอกสารนี้อยู่แล้ว จึงใช้รายการเดิม */
  reused: boolean;
};

export class ErpPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErpPayloadError";
  }
}

const money = (v: string | null | undefined, field: string, fallback?: string): string => {
  const s = v ?? fallback;
  if (s == null || s.trim() === "") throw new ErpPayloadError(`ไม่มีค่า ${field}`);
  return new Decimal(s).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
};

/**
 * สร้าง payload จากข้อมูลเอกสารที่ผ่านกฎตรวจแล้ว (ไม่มี ERROR)
 * ค่าบังคับที่ขาดถือเป็นข้อผิดพลาดของโปรแกรม เพราะเอกสารที่ส่งได้ต้องผ่านการยืนยันมาแล้ว
 */
export function buildErpPayload(
  doc: { id: string; docNo: string; data: DocumentData },
  vendor: { erpPartnerId?: string | null } = {},
): ErpPayload {
  const d = doc.data;
  if (!d.vendorTaxId || !d.invoiceNo || !d.invoiceDate) throw new ErpPayloadError("ข้อมูลผู้ขาย เลขที่ หรือวันที่เอกสารไม่ครบ");
  const vatExempt = d.vatExempt;
  const hasWht = d.whtAmount != null && d.whtAmount.trim() !== "" && !new Decimal(d.whtAmount).isZero();
  return {
    idempotencyKey: `sdes:${doc.id}`,
    documentId: doc.id,
    docNo: doc.docNo,
    vendor: {
      name: d.vendorName?.trim() || "ไม่ทราบชื่อผู้ขาย",
      taxId: normalizeTaxId(d.vendorTaxId),
      branch: d.vendorBranch?.trim() || "00000",
      erpPartnerId: vendor.erpPartnerId ?? null,
    },
    invoice: { number: d.invoiceNo.trim(), date: d.invoiceDate },
    currency: "THB",
    lines: d.items.map((it, i) => ({
      description: it.description?.trim() || `รายการที่ ${i + 1}`,
      quantity: new Decimal(it.quantity ?? "1").toString(),
      unitPrice: money(it.unitPrice, `ราคาต่อหน่วยบรรทัดที่ ${i + 1}`, it.amount ?? undefined),
      discount: money(it.discount, "ส่วนลดของบรรทัด", "0"),
      amount: money(it.amount, `ยอดบรรทัดที่ ${i + 1}`),
    })),
    totals: {
      subtotal: money(d.subtotal, "ยอดก่อนภาษี"),
      discount: money(d.discount, "ส่วนลด", "0"),
      vatBase: money(d.vatBase, "ฐานภาษี", vatExempt ? "0" : undefined),
      vatRate: vatExempt ? "0" : (d.vatRate?.trim() || "7"),
      vatAmount: money(d.vatAmount, "ภาษีมูลค่าเพิ่ม", vatExempt ? "0" : undefined),
      vatExempt,
      grandTotal: money(d.grandTotal, "ยอดรวม"),
    },
    withholding: hasWht
      ? {
          base: money(d.whtBase, "ฐานหัก ณ ที่จ่าย"),
          rate: d.whtRate?.trim() || "0",
          amount: money(d.whtAmount, "ภาษีหัก ณ ที่จ่าย"),
          netPayable: money(d.netPayable, "ยอดจ่ายสุทธิ"),
        }
      : null,
  };
}

/** ข้อความหมายเหตุภาษาไทยของข้อมูลหัก ณ ที่จ่าย (ใช้ในหมายเหตุของ ERP) */
export function withholdingNote(p: ErpPayload): string | null {
  const w = p.withholding;
  if (!w) return null;
  const fmt = (s: string) => Number(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `หัก ณ ที่จ่าย ${w.rate}% จากฐาน ${fmt(w.base)} บาท = ${fmt(w.amount)} บาท · ยอดจ่ายสุทธิ ${fmt(w.netPayable)} บาท`;
}
