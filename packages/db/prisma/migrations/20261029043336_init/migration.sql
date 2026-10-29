-- เลขเอกสาร DOC-000123 (ต้องมีก่อนตาราง documents)
CREATE SEQUENCE "document_no_seq";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('AP_CLERK', 'AP_LEAD', 'FINANCE_EXEC', 'SYS_ADMIN');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'FAILED', 'EXTRACTED', 'VERIFIED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SYNCING', 'SYNCED', 'SYNC_FAILED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "external_subject" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "tax_id" CHAR(13) NOT NULL,
    "branch_code" CHAR(5) NOT NULL DEFAULT '00000',
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "doc_no" TEXT NOT NULL DEFAULT ('DOC-'::text || lpad((nextval('document_no_seq'::regclass))::text, 6, '0'::text)),
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "sha256" CHAR(64) NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT,
    "model_version" TEXT,
    "confidence" DECIMAL(5,4),
    "risk_flags" JSONB NOT NULL DEFAULT '[]',
    "invoice_no" TEXT,
    "invoice_date" DATE,
    "vendor_id" UUID,
    "buyer_tax_id" CHAR(13),
    "subtotal" DECIMAL(18,2),
    "discount" DECIMAL(18,2),
    "vat_base" DECIMAL(18,2),
    "vat_rate" DECIMAL(5,2),
    "vat_amount" DECIMAL(18,2),
    "vat_exempt" BOOLEAN NOT NULL DEFAULT false,
    "grand_total" DECIMAL(18,2),
    "wht_base" DECIMAL(18,2),
    "wht_rate" DECIMAL(5,2),
    "wht_amount" DECIMAL(18,2),
    "net_payable" DECIMAL(18,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_extractions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "raw" JSONB NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_status_history" (
    "id" BIGSERIAL NOT NULL,
    "document_id" UUID NOT NULL,
    "from_status" "DocumentStatus",
    "to_status" "DocumentStatus" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "erp_sync_attempts" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "adapter" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "transaction_id" TEXT,
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(6),

    CONSTRAINT "erp_sync_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "ip" TEXT,
    "details" JSONB,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_external_subject_key" ON "users"("external_subject");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_tax_id_branch_code_key" ON "vendors"("tax_id", "branch_code");

-- CreateIndex
CREATE UNIQUE INDEX "documents_doc_no_key" ON "documents"("doc_no");

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_key_key" ON "documents"("storage_key");

-- CreateIndex
CREATE INDEX "documents_status_created_at_idx" ON "documents"("status", "created_at");

-- CreateIndex
CREATE INDEX "documents_vendor_id_invoice_no_idx" ON "documents"("vendor_id", "invoice_no");

-- CreateIndex
CREATE INDEX "document_extractions_document_id_created_at_idx" ON "document_extractions"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "document_status_history_document_id_created_at_idx" ON "document_status_history"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "erp_sync_attempts_document_id_attempt_idx" ON "erp_sync_attempts"("document_id", "attempt");

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_occurred_at_idx" ON "audit_events"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_occurred_at_idx" ON "audit_events"("entity_type", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_action_occurred_at_idx" ON "audit_events"("action", "occurred_at");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_status_history" ADD CONSTRAINT "document_status_history_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_sync_attempts" ADD CONSTRAINT "erp_sync_attempts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ====================================================================
-- SQL ดิบที่ Prisma สร้างเองไม่ได้ (design D3, D7) — task 2.2
-- ====================================================================

-- role ของแอป: สร้างเองถ้ายังไม่มี (dev สร้างพร้อมรหัสผ่านใน docker/postgres init, CI ตั้งรหัสผ่านแยก)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sdes_app') THEN
    CREATE ROLE sdes_app LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO sdes_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sdes_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sdes_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sdes_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO sdes_app;

-- audit_events: append-only ทั้งระดับสิทธิ์และ trigger (กันแม้ role อื่นที่ได้สิทธิ์ภายหลัง)
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM sdes_app;

CREATE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- กันไฟล์ซ้ำด้วย SHA-256 ยกเว้นเอกสารที่ประมวลผลล้มเหลว (spec document-ingestion)
CREATE UNIQUE INDEX "documents_sha256_active_key" ON "documents" ("sha256") WHERE "status" <> 'FAILED';

-- กันค่าที่ผิดรูปแบบ
ALTER TABLE "documents" ADD CONSTRAINT "documents_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_tax_id_digits" CHECK ("tax_id" ~ '^[0-9]{13}$');
ALTER TABLE "documents" ADD CONSTRAINT "documents_size_limit" CHECK ("size_bytes" > 0 AND "size_bytes" <= 20971520);
