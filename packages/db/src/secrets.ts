// เข้ารหัส secret ของการเชื่อมต่อ ERP ด้วย AES-256-GCM (spec erp-connection "Secret protection", design D5)
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EncryptedSecret = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

/**
 * กุญแจ 32 ไบต์จาก ERP_SECRET_KEY: ค่า base64 ของ 32 ไบต์ใช้ตรง ๆ, ค่าสุ่มอื่นที่ยาวพอ (เช่นจากสคริปต์สร้าง .env) แปลงด้วย SHA-256
 * ไม่มีหรือสั้นเกินให้หยุดพร้อมข้อความชัดเจน
 */
export function loadSecretKey(raw = process.env.ERP_SECRET_KEY): Buffer {
  if (!raw || raw === "change-me") throw new SecretKeyError("ต้องตั้ง ERP_SECRET_KEY ใน .env เพื่อใช้การเชื่อมต่อ ERP");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32 && decoded.toString("base64") === raw) return decoded;
  if (raw.length < 24) throw new SecretKeyError("ERP_SECRET_KEY ต้องเป็นค่าสุ่มยาวอย่างน้อย 24 ตัวอักษร");
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptSecret(plain: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/** ถอดรหัส — ข้อมูลหรือ tag ถูกแก้ หรือกุญแจไม่ตรง จะ throw */
export function decryptSecret(s: EncryptedSecret, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, s.iv);
  decipher.setAuthTag(s.tag);
  return Buffer.concat([decipher.update(s.ciphertext), decipher.final()]).toString("utf8");
}
