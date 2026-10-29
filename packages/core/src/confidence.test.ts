import { describe, expect, it } from "vitest";
import { applyValidationPenalty, emptyHeader, overallConfidence, type ExtractionResult } from "./index.js";

const f = (value: string | null, confidence: number) => ({ value, confidence, bbox: null });

function result(): Pick<ExtractionResult, "header" | "items"> {
  const header = emptyHeader();
  header.invoiceNo = f("INV-1", 0.99);
  header.vendorTaxId = f("0105536000011", 0.95);
  header.subtotal = f("10000.00", 0.97);
  header.vatAmount = f("700.00", 0.9);
  header.grandTotal = f("10700.00", 0.96);
  return { header, items: [{ no: 1, description: f("ค่าบริการ", 0.95), quantity: f("2", 0.99), unitPrice: f("5000.00", 0.97), amount: f("10000.00", 0.97) }] };
}

describe("overallConfidence (design D3)", () => {
  it("ไม่สูงกว่า field เงินหลักที่ต่ำที่สุด", () => {
    const r = result();
    const c = overallConfidence(r);
    expect(c).toBeLessThanOrEqual(0.9);
    expect(c).toBeGreaterThan(0.8);
  });

  it("field เงินที่ไม่มีค่า (ไม่มีหัก ณ ที่จ่าย) ไม่ดึงค่าลง", () => {
    const r = result();
    r.header.whtAmount = f(null, 0);
    expect(overallConfidence(r)).toBe(overallConfidence(result()));
  });

  it("ยอดรวมเลือนทำให้ความมั่นใจรวมต่ำ", () => {
    const r = result();
    r.header.grandTotal = f("10700.00", 0.4);
    expect(overallConfidence(r)).toBeLessThanOrEqual(0.4);
  });

  it("ผลว่างได้ 0", () => {
    expect(overallConfidence({ header: emptyHeader(), items: [] })).toBe(0);
  });
});

describe("applyValidationPenalty (design D3)", () => {
  it("ลดความมั่นใจของ field ที่อยู่ใน ERROR ไม่เกิน 0.5 และไม่แก้ต้นฉบับ", () => {
    const r = result();
    const out = applyValidationPenalty(r, [
      { code: "GRAND_TOTAL", severity: "ERROR", message: "", fields: ["header.grandTotal"] },
      { code: "LINE_AMOUNT", severity: "ERROR", message: "", fields: ["items[0].amount"] },
      { code: "BRANCH_MISSING", severity: "WARNING", message: "", fields: ["header.vendorTaxId"] },
    ]);
    expect(out.header.grandTotal.confidence).toBe(0.5);
    expect(out.items[0]!.amount.confidence).toBe(0.5);
    expect(out.header.vendorTaxId.confidence).toBe(0.95);
    expect(r.header.grandTotal.confidence).toBe(0.96);
    expect(overallConfidence(out)).toBeLessThanOrEqual(0.5);
  });

  it("ไม่เพิ่มความมั่นใจที่ต่ำกว่าเพดานอยู่แล้ว", () => {
    const r = result();
    r.header.grandTotal = f("10700.00", 0.3);
    const out = applyValidationPenalty(r, [{ code: "GRAND_TOTAL", severity: "ERROR", message: "", fields: ["header.grandTotal"] }]);
    expect(out.header.grandTotal.confidence).toBe(0.3);
  });

  it("ข้ามตำแหน่งที่ไม่มีอยู่จริง", () => {
    expect(() =>
      applyValidationPenalty(result(), [{ code: "X", severity: "ERROR", message: "", fields: ["items", "items[9].amount", "header.nope"] }]),
    ).not.toThrow();
  });
});
