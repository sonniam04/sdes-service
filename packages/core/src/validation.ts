// กฎตรวจข้อมูลเอกสาร (spec invoice-validation, design D4) — pure function ใช้ร่วมกันทั้ง api, worker และ web
import Decimal from "decimal.js";
import { HEADER_FIELDS, MONEY_RE, DECIMAL_RE, ISO_DATE_RE, type ExtractedHeader, type ExtractionResult } from "./extraction.js";
import { isValidBranchCode, isValidTaxId, normalizeTaxId } from "./taxid.js";

export type Severity = "ERROR" | "WARNING";
/** ตำแหน่งของ field เช่น `header.grandTotal`, `items[2].amount` หรือ `items` (ทั้งตาราง) */
export type FieldPath = string;
export type ValidationIssue = { code: string; severity: Severity; message: string; fields: FieldPath[] };

type HeaderValues = { [K in keyof ExtractedHeader]: K extends "vatExempt" ? boolean : string | null };
export type DocumentItem = {
  no: number;
  description: string | null;
  quantity: string | null;
  unitPrice: string | null;
  discount?: string | null;
  vat?: string | null;
  amount: string | null;
};
/** ข้อมูลเอกสารที่ตรวจได้ — ค่าที่ผู้ใช้เห็นและแก้ในฟอร์ม (ไม่มีความมั่นใจ/ตำแหน่ง) */
export type DocumentData = HeaderValues & { items: DocumentItem[] };

export type ValidationContext = {
  /** Tax ID ของบริษัทที่ตั้งค่าไว้ — null เมื่อยังไม่ได้ตั้ง */
  companyTaxId: string | null;
  /** เวลาที่อัปโหลด ใช้ตรวจวันที่เอกสาร */
  uploadedAt: Date | string;
  /** เลขเอกสารในระบบของฉบับที่ยืนยันแล้วซึ่งมีผู้ขาย + เลขที่ซ้ำกัน (ผู้เรียกหาให้) */
  duplicateDocNo?: string | null;
};

export const TOLERANCE = new Decimal("0.01");
export const VAT_RATE = new Decimal(7);
const ZERO = new Decimal(0);
const MONEY_FIELDS = ["subtotal", "discount", "vatBase", "vatAmount", "grandTotal", "whtBase", "whtAmount", "netPayable"] as const;
const RATE_FIELDS = ["vatRate", "whtRate"] as const;

const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** ตรงกันเมื่อต่างกันไม่เกิน 0.01 บาท */
export const moneyEquals = (a: Decimal, b: Decimal) => round2(a).minus(round2(b)).abs().lte(TOLERANCE);
const fmt = (d: Decimal) => round2(d).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** แปลงผลการอ่านเป็นข้อมูลเอกสารที่ตรวจและแก้ได้ */
export function toDocumentData(r: Pick<ExtractionResult, "header" | "items">): DocumentData {
  const header = Object.fromEntries(
    HEADER_FIELDS.map((k) => [k, k === "vatExempt" ? r.header.vatExempt.value === true : (r.header[k].value as string | null)]),
  ) as HeaderValues;
  const items = r.items.map((i) => ({
    no: i.no,
    description: i.description.value,
    quantity: i.quantity.value,
    unitPrice: i.unitPrice.value,
    discount: i.discount?.value ?? null,
    vat: i.vat?.value ?? null,
    amount: i.amount.value,
  }));
  return { ...header, items };
}

/**
 * ข้อมูลเอกสารจาก column jsonb → DocumentData ที่มีครบทุก field
 * ค่าเริ่มต้นของ column คือ {} (แถวที่สร้างก่อนเก็บผลการอ่าน หรือยังไม่ได้อ่าน) — ห้าม cast ตรง ๆ
 */
export function asDocumentData(json: unknown): DocumentData {
  const o = (json !== null && typeof json === "object" && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const header = Object.fromEntries(
    HEADER_FIELDS.map((k) => [k, k === "vatExempt" ? o[k] === true : typeof o[k] === "string" ? o[k] : null]),
  ) as HeaderValues;
  return { ...header, items: Array.isArray(o.items) ? (o.items as DocumentItem[]) : [] };
}

/** ตรวจข้อมูลเอกสารทั้งหมด คืนรายการที่ไม่ผ่าน (ว่าง = ผ่านทุกกฎ) */
export function validateDocument(d: DocumentData, ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, severity: Severity, message: string, ...fields: FieldPath[]) =>
    issues.push({ code, severity, message, fields });

  // ---- รูปแบบตัวเลข: ค่าที่อ่านไม่ได้ไม่นำไปคำนวณต่อ ----
  const num = (value: string | null | undefined, path: FieldPath, re: RegExp): Decimal | null => {
    if (value == null || value.trim() === "") return null;
    if (!re.test(value.trim())) {
      add("NUMBER_FORMAT", "ERROR", "รูปแบบตัวเลขไม่ถูกต้อง", path);
      return null;
    }
    return new Decimal(value.trim());
  };
  const h = Object.fromEntries([
    ...MONEY_FIELDS.map((k) => [k, num(d[k], `header.${k}`, MONEY_RE)]),
    ...RATE_FIELDS.map((k) => [k, num(d[k], `header.${k}`, DECIMAL_RE)]),
  ]) as Record<(typeof MONEY_FIELDS)[number] | (typeof RATE_FIELDS)[number], Decimal | null>;

  // ---- field บังคับและวันที่ ----
  const required: [keyof HeaderValues, string][] = [
    ["invoiceNo", "เลขที่เอกสาร"],
    ["invoiceDate", "วันที่เอกสาร"],
    ["vendorTaxId", "เลขประจำตัวผู้เสียภาษีของผู้ขาย"],
    ["grandTotal", "ยอดรวม"],
  ];
  for (const [k, label] of required) {
    const v = d[k];
    if (v == null || (typeof v === "string" && v.trim() === "")) add("REQUIRED", "ERROR", `ยังไม่มี${label}`, `header.${k}`);
  }
  if (d.invoiceDate) {
    if (!ISO_DATE_RE.test(d.invoiceDate)) {
      add("DATE_FORMAT", "ERROR", "วันที่เอกสารไม่ถูกต้อง", "header.invoiceDate");
    } else {
      const uploaded = bangkokDate(ctx.uploadedAt);
      if (d.invoiceDate > uploaded) add("DATE_FUTURE", "WARNING", "วันที่เอกสารอยู่ในอนาคต", "header.invoiceDate");
      else if (d.invoiceDate < addMonths(uploaded, -6)) add("DATE_OLD", "WARNING", "เอกสารเก่ากว่า 6 เดือน", "header.invoiceDate");
    }
  }

  // ---- รายการสินค้า ----
  let linesSum: Decimal | null = d.items.length ? ZERO : null;
  d.items.forEach((item, i) => {
    const p = `items[${i}]`;
    const qty = num(item.quantity, `${p}.quantity`, DECIMAL_RE);
    const price = num(item.unitPrice, `${p}.unitPrice`, MONEY_RE);
    const disc = num(item.discount, `${p}.discount`, MONEY_RE) ?? ZERO;
    const amount = num(item.amount, `${p}.amount`, MONEY_RE);
    if (amount == null) {
      add("LINE_AMOUNT_MISSING", "ERROR", `บรรทัดที่ ${item.no} ยังไม่มียอดสุทธิ`, `${p}.amount`);
      linesSum = null;
      return;
    }
    if (linesSum) linesSum = linesSum.plus(amount);
    if (qty && price) {
      const expected = qty.times(price).minus(disc);
      if (!moneyEquals(expected, amount))
        add("LINE_AMOUNT", "ERROR", `บรรทัดที่ ${item.no}: จำนวน × ราคาต่อหน่วยได้ ${fmt(expected)} ไม่ตรงกับยอดสุทธิ`, `${p}.amount`);
    }
  });
  if (linesSum && h.subtotal && !moneyEquals(linesSum, h.subtotal))
    add("LINES_TOTAL", "ERROR", `ผลรวมรายการ ${fmt(linesSum)} ไม่ตรงกับยอดก่อนภาษี`, "header.subtotal", "items");

  // ---- ชั้นที่ 1: ยอดรวม ----
  const discount = h.discount ?? ZERO;
  const net = h.subtotal ? h.subtotal.minus(discount) : null;
  if (h.subtotal && h.vatAmount && h.grandTotal && !moneyEquals(h.subtotal.minus(discount).plus(h.vatAmount), h.grandTotal))
    add("GRAND_TOTAL", "ERROR", "ยอดรวมไม่ตรงกับยอดก่อนภาษีบวก VAT", "header.grandTotal");
  if (net && h.vatBase) {
    if (round2(h.vatBase).minus(round2(net)).gt(TOLERANCE))
      add("VAT_BASE", "ERROR", "ฐานภาษีมากกว่ายอดก่อนภาษีหลังหักส่วนลด", "header.vatBase");
    else if (!d.vatExempt && !moneyEquals(h.vatBase, net))
      add("VAT_BASE_PARTIAL", "WARNING", "ฐานภาษีน้อยกว่ายอดก่อนภาษี (มียอดที่ไม่คิด VAT)", "header.vatBase");
  }

  // ---- อัตรา VAT ----
  if (d.vatExempt) {
    if (h.vatAmount && !moneyEquals(h.vatAmount, ZERO)) add("VAT_EXEMPT", "ERROR", "เอกสารยกเว้น VAT แต่มียอด VAT", "header.vatAmount");
  } else {
    const base = h.vatBase ?? net;
    if (base && h.vatAmount && !moneyEquals(base.times(VAT_RATE).dividedBy(100), h.vatAmount))
      add("VAT_AMOUNT", "ERROR", `ยอด VAT ควรเป็น 7% ของฐานภาษี = ${fmt(base.times(VAT_RATE).dividedBy(100))}`, "header.vatAmount");
  }
  if (h.vatRate && !h.vatRate.eq(VAT_RATE) && !h.vatRate.isZero())
    add("VAT_RATE", "WARNING", `อัตรา VAT ${h.vatRate.toString()}% ไม่ใช่ 7%`, "header.vatRate");

  // ---- ชั้นที่ 2: หัก ณ ที่จ่าย และยอดจ่ายสุทธิ ----
  if (h.whtBase && net && round2(h.whtBase).minus(round2(net)).gt(TOLERANCE))
    add("WHT_BASE", "ERROR", "ฐานหัก ณ ที่จ่ายมากกว่ายอดก่อนภาษีหลังหักส่วนลด", "header.whtBase");
  if (h.whtBase && h.whtRate && h.whtAmount) {
    const expected = h.whtBase.times(h.whtRate).dividedBy(100);
    if (!moneyEquals(expected, h.whtAmount))
      add("WHT_AMOUNT", "ERROR", `ยอดหัก ณ ที่จ่ายควรเป็น ${fmt(expected)} (ฐาน × อัตรา)`, "header.whtAmount");
  }
  const wht = h.whtAmount ?? ZERO;
  if (h.grandTotal && h.netPayable && !moneyEquals(h.grandTotal.minus(wht), h.netPayable))
    add("NET_PAYABLE", "ERROR", "ยอดจ่ายสุทธิไม่ตรงกับยอดรวมหักภาษี ณ ที่จ่าย", "header.netPayable");
  if (!wht.isZero() && !h.netPayable) add("NET_PAYABLE_MISSING", "ERROR", "มีหัก ณ ที่จ่ายแต่ยังไม่มียอดจ่ายสุทธิ", "header.netPayable");

  // ---- Tax ID และสาขา ----
  if (d.vendorTaxId && !isValidTaxId(d.vendorTaxId))
    add("TAX_ID_INVALID", "ERROR", "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง", "header.vendorTaxId");
  if (!d.vendorBranch) add("BRANCH_MISSING", "WARNING", "ไม่ระบุสาขาของผู้ขาย", "header.vendorBranch");
  else if (!isValidBranchCode(d.vendorBranch)) add("BRANCH_INVALID", "ERROR", "รหัสสาขาต้องเป็นตัวเลข 5 หลัก", "header.vendorBranch");
  if (d.buyerBranch && !isValidBranchCode(d.buyerBranch))
    add("BRANCH_INVALID", "ERROR", "รหัสสาขาต้องเป็นตัวเลข 5 หลัก", "header.buyerBranch");

  // ---- ผู้ซื้อต้องเป็นบริษัทเรา ----
  if (d.buyerTaxId && !isValidTaxId(d.buyerTaxId)) {
    add("TAX_ID_INVALID", "ERROR", "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง", "header.buyerTaxId");
  } else if (!ctx.companyTaxId) {
    add("COMPANY_TAX_ID_NOT_SET", "WARNING", "ยังไม่ได้ตั้งเลขประจำตัวผู้เสียภาษีของบริษัท จึงตรวจผู้ซื้อไม่ได้", "header.buyerTaxId");
  } else if (!d.buyerTaxId || normalizeTaxId(d.buyerTaxId) !== normalizeTaxId(ctx.companyTaxId)) {
    add("BUYER_MISMATCH", "ERROR", "ใบกำกับภาษีไม่ได้ออกให้บริษัท", "header.buyerTaxId");
  }

  // ---- เลขที่เอกสารซ้ำ ----
  if (ctx.duplicateDocNo)
    add("DUPLICATE_INVOICE", "ERROR", `เลขที่เอกสารนี้เคยบันทึกแล้วใน ${ctx.duplicateDocNo}`, "header.invoiceNo");

  return issues;
}

export const hasErrors = (issues: readonly ValidationIssue[]) => issues.some((i) => i.severity === "ERROR");

/** วันที่ตามปฏิทินไทย (Asia/Bangkok, UTC+7 ไม่มี DST) ในรูป YYYY-MM-DD */
function bangkokDate(at: Date | string): string {
  const t = new Date(typeof at === "string" ? at : at.getTime());
  return new Date(t.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

function addMonths(isoDate: string, months: number): string {
  const [y, m, day] = isoDate.split("-").map(Number) as [number, number, number];
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
