-- AlterTable
ALTER TABLE "document_extractions" ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "error" TEXT;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "buyer_branch" CHAR(5),
ADD COLUMN     "data" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "field_meta" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "validation_issues" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "vendor_branch" CHAR(5),
ADD COLUMN     "vendor_name" TEXT,
ADD COLUMN     "vendor_tax_id" CHAR(13),
ADD COLUMN     "verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "verified_by" UUID;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- เลขที่ใบแจ้งหนี้ของผู้ขายรายเดียวกันต้องไม่ถูกยืนยันซ้ำ (spec invoice-validation "Duplicate invoice number")
-- ตาข่ายชั้นสุดท้ายเมื่อยืนยันพร้อมกัน — กฎใน core แจ้งผู้ใช้ก่อนถึงตรงนี้; เอกสารที่ถูกปฏิเสธหรือยังไม่ยืนยันไม่นับ
CREATE UNIQUE INDEX "documents_vendor_invoice_confirmed_key" ON "documents"("vendor_id", "invoice_no")
  WHERE "status" IN ('VERIFIED', 'PENDING_APPROVAL', 'APPROVED', 'SYNCING', 'SYNCED', 'SYNC_FAILED');
