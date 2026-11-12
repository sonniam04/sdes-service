// แปลงผลจากโมเดลให้ตรงรูปแบบเข้มของ ExtractionResult — ค่าที่แปลงไม่ได้เป็น null (ผลดิบยังอยู่ใน raw)
import {
  DECIMAL_RE,
  HEADER_FIELDS,
  ISO_DATE_RE,
  MONEY_RE,
  overallConfidence,
  parseExtractionResult,
  type BBox,
  type ExtractedHeader,
  type ExtractionResult,
  type ModelExtraction,
} from "@sdes/core";

type ModelField = { value: string | boolean | null; confidence: number; bbox: { page: number; x: number; y: number; w: number; h: number } | null };
type Field<T> = { value: T | null; confidence: number; bbox: BBox | null };

const MONEY_KEYS = new Set(["subtotal", "discount", "vatBase", "vatAmount", "grandTotal", "whtBase", "whtAmount", "netPayable"]);
const RATE_KEYS = new Set(["vatRate", "whtRate"]);
const BRANCH_KEYS = new Set(["vendorBranch", "buyerBranch"]);
const TAX_ID_KEYS = new Set(["vendorTaxId", "buyerTaxId"]);

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function normalizeBBox(b: ModelField["bbox"]): BBox | null {
  if (!b) return null;
  const page = Math.round(b.page);
  const box = { page, x: clamp01(b.x), y: clamp01(b.y), w: clamp01(b.w), h: clamp01(b.h) };
  if (!Number.isFinite(b.page) || page < 1 || box.w === 0 || box.h === 0) return null;
  box.w = Math.min(box.w, 1 - box.x);
  box.h = Math.min(box.h, 1 - box.y);
  return box;
}

/** "10,700.00 บาท" → "10700.00"; ทศนิยมเกิน 2 ตำแหน่งที่ไม่ใช่ศูนย์ถือว่าอ่านไม่แน่นอน → null */
export function normalizeMoney(v: string): string | null {
  const s = v.replace(/[,\s฿]|บาท/g, "");
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) return null;
  const out = frac ? `${m[1]}.${frac.slice(0, 2).padEnd(2, "0")}` : m[1]!;
  return MONEY_RE.test(out) ? out : null;
}

export function normalizeRate(v: string): string | null {
  const s = v.replace(/[%\s]/g, "");
  return DECIMAL_RE.test(s) ? s : null;
}

/** รับ YYYY-MM-DD หรือ DD/MM/YYYY ทั้ง ค.ศ. และ พ.ศ. คืน YYYY-MM-DD แบบ ค.ศ. */
export function normalizeDate(v: string): string | null {
  const s = v.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else return null;
  if (y > 2400) y -= 543;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const out = date.toISOString().slice(0, 10);
  return ISO_DATE_RE.test(out) ? out : null;
}

export function normalizeBranch(v: string): string | null {
  const s = v.trim();
  if (/สำนักงานใหญ่|head\s*office/i.test(s)) return "00000";
  const digits = s.replace(/\D/g, "");
  return digits.length >= 1 && digits.length <= 5 ? digits.padStart(5, "0") : s || null;
}

/** ตัดขีด/ช่องว่างเมื่อเหลือ 13 หลักพอดี ไม่เช่นนั้นคงค่าเดิมให้ผู้ใช้เห็นและแก้ */
export function normalizeTaxIdText(v: string): string | null {
  const digits = v.replace(/[\s-]/g, "");
  return /^\d{13}$/.test(digits) ? digits : v.trim() || null;
}

function normalizeField(key: string, f: ModelField): Field<string | boolean> {
  const out: Field<string | boolean> = { value: null, confidence: clamp01(f.confidence), bbox: normalizeBBox(f.bbox) };
  const v = f.value;
  if (v === null || v === "") return { ...out, confidence: v === null ? out.confidence : 0 };
  if (key === "vatExempt") return { ...out, value: typeof v === "boolean" ? v : /^(true|yes|ใช่)$/i.test(String(v)) };
  const s = String(v);
  let value: string | null;
  if (MONEY_KEYS.has(key)) value = normalizeMoney(s);
  else if (RATE_KEYS.has(key)) value = normalizeRate(s);
  else if (key === "invoiceDate") value = normalizeDate(s);
  else if (BRANCH_KEYS.has(key)) value = normalizeBranch(s);
  else if (TAX_ID_KEYS.has(key)) value = normalizeTaxIdText(s);
  else value = s.trim() || null;
  // อ่านได้แต่แปลงไม่ได้ = ไม่มั่นใจ
  return value === null ? { ...out, confidence: 0, bbox: out.bbox } : { ...out, value };
}

function itemField(key: "money" | "decimal" | "text", f: ModelField): Field<string> {
  const base = { confidence: clamp01(f.confidence), bbox: normalizeBBox(f.bbox) };
  if (f.value === null || f.value === "") return { value: null, ...base };
  const s = String(f.value);
  const value = key === "money" ? normalizeMoney(s) : key === "decimal" ? normalizeRate(s) : s.trim() || null;
  return value === null ? { value: null, ...base, confidence: 0 } : { value, ...base };
}

export function normalizeModelOutput(
  out: ModelExtraction,
  meta: { provider: string; modelVersion: string; raw: unknown },
): ExtractionResult {
  const header = Object.fromEntries(
    HEADER_FIELDS.map((k) => [k, normalizeField(k, out.header[k] as ModelField)]),
  ) as unknown as ExtractedHeader;
  const items = out.items.map((i, idx) => ({
    // ลำดับจากโมเดลอาจซ้ำหรือขาด ใช้ลำดับที่พบในเอกสารแทน
    no: idx + 1,
    description: itemField("text", i.description as ModelField),
    quantity: itemField("decimal", i.quantity as ModelField),
    unitPrice: itemField("money", i.unitPrice as ModelField),
    discount: itemField("money", i.discount as ModelField),
    vat: itemField("money", i.vat as ModelField),
    amount: itemField("money", i.amount as ModelField),
  }));
  const result = { ...meta, header, items, confidence: 0 };
  result.confidence = overallConfidence(result);
  return parseExtractionResult(result);
}
