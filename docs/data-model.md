# Data model

แหล่งความจริงของโครงสร้างคือ `packages/db/prisma/schema.prisma` และไฟล์ใน `packages/db/prisma/migrations/` เอกสารนี้อธิบายความหมายและกติกาที่ schema อย่างเดียวบอกไม่ได้

## หลักการ

- **สอง role ในฐานข้อมูล**
  - `sdes_owner` ใช้รัน migration และ seed
  - แอป (api, worker) เชื่อมต่อด้วย `sdes_app` ซึ่งไม่ใช่ owner และมีสิทธิ์เท่าที่ migration กำหนด
- **ยอดเงิน** เป็น `NUMERIC(18,2)` ทุกช่อง และในโค้ดใช้ `Decimal` ห้ามใช้ float
- **เวลา** เก็บเป็น `timestamptz` (UTC) แล้วแปลงเป็น Asia/Bangkok ตอนแสดงผล
- **ไม่ลบแถวที่มี audit อ้างถึง** ความสัมพันธ์ทั้งหมดเป็น `ON DELETE RESTRICT` ผู้ใช้ใช้วิธีปิดใช้งานแทนการลบ

## ER diagram

```mermaid
erDiagram
  users ||--o{ user_roles : has
  users ||--o{ refresh_tokens : owns
  users ||--o| api_keys : "service account of"
  users ||--o{ documents : uploads
  users ||--o{ documents : verifies
  vendors ||--o{ documents : issues
  documents ||--o{ document_extractions : "extracted as"
  documents ||--o{ document_status_history : "moves through"
  documents ||--o{ erp_sync_attempts : "synced by"
  audit_events }o--o| users : "actor (by id)"

  users { uuid id PK; text email UK; text password_hash; text external_subject UK; bool is_active; bool must_change_password; int failed_login_count; timestamptz locked_until }
  user_roles { uuid user_id PK; Role role PK }
  refresh_tokens { uuid id PK; text token_hash UK; uuid family_id; timestamptz expires_at; timestamptz used_at; timestamptz revoked_at }
  vendors { uuid id PK; char13 tax_id; char5 branch_code; text name; text erp_partner_id }
  documents { uuid id PK; text doc_no UK; DocumentStatus status; char64 sha256; text storage_key UK; int version; numeric grand_total; numeric wht_base; numeric net_payable; jsonb data; jsonb field_meta; jsonb validation_issues; uuid verified_by FK }
  document_extractions { uuid id PK; text provider; text model_version; numeric confidence; jsonb raw; jsonb items; int duration_ms; text error }
  document_status_history { bigint id PK; DocumentStatus from_status; DocumentStatus to_status; ActorType actor_type; text reason }
  settings { text key PK; jsonb value }
  erp_connections { int id PK; text adapter; text url; jsonb config; bytea secret_ciphertext; bool auto_sync; text tested_hash }
  erp_sync_attempts { uuid id PK; text adapter; int attempt; text status; text transaction_id; bool reused }
  api_keys { uuid id PK; uuid service_user_id FK; text prefix; char key_hash; text_arr scopes; timestamptz expires_at; timestamptz revoked_at }
  system_logs { bigint id PK; timestamptz created_at; text service; text level; text message; jsonb details }
  audit_events { bigint id PK; timestamptz occurred_at; ActorType actor_type; uuid actor_user_id; text action; text entity_type; text entity_id; text ip; jsonb details }
```

## ตาราง

| ตาราง | หน้าที่ | กติกาสำคัญ |
|---|---|---|
| `users` | บัญชีผู้ใช้ | `email` unique (เก็บเป็นตัวพิมพ์เล็ก)<br>`password_hash` เป็น argon2id<br>`external_subject` เว้นไว้สำหรับ OIDC/SSO<br>`must_change_password` บังคับเปลี่ยนรหัสชั่วคราว<br>`failed_login_count` + `locked_until` ใช้ล็อกบัญชี 15 นาทีเมื่อรหัสผิด 5 ครั้ง<br>`kind` = `HUMAN` (คน) หรือ `SERVICE` (บัญชีของ API key: ไม่มี `password_hash` จึงล็อกอินไม่ได้ และไม่แสดงในหน้าจัดการผู้ใช้) |
| `user_roles` | role ของผู้ใช้ (มีได้หลาย role) | role มี 4 ค่า: `AP_CLERK`, `AP_LEAD`, `FINANCE_EXEC`, `SYS_ADMIN`<br>ผู้ใช้ต้องมีอย่างน้อย 1 role (บังคับที่แอป) |
| `refresh_tokens` | refresh token แบบหมุนเวียน | เก็บเฉพาะ hash<br>`family_id` ใช้ revoke ทั้งชุดเมื่อพบการใช้ token ซ้ำ (`used_at` มีค่าแล้ว) |
| `vendors` | ทะเบียนผู้ขาย | `(tax_id, branch_code)` unique<br>`tax_id` ต้องเป็นตัวเลข 13 หลัก (CHECK)<br>สาขาสำนักงานใหญ่ = `00000`<br>`erp_partner_id` รหัสคู่ค้าใน ERP ที่จับคู่หรือสร้างไว้ ใช้ซ้ำในการส่งครั้งต่อไป |
| `documents` | เอกสารหนึ่งฉบับ = หนึ่งไฟล์ | ดูหัวข้อ "documents" ด้านล่าง |
| `document_extractions` | ผลอ่านจาก AI provider แต่ละรอบ (รวมรอบที่ล้มเหลว) | เก็บ `raw` ไว้ตรวจย้อนหลัง<br>`items` เป็น JSONB (ลำดับ, รายการ, จำนวน, ราคาต่อหน่วย, ภาษี, ยอด, bbox, confidence) เป็นค่าที่ AI อ่าน แก้ไม่ได้<br>`duration_ms` เวลาที่ใช้อ่าน (KPI <30 วินาที), `error` เหตุผลเมื่อรอบนั้นไม่สำเร็จ |
| `document_status_history` | ประวัติการเปลี่ยนสถานะ | เขียนใน transaction เดียวกับการเปลี่ยนสถานะ<br>`actor_type` = USER/SYSTEM<br>การปฏิเสธต้องมี `reason` |
| `erp_connections` | การเชื่อมต่อ ERP (แถวเดียว `id = 1`, CHECK) | `adapter` (`odoo`/`webhook`), `url`, `database`, `config` (`apiMode`, `login`, `journalId`, `purchaseTaxId`, `expenseAccountId`)<br>API key/secret เก็บเป็น `secret_ciphertext` + `secret_iv` + `secret_tag` (AES-256-GCM ด้วย `ERP_SECRET_KEY` ที่อยู่นอกฐานข้อมูล)<br>`auto_sync` เปิดได้เมื่อ `tested_hash` ตรงกับ hash ของการตั้งค่าปัจจุบัน |
| `settings` | การตั้งค่าที่ Admin แก้ได้ | ค่าเริ่มต้นจาก seed: `risk.confidence_threshold = 0.85`, `risk.high_amount_threshold = null` (รอฝ่ายบัญชี), `company.tax_id` / `company.name` (จาก `COMPANY_TAX_ID` / `COMPANY_NAME` หรือ null)<br>seed ไม่เขียนทับค่าที่มีอยู่แล้ว |
| `erp_sync_attempts` | ประวัติการส่งเข้า ERP หนึ่งแถวต่อการลองส่งหนึ่งครั้ง | `attempt` ครั้งที่, `adapter`, `status`, `transaction_id`, `error`, เวลาส่ง/ตอบ<br>`reused` = ERP มีรายการของเอกสารนี้อยู่แล้ว จึงใช้รายการเดิม (กันส่งซ้ำ) |
| `audit_events` | audit trail | ดูหัวข้อ "audit_events" ด้านล่าง |
| `api_keys` | API key ของระบบภายนอก (หนึ่ง key ต่อหนึ่งบัญชี `SERVICE`) | เก็บ `key_hash` (SHA-256 ของ key เต็ม) ไม่เก็บค่าเต็ม<br>`prefix` unique ใช้หาแถวและแสดงในหน้าจอ<br>`scopes` ต้องมีอย่างน้อยหนึ่งค่าจาก `document.upload`, `document.read` (CHECK)<br>`expires_at` บังคับ, `revoked_at`/`revoked_by` เมื่อเพิกถอน, `last_used_at` อัปเดตไม่เกินนาทีละครั้ง |
| `system_logs` | log ระดับ `warn`/`error` ของ `api`/`worker` (CHECK ทั้งสองค่า) | ข้อมูลถูกปิดบังก่อนเก็บ<br>`sdes_app` เพิ่ม/อ่าน/ลบได้แต่แก้ไม่ได้<br>worker ลบแถวที่เก่ากว่า 30 วันวันละครั้ง |

### documents
- **`doc_no`** มาจาก sequence `document_no_seq` รูปแบบ `DOC-000123`
- **`status`** เป็นหนึ่งใน 11 สถานะ
  - การเปลี่ยนสถานะที่อนุญาตอยู่ใน `packages/core/src/lifecycle.ts`
  - การเปลี่ยนสถานะทำด้วย `UPDATE ... WHERE status = ? AND version = ?` (optimistic lock) ถ้าอัปเดตได้ 0 แถว → 409
- **`sha256`** มี partial unique index `documents_sha256_active_key` ที่ทำงานเฉพาะแถวที่ `status <> 'FAILED'` จึงอัปโหลดไฟล์เดิมของเอกสารที่อ่านล้มเหลวซ้ำได้
- **`size_bytes`** ต้องไม่เกิน 20 MB (CHECK)
- **`storage_key`** คือ key ของไฟล์ต้นฉบับใน S3 ไฟล์ต้นฉบับห้ามเขียนทับ
- **field ภาษี**
  - ตรวจยอดชั้นที่ 1: `subtotal`, `discount`, `vat_base`, `vat_rate`, `vat_amount`, `vat_exempt`, `grand_total`
  - ชั้นที่ 2: `wht_base`, `wht_rate`, `wht_amount`, `net_payable`
  - **`wht_base` แยกจาก `vat_base`** เพราะใบเดียวอาจมีทั้งสินค้าที่ไม่ถูกหักและบริการที่ถูกหัก
- **`provider` / `model_version`** บันทึกว่า AI ตัวไหนอ่านเอกสารนี้ ใช้เทียบความแม่นยำเมื่อเปลี่ยน model
- **`risk_flags`** (JSONB) ผลประเมินความเสี่ยงตอนยืนยัน (รหัสกฎ, ข้อความ, ค่าที่เข้าเกณฑ์, ค่าเกณฑ์ ณ เวลาประเมิน) — แก้เกณฑ์ภายหลังไม่เปลี่ยนค่าที่เก็บแล้ว
- **`data`** (JSONB) ข้อมูลที่ตรวจ/แก้ได้ทั้งชุดเป็นสตริง ตามรูป `DocumentData` ใน `packages/core/src/validation.ts` (หัวเอกสาร + `items`)
  - เก็บเป็นสตริงเพราะระหว่างแก้อาจมีค่าที่ยังผิดรูปแบบ (เช่น `7OO.00`) ซึ่ง column typed เก็บไม่ได้
  - column typed (`invoice_no`, `invoice_date`, `grand_total`, `vendor_tax_id` ฯลฯ) คัดลอกจาก `data` เฉพาะค่าที่ถูกรูปแบบ ใช้กับคิว การค้นหา และ Phase 3
- **`field_meta`** (JSONB) ราย field: ความมั่นใจ, ตำแหน่ง (`bbox` พิกัดสัดส่วนของหน้า) และค่าที่ AI อ่านได้ ใช้ไฮไลต์บนหน้าตรวจและบอกว่า field ไหนถูกแก้
- **`validation_issues`** (JSONB) ผลตรวจล่าสุด (`code`, `severity`, `message`, `fields`) คำนวณใหม่ทุกครั้งที่บันทึก
- **`vendor_tax_id` / `vendor_branch` / `vendor_name` / `buyer_branch`** ค่าจากเอกสาร (ส่วน `vendor_id` ผูกกับทะเบียนตอนยืนยัน)
- **`erp_transaction_id` / `synced_at` / `sync_error`** เลขอ้างอิงใน ERP และเวลาหลังส่งสำเร็จ / เหตุผลล่าสุดที่ส่งไม่สำเร็จ (แสดงในหน้าจอ; รายละเอียดทุกครั้งอยู่ใน `erp_sync_attempts`)
- **`verified_by` / `verified_at`** ผู้ยืนยันและเวลา ใช้ตรวจการแยกหน้าที่ (ผู้ยืนยันอนุมัติเองไม่ได้)
- **`(vendor_id, invoice_no)`** มี partial unique index `documents_vendor_invoice_confirmed_key` เฉพาะสถานะที่ยืนยันแล้ว (`VERIFIED` ขึ้นไป ยกเว้น `REJECTED`) กันเลขที่ใบแจ้งหนี้ซ้ำเมื่อยืนยันพร้อมกัน

### audit_events
- **append-only:**
  - `REVOKE UPDATE, DELETE, TRUNCATE` จาก `sdes_app`
  - มี trigger `audit_events_immutable` ที่ปฏิเสธ UPDATE/DELETE/TRUNCATE **แม้แต่ owner**
- **`details`** เก็บ field, ค่าก่อน และค่าหลัง ผ่าน `redact()` ใน `packages/core` แล้ว (ตัดรหัสผ่าน/token และ mask เลขบัตรประชาชนกับเลขบัญชีส่วนบุคคล)
- **เขียนใน transaction เดียวกับการกระทำ** ถ้าเขียน audit ไม่ได้ การกระทำนั้นต้องไม่มีผล

## Migration

- `20261029043336_init`: ตารางทั้งหมด, sequence, สิทธิ์ของ `sdes_app`, trigger ของ audit, partial unique index และ CHECK
- `20261029050000_app_role_hardening`: `sdes_app` เข้าถึง `_prisma_migrations` ไม่ได้
- `*_phase3_erp_sync`: `erp_connections`, `vendors.erp_partner_id` (รหัสคู่ค้าใน ERP), `documents.erp_transaction_id/synced_at/sync_error`, `erp_sync_attempts.reused`
- `20261029094400_phase2_review_data`: column สำหรับการตรวจแก้ (`data`, `field_meta`, `validation_issues`, ข้อมูลผู้ขาย/ผู้ซื้อ, ผู้ยืนยัน), `duration_ms`/`error` ของ `document_extractions` และ partial unique index เลขที่ใบแจ้งหนี้

**คำสั่ง (ใน `Service/`):**
- `pnpm --filter @sdes/db migrate:dev` สร้าง migration ใหม่ (dev)
- `pnpm --filter @sdes/db migrate:deploy` รัน migration (CI/production)
- `pnpm --filter @sdes/db seed` สร้าง System Admin คนแรกและค่าเริ่มต้น (หลัง `pnpm build`)

ห้ามใช้ `prisma db push` เพราะจะไม่รัน SQL ดิบ (trigger, REVOKE, partial index)
