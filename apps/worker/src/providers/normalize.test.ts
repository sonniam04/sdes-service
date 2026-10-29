import { HEADER_FIELDS, type ModelExtraction } from "@sdes/core";
import { describe, expect, it } from "vitest";
import { normalizeBBox, normalizeBranch, normalizeDate, normalizeModelOutput, normalizeMoney, normalizeTaxIdText } from "./normalize.js";

describe("normalize ผลจากโมเดล", () => {
  it.each([
    ["10,700.00", "10700.00"],
    ["10700", "10700"],
    ["฿ 1,234.5", "1234.50"],
    ["700.00 บาท", "700.00"],
    ["10700.000", "10700.00"],
    ["10700.005", null],
    ["abc", null],
  ])("เงิน %s → %s", (input, expected) => {
    expect(normalizeMoney(input)).toBe(expected);
  });

  it.each([
    ["2026-10-15", "2026-10-15"],
    ["2569-10-15", "2026-10-15"],
    ["15/10/2569", "2026-10-15"],
    ["15/10/2026", "2026-10-15"],
    ["31/02/2026", null],
    ["ต.ค. 2569", null],
  ])("วันที่ %s → %s", (input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  it.each([
    ["สำนักงานใหญ่", "00000"],
    ["Head Office", "00000"],
    ["สาขาที่ 3", "00003"],
    ["00012", "00012"],
  ])("สาขา %s → %s", (input, expected) => {
    expect(normalizeBranch(input)).toBe(expected);
  });

  it("Tax ID ตัดขีดเมื่อครบ 13 หลัก ไม่ครบคงค่าเดิมให้ผู้ใช้แก้", () => {
    expect(normalizeTaxIdText("0-1055-36000-01-1")).toBe("0105536000011");
    expect(normalizeTaxIdText("01055-3600")).toBe("01055-3600");
  });

  it("bbox ถูกบีบให้อยู่ในหน้า และกรอบที่ไม่มีขนาดเป็น null", () => {
    expect(normalizeBBox({ page: 1, x: 0.9, y: -0.1, w: 0.3, h: 0.05 })).toEqual({ page: 1, x: 0.9, y: 0, w: expect.closeTo(0.1, 5), h: 0.05 });
    expect(normalizeBBox({ page: 0, x: 0, y: 0, w: 0.1, h: 0.1 })).toBeNull();
    expect(normalizeBBox({ page: 1, x: 0.1, y: 0.1, w: 0, h: 0.1 })).toBeNull();
  });

  it("แปลงผลทั้งชุดเป็น ExtractionResult ที่ผ่าน schema และคิดความมั่นใจรวม", () => {
    const f = (value: string | null, confidence = 0.95) => ({ value, confidence, bbox: { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.03 } });
    const header = Object.fromEntries(HEADER_FIELDS.map((k) => [k, f(null, 0)])) as Record<string, unknown>;
    Object.assign(header, {
      invoiceNo: f("INV-001"),
      invoiceDate: f("15/10/2569"),
      grandTotal: f("10,700.00", 0.9),
      subtotal: f("10,000.00"),
      vatAmount: f("ไม่ชัด", 0.8),
      vatExempt: { value: false, confidence: 0.99, bbox: null },
    });
    const out = {
      header,
      items: [{ no: 7, description: f("ค่าบริการ"), quantity: f("2"), unitPrice: f("5,000.00"), discount: f(null, 0), vat: f(null, 0), amount: f("10,000.00") }],
    } as unknown as ModelExtraction;
    const r = normalizeModelOutput(out, { provider: "claude", modelVersion: "m", raw: {} });
    expect(r.header.invoiceDate.value).toBe("2026-10-15");
    expect(r.header.grandTotal.value).toBe("10700.00");
    expect(r.header.vatAmount).toMatchObject({ value: null, confidence: 0 });
    expect(r.items[0]).toMatchObject({ no: 1, unitPrice: { value: "5000.00" } });
    expect(r.confidence).toBeLessThanOrEqual(0.9);
  });
});
