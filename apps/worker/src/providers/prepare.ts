// เตรียมไฟล์ก่อนส่งอ่าน (design D1): PDF ส่งทั้งไฟล์, JPG/PNG ส่งเป็นภาพ, TIFF แปลงทุกหน้าเป็น PNG
import sharp from "sharp";
import { permanent } from "./errors.js";

export type ImagePage = { mediaType: "image/png" | "image/jpeg"; data: Buffer };
export type PreparedInput = { kind: "pdf"; data: Buffer } | { kind: "images"; pages: ImagePage[] };

/** ภาพที่ส่งให้ API ต้องเล็กกว่า 5 MB; ย่อภาพใหญ่ให้ด้านยาวไม่เกินนี้ (พิกัด bbox เป็นสัดส่วน จึงไม่กระทบ) */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const MAX_EDGE = 2400;

export async function prepareInput(file: Uint8Array, mime: string): Promise<PreparedInput> {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  switch (mime) {
    case "application/pdf":
      if (isPasswordProtectedPdf(buf)) throw permanent("ไฟล์ PDF ถูกล็อกด้วยรหัสผ่าน");
      return { kind: "pdf", data: buf };
    case "image/png":
    case "image/jpeg":
      return { kind: "images", pages: [await fitImage(buf, mime)] };
    case "image/tiff":
      return { kind: "images", pages: await tiffToPng(buf) };
    default:
      throw permanent(`ไม่รองรับไฟล์ชนิด ${mime}`);
  }
}

/**
 * PDF ที่เข้ารหัสมี /Encrypt ใน trailer ซึ่งแปลว่าต้องถอดรหัสก่อนอ่าน
 * (อาจรวม PDF ที่ล็อกเฉพาะสิทธิ์แก้ไข — ยอมรับเพราะพบน้อยในใบกำกับภาษีและผู้ใช้ส่งไฟล์ใหม่ได้)
 */
export function isPasswordProtectedPdf(buf: Buffer): boolean {
  const tail = buf.subarray(Math.max(0, buf.length - 64 * 1024)).toString("latin1");
  const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString("latin1");
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(tail) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(head);
}

/** แปลง TIFF ทุกหน้าเป็น PNG ตามลำดับหน้า */
export async function tiffToPng(buf: Buffer) {
  let pageCount: number;
  try {
    pageCount = (await sharp(buf).metadata()).pages ?? 1;
  } catch (e) {
    throw permanent("เปิดไฟล์ TIFF ไม่ได้ ไฟล์อาจเสียหาย", e);
  }
  const pages: ImagePage[] = [];
  for (let page = 0; page < pageCount; page++) {
    const png = await sharp(buf, { page }).png().toBuffer();
    pages.push(await fitImage(png, "image/png"));
  }
  return pages;
}

async function fitImage(buf: Buffer, mime: ImagePage["mediaType"]): Promise<ImagePage> {
  try {
    const meta = await sharp(buf).metadata();
    const tooBig = Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_EDGE;
    if (!tooBig && buf.length <= MAX_IMAGE_BYTES) return { mediaType: mime, data: buf };
    const resized = sharp(buf).resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true });
    const out = await (mime === "image/png" ? resized.png({ compressionLevel: 9 }) : resized.jpeg({ quality: 85 })).toBuffer();
    // PNG ที่ยังใหญ่เกิน (ภาพสแกนสี) แปลงเป็น JPEG
    if (out.length <= MAX_IMAGE_BYTES) return { mediaType: mime, data: out };
    return { mediaType: "image/jpeg", data: await sharp(out).jpeg({ quality: 80 }).toBuffer() };
  } catch (e) {
    throw permanent("เปิดไฟล์ภาพไม่ได้ ไฟล์อาจเสียหาย", e);
  }
}
