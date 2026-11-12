import { describe, expect, it } from "vitest";
import { isValidBranchCode, isValidTaxId, normalizeTaxId } from "./index.js";

describe("Tax ID (spec invoice-validation)", () => {
  it.each(["0105536000011", "3101400478778", "0994000165617"])("เลขถูกต้อง %s", (id) => {
    expect(isValidTaxId(id)).toBe(true);
  });

  it("หลักสุดท้ายผิด", () => {
    expect(isValidTaxId("0105536000014")).toBe(false);
  });

  it.each(["010553600001", "01055360000113", "", "01055360000A3"])("ความยาวหรืออักขระผิด %s", (id) => {
    expect(isValidTaxId(id)).toBe(false);
  });

  it("ยอมรับขีดและช่องว่างที่คั่นไว้", () => {
    expect(normalizeTaxId("0-1055-36000-01-1")).toBe("0105536000011");
    expect(isValidTaxId("0 1055 36000 01 1")).toBe(true);
  });

  it.each([
    ["00000", true],
    ["00012", true],
    ["0000", false],
    ["สำนักงานใหญ่", false],
  ])("รหัสสาขา %s → %s", (code, ok) => {
    expect(isValidBranchCode(code)).toBe(ok);
  });
});
