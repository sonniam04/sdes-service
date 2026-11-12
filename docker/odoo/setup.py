# ตั้งค่า Odoo สำหรับ dev/E2E (design D10) — รันผ่าน `odoo shell` โดย docker/odoo/setup.sh
# บริษัทไทย + ผังบัญชีไทย, ผู้ใช้ sdes-integration (สิทธิ์ Billing) และ API key ใหม่หนึ่งชุด
import json
from datetime import timedelta
from odoo import fields

company = env.company
company.write({"name": "บริษัท ทดสอบระบบบัญชี จำกัด", "country_id": env.ref("base.th").id, "vat": "0994000165617"})
if company.chart_template != "th":
    env["account.chart.template"].try_loading("th", company, install_demo=False)

journal = env["account.journal"].search([("type", "=", "purchase"), ("company_id", "=", company.id)], limit=1)
tax = env["account.tax"].search(
    [("type_tax_use", "=", "purchase"), ("amount", "=", 7), ("amount_type", "=", "percent"), ("price_include", "=", False), ("company_id", "=", company.id)],
    limit=1,
)
account = env["account.account"].search([("account_type", "=", "expense")], limit=1)

# Billing (สร้างใบแจ้งหนี้ซื้อ) + Contact/Creation (สร้างคู่ค้าใหม่อัตโนมัติ) — ไม่ใช่ผู้ดูแลระบบ
groups = [env.ref("base.group_user").id, env.ref("account.group_account_invoice").id, env.ref("base.group_partner_manager").id]
user = env["res.users"].search([("login", "=", "sdes-integration")], limit=1)
if not user:
    user = env["res.users"].create({"name": "SDES Integration", "login": "sdes-integration", "group_ids": [(6, 0, groups)]})
else:
    user.write({"group_ids": [(4, g) for g in groups]})
key = env["res.users.apikeys"].with_user(user)._generate(None, "sdes-integration", fields.Datetime.now() + timedelta(days=90))
env.cr.commit()

print("SDES_SETUP " + json.dumps({
    "apiKey": key,
    "login": user.login,
    "journalId": journal.id, "journal": journal.name,
    "purchaseTaxId": tax.id, "tax": tax.name,
    "expenseAccountId": account.id, "account": account.display_name,
}, ensure_ascii=False))
