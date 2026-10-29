import { describe, expect, it } from "vitest";
import { HEADER_FIELDS, emptyHeader, parseExtractionResult, type ExtractionResult } from "./index.js";

const f = <T extends string | boolean>(value: T | null, confidence = 0.98) => ({ value, confidence, bbox: { page: 1, x: 0.1, y: 0.2, w: 0.2, h: 0.03 } });

function sample(): ExtractionResult {
  const header = emptyHeader();
  Object.assign(header, {
    invoiceNo: f("INV-2026-001"),
    invoiceDate: f("2026-10-15"),
    vendorName: f("บริษัท ตัวอย่าง จำกัด"),
    vendorTaxId: f("0105536000011"),
    vendorBranch: f("00000"),
    subtotal: f("10000.00"),
    vatBase: f("10000.00"),
    vatRate: f("7"),
    vatAmount: f("700.00"),
    vatExempt: f(false),
    grandTotal: f("10700.00"),
  });
  return {
    provider: "test",
    modelVersion: "t-1",
    confidence: 0.95,
    header,
    items: [{ no: 1, description: f("ค่าบริการ"), quantity: f("2"), unitPrice: f("5000.00"), amount: f("10000.00") }],
    raw: {},
  };
}

describe("ExtractionResult (design D2)", () => {
  it("มี field หัวเอกสารครบตาม spec document-extraction", () => {
    expect(HEADER_FIELDS).toEqual([
      "invoiceNo", "invoiceDate", "vendorName", "vendorTaxId", "vendorBranch", "buyerTaxId", "buyerBranch",
      "subtotal", "discount", "vatBase", "vatRate", "vatAmount", "vatExempt", "grandTotal",
      "whtBase", "whtRate", "whtAmount", "netPayable",
    ]);
  });

  it("รับผลที่ถูกรูปแบบ", () => {
    expect(() => parseExtractionResult(sample())).not.toThrow();
  });

  it("ปฏิเสธยอดเงินที่เป็น number", () => {
    const r = sample() as unknown as { header: { grandTotal: { value: unknown } } };
    r.header.grandTotal.value = 10700;
    expect(() => parseExtractionResult(r)).toThrow();
  });

  it("ปฏิเสธยอดเงินทศนิยมเกิน 2 ตำแหน่ง", () => {
    const r = sample();
    r.header.grandTotal.value = "10700.005";
    expect(() => parseExtractionResult(r)).toThrow(/ทศนิยม/);
  });

  it.each(["2569-10-15", "15/10/2026", "2026-13-01"])("ปฏิเสธวันที่ %s", (d) => {
    const r = sample();
    r.header.invoiceDate.value = d;
    expect(() => parseExtractionResult(r)).toThrow();
  });

  it("ปฏิเสธพิกัด bbox นอกช่วง 0–1", () => {
    const r = sample();
    r.header.invoiceNo.bbox = { page: 1, x: 1.2, y: 0, w: 0.1, h: 0.1 };
    expect(() => parseExtractionResult(r)).toThrow();
  });

  it("field ที่ไม่พบเป็นค่าว่าง", () => {
    expect(parseExtractionResult(sample()).header.whtAmount.value).toBeNull();
  });

});
