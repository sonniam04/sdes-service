import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_THRESHOLDS, assessRisk, isMoneyField, type RiskInput } from "./index.js";

const clean: RiskInput = { confidence: 0.97, grandTotal: "10700.00", isNewVendor: false, editedFields: [], issues: [] };
const codes = (over: Partial<RiskInput>, t = DEFAULT_RISK_THRESHOLDS) => assessRisk({ ...clean, ...over }, t).map((f) => f.code);

describe("assessRisk (spec risk-assessment)", () => {
  it("เคสไม่เสี่ยงไม่มีเหตุผล", () => {
    expect(codes({})).toEqual([]);
  });

  it("ความมั่นใจต่ำ พร้อมค่าและเกณฑ์ ณ เวลาประเมิน", () => {
    const [flag] = assessRisk({ ...clean, confidence: 0.8 }, DEFAULT_RISK_THRESHOLDS);
    expect(flag).toEqual({ code: "LOW_CONFIDENCE", message: "ความมั่นใจของ AI ต่ำกว่า 85%", value: 0.8, threshold: 0.85 });
  });

  it("ความมั่นใจเท่าเกณฑ์พอดีไม่นับว่าต่ำ", () => {
    expect(codes({ confidence: 0.85 })).toEqual([]);
  });

  it("ไม่มีผลการอ่านนับเป็นความมั่นใจต่ำ", () => {
    expect(codes({ confidence: null })).toEqual(["LOW_CONFIDENCE"]);
  });

  it("แก้ยอดเงิน พร้อมชื่อ field", () => {
    const flags = assessRisk({ ...clean, editedFields: ["header.grandTotal", "header.invoiceNo", "items[1].amount"] }, DEFAULT_RISK_THRESHOLDS);
    expect(flags).toEqual([
      { code: "MONEY_EDITED", message: "มีการแก้ยอดเงินหลังการอ่าน", value: ["header.grandTotal", "items[1].amount"] },
    ]);
  });

  it("แก้เฉพาะเลขที่เอกสารไม่นับเป็นแก้ยอดเงิน", () => {
    expect(codes({ editedFields: ["header.invoiceNo", "items[0].description"] })).toEqual([]);
  });

  it("ยังไม่ได้ตั้งเกณฑ์ยอดสูง กฎอื่นยังทำงาน", () => {
    expect(codes({ grandTotal: "99999999.00", isNewVendor: true })).toEqual(["NEW_VENDOR"]);
  });

  it("ยอดสูงกว่าเกณฑ์", () => {
    const t = { ...DEFAULT_RISK_THRESHOLDS, highAmount: "500000.00" };
    expect(codes({ grandTotal: "500000.01" }, t)).toEqual(["HIGH_AMOUNT"]);
    expect(codes({ grandTotal: "500000.00" }, t)).toEqual([]);
  });

  it("ผู้ขายรายใหม่", () => {
    expect(codes({ isNewVendor: true })).toEqual(["NEW_VENDOR"]);
  });

  it("มี WARNING ค้าง (ERROR ไม่นับเพราะยืนยันไม่ได้อยู่แล้ว)", () => {
    const flags = assessRisk(
      { ...clean, issues: [{ code: "BRANCH_MISSING", severity: "WARNING", message: "", fields: [] }] },
      DEFAULT_RISK_THRESHOLDS,
    );
    expect(flags).toEqual([{ code: "OPEN_WARNINGS", message: "มีรายการที่ต้องตรวจค้างอยู่", value: ["BRANCH_MISSING"] }]);
  });

  it.each([
    ["header.vatAmount", true],
    ["header.vatRate", true],
    ["items[3].unitPrice", true],
    ["items", true],
    ["items[2]", true],
    ["header.vendorName", false],
    ["header.invoiceDate", false],
    ["items[0].description", false],
  ])("isMoneyField(%s) = %s", (path, expected) => {
    expect(isMoneyField(path)).toBe(expected);
  });
});
