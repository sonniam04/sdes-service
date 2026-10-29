// ข้อผิดพลาดของการส่งเข้า ERP (spec erp-sync "Retry and dead letter queue")
/** ประเภทของความล้มเหลว — ใช้แยกผลทดสอบการเชื่อมต่อ (เข้าถึงไม่ได้ vs key ผิด vs ข้อมูลถูกปฏิเสธ) */
export type SyncErrorCode = "network" | "unavailable" | "auth" | "rejected";

export class SyncError extends Error {
  constructor(
    message: string,
    /** true = ลองใหม่ก็ไม่หาย (ข้อมูลถูกปฏิเสธ, สิทธิ์ไม่พอ, ยอดไม่ตรง) */
    readonly permanent: boolean,
    options?: { cause?: unknown; code?: SyncErrorCode },
  ) {
    super(message, options);
    this.name = "SyncError";
    this.code = options?.code ?? (permanent ? "rejected" : "unavailable");
  }

  readonly code: SyncErrorCode;
}

export const syncPermanent = (message: string, cause?: unknown, code?: SyncErrorCode) => new SyncError(message, true, { cause, code });
export const syncTransient = (message: string, cause?: unknown, code?: SyncErrorCode) => new SyncError(message, false, { cause, code });

/** จำแนกตาม HTTP status: 408/429/5xx = ชั่วคราว, 401/403 = สิทธิ์, 4xx อื่น = ข้อมูลถูกปฏิเสธ */
export function syncErrorForStatus(status: number, detail: string, target: string): SyncError {
  if (status === 408 || status === 429 || status >= 500) return syncTransient(`${target} ขัดข้องชั่วคราว (${status})${detail ? `: ${detail}` : ""}`);
  if (status === 401 || status === 403) return syncPermanent(`${target} ไม่รับ API key หรือผู้ใช้ไม่มีสิทธิ์ (${status})`, undefined, "auth");
  return syncPermanent(`${target} ปฏิเสธข้อมูล (${status})${detail ? `: ${detail}` : ""}`);
}

/** fetch ล้มก่อนได้คำตอบ (เชื่อมต่อไม่ได้, หมดเวลา) = ชั่วคราว */
export function syncNetworkError(e: unknown, target: string): SyncError {
  if (e instanceof SyncError) return e;
  const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  return syncTransient(timeout ? `${target} ไม่ตอบภายในเวลาที่กำหนด` : `เชื่อมต่อ ${target} ไม่ได้`, e, "network");
}
