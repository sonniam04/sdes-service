import { describe, expect, it } from "vitest";
import { asDocumentData, emptyHeader, hasErrors, toDocumentData, validateDocument, type DocumentData, type ValidationContext } from "./index.js";

const COMPANY = "0994000165617";
const ctx: ValidationContext = { companyTaxId: COMPANY, uploadedAt: "2026-10-29T03:00:00Z" };

function doc(over: Partial<DocumentData> = {}): DocumentData {
  return {
    invoiceNo: "INV-2026-001",
    invoiceDate: "2026-10-15",
    vendorName: "บริษัท ตัวอย่าง จำกัด",
    vendorTaxId: "0105536000011",
    vendorBranch: "00000",
    buyerTaxId: COMPANY,
    buyerBranch: "00000",
    subtotal: "10000.00",
    discount: "0.00",
    vatBase: "10000.00",
    vatRate: "7",
    vatAmount: "700.00",
    vatExempt: false,
    grandTotal: "10700.00",
    whtBase: null,
    whtRate: null,
    whtAmount: null,
    netPayable: null,
    items: [{ no: 1, description: "ค่าบริการ", quantity: "2", unitPrice: "5000.00", amount: "10000.00" }],
    ...over,
  };
}
const codes = (d: DocumentData, c = ctx) => validateDocument(d, c).map((i) => `${i.severity}:${i.code}`);
const issue = (d: DocumentData, code: string, c = ctx) => validateDocument(d, c).find((i) => i.code === code);

describe("validateDocument (spec invoice-validation)", () => {
  it("เอกสารถูกต้องไม่มีรายการ", () => {
    expect(codes(doc())).toEqual([]);
  });

  describe("Monetary tolerance", () => {
    it("ต่างกันหนึ่งสตางค์ผ่าน", () => {
      expect(codes(doc({ grandTotal: "10700.01" }))).toEqual([]);
    });
    it("ต่างกันสองสตางค์เป็น ERROR", () => {
      expect(codes(doc({ grandTotal: "10700.02" }))).toContain("ERROR:GRAND_TOTAL");
    });
    it("ไม่ใช้ทศนิยมลอยตัว (0.1 + 0.2)", () => {
      const d = doc({
        subtotal: "0.30",
        vatBase: "0.30",
        vatAmount: "0.02",
        grandTotal: "0.32",
        items: [
          { no: 1, description: "a", quantity: "1", unitPrice: "0.10", amount: "0.10" },
          { no: 2, description: "b", quantity: "1", unitPrice: "0.20", amount: "0.20" },
        ],
      });
      expect(codes(d)).toEqual([]);
    });
  });

  describe("Line items total", () => {
    it("ผลรวมบรรทัดไม่ตรง", () => {
      const d = doc({
        items: [
          { no: 1, description: "a", quantity: "1", unitPrice: "4500.00", amount: "4500.00" },
          { no: 2, description: "b", quantity: "1", unitPrice: "3000.00", amount: "3000.00" },
          { no: 3, description: "c", quantity: "1", unitPrice: "2000.00", amount: "2000.00" },
        ],
      });
      const i = issue(d, "LINES_TOTAL");
      expect(i?.severity).toBe("ERROR");
      expect(i?.fields).toEqual(["header.subtotal", "items"]);
    });
    it("บรรทัดคูณไม่ตรง", () => {
      const d = doc({
        subtotal: "700.00",
        vatBase: "700.00",
        vatAmount: "49.00",
        grandTotal: "749.00",
        items: [{ no: 1, description: "a", quantity: "3", unitPrice: "250.00", amount: "700.00" }],
      });
      expect(issue(d, "LINE_AMOUNT")?.fields).toEqual(["items[0].amount"]);
    });
    it("หักส่วนลดของบรรทัด", () => {
      const d = doc({ items: [{ no: 1, description: "a", quantity: "2", unitPrice: "5100.00", discount: "200.00", amount: "10000.00" }] });
      expect(codes(d)).toEqual([]);
    });
  });

  describe("Grand total (tier 1)", () => {
    it("ยอดรวมผิดชี้ที่ยอดรวม", () => {
      const i = issue(doc({ grandTotal: "10070.00" }), "GRAND_TOTAL");
      expect(i).toMatchObject({ severity: "ERROR", message: "ยอดรวมไม่ตรงกับยอดก่อนภาษีบวก VAT", fields: ["header.grandTotal"] });
    });
    it("หักส่วนลดท้ายบิล", () => {
      expect(codes(doc({ discount: "1000.00", vatBase: "9000.00", vatAmount: "630.00", grandTotal: "9630.00" }))).toEqual([]);
    });
    it("ฐานภาษีมากกว่ายอดหลังส่วนลด", () => {
      expect(codes(doc({ vatBase: "10500.00", vatAmount: "735.00", grandTotal: "10735.00" }))).toContain("ERROR:VAT_BASE");
    });
    it("ฐานภาษีน้อยกว่า (มียอดไม่คิด VAT) เป็น WARNING", () => {
      expect(codes(doc({ vatBase: "8000.00", vatAmount: "560.00", grandTotal: "10560.00" }))).toEqual(["WARNING:VAT_BASE_PARTIAL"]);
    });
  });

  describe("VAT rate", () => {
    it("VAT ไม่ใช่ 7%", () => {
      expect(issue(doc({ vatAmount: "1000.00", grandTotal: "11000.00" }), "VAT_AMOUNT")?.fields).toEqual(["header.vatAmount"]);
    });
    it("ยกเว้น VAT ยอด 0 ผ่าน", () => {
      expect(codes(doc({ vatExempt: true, vatBase: "0.00", vatRate: "0", vatAmount: "0.00", grandTotal: "10000.00" }))).toEqual([]);
    });
    it("ยกเว้น VAT แต่มียอด VAT", () => {
      expect(codes(doc({ vatExempt: true, vatBase: "0.00", vatRate: "0" }))).toContain("ERROR:VAT_EXEMPT");
    });
    it("อัตราที่ระบุไม่ใช่ 7 หรือ 0 เป็น WARNING", () => {
      expect(codes(doc({ vatRate: "10" }))).toEqual(["WARNING:VAT_RATE"]);
    });
  });

  describe("Net payable (tier 2)", () => {
    const wht = { whtBase: "5000.00", whtRate: "3", whtAmount: "150.00", netPayable: "10550.00" };
    it("หัก 3% ของค่าบริการผ่าน", () => {
      expect(codes(doc(wht))).toEqual([]);
    });
    it("คิดหักจากยอดรวมทั้งใบ", () => {
      expect(issue(doc({ ...wht, whtAmount: "321.00", netPayable: "10379.00" }), "WHT_AMOUNT")?.fields).toEqual(["header.whtAmount"]);
    });
    it("ยอดจ่ายสุทธิไม่ตรง", () => {
      expect(codes(doc({ ...wht, netPayable: "10700.00" }))).toContain("ERROR:NET_PAYABLE");
    });
    it("ฐานหักมากกว่ายอดก่อนภาษี", () => {
      expect(codes(doc({ ...wht, whtBase: "12000.00", whtAmount: "360.00", netPayable: "10340.00" }))).toContain("ERROR:WHT_BASE");
    });
    it("มียอดหักแต่ไม่มียอดจ่ายสุทธิ", () => {
      expect(codes(doc({ ...wht, netPayable: null }))).toContain("ERROR:NET_PAYABLE_MISSING");
    });
  });

  describe("Tax ID และสาขา", () => {
    it("หลักตรวจสอบผิด", () => {
      expect(issue(doc({ vendorTaxId: "0105536000014" }), "TAX_ID_INVALID")).toMatchObject({
        message: "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง",
        fields: ["header.vendorTaxId"],
      });
    });
    it("ไม่ระบุสาขาเป็น WARNING", () => {
      expect(codes(doc({ vendorBranch: null }))).toEqual(["WARNING:BRANCH_MISSING"]);
    });
    it("รหัสสาขาผิดรูปแบบ", () => {
      expect(codes(doc({ vendorBranch: "สนญ" }))).toContain("ERROR:BRANCH_INVALID");
    });
  });

  describe("Buyer is our company", () => {
    it("ใบกำกับออกให้บริษัทอื่น", () => {
      expect(issue(doc({ buyerTaxId: "0105536000011" }), "BUYER_MISMATCH")).toMatchObject({
        severity: "ERROR",
        message: "ใบกำกับภาษีไม่ได้ออกให้บริษัท",
        fields: ["header.buyerTaxId"],
      });
    });
    it("ไม่มี Tax ID ผู้ซื้อ", () => {
      expect(codes(doc({ buyerTaxId: null }))).toContain("ERROR:BUYER_MISMATCH");
    });
    it("ยังไม่ได้ตั้ง Tax ID บริษัท", () => {
      expect(codes(doc(), { ...ctx, companyTaxId: null })).toEqual(["WARNING:COMPANY_TAX_ID_NOT_SET"]);
    });
  });

  it("เลขที่ซ้ำกับเอกสารที่ยืนยันแล้ว", () => {
    expect(issue(doc(), "DUPLICATE_INVOICE", { ...ctx, duplicateDocNo: "DOC-000120" })?.message).toBe(
      "เลขที่เอกสารนี้เคยบันทึกแล้วใน DOC-000120",
    );
  });

  describe("Required fields and dates", () => {
    it("ไม่มีวันที่", () => {
      expect(issue(doc({ invoiceDate: null }), "REQUIRED")?.fields).toEqual(["header.invoiceDate"]);
    });
    it.each(["invoiceNo", "vendorTaxId", "grandTotal"] as const)("ไม่มี %s", (k) => {
      expect(validateDocument(doc({ [k]: null }), ctx).some((i) => i.code === "REQUIRED" && i.fields[0] === `header.${k}`)).toBe(true);
    });
    it("เอกสารเก่ากว่า 6 เดือน", () => {
      expect(codes(doc({ invoiceDate: "2026-02-28" }))).toEqual(["WARNING:DATE_OLD"]);
    });
    it("เก่า 6 เดือนพอดีไม่เตือน", () => {
      expect(codes(doc({ invoiceDate: "2026-04-29" }))).toEqual([]);
    });
    it("วันที่ในอนาคต (ตามเวลาไทย)", () => {
      expect(codes(doc({ invoiceDate: "2026-10-30" }))).toEqual(["WARNING:DATE_FUTURE"]);
      // 20:00 UTC ของวันที่ 29 คือวันที่ 30 ตามเวลาไทยแล้ว จึงไม่ใช่อนาคต
      expect(codes(doc({ invoiceDate: "2026-10-30" }), { ...ctx, uploadedAt: "2026-10-29T20:00:00Z" })).toEqual([]);
    });
  });

  it("ตัวเลขผิดรูปแบบเป็น ERROR และไม่ถูกนำไปคำนวณ", () => {
    expect(codes(doc({ vatAmount: "7OO.00" }))).toEqual(["ERROR:NUMBER_FORMAT"]);
  });

  it("hasErrors แยก ERROR กับ WARNING", () => {
    expect(hasErrors(validateDocument(doc({ vendorBranch: null }), ctx))).toBe(false);
    expect(hasErrors(validateDocument(doc({ grandTotal: "1" }), ctx))).toBe(true);
  });

  it("toDocumentData แปลงผลการอ่าน", () => {
    const header = emptyHeader();
    header.grandTotal = { value: "10700.00", confidence: 0.9, bbox: null };
    header.vatExempt = { value: true, confidence: 0.9, bbox: null };
    const d = toDocumentData({ header, items: [] });
    expect(d.grandTotal).toBe("10700.00");
    expect(d.vatExempt).toBe(true);
    expect(d.invoiceNo).toBeNull();
  });
});

describe("asDocumentData — ข้อมูล jsonb จากฐาน", () => {
  it("แถวเก่าที่เป็น {} ได้ทุก field เป็นค่าว่างและรายการว่าง แล้วตรวจได้โดยไม่ throw", () => {
    const d = asDocumentData({});
    expect(d.items).toEqual([]);
    expect(d.grandTotal).toBeNull();
    expect(d.vatExempt).toBe(false);
    expect(() => validateDocument(d, { companyTaxId: null, uploadedAt: "2026-10-29T00:00:00Z" })).not.toThrow();
  });

  it("null หรือค่าที่ไม่ใช่ object ก็ได้ข้อมูลว่าง", () => {
    for (const v of [null, undefined, "x", 3, []]) expect(asDocumentData(v).items).toEqual([]);
  });

  it("ข้อมูลครบคืนค่าเดิม", () => {
    const full = { ...asDocumentData({}), invoiceNo: "IV-1", grandTotal: "10.00", vatExempt: true, items: [{ no: 1, description: "a", quantity: "1", unitPrice: "10.00", discount: null, vat: null, amount: "10.00" }] };
    expect(asDocumentData(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });
});
