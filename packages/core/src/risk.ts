// ประเมินความเสี่ยงหลังยืนยัน (spec risk-assessment) — pure function
import Decimal from "decimal.js";
import type { FieldPath, ValidationIssue } from "./validation.js";

export type RiskThresholds = {
  /** เกณฑ์ความมั่นใจ 0–1 (ค่าเริ่มต้น 0.85) */
  confidence: number;
  /** เกณฑ์ยอดสูง (สตริงทศนิยม) — null คือยังไม่ได้ตั้ง กฎนี้จึงไม่ถูกใช้ */
  highAmount: string | null;
};

export type RiskInput = {
  /** ความมั่นใจรวมของเอกสาร — null เมื่อไม่มีผลการอ่าน */
  confidence: number | null;
  grandTotal: string | null;
  /** ผู้ขายยังไม่เคยมีเอกสารที่อนุมัติหรือผ่านมาก่อน */
  isNewVendor: boolean;
  /** field ที่ถูกแก้หลังการอ่าน (ทุกชนิด — ฟังก์ชันคัดเฉพาะยอดเงินเอง) */
  editedFields: readonly FieldPath[];
  /** ผลตรวจล่าสุด ณ ตอนยืนยัน */
  issues: readonly ValidationIssue[];
};

export type RiskFlag = {
  code: "LOW_CONFIDENCE" | "HIGH_AMOUNT" | "NEW_VENDOR" | "MONEY_EDITED" | "OPEN_WARNINGS";
  message: string;
  /** ค่าที่ทำให้เข้าเกณฑ์ */
  value?: string | number | readonly string[];
  /** ค่าเกณฑ์ ณ เวลาประเมิน */
  threshold?: string | number;
};

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = { confidence: 0.85, highAmount: null };

const HEADER_MONEY = new Set(["subtotal", "discount", "vatBase", "vatAmount", "grandTotal", "whtBase", "whtRate", "whtAmount", "netPayable", "vatRate"]);
const ITEM_MONEY = new Set(["quantity", "unitPrice", "discount", "vat", "amount"]);

/** field ที่เป็นยอดเงิน/ตัวเลขที่มีผลต่อยอด — ใช้ตัดสิน "มีการแก้ยอดเงิน" */
export function isMoneyField(path: FieldPath): boolean {
  if (path === "items") return true;
  const header = /^header\.(\w+)$/.exec(path);
  if (header) return HEADER_MONEY.has(header[1]!);
  const item = /^items\[\d+\]\.(\w+)$/.exec(path);
  return item ? ITEM_MONEY.has(item[1]!) : false;
}

export function assessRisk(input: RiskInput, t: RiskThresholds): RiskFlag[] {
  const flags: RiskFlag[] = [];

  if (input.confidence === null || input.confidence < t.confidence)
    flags.push({
      code: "LOW_CONFIDENCE",
      message: `ความมั่นใจของ AI ต่ำกว่า ${Math.round(t.confidence * 100)}%`,
      value: input.confidence ?? 0,
      threshold: t.confidence,
    });

  if (t.highAmount !== null && input.grandTotal !== null && new Decimal(input.grandTotal).gt(t.highAmount))
    flags.push({ code: "HIGH_AMOUNT", message: "ยอดสูงกว่าเกณฑ์", value: input.grandTotal, threshold: t.highAmount });

  if (input.isNewVendor) flags.push({ code: "NEW_VENDOR", message: "ผู้ขายรายใหม่ ยังไม่เคยมีเอกสารที่ผ่านการอนุมัติ" });

  const money = [...new Set(input.editedFields.filter(isMoneyField))];
  if (money.length) flags.push({ code: "MONEY_EDITED", message: "มีการแก้ยอดเงินหลังการอ่าน", value: money });

  const warnings = input.issues.filter((i) => i.severity === "WARNING");
  if (warnings.length)
    flags.push({ code: "OPEN_WARNINGS", message: "มีรายการที่ต้องตรวจค้างอยู่", value: warnings.map((w) => w.code) });

  return flags;
}
