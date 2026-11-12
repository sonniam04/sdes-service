// ชื่อคิวและช่องสัญญาณที่ api และ worker ใช้ร่วมกัน
export const EXTRACT_QUEUE = "document-extract";
export const STATUS_CHANNEL = "document-status";

export type ExtractJob = { documentId: string };

export type StatusEvent = { id: string; docNo: string; status: string; at: string };

/** ตัวเลือกของงานอ่านเอกสาร: jobId = document id (idempotent), retry 3 ครั้งแบบ exponential backoff */
export const extractJobOptions = (documentId: string) => ({
  jobId: documentId,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 1000,
});

/** คิวส่งเอกสารเข้า ERP (design D1) */
export const ERP_SYNC_QUEUE = "erp-sync";

export type ErpSyncJob = { documentId: string };

/** jobId = document id (ไม่ใส่ซ้ำขณะรอ), retry รวม 3 ครั้งแบบ exponential เริ่ม 5 วินาที */
export const erpSyncJobOptions = (documentId: string) => ({
  jobId: documentId,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 1000,
});
