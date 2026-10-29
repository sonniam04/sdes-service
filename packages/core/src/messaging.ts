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
