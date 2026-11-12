# Odoo สำหรับ dev/E2E + ฟอนต์ไทย — ไม่มีฟอนต์ไทย PDF ของ Odoo (เช่น ใบแจ้งการชำระเงิน) จะแสดงอักษรไทยเป็นกล่อง
FROM odoo:19
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-thai-tlwg \
 && rm -rf /var/lib/apt/lists/*
USER odoo
