#!/bin/sh
# เตรียม Odoo สำหรับ dev/E2E (design D10) — รันจากโฟลเดอร์ Service/:  sh docker/odoo/setup.sh
# สร้างฐาน sdes_erp (account + l10n_th) ถ้ายังไม่มี แล้วพิมพ์ API key ใหม่และ id ที่ต้องใส่ในหน้าตั้งค่า ERP
# API key แสดงครั้งเดียว ไม่ถูกเขียนลงไฟล์ — รันซ้ำได้ (ได้ key ใหม่ทุกครั้ง)
set -e
DC="docker compose --profile odoo"
$DC up -d --wait odoo-db
$DC run --rm -T odoo odoo -d sdes_erp -i account,l10n_th --stop-after-init >/dev/null 2>&1
$DC run --rm -T odoo odoo shell -d sdes_erp --no-http < docker/odoo/setup.py 2>/dev/null | grep '^SDES_SETUP ' | sed 's/^SDES_SETUP //'
$DC up -d --wait odoo
