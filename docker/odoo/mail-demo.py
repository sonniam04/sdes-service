# ตั้ง Odoo dev ให้ส่งอีเมลแจ้งการชำระเงินถึงผู้ขายอัตโนมัติ — รันผ่าน `odoo shell` โดย docker/odoo/mail-demo.sh
# อีเมลทั้งหมดไปที่ Mailpit (ไม่ส่งออกจริง) · ผู้ขายที่ยังไม่มีอีเมลได้อีเมลสมมติ vendor-<Tax ID>@demo.sdes.local
# รันซ้ำได้ — อัปเดตของเดิมแทนการสร้างใหม่

company = env.company
if not company.email:
    company.email = "ap@demo.sdes.local"
admin = env.ref("base.user_admin")
if not admin.email:
    admin.email = "admin@demo.sdes.local"

server = env["ir.mail_server"].search([("name", "=", "Mailpit (dev)")], limit=1)
vals = {"name": "Mailpit (dev)", "smtp_host": "mailpit", "smtp_port": 1025, "smtp_encryption": "none", "sequence": 1}
server.write(vals) if server else env["ir.mail_server"].create(vals)

vendors = env["res.partner"].search([("supplier_rank", ">", 0), ("email", "in", [False, ""])])
for p in vendors:
    p.email = f"vendor-{p.vat or p.id}@demo.sdes.local"

payment_model = env["ir.model"]._get("account.payment")
template = env["mail.template"].search([("name", "=", "SDES: แจ้งการชำระเงินถึงผู้ขาย")], limit=1)
tvals = {
    "name": "SDES: แจ้งการชำระเงินถึงผู้ขาย",
    "model_id": payment_model.id,
    "email_from": "{{ object.company_id.email_formatted }}",
    "partner_to": "{{ object.partner_id.id }}",
    "subject": "แจ้งการชำระเงิน {{ object.name }} จาก {{ object.company_id.name }}",
    "body_html": """
<div style="font-family: sans-serif; font-size: 14px;">
  <p>เรียน <t t-out="object.partner_id.name"/></p>
  <p><t t-out="object.company_id.name"/> ได้ชำระเงินให้ท่านแล้ว รายละเอียดดังนี้</p>
  <table style="border-collapse: collapse;">
    <tr><td style="padding: 2px 12px 2px 0;">เลขที่การชำระ</td><td><t t-out="object.name"/></td></tr>
    <tr><td style="padding: 2px 12px 2px 0;">วันที่ชำระ</td><td><t t-out="object.date"/></td></tr>
    <tr><td style="padding: 2px 12px 2px 0;">จำนวนเงิน</td><td><t t-out="format_amount(object.amount, object.currency_id)"/></td></tr>
    <tr><td style="padding: 2px 12px 2px 0;">ชำระผ่าน</td><td><t t-out="object.journal_id.name"/></td></tr>
    <tr t-if="object.reconciled_bill_ids"><td style="padding: 2px 12px 2px 0;">สำหรับใบแจ้งหนี้</td>
      <td><t t-out="', '.join(b.ref or b.name for b in object.reconciled_bill_ids)"/></td></tr>
  </table>
  <p>แนบใบแจ้งการชำระเงินมาพร้อมนี้ หากมีข้อสงสัยกรุณาติดต่อฝ่ายบัญชีเจ้าหนี้</p>
  <p>ขอแสดงความนับถือ<br/><t t-out="object.company_id.name"/></p>
</div>""",
    "report_template_ids": [(6, 0, [env.ref("account.action_report_payment_receipt").id])],
    "auto_delete": False,
}
template.write(tvals) if template else (template := env["mail.template"].create(tvals))

# trigger ที่ใบแจ้งหนี้ผู้ขายเมื่อสถานะการชำระเป็น In Payment/Paid — ตอนนั้นการชำระได้เลขจริงและผูกกับใบแล้ว
# (ถ้า trigger ที่ account.payment ตอน post จะยังไม่มีเลขจริงและยังไม่ผูกใบ) · ส่งครั้งเดียวต่อการชำระ (is_sent)
move_model = env["ir.model"]._get("account.move")
NAME = "SDES: ส่งอีเมลแจ้งผู้ขายเมื่อชำระเงิน"
env["base.automation"].search([("name", "=", NAME)]).unlink()
code = f"""template = env["mail.template"].browse({template.id})
for bill in records:
    # matched_payment_ids ยังไม่ถูกผูกตอนที่ payment_state เปลี่ยน — หาจากรายการที่ตัดชำระกันแล้วด้วย
    lines = bill.line_ids
    payments = bill.matched_payment_ids | lines.matched_debit_ids.debit_move_id.payment_id | lines.matched_credit_ids.credit_move_id.payment_id
    for pay in payments:
        if pay.is_sent or pay.state not in ("in_process", "paid"):
            continue
        partner = pay.partner_id
        if not partner.email:
            # dev: ใบกำกับภาษีไม่มีอีเมลผู้ขาย จึงเติมอีเมลสมมติ (อีเมลทั้งหมดไปที่ Mailpit)
            partner.write({{"email": "vendor-%s@demo.sdes.local" % (partner.vat or partner.id)}})
        template.send_mail(pay.id, force_send=True)  # ส่งทันที ไม่รอ cron คิวอีเมล (ชั่วโมงละครั้ง)
        pay.write({{"is_sent": True}})
        bill.message_post(body="ส่งอีเมลแจ้งการชำระเงิน %s ถึง %s แล้ว" % (pay.name, partner.email))
"""
env["base.automation"].create({
    "name": NAME,
    "model_id": move_model.id,
    "trigger": "on_create_or_write",
    "trigger_field_ids": [(6, 0, env["ir.model.fields"]._get("account.move", "payment_state").ids)],
    "filter_pre_domain": "[('payment_state', 'not in', ['in_payment', 'paid'])]",
    "filter_domain": "[('move_type', '=', 'in_invoice'), ('payment_state', 'in', ['in_payment', 'paid'])]",
    "active": True,
    "action_server_ids": [(0, 0, {"name": "ส่งอีเมลแจ้งการชำระเงิน", "model_id": move_model.id, "state": "code", "code": code, "usage": "base_automation"})],
})
env.cr.commit()
print(f"SDES_MAIL ok vendors_with_new_email={len(vendors)} template={template.id}")
