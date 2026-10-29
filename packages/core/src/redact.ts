// ตัดข้อมูลลับและ mask ข้อมูลส่วนบุคคลก่อนเขียน audit (spec audit-trail: Sensitive data masking)

export const REDACTED = "[REDACTED]";

const SECRET_KEY = /pass(word)?|token|secret|authorization|api[-_]?key|cookie/i;
/** field ภาษีเก็บได้ตามกฎหมาย — ไม่ mask */
const TAX_KEY = /tax_?id/i;
const PERSONAL_KEY = /national_?id|id_?card|citizen_?id|bank_?account/i;

// เลข 13 หลักขึ้นต้น 1–8 = เลขบัตรประชาชนบุคคล (นิติบุคคลขึ้นต้น 0) จะมีขีดคั่นหรือไม่ก็ได้
const PERSONAL_ID = /\b[1-8][- ]?\d{4}[- ]?\d{5}[- ]?\d{2}[- ]?\d\b/g;
// เลขบัญชีธนาคาร 10–12 หลัก รูปแบบ xxx-x-xxxxx-x หรือเลขติดกัน
const BANK_ACCOUNT = /\b\d{3}-\d-\d{5}-\d\b|\b\d{10,12}\b/g;

const keepLast = (s: string, n: number) => {
  const digits = s.replace(/\D/g, "");
  return `${"x".repeat(Math.max(0, digits.length - n))}${digits.slice(-n)}`;
};

function maskString(s: string): string {
  return s.replace(PERSONAL_ID, (m) => keepLast(m, 3)).replace(BANK_ACCOUNT, (m) => keepLast(m, 4));
}

export function redact<T>(value: T, key = ""): T {
  if (SECRET_KEY.test(key)) return REDACTED as T;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (TAX_KEY.test(key)) return value;
    if (PERSONAL_KEY.test(key)) return keepLast(value, 4) as T;
    return maskString(value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key)) as T;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)])) as T;
  }
  return value;
}
