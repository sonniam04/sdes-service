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
  users ||--o{ documents : uploads
  vendors ||--o{ documents : issues
  documents ||--o{ document_extractions : "extracted as"
  documents ||--o{ document_status_history : "moves through"
  documents ||--o{ erp_sync_attempts : "synced by"
  audit_events }o--o| users : "actor (by id)"

  users { uuid id PK; text email UK; text password_hash; text external_subject UK; bool is_active; bool must_change_password; int failed_login_count; timestamptz locked_until }
  user_roles { uuid user_id PK; Role role PK }
  refresh_tokens { uuid id PK; text token_hash UK; uuid family_id; timestamptz expires_at; timestamptz used_at; timestamptz revoked_at }
  vendors { uuid id PK; char13 tax_id; char5 branch_code; text name }
  documents { uuid id PK; text doc_no UK; DocumentStatus status; char64 sha256; text storage_key UK; int version; numeric grand_total; numeric wht_base; numeric net_payable }
  document_extractions { uuid id PK; text provider; text model_version; numeric confidence; jsonb raw; jsonb items }
  document_status_history { bigint id PK; DocumentStatus from_status; DocumentStatus to_status; ActorType actor_type; text reason }
  settings { text key PK; jsonb value }
  erp_sync_attempts { uuid id PK; text adapter; int attempt; text status; text transaction_id }
  audit_events { bigint id PK; timestamptz occurred_at; ActorType actor_type; uuid actor_user_id; text action; text entity_type; text entity_id; text ip; jsonb details }
```

## ตาราง

| ตาราง | หน้าที่ | กติกาสำคัญ |
|---|---|---|
| `users` | บัญชีผู้ใช้ | `email` unique (เก็บเป็นตัวพิมพ์เล็ก)<br>`password_hash` เป็น argon2id<br>`external_subject` เว้นไว้สำหรับ OIDC/SSO<br>`must_change_password` บังคับเปลี่ยนรหัสชั่วคราว<br>`failed_login_count` + `locked_until` ใช้ล็อกบัญชี 15 นาทีเมื่อรหัสผิด 5 ครั้ง |
| `user_roles` | role ของผู้ใช้ (มีได้หลาย role) | role มี 4 ค่า: `AP_CLERK`, `AP_LEAD`, `FINANCE_EXEC`, `SYS_ADMIN`<br>ผู้ใช้ต้องมีอย่างน้อย 1 role (บังคับที่แอป) |
| `refresh_tokens` | refresh token แบบหมุนเวียน | เก็บเฉพาะ hash<br>`family_id` ใช้ revoke ทั้งชุดเมื่อพบการใช้ token ซ้ำ (`used_at` มีค่าแล้ว) |
| `vendors` | ทะเบียนผู้ขาย | `(tax_id, branch_code)` unique<br>`tax_id` ต้องเป็นตัวเลข 13 หลัก (CHECK)<br>สาขาสำนักงานใหญ่ = `00000` |
| `documents` | เอกสารหนึ่งฉบับ = หนึ่งไฟล์ | ดูหัวข้อ "documents" ด้านล่าง |
| `document_extractions` | ผลอ่านจาก AI provider แต่ละรอบ | เก็บ `raw` ไว้ตรวจย้อนหลัง<br>`items` เป็น JSONB (ลำดับ, รายการ, จำนวน, ราคาต่อหน่วย, ภาษี, ยอด, bbox, confidence) |
| `document_status_history` | ประวัติการเปลี่ยนสถานะ | เขียนใน transaction เดียวกับการเปลี่ยนสถานะ<br>`actor_type` = USER/SYSTEM<br>การปฏิเสธต้องมี `reason` |
| `settings` | การตั้งค่าที่ Admin แก้ได้ | ค่าเริ่มต้นจาก seed: `risk.confidence_threshold = 0.85`, `risk.high_amount_threshold = null` (รอฝ่ายบัญชี)<br>seed ไม่เขียนทับค่าที่มีอยู่แล้ว |
| `erp_sync_attempts` | ประวัติการส่งเข้า ERP | สร้างโครงไว้สำหรับ Phase 3 |
| `audit_events` | audit trail | ดูหัวข้อ "audit_events" ด้านล่าง |

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
- **`risk_flags`** (JSONB) เหตุผลที่เป็นเคสเสี่ยง จะใช้ตั้งแต่ Phase 2

### audit_events
- **append-only:**
  - `REVOKE UPDATE, DELETE, TRUNCATE` จาก `sdes_app`
  - มี trigger `audit_events_immutable` ที่ปฏิเสธ UPDATE/DELETE/TRUNCATE **แม้แต่ owner**
- **`details`** เก็บ field, ค่าก่อน และค่าหลัง ผ่าน `redact()` ใน `packages/core` แล้ว (ตัดรหัสผ่าน/token และ mask เลขบัตรประชาชนกับเลขบัญชีส่วนบุคคล)
- **เขียนใน transaction เดียวกับการกระทำ** ถ้าเขียน audit ไม่ได้ การกระทำนั้นต้องไม่มีผล

## Migration

- `20261029043336_init`: ตารางทั้งหมด, sequence, สิทธิ์ของ `sdes_app`, trigger ของ audit, partial unique index และ CHECK
- `20261029050000_app_role_hardening`: `sdes_app` เข้าถึง `_prisma_migrations` ไม่ได้

**คำสั่ง (ใน `Service/`):**
- `pnpm --filter @sdes/db migrate:dev` สร้าง migration ใหม่ (dev)
- `pnpm --filter @sdes/db migrate:deploy` รัน migration (CI/production)
- `pnpm --filter @sdes/db seed` สร้าง System Admin คนแรกและค่าเริ่มต้น (หลัง `pnpm build`)

ห้ามใช้ `prisma db push` เพราะจะไม่รัน SQL ดิบ (trigger, REVOKE, partial index)
