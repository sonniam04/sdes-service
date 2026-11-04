#!/bin/sh
# ให้ Odoo dev ส่งอีเมลแจ้งการชำระเงินถึงผู้ขายอัตโนมัติ (ไปที่ Mailpit http://127.0.0.1:8025) — รันจาก Service/ หลัง setup.sh
#   sh docker/odoo/mail-demo.sh
# รันซ้ำได้ — ผู้ขายที่ Odoo สร้างภายหลังจะได้อีเมลสมมติเมื่อรันอีกครั้ง
set -e
DC="docker compose --profile odoo"
$DC up -d --wait mailpit odoo-db
$DC stop odoo
$DC run --rm -T odoo odoo -d sdes_erp -i base_automation --stop-after-init >/dev/null 2>&1
$DC run --rm -T odoo odoo shell -d sdes_erp --no-http < docker/odoo/mail-demo.py 2>/dev/null | grep '^SDES_MAIL '
$DC up -d --wait odoo
