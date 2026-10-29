import { describe, expect, it } from "vitest";
import { ErpPayloadError, buildErpPayload, withholdingNote, type DocumentData } from "./index.js";

const data = (over: Partial<DocumentData> = {}): DocumentData => ({
  invoiceNo: " INV-2026-001 ",
  invoiceDate: "2026-10-15",
  vendorName: "บริษัท ผู้ขาย จำกัด",
  vendorTaxId: "0-1055-36000-01-1",
  vendorBranch: null,
  buyerTaxId: "0994000165617",
  buyerBranch: "00000",
  subtotal: "10000",
  discount: null,
  vatBase: "10000.00",
  vatRate: "7",
  vatAmount: "700.00",
  vatExempt: false,
  grandTotal: "10700.00",
  whtBase: null,
  whtRate: null,
  whtAmount: null,
  netPayable: null,
  items: [
    { no: 1, description: "ค่าบริการ", quantity: "2", unitPrice: "5100.00", discount: "200.00", amount: "10000.00" },
  ],
  ...over,
});
const doc = (d = data()) => ({ id: "11111111-1111-1111-1111-111111111111", docNo: "DOC-000120", data: d });

describe("buildErpPayload (design D2)", () => {
  it("ยอดทุกชั้นเป็นทศนิยม 2 ตำแหน่ง และ Tax ID/สาขา/เลขที่ถูกทำให้เป็นมาตรฐาน", () => {
    const p = buildErpPayload(doc(), { erpPartnerId: "42" });
    expect(p.totals).toEqual({ subtotal: "10000.00", discount: "0.00", vatBase: "10000.00", vatRate: "7", vatAmount: "700.00", vatExempt: false, grandTotal: "10700.00" });
    expect(p.vendor).toEqual({ name: "บริษัท ผู้ขาย จำกัด", taxId: "0105536000011", branch: "00000", erpPartnerId: "42" });
    expect(p.invoice).toEqual({ number: "INV-2026-001", date: "2026-10-15" });
    expect(p.currency).toBe("THB");
  });

  it("บรรทัดรายการพร้อมส่วนลดของบรรทัด", () => {
    expect(buildErpPayload(doc()).lines).toEqual([{ description: "ค่าบริการ", quantity: "2", unitPrice: "5100.00", discount: "200.00", amount: "10000.00" }]);
  });

  it("idempotency key คงที่ต่อเอกสาร", () => {
    expect(buildErpPayload(doc()).idempotencyKey).toBe(buildErpPayload(doc()).idempotencyKey);
    expect(buildErpPayload(doc()).idempotencyKey).toBe("sdes:11111111-1111-1111-1111-111111111111");
  });

  it("หัก ณ ที่จ่าย และหมายเหตุภาษาไทย", () => {
    const p = buildErpPayload(doc(data({ whtBase: "5000.00", whtRate: "3", whtAmount: "150.00", netPayable: "10550.00" })));
    expect(p.withholding).toEqual({ base: "5000.00", rate: "3", amount: "150.00", netPayable: "10550.00" });
    expect(withholdingNote(p)).toBe("หัก ณ ที่จ่าย 3% จากฐาน 5,000.00 บาท = 150.00 บาท · ยอดจ่ายสุทธิ 10,550.00 บาท");
  });

  it("ไม่มีหัก ณ ที่จ่าย", () => {
    const p = buildErpPayload(doc());
    expect(p.withholding).toBeNull();
    expect(withholdingNote(p)).toBeNull();
  });

  it("ยกเว้น VAT ได้ฐาน/ภาษี/อัตราเป็นศูนย์", () => {
    const p = buildErpPayload(doc(data({ vatExempt: true, vatBase: null, vatAmount: null, vatRate: null, grandTotal: "10000.00" })));
    expect(p.totals).toMatchObject({ vatBase: "0.00", vatAmount: "0.00", vatRate: "0", vatExempt: true });
  });

  it("ข้อมูลบังคับขาดเป็นข้อผิดพลาด", () => {
    expect(() => buildErpPayload(doc(data({ invoiceNo: null })))).toThrow(ErpPayloadError);
    expect(() => buildErpPayload(doc(data({ grandTotal: null })))).toThrow(/ยอดรวม/);
  });
});
