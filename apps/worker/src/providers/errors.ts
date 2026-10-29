// จำแนกข้อผิดพลาดของการอ่าน (design D1): transient ให้ BullMQ retry, permanent ทำ FAILED ทันที
import Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";

export class ExtractionError extends Error {
  constructor(
    message: string,
    /** true = ลองใหม่ก็ไม่หาย (ไฟล์เสีย, ถูกปฏิเสธ, คำขอผิดรูปแบบ) */
    readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

export const permanent = (message: string, cause?: unknown) => new ExtractionError(message, true, { cause });
export const transient = (message: string, cause?: unknown) => new ExtractionError(message, false, { cause });

const TEMPORARY = "ระบบอ่านเอกสารไม่สำเร็จชั่วคราว กรุณากด \"อ่านใหม่\"";

/** แปลงข้อผิดพลาดจาก Anthropic SDK เป็น ExtractionError ที่บอกว่าควร retry หรือไม่ */
export function classifyError(e: unknown): ExtractionError {
  if (e instanceof ExtractionError) return e;
  // ผลที่ไม่ผ่าน schema อ่านซ้ำก็ได้ผลเดิม
  if (e instanceof ZodError) return permanent("ผลการอ่านไม่ตรงรูปแบบที่กำหนด", e);
  // APIConnectionError (รวม timeout) เป็นคลาสลูกของ APIError ใน TS SDK จึงต้องตรวจก่อน
  if (e instanceof Anthropic.APIConnectionError) return transient(`${TEMPORARY} (เชื่อมต่อผู้ให้บริการ AI ไม่ได้หรือหมดเวลา)`, e);
  if (e instanceof Anthropic.RateLimitError) return transient(`${TEMPORARY} (เกินอัตราที่ผู้ให้บริการ AI กำหนด)`, e);
  if (e instanceof Anthropic.InternalServerError) return transient(`${TEMPORARY} (ผู้ให้บริการ AI ขัดข้อง)`, e);
  if (e instanceof Anthropic.APIError) {
    // 529 overloaded และ 408 ถือเป็นชั่วคราว; 4xx อื่นคือคำขอผิด ลองใหม่ก็ไม่หาย
    if (e.status === 529 || e.status === 408) return transient(`${TEMPORARY} (ผู้ให้บริการ AI ไม่ว่าง)`, e);
    return permanent(`ผู้ให้บริการ AI ปฏิเสธคำขอ (${e.status ?? "ไม่ทราบรหัส"})`, e);
  }
  // ข้อผิดพลาดที่ไม่รู้จัก (เช่น S3 ชั่วคราว) ให้ลองใหม่ตามรอบของคิว
  return transient(TEMPORARY, e);
}
