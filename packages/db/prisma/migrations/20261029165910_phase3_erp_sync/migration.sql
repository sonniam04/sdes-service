-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "erp_transaction_id" TEXT,
ADD COLUMN     "sync_error" TEXT,
ADD COLUMN     "synced_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "erp_sync_attempts" ADD COLUMN     "reused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "erp_partner_id" TEXT;

-- CreateTable
CREATE TABLE "erp_connections" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "adapter" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "database" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret_ciphertext" BYTEA,
    "secret_iv" BYTEA,
    "secret_tag" BYTEA,
    "auto_sync" BOOLEAN NOT NULL DEFAULT false,
    "tested_at" TIMESTAMPTZ(6),
    "tested_hash" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "erp_connections_pkey" PRIMARY KEY ("id")
);

-- การเชื่อมต่อ ERP มีได้แถวเดียว
ALTER TABLE "erp_connections" ADD CONSTRAINT "erp_connections_single_row" CHECK ("id" = 1);
