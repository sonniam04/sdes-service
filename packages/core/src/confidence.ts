// ความมั่นใจรวมของเอกสารและการลดความมั่นใจตามผลกฎตรวจ (design D3)
import { HEADER_FIELDS, type ExtractedHeader, type ExtractionResult } from "./extraction.js";
import type { ValidationIssue } from "./validation.js";

/** field ยอดเงินหลัก — ความมั่นใจรวมต้องไม่สูงกว่าตัวที่ต่ำที่สุด */
export const KEY_MONEY_FIELDS = ["subtotal", "vatAmount", "grandTotal", "whtAmount"] as const;
/** เพดานความมั่นใจของ field ที่ไม่ผ่านกฎตรวจระดับ ERROR */
export const FAILED_RULE_CONFIDENCE_CAP = 0.5;

type Result = Pick<ExtractionResult, "header" | "items">;

/**
 * ความมั่นใจรวม = ต่ำสุดของ field เงินหลักที่มีค่า × ค่าเฉลี่ยของ field อื่นที่มีค่า
 * field ที่ไม่มีค่า (เช่น ใบที่ไม่มีหัก ณ ที่จ่าย) ไม่นำมาคิด
 */
export function overallConfidence(r: Result): number {
  const present = (k: keyof ExtractedHeader) => r.header[k].value !== null;
  const key = KEY_MONEY_FIELDS.filter(present).map((k) => r.header[k].confidence);
  const others = [
    ...HEADER_FIELDS.filter((k) => !(KEY_MONEY_FIELDS as readonly string[]).includes(k) && present(k)).map((k) => r.header[k].confidence),
    ...r.items.flatMap((i) => [i.description, i.quantity, i.unitPrice, i.amount].filter((f) => f.value !== null).map((f) => f.confidence)),
  ];
  if (!key.length && !others.length) return 0;
  const minKey = key.length ? Math.min(...key) : 1;
  const mean = others.length ? others.reduce((a, b) => a + b, 0) / others.length : 1;
  return round4(minKey * mean);
}

/** คืนสำเนาผลการอ่านที่ field ซึ่งอยู่ในผลตรวจระดับ ERROR ถูกลดความมั่นใจไม่เกินเพดาน */
export function applyValidationPenalty<T extends Result>(r: T, issues: readonly ValidationIssue[]): T {
  const out = structuredClone(r);
  for (const issue of issues) {
    if (issue.severity !== "ERROR") continue;
    for (const path of issue.fields) {
      const header = /^header\.(\w+)$/.exec(path);
      if (header && header[1]! in out.header) {
        cap(out.header[header[1] as keyof ExtractedHeader]);
        continue;
      }
      const item = /^items\[(\d+)\]\.(\w+)$/.exec(path);
      const row = item ? out.items[Number(item[1])] : undefined;
      const f = row ? (row as Record<string, unknown>)[item![2]!] : undefined;
      if (f && typeof f === "object" && "confidence" in f) cap(f as { confidence: number });
    }
  }
  return out;
}

const cap = (f: { confidence: number }) => {
  f.confidence = Math.min(f.confidence, FAILED_RULE_CONFIDENCE_CAP);
};
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
