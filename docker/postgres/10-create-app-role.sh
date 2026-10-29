#!/bin/sh
# สร้าง role ของแอป (ไม่ใช่ owner) ตอน init ฐานข้อมูลครั้งแรก — สิทธิ์ทั้งหมดกำหนดใน migration
set -e
psql -v ON_ERROR_STOP=1 -v app_password="$POSTGRES_APP_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE sdes_app LOGIN PASSWORD :'app_password';
SQL
