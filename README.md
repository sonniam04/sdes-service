# sdes-service

Backend ของ SDES — Smart Document Extraction & ERP Sync Pipeline

| ส่วน | หน้าที่ |
|---|---|
| `apps/api` | NestJS REST API + socket.io (`/ws`) — auth, ผู้ใช้, audit, อัปโหลดเอกสาร |
| `apps/worker` | BullMQ worker อ่านข้อมูลเอกสาร (Phase 1 ใช้ `FakeExtractionProvider`) |
| `packages/core` | กติกากลาง: role/สิทธิ์, lifecycle ของเอกสาร, redactor, ชื่อ queue/channel |
| `packages/db` | Prisma schema, migration, seed, `transitionDocument`, `recordAudit` |

เอกสารประกอบ: [docs/data-model.md](docs/data-model.md) · Swagger ที่ `http://127.0.0.1:3000/docs` เมื่อรันแล้ว

## สิ่งที่ต้องมี

- Node.js 22 ขึ้นไป และ pnpm 10 (`corepack enable`)
- Docker Engine + Docker Compose v2
  - บน Windows: ติดตั้ง Docker ใน WSL (Ubuntu) แล้วสั่งผ่าน `wsl docker ...` — ไม่ต้องใช้ Docker Desktop
  - เรียก service จาก Windows ด้วย `127.0.0.1` ไม่ใช่ `localhost` (localhost อาจไปที่ IPv6 ซึ่ง WSL ไม่ได้ forward)
- RAM ว่างประมาณ 3–4 GB (ClamAV ใช้ราว 1–1.5 GB)
- บน Windows ให้ clone ไว้ใน path ที่ไม่ลึกเกินไป — path ของ Prisma engine ใน `node_modules` ยาวกว่าตัว repo ราว 130 ตัวอักษร ถ้ารวมแล้วเกิน 260 คำสั่ง migrate จะล้มด้วย `spawn ... ENOENT`

## รันครั้งแรก

```bash
# 1. ติดตั้ง dependency (postinstall จะ generate Prisma client)
pnpm install

# 2. สร้าง .env จากตัวอย่าง พร้อมสุ่มรหัสทุกช่องที่เป็น change-me
node -e "const c=require('crypto'),f=require('fs');f.writeFileSync('.env',f.readFileSync('.env.example','utf8').replace(/change-me/g,()=>c.randomBytes(24).toString('base64url')))"

# 3. เปิด stack: postgres, redis, seaweedfs (S3), clamav, api, worker
docker compose up -d --build --wait
#    Windows: wsl --cd "<path ของ Service>" docker compose up -d --build --wait
#    ครั้งแรก ClamAV ดาวน์โหลดฐานไวรัส 2–5 นาทีก่อนจะ healthy

# 4. สร้างตารางและ System Admin คนแรก
pnpm build
pnpm --filter @sdes/db migrate:deploy
pnpm --filter @sdes/db seed

# 5. ตรวจว่าใช้งานได้ — ต้องได้ "status":"ok" และ check ผ่านทั้ง 4 ตัว
curl http://127.0.0.1:3000/health
```

ล็อกอินครั้งแรกด้วย `SEED_ADMIN_EMAIL` และ `SEED_ADMIN_PASSWORD` ใน `.env` (เปิดดูในไฟล์ ห้ามคัดลอกไปที่อื่น) ระบบจะบังคับเปลี่ยนรหัสผ่านทันที จากนั้นเปิดหน้าเว็บตาม [sdes-web](../Web/README.md)

Stack ตั้ง `restart: unless-stopped` ไว้ — บน WSL ถ้า distro หยุดเพราะไม่มีการใช้งาน container จะหยุดตาม ให้เปิด `wsl -d Ubuntu --exec sleep infinity` ค้างไว้ระหว่างทำงาน

### คำสั่งที่ใช้บ่อย

| ต้องการ | คำสั่ง |
|---|---|
| ดู log | `docker compose logs -f api worker` |
| build api/worker ใหม่หลังแก้โค้ด | `docker compose up -d --build --wait api worker` |
| หยุด stack (ข้อมูลยังอยู่) | `docker compose down` |
| ล้างข้อมูลทั้งหมด | `docker compose down -v` แล้วทำขั้น 3–4 ใหม่ |
| สร้าง migration ใหม่ | `pnpm --filter @sdes/db migrate:dev --name <ชื่อ>` |

## Environment

ไฟล์ `.env` ใช้ทั้ง docker compose และคำสั่ง dev/test บนเครื่อง (ห้าม commit — อยู่ใน `.gitignore` แล้ว)

| ตัวแปร | ใช้ทำอะไร |
|---|---|
| `API_PORT`, `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `S3_HOST_PORT`, `CLAMD_HOST_PORT` | port ฝั่งเครื่อง (ค่าเริ่มต้น 3000 / 5433 / 6379 / 8333 / 3310) |
| `POSTGRES_DB`, `POSTGRES_OWNER_USER`, `POSTGRES_OWNER_PASSWORD` | บัญชี owner — ใช้รัน migration, seed และ integration test |
| `POSTGRES_APP_PASSWORD` | บัญชี `sdes_app` ที่ api/worker ใช้ (ไม่มีสิทธิ์แก้/ลบ `audit_events`) |
| `REDIS_PASSWORD` | Redis (queue + ช่องสถานะ real-time) |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, `S3_SSE` | ที่เก็บไฟล์ต้นฉบับ; production ต้องตั้ง `S3_SSE=true` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | System Admin คนแรก (รหัสชั่วคราว อย่างน้อย 12 ตัว) |
| `JWT_SECRET` | ลายเซ็น access token — สุ่มอย่างน้อย 32 bytes |
| `COOKIE_SECURE` | `true` ใน production (refresh cookie ส่งผ่าน HTTPS เท่านั้น) |

## ทดสอบ

```bash
pnpm lint
pnpm typecheck
pnpm test        # core (unit) + db/api (integration) — ต้องเปิด postgres และ redis ก่อน
```

- integration test ของ api สร้างฐาน `sdes_test` ใหม่ทุกครั้ง และใช้ queue prefix `sdes-test` จึงไม่ปนกับข้อมูล dev
- test การอัปโหลด (สแกนไวรัส + S3) รันเฉพาะเมื่อเข้าถึง SeaweedFS และ ClamAV ได้ — บน CI จะข้าม
- E2E ตลอดสายผ่านหน้าเว็บอยู่ใน `qa/e2e` ของ repo วางแผน (smart-document-extraction-erp-sync)
- Load test การอัปโหลด: `node load/create-load-user.mjs` แล้วรัน `load/upload.k6.js` ด้วย k6 (ผลล่าสุดอยู่ใน `qa/phase1/load-upload.md`)
