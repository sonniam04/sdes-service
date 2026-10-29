// ข้อผิดพลาดของการส่งเข้า ERP (spec erp-sync "Retry and dead letter queue")
export class SyncError extends Error {
  constructor(
    message: string,
    /** true = ลองใหม่ก็ไม่หาย (ข้อมูลถูกปฏิเสธ, สิทธิ์ไม่พอ, ยอดไม่ตรง) */
    readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SyncError";
  }
}

export const syncPermanent = (message: string, cause?: unknown) => new SyncError(message, true, { cause });
export const syncTransient = (message: string, cause?: unknown) => new SyncError(message, false, { cause });

/** จำแนกตาม HTTP status: 408/429/5xx = ชั่วคราว, 401/403 = สิทธิ์, 4xx อื่น = ข้อมูลถูกปฏิเสธ */
export function syncErrorForStatus(status: number, detail: string, target: string): SyncError {
  if (status === 408 || status === 429 || status >= 500) return syncTransient(`${target} ขัดข้องชั่วคราว (${status})${detail ? `: ${detail}` : ""}`);
  if (status === 401 || status === 403) return syncPermanent(`${target} ไม่รับ API key หรือผู้ใช้ไม่มีสิทธิ์ (${status})`);
  return syncPermanent(`${target} ปฏิเสธข้อมูล (${status})${detail ? `: ${detail}` : ""}`);
}

/** fetch ล้มก่อนได้คำตอบ (เชื่อมต่อไม่ได้, หมดเวลา) = ชั่วคราว */
export function syncNetworkError(e: unknown, target: string): SyncError {
  if (e instanceof SyncError) return e;
  const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  return syncTransient(timeout ? `${target} ไม่ตอบภายในเวลาที่กำหนด` : `เชื่อมต่อ ${target} ไม่ได้`, e);
}
