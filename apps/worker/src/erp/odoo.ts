// สร้างใบแจ้งหนี้ซื้อแบบร่างใน Odoo (spec erp-sync "Odoo vendor bill content", design D3)
import Decimal from "decimal.js";
import { withholdingNote, type ErpAdapter, type ErpAttachment, type ErpPayload, type ErpPushResult } from "@sdes/core";
import { syncPermanent } from "./errors.js";
import type { OdooClient } from "./odoo-client.js";

export type OdooAccounts = { journalId: number | null; purchaseTaxId: number | null; expenseAccountId: number | null };

/** ข้อความนำหน้าหมายเหตุเมื่อยอดใน Odoo ไม่ตรงกับเอกสาร — ให้ฝ่ายบัญชีเห็นว่าต้องตรวจ */
export const MISMATCH_FLAG = "[SDES: ยอดไม่ตรง ต้องตรวจ]";

type Move = { id: number; amount_total: number; narration: string | false };
type Partner = { id: number; ref: string | false };

export class OdooErpAdapter implements ErpAdapter {
  readonly name = "odoo";

  constructor(
    private readonly client: OdooClient,
    private readonly accounts: OdooAccounts,
  ) {}

  async push(p: ErpPayload, attachment?: ErpAttachment): Promise<ErpPushResult> {
    if (!p.totals.vatExempt && !this.accounts.purchaseTaxId) throw syncPermanent("ยังไม่ได้ตั้งรหัสภาษีซื้อ 7% ของ Odoo ในหน้าตั้งค่า ERP");
    const partnerId = await this.partner(p);

    // กันซ้ำ: ใบที่สร้างจากเอกสารนี้มี invoice_origin = เลขเอกสารระบบ (spec "No duplicate records in ERP")
    const existing = await this.client.searchRead<Move>(
      "account.move",
      [["move_type", "=", "in_invoice"], ["invoice_origin", "=", p.docNo]],
      ["id", "amount_total", "narration"],
      1,
    );
    const reused = existing.length > 0;
    const moveId = reused ? existing[0]!.id : await this.client.create("account.move", this.billValues(p, partnerId));

    if (attachment) await this.attach(moveId, attachment);

    const [move] = await this.client.read<Move>("account.move", [moveId], ["amount_total", "narration"]);
    const expected = new Decimal(p.totals.grandTotal);
    const actual = new Decimal(move?.amount_total ?? 0);
    if (actual.minus(expected).abs().gt("0.01")) {
      const narration = typeof move?.narration === "string" ? move.narration : "";
      if (!narration.includes(MISMATCH_FLAG)) await this.client.write("account.move", [moveId], { narration: `${MISMATCH_FLAG} ${narration}`.trim() });
      throw syncPermanent(
        `ยอดรวมของใบแจ้งหนี้ใน Odoo (${actual.toFixed(2)}) ไม่ตรงกับเอกสาร (${expected.toFixed(2)}) — ใบแจ้งหนี้ร่าง id ${moveId} ถูกระบุให้ตรวจ`,
      );
    }
    return { transactionId: String(moveId), reused, partnerId: String(partnerId) };
  }

  /** หาคู่ค้าจาก Tax ID (+ สาขาใน ref) หรือสร้างใหม่ (spec "Vendor partner in ERP") */
  private async partner(p: ErpPayload): Promise<number> {
    if (p.vendor.erpPartnerId) return Number(p.vendor.erpPartnerId);
    const found = await this.client.searchRead<Partner>("res.partner", [["vat", "=", p.vendor.taxId]], ["id", "ref"], 20);
    const match = found.find((x) => x.ref === p.vendor.branch) ?? found[0];
    if (match) return match.id;
    return this.client.create("res.partner", { name: p.vendor.name, vat: p.vendor.taxId, is_company: true, ref: p.vendor.branch });
  }

  billValues(p: ErpPayload, partnerId: number) {
    const taxIds = p.totals.vatExempt ? [] : [this.accounts.purchaseTaxId];
    const line = (name: string, quantity: number, priceUnit: string) => [
      0,
      0,
      {
        name,
        quantity,
        price_unit: Number(priceUnit),
        tax_ids: [[6, 0, taxIds]],
        ...(this.accounts.expenseAccountId ? { account_id: this.accounts.expenseAccountId } : {}),
      },
    ];
    const lines: unknown[] = [];
    for (const l of p.lines) {
      lines.push(line(l.description, Number(l.quantity), l.unitPrice));
      // ส่วนลดเป็นบรรทัดติดลบที่มีภาษีเดียวกัน — ส่วนลดแบบ % ของ Odoo มีทศนิยมจำกัดและทำให้ยอดเพี้ยนได้
      if (!new Decimal(l.discount).isZero()) lines.push(line(`ส่วนลด: ${l.description}`, 1, new Decimal(l.discount).negated().toFixed(2)));
    }
    if (!new Decimal(p.totals.discount).isZero()) lines.push(line("ส่วนลดท้ายบิล", 1, new Decimal(p.totals.discount).negated().toFixed(2)));

    const notes = [`สร้างจาก SDES ${p.docNo}`, withholdingNote(p)].filter(Boolean).join("\n");
    return {
      move_type: "in_invoice",
      partner_id: partnerId,
      invoice_date: p.invoice.date,
      ref: p.invoice.number,
      invoice_origin: p.docNo,
      narration: notes,
      ...(this.accounts.journalId ? { journal_id: this.accounts.journalId } : {}),
      invoice_line_ids: lines,
    };
  }

  private async attach(moveId: number, a: ErpAttachment) {
    const exists = await this.client.searchRead<{ id: number }>(
      "ir.attachment",
      [["res_model", "=", "account.move"], ["res_id", "=", moveId], ["name", "=", a.name]],
      ["id"],
      1,
    );
    if (exists.length) return;
    await this.client.create("ir.attachment", {
      name: a.name,
      datas: Buffer.from(a.data).toString("base64"),
      res_model: "account.move",
      res_id: moveId,
      mimetype: a.mimeType,
    });
  }
}
