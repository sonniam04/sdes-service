-- ข้อมูลจำลองสำหรับวัดเวลารายงาน (task 4.4 ของ complete-missing-features): 12 เดือน × 3,500 ฉบับ (BRD: 3,500 ฉบับ/เดือน)
-- รันบนฐานแยก (เช่น sdes_perf) ที่ migrate แล้ว — ห้ามรันบนฐานจริง
BEGIN;
INSERT INTO users (id, email, display_name, password_hash, must_change_password, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'perf-uploader@perf.local', 'ผู้อัปโหลด perf', NULL, false, now());

INSERT INTO vendors (id, tax_id, branch_code, name)
SELECT gen_random_uuid(), lpad((105500000000 + i)::text, 13, '0'), '00000', 'ผู้ขาย perf ' || i FROM generate_series(1, 300) i;

WITH v AS (SELECT id, row_number() OVER () AS rn FROM vendors),
docs AS (
  SELECT i,
         timestamptz '2025-11-01 00:00+07' + (i % 365) * interval '1 day' + (i % 600) * interval '1 minute' AS created,
         (ARRAY['SYNCED','SYNCED','SYNCED','SYNCED','APPROVED','VERIFIED','PENDING_APPROVAL','EXTRACTED','REJECTED','SYNC_FAILED'])[1 + i % 10] AS status,
         ((i * 37) % 50000 + 100)::numeric(18,2) AS sub
  FROM generate_series(1, 42000) i)
INSERT INTO documents (id, status, sha256, file_name, mime_type, size_bytes, storage_key, uploaded_by, vendor_id, invoice_no, invoice_date,
                       subtotal, discount, vat_amount, wht_amount, grand_total, created_at, updated_at)
SELECT gen_random_uuid(), docs.status::"DocumentStatus", md5(i::text) || md5((i + 1)::text), 'perf-' || i || '.pdf', 'application/pdf', 1000, 'perf/' || i,
       '00000000-0000-4000-8000-000000000001', v.id, 'IV-' || i, (docs.created AT TIME ZONE 'Asia/Bangkok')::date - 1,
       docs.sub, 0, round(docs.sub * 0.07, 2), CASE WHEN i % 4 = 0 THEN round(docs.sub * 0.03, 2) END, round(docs.sub * 1.07, 2), docs.created, docs.created
FROM docs JOIN v ON v.rn = 1 + docs.i % 300;

-- ประวัติสถานะ 5 แถวต่อฉบับ (อัปโหลด → อ่าน → อ่านเสร็จ → ยืนยัน → ส่งเสร็จ)
INSERT INTO document_status_history (document_id, from_status, to_status, actor_type, created_at)
SELECT d.id, s.f::"DocumentStatus", s.t::"DocumentStatus", 'SYSTEM', d.created_at + s.sec * interval '1 second'
FROM documents d
CROSS JOIN (VALUES (NULL, 'UPLOADED', 0), ('UPLOADED', 'PROCESSING', 2), ('PROCESSING', 'EXTRACTED', 18), ('EXTRACTED', 'VERIFIED', 240), ('VERIFIED', 'SYNCED', 260)) AS s(f, t, sec)
WHERE d.storage_key LIKE 'perf/%';

-- 20% ของเอกสารมีการแก้ field
INSERT INTO audit_events (actor_type, action, entity_type, entity_id, details)
SELECT 'SYSTEM', 'document.field_edited', 'document', d.id::text, '{"field":"header.grandTotal"}'
FROM documents d WHERE d.storage_key LIKE 'perf/%' AND abs(hashtext(d.id::text)) % 5 = 0;
COMMIT;
ANALYZE;
SELECT (SELECT count(*) FROM documents) AS documents, (SELECT count(*) FROM document_status_history) AS history, (SELECT count(*) FROM audit_events) AS audits;
