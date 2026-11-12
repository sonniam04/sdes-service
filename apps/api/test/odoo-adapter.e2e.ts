// OdooErpAdapter กับ Odoo จริง (compose profile odoo + docker/odoo/setup.sh) — phase 3 task 3.2
// รันเมื่อตั้ง ODOO_TEST_URL, ODOO_TEST_API_KEY, ODOO_TEST_JOURNAL_ID, ODOO_TEST_TAX_ID, ODOO_TEST_ACCOUNT_ID
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OdooErpAdapter, createOdooClient, MISMATCH_FLAG, type ErpPayload, type OdooClient } from "@sdes/core";

const e = process.env;
const run = Boolean(e.ODOO_TEST_URL && e.ODOO_TEST_API_KEY);

/** เลขประจำตัวผู้เสียภาษีสุ่มที่ผ่าน mod 11 (ผู้ขายใหม่ทุกครั้ง) */
function taxId() {
  let b = "0105";
  while (b.length < 12) b += String(Math.floor(Math.random() * 10));
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(b[i]) * (13 - i);
  return b + ((11 - (s % 11)) % 10);
}

function payload(over: Partial<ErpPayload> = {}, totals: Partial<ErpPayload["totals"]> = {}): ErpPayload {
  const id = randomUUID();
  return {
    idempotencyKey: `sdes:${id}`,
    documentId: id,
    docNo: `QA-${id.slice(0, 8)}`,
    vendor: { name: "บริษัท ผู้ขายทดสอบ Odoo จำกัด", taxId: taxId(), branch: "00000", erpPartnerId: null },
    invoice: { number: `INV-${id.slice(0, 6)}`, date: "2026-10-15" },
    currency: "THB",
    lines: [
      { description: "ค่าบริการ", quantity: "1", unitPrice: "6000.00", discount: "0.00", amount: "6000.00" },
      { description: "กระดาษ A4", quantity: "40", unitPrice: "100.00", discount: "0.00", amount: "4000.00" },
    ],
    totals: { subtotal: "10000.00", discount: "0.00", vatBase: "10000.00", vatRate: "7", vatAmount: "700.00", vatExempt: false, grandTotal: "10700.00", ...totals },
    withholding: null,
    ...over,
  };
}

type Move = { id: number; amount_total: number; amount_tax: number; state: string; ref: string; narration: string | false; partner_id: [number, string]; invoice_line_ids: number[] };

describe.skipIf(!run)("OdooErpAdapter กับ Odoo จริง (spec erp-sync)", () => {
  const client: OdooClient = createOdooClient({ url: e.ODOO_TEST_URL!, apiMode: "json2", apiKey: e.ODOO_TEST_API_KEY! });
  const adapter = new OdooErpAdapter(client, {
    journalId: Number(e.ODOO_TEST_JOURNAL_ID),
    purchaseTaxId: Number(e.ODOO_TEST_TAX_ID),
    expenseAccountId: Number(e.ODOO_TEST_ACCOUNT_ID),
  });
  const move = async (id: string) => (await client.read<Move>("account.move", [Number(id)], ["amount_total", "amount_tax", "state", "ref", "narration", "partner_id", "invoice_line_ids"]))[0]!;
  const pdf = { name: "invoice.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4\n%%EOF\n") };

  it("ใบกำกับภาษีมี VAT: ใบแจ้งหนี้ร่างสองบรรทัด ภาษีซื้อ 7% ยอดรวม 10,700.00 และมีไฟล์แนบ", async () => {
    const p = payload();
    const r = await adapter.push(p, pdf);
    expect(r.reused).toBe(false);
    const m = await move(r.transactionId);
    expect(m).toMatchObject({ amount_total: 10700, amount_tax: 700, state: "draft", ref: p.invoice.number });
    expect(m.invoice_line_ids).toHaveLength(2);
    const att = await client.searchRead("ir.attachment", [["res_model", "=", "account.move"], ["res_id", "=", m.id]], ["name"]);
    expect(att).toEqual([expect.objectContaining({ name: "invoice.pdf" })]);
  });

  it("ส่งซ้ำได้ใบเดิม (reused) และ Odoo มีใบของเอกสารนี้ใบเดียว ไฟล์แนบไม่ซ้ำ", async () => {
    const p = payload();
    const a = await adapter.push(p, pdf);
    const b = await adapter.push(p, pdf);
    expect(b).toMatchObject({ transactionId: a.transactionId, reused: true });
    expect(await client.searchRead("account.move", [["invoice_origin", "=", p.docNo]], ["id"])).toHaveLength(1);
    expect(await client.searchRead("ir.attachment", [["res_model", "=", "account.move"], ["res_id", "=", Number(a.transactionId)]], ["id"])).toHaveLength(1);
  });

  it("หัก ณ ที่จ่ายอยู่ในหมายเหตุ ยอดรวมยังเป็น 10,700.00", async () => {
    const p = payload({ withholding: { base: "6000.00", rate: "3", amount: "180.00", netPayable: "10520.00" } });
    const m = await move((await adapter.push(p)).transactionId);
    expect(m.amount_total).toBe(10700);
    expect(String(m.narration)).toContain("หัก ณ ที่จ่าย 3%");
    expect(String(m.narration)).toContain("10,520.00");
  });

  it("ส่วนลดของบรรทัดและท้ายบิลเป็นบรรทัดติดลบ ยอดตรงทุกสตางค์", async () => {
    const p = payload(
      {
        lines: [
          { description: "จอภาพ", quantity: "3", unitPrice: "3333.33", discount: "99.99", amount: "9900.00" },
          { description: "สาย LAN", quantity: "1", unitPrice: "100.00", discount: "0.00", amount: "100.00" },
        ],
      },
      { subtotal: "10000.00", discount: "500.00", vatBase: "9500.00", vatAmount: "665.00", grandTotal: "10165.00" },
    );
    const m = await move((await adapter.push(p)).transactionId);
    expect(m.amount_total).toBe(10165);
    expect(m.invoice_line_ids).toHaveLength(4);
  });

  it("เอกสารยกเว้น VAT ไม่มีภาษี", async () => {
    const p = payload({}, { vatExempt: true, vatBase: "0.00", vatRate: "0", vatAmount: "0.00", grandTotal: "10000.00" });
    const m = await move((await adapter.push(p)).transactionId);
    expect(m).toMatchObject({ amount_total: 10000, amount_tax: 0 });
  });

  it("ผู้ขายรายใหม่ถูกสร้างครั้งเดียว ฉบับถัดไปใช้คู่ค้าเดิม; ผู้ขายที่มีใน Odoo แล้วไม่ถูกสร้างซ้ำ", async () => {
    const vendor = { name: "บริษัท คู่ค้าใหม่ จำกัด", taxId: taxId(), branch: "00000", erpPartnerId: null };
    const first = await adapter.push(payload({ vendor }));
    expect(await client.searchRead("res.partner", [["vat", "=", vendor.taxId]], ["id"])).toHaveLength(1);
    const second = await adapter.push(payload({ vendor }));
    expect(second.partnerId).toBe(first.partnerId);
    expect(await client.searchRead("res.partner", [["vat", "=", vendor.taxId]], ["id"])).toHaveLength(1);
  });

  it("ยอดใน Odoo ไม่ตรงกับเอกสาร → ข้อผิดพลาดถาวรบอกทั้งสองยอด และใบร่างถูกระบุให้ตรวจ", async () => {
    const p = payload({}, { grandTotal: "10800.00" });
    const err = await adapter.push(p).catch((x: unknown) => x);
    expect(err).toMatchObject({ permanent: true, message: expect.stringMatching(/10700\.00.*10800\.00/) });
    const [m] = await client.searchRead<Move>("account.move", [["invoice_origin", "=", p.docNo]], ["narration"]);
    expect(String(m!.narration)).toContain(MISMATCH_FLAG);
  });
});
