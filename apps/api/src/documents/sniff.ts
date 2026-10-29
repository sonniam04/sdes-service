// ตรวจชนิดไฟล์จาก magic bytes ของเนื้อหาจริง ไม่เชื่อนามสกุลหรือ Content-Type จาก client
export type SupportedMime = "application/pdf" | "image/png" | "image/jpeg" | "image/tiff";

export const EXTENSION: Record<SupportedMime, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/tiff": "tiff",
};

const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);

export function sniffMime(head: Buffer): SupportedMime | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  return null;
}
