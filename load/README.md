# Load test

ทดสอบ requirement "Concurrent upload capacity" (spec `document-ingestion`) ด้วย k6 ผ่าน Docker ใน WSL โดยไม่ต้องติดตั้ง k6 ในเครื่อง

```sh
# 1. dev stack ต้องรันอยู่ (wsl docker compose up -d) และ build แล้ว (pnpm build)
# 2. สร้างผู้ใช้ AP_CLERK สำหรับ load test — รหัสสุ่มเก็บใน load/.load-user.env (ไม่ commit)
node load/create-load-user.mjs
# 3. ยิง 50 ไฟล์ × 5 MB พร้อมกัน จาก container ใน network เดียวกับ api
wsl docker run --rm --network sdes_default --env-file load/.load-user.env -e API=http://api:3000 \
  -v "$PWD/load:/scripts:ro" grafana/k6:latest run /scripts/upload.k6.js
```

ไฟล์ที่ใช้เป็น byte สุ่มที่ขึ้นต้นด้วย `%PDF-1.7` ไม่ใช่เอกสารจริง เอกสารที่ได้ในฐานข้อมูลจะชื่อ `load-<vu>-<iter>.pdf`

ผลล่าสุดอยู่ที่ `qa/phase1/load-upload.md` ใน repo หลัก
