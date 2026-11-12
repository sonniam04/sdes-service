-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('HUMAN', 'SERVICE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "kind" "UserKind" NOT NULL DEFAULT 'HUMAN';

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "service_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logs" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "context" TEXT,
    "message" TEXT NOT NULL,
    "details" JSONB,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_service_user_id_key" ON "api_keys"("service_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "system_logs_created_at_idx" ON "system_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "system_logs_level_service_created_at_idx" ON "system_logs"("level", "service", "created_at");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_service_user_id_fkey" FOREIGN KEY ("service_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- log เก็บแล้วแก้ไม่ได้: แอปเพิ่ม/อ่าน/ลบ (ลบเก่ากว่า 30 วัน) เท่านั้น (design D4)
REVOKE UPDATE ON "system_logs" FROM sdes_app;
ALTER TABLE "system_logs" ADD CONSTRAINT "system_logs_level_check" CHECK ("level" IN ('warn', 'error'));
ALTER TABLE "system_logs" ADD CONSTRAINT "system_logs_service_check" CHECK ("service" IN ('api', 'worker'));
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes_check" CHECK (cardinality("scopes") > 0 AND "scopes" <@ ARRAY['document.upload', 'document.read']::text[]);
