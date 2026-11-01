# sdes-service

Backend ของ SDES — Smart Document Extraction & ERP Sync Pipeline

| ส่วน | หน้าที่ |
|---|---|
| `apps/api` | NestJS REST API + socket.io (`/ws`) — auth, ผู้ใช้, audit, อัปโหลด/ตรวจ/อนุมัติเอกสาร, ตั้งค่า ERP, ติดตามคิว |
| `apps/worker` | BullMQ worker: อ่านข้อมูลเอกสารด้วย AI (คิว `extract`) และส่งเข้า ERP (คิว `erp-sync`) |
| `packages/core` | กติกากลาง: role/สิทธิ์, lifecycle ของเอกสาร, validation, payload และ adapter ของ ERP (Odoo, webhook) |
| `packages/db` | Prisma schema, migration, seed, `transitionDocument`, `recordAudit`, เข้ารหัส secret ของ ERP |

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
| `COMPANY_TAX_ID`, `COMPANY_NAME` | บริษัทผู้ซื้อในใบกำกับภาษี ใช้ตรวจ Tax ID ผู้ซื้อ (seed ครั้งแรก — แก้ภายหลังที่หน้าตั้งค่า) |
| `EXTRACTION_PROVIDER` | ตัวอ่านเอกสารของ worker: `fake` (ผลว่าง, ค่าเริ่มต้น), `fixture` (เฉลยของชุดทดสอบ), `claude` (Claude vision), `gemini` (Gemini) |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | key ของ provider ที่เลือก — ส่งให้เฉพาะ worker ไม่ส่งให้ api |
| `EXTRACTION_MODEL`, `EXTRACTION_EFFORT`, `EXTRACTION_TIMEOUT_MS` | รุ่นโมเดล (ว่าง = `claude-opus-5-5` หรือ `gemini-3.8-flash`), ระดับ effort ของ Claude (`low`) และเวลาสูงสุดต่อคำขอ (120000 ms) |
| `EXTRACTION_FIXTURE_HOST_DIR` | โฟลเดอร์ `<sha256>.json` ของ fixture provider (mount เข้า worker ที่ `/fixtures`) |
| `ERP_SECRET_KEY` | กุญแจเข้ารหัส API key/webhook secret ของการเชื่อมต่อ ERP (AES-256-GCM) ส่งให้ api และ worker — base64 ของ 32 bytes หรือค่าสุ่มยาวอย่างน้อย 24 ตัว (ขั้นตอนสร้าง `.env` ด้านบนสุ่มให้แล้ว) |
| `RATE_LIMIT_AUTH`, `RATE_LIMIT_UPLOAD` | จำนวนครั้งต่อนาที: login/refresh ต่อ IP (10) และอัปโหลดต่อผู้ใช้ (60) — เกินได้ 429 พร้อม `Retry-After` |
| `TRUST_PROXY` | proxy ที่ api เชื่อ `X-Forwarded-For` (ค่าเริ่มต้นใน compose `loopback, uniquelocal`) — **ต้องมี** เพราะเว็บเรียก `/auth` และ `/api` ผ่าน proxy ของ Next ถ้าไม่ตั้ง ผู้ใช้ทุกคนจะใช้ IP ของเว็บร่วมกันและโดน rate limit ของ login/refresh พร้อมกัน production ให้ระบุ IP ของ proxy จริง และไม่เปิด port ของ api ให้เครื่องอื่นเรียกตรง (ไม่อย่างนั้นเครื่องใน LAN ปลอม header เพื่อเลี่ยง rate limit ได้) |
| `ODOO_HOST_PORT`, `ODOO_DB_PASSWORD` | เฉพาะ profile `odoo` สำหรับ dev (ค่าเริ่มต้น 8069 / `odoo-dev-only`) |

## การอ่านเอกสารด้วย AI

ค่าเริ่มต้น worker ใช้ provider `fake` ที่คืนผลว่าง เอกสารจึงถึง `EXTRACTED` แต่ไม่มีข้อมูล ถ้าต้องการอ่านจริง:

1. ใส่ใน `.env` (ห้าม commit) อย่างใดอย่างหนึ่ง:
   - `EXTRACTION_PROVIDER=claude` + `ANTHROPIC_API_KEY=...`
   - `EXTRACTION_PROVIDER=gemini` + `GEMINI_API_KEY=...` (ต้องเป็น paid tier — free tier ของ Gemini API นำข้อมูลไปปรับปรุงผลิตภัณฑ์และอาจมีคนอ่าน จึงไม่เหมาะกับใบกำกับภาษีจริง)
2. `docker compose up -d --wait worker`
3. ถ้าไม่มี key worker จะหยุดตั้งแต่เริ่มพร้อมข้อความบอกว่าขาดอะไร

ข้อควรรู้:
- **ข้อมูลที่ส่งออกไปภายนอก:** worker ส่งเฉพาะไฟล์เอกสารและคำสั่งอ่านให้ Anthropic API หรือ Gemini API ไม่ส่งชื่อหรืออีเมลผู้ใช้ ต้องใช้บัญชี API เชิงพาณิชย์ที่ไม่นำข้อมูลไปฝึกโมเดล และบันทึกเรื่องนี้ในการประเมิน PDPA
- **ค่าใช้จ่าย:** ทุกเอกสารเรียก API หนึ่งครั้ง (อ่านใหม่ = เรียกอีกครั้ง) ดูค่าใช้จ่ายต่อฉบับจากรายงานชุดวัดผลใน `qa/phase2/` ของ repo วางแผน
- **ล้มเหลวชั่วคราว** (429, 5xx, หมดเวลา) ลองใหม่อัตโนมัติรวม 3 ครั้ง; **ล้มเหลวถาวร** (PDF ล็อกรหัสผ่าน, ไฟล์เสีย, ถูกปฏิเสธ) เป็น `FAILED` ทันทีพร้อมเหตุผล ทุกรอบถูกเก็บใน `document_extractions`
- TIFF ถูกแปลงเป็น PNG ทีละหน้าก่อนส่ง ภาพที่ใหญ่เกินถูกย่อ (ตำแหน่งที่อ่านได้เป็นพิกัดสัดส่วนของหน้า จึงไม่กระทบ)
- **E2E/CI** ใช้ `EXTRACTION_PROVIDER=fixture` กับเฉลยของชุดทดสอบ จึงไม่เรียก API จริง

## การส่งเข้า ERP

เอกสารที่ยืนยันแล้ว (`VERIFIED` ที่ไม่มีความเสี่ยง) หรืออนุมัติแล้ว (`APPROVED`) ถูกส่งเข้า ERP เมื่อ **เปิดการส่งอัตโนมัติ** ที่หน้า `/admin/erp` ของเว็บ ซึ่งเปิดได้หลังทดสอบการเชื่อมต่อผ่านเท่านั้น การแก้การตั้งค่าใด ๆ จะปิดการส่งอัตโนมัติจนกว่าจะทดสอบผ่านอีกครั้ง เอกสารที่ส่งไม่สำเร็จ (`SYNC_FAILED`) System Admin ส่งใหม่ได้ที่หน้า `/admin/sync`

- **Odoo:** สร้างใบแจ้งหนี้ผู้ขาย (vendor bill) **แบบร่าง** ไม่ post ให้ฝ่ายบัญชีตรวจใน Odoo ก่อน — รองรับ JSON-2 (Odoo 19 ขึ้นไป) และ JSON-RPC (17–18) กันส่งซ้ำด้วย `invoice_origin` = เลขเอกสาร SDES, หาคู่ค้าด้วย Tax ID แล้วสร้างใหม่ถ้าไม่มี, ข้อมูลหัก ณ ที่จ่ายอยู่ในหมายเหตุ และแนบไฟล์ต้นฉบับ
- **Webhook:** `POST` JSON ไปยัง URL ที่ตั้ง ลงลายเซ็นด้วย secret — ปลายทางต้องตอบ 2xx พร้อม `{"transactionId": "..."}`
- ส่งไม่สำเร็จชั่วคราว (เครือข่าย, 429, 5xx) ลองใหม่รวม 3 ครั้ง; ถูกปฏิเสธ (4xx) เป็น `SYNC_FAILED` ทันที ทุกครั้งที่ส่งเก็บใน `erp_sync_attempts`
- API key/secret ถูกเข้ารหัสด้วย `ERP_SECRET_KEY` ไม่ถูกส่งกลับใน API, log หรือ audit — ถ้ากุญแจหาย ให้ใส่ API key ใหม่ในหน้าตั้งค่า (ข้อมูลเอกสารไม่กระทบ) และ production ต้องเก็บกุญแจใน secret manager

### Odoo สำหรับพัฒนาและทดสอบ (profile `odoo`)

```bash
docker compose --profile odoo up -d --wait   # เพิ่ม odoo:19 + postgres ของ Odoo (RAM เพิ่มราว 1 GB)
sh docker/odoo/setup.sh                       # Windows: wsl --cd "<path ของ Service>" sh docker/odoo/setup.sh
```

`setup.sh` สร้างฐาน `sdes_erp` (โมดูล `account` + `l10n_th`) และผู้ใช้ `sdes-integration` แล้วพิมพ์ **API key ใหม่** กับ id ของ journal ซื้อ, ภาษีซื้อ 7% และบัญชีค่าใช้จ่าย ให้นำไปใส่ในหน้า `/admin/erp` (URL `http://odoo:8069` เพราะ worker เรียกจากใน docker network) — API key แสดงครั้งเดียวและไม่ถูกเขียนลงไฟล์ รันซ้ำได้ (ได้ key ใหม่ทุกครั้ง) ดูใบแจ้งหนี้ที่ส่งเข้าไปได้ที่ `http://127.0.0.1:8069`

### ตรวจลายเซ็น webhook ฝั่งปลายทาง

Header ที่ส่งไป: `X-SDES-Timestamp` (unix วินาที), `X-SDES-Signature` (`sha256=` + HMAC-SHA256 ของ `<timestamp>.<body>`), `Idempotency-Key` (คงที่ต่อเอกสาร — ส่งซ้ำได้ค่าเดิม ปลายทางใช้กันสร้างซ้ำ)

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody = body ที่ได้รับแบบยังไม่ parse (string/Buffer)
function verify(req, rawBody, secret) {
  const ts = req.headers["x-sdes-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // กันการส่งซ้ำของคำขอเก่า
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const got = String(req.headers["x-sdes-signature"] ?? "");
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
```

## API key สำหรับระบบภายนอก

System Admin สร้าง key ได้ที่หน้า `/admin/api-keys` ของเว็บ (ตั้งชื่อ, เลือกขอบเขต, อายุ 1–365 วัน ค่าเริ่มต้น 90) ค่า key แสดงครั้งเดียว ระบบเก็บแค่ hash
- ขอบเขต `document.upload` = อัปโหลดและอ่านสถานะเอกสาร, `document.read` = อ่านรายการ/สถานะเท่านั้น — key แก้ข้อมูล อนุมัติ หรือเรียก endpoint ของผู้ดูแลไม่ได้
- แต่ละ key มีบัญชีบริการของตัวเอง เอกสารที่อัปโหลดด้วย key จึงมีผู้อัปโหลดและ audit เป็นชื่อ key บัญชีนี้ล็อกอินด้วยรหัสผ่านไม่ได้และไม่อยู่ในหน้าจัดการผู้ใช้
- ส่ง key ใน `Authorization: Bearer <key>` หรือ `X-API-Key: <key>`; key ผิด หมดอายุ หรือถูกเพิกถอน ได้ 401; rate limit การอัปโหลดนับต่อ key

```bash
# อัปโหลด (หลายไฟล์ได้: -F files=@a.pdf -F files=@b.pdf) — ผลรายไฟล์มีเลขเอกสารและสถานะ
curl -sS -H "Authorization: Bearer $SDES_API_KEY" -F "files=@invoice.pdf" http://127.0.0.1:3000/documents
# อ่านสถานะเอกสารที่เปลี่ยนตั้งแต่เวลาที่กำหนด
curl -sS -H "X-API-Key: $SDES_API_KEY" "http://127.0.0.1:3000/documents?updatedSince=2026-10-30T00:00:00Z"
```

## System logs

api และ worker เก็บ log ระดับ warning/error ลงตาราง `system_logs` (นอกจากพิมพ์ stdout ตามเดิม) ดูได้ที่หน้า `/admin/logs` ของเว็บ
- ก่อนเก็บจะปิดบัง Authorization/Bearer token, API key, รหัสผ่านใน connection string และเลข 13 หลัก — อ้างถึงเอกสารด้วยเลข `DOC-xxxxxx` แทน
- เก็บเป็นชุดทุก 2 วินาทีแบบไม่บล็อกงาน; ฐานข้อมูลล่ม = log ชุดนั้นหายแต่คำขอ/งานทำงานต่อ (ยังอยู่ใน stdout)
- worker ลบ log ที่เก่ากว่า 30 วันวันละครั้ง (`sdes_app` แก้ log ไม่ได้)

## ทะเบียนผู้ขายและรายงาน

- `GET /vendors?q=&page=&pageSize=` และ `GET /vendors/:id` (AP Clerk, AP Lead) — ยอดรวมนับเฉพาะเอกสารที่ยืนยันแล้วขึ้นไปและไม่ถูกปฏิเสธ; `isNew` ใช้เงื่อนไขเดียวกับเหตุผลความเสี่ยง "ผู้ขายรายใหม่"
- `GET /reports/summary?from=YYYY-MM&to=YYYY-MM` และ `/reports/summary/export` (Finance Exec, ไม่เกิน 24 เดือน) — ยอดเงินจัดตามวันที่ในใบกำกับ ตัวชี้วัดกระบวนการจัดตามวันที่อัปโหลด (เวลาไทย); ผลวัดเวลาตอบอยู่ใน `qa/complete-missing-features/reports-perf.md` ของ repo วางแผน (`load/reports-perf.mjs`)

## หน้าภาพรวม

`GET /dashboard` (สิทธิ์ `dashboard.view` — ทุก role ของคน, API key เรียกไม่ได้) คืนข้อมูลหน้าแรกของเว็บในคำขอเดียว แต่ละส่วนมีเฉพาะเมื่อผู้เรียกมีสิทธิ์ดูข้อมูลชนิดนั้นอยู่แล้ว (ส่วนที่ไม่มีสิทธิ์ไม่มี key ในผลลัพธ์):
- `backlog`, `throughput` (14 วันรวมวันนี้ ตามเวลาไทย), `indicators` (7 วันล่าสุด เทียบเป้า 30 วินาทีและ 92%) — ผู้ที่ดูเอกสารได้
- `finance` (เดือนนี้และเดือนก่อน ตามวันที่ในใบกำกับ ชุดเดียวกับ `/reports/summary`) — Finance Exec
- `health` (คิว, ERP, `syncFailed`) — ผู้ที่มี `ops.view`; `errors24h` เพิ่มเมื่อมี `logs.view` และ `expiringKeys` (14 วัน) เมื่อมี `apikey.manage`

ตัวอย่างผลลัพธ์อยู่ใน Swagger (`/docs`); ผลวัดเวลาตอบอยู่ใน `qa/overview-dashboard/dashboard-perf.md` ของ repo วางแผน (`load/dashboard-perf.mjs`)

## ความปลอดภัย

- **Rate limit** เก็บตัวนับใน Redis (ใช้ร่วมกันได้หลาย instance) — ค่าตาม `RATE_LIMIT_*` ด้านบน นับต่อ IP จริงของผู้ใช้ผ่าน `TRUST_PROXY` (ดูตาราง Environment) — ชุด E2E ที่ล็อกอินหลายบัญชีจากเครื่องเดียวต้องเพิ่ม `RATE_LIMIT_AUTH`
- **Security headers** ด้วย `helmet` ที่ api (หน้าเว็บตั้ง CSP เองใน `next.config.ts` ของ sdes-web)
- **Dependency gate:** CI รัน `pnpm audit:gate` — ล้มเมื่อพบช่องโหว่ระดับ critical ใน dependency ที่ใช้งานจริง ยกเว้นรายการที่อยู่ใน `security/audit-exceptions.json` (ต้องมีเหตุผลและวันหมดอายุ; หมดอายุแล้ว CI ล้ม)
- **Authorization regression test** (`apps/api/test/authorization.e2e.ts`) ไล่ทุก route: route ใหม่ที่ลืม `@RequirePermission` จะทำให้ test ล้มพร้อมชื่อ endpoint

## ทดสอบ

```bash
pnpm lint
pnpm typecheck
pnpm test        # core (unit) + db/api (integration) — ต้องเปิด postgres และ redis ก่อน
```

- integration test ของ api สร้างฐาน `sdes_test` ใหม่ทุกครั้ง และใช้ queue prefix `sdes-test` จึงไม่ปนกับข้อมูล dev
- test การอัปโหลด (สแกนไวรัส + S3) รันเฉพาะเมื่อเข้าถึง SeaweedFS และ ClamAV ได้ — บน CI จะข้าม
- test ของ adapter Odoo (`apps/api/test/odoo-adapter.e2e.ts`) รันเฉพาะเมื่อตั้ง `ODOO_TEST_URL` (`http://127.0.0.1:8069`), `ODOO_TEST_API_KEY`, `ODOO_TEST_JOURNAL_ID`, `ODOO_TEST_TAX_ID`, `ODOO_TEST_ACCOUNT_ID` จากผลของ `setup.sh` ใน environment ของ shell (ไม่ต้องใส่ใน `.env`) — ไม่ตั้ง = ข้าม
- E2E ตลอดสายผ่านหน้าเว็บอยู่ใน `qa/e2e` ของ repo วางแผน (smart-document-extraction-erp-sync)
- Load test การอัปโหลด: `node load/create-load-user.mjs` แล้วรัน `load/upload.k6.js` ด้วย k6 (ผลล่าสุดอยู่ใน `qa/phase1/load-upload.md`)
