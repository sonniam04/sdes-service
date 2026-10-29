import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretKeyError, decryptSecret, encryptSecret, loadSecretKey } from "./secrets.js";

const key = randomBytes(32);

describe("ERP secret encryption (task 2.2)", () => {
  it("เข้ารหัสแล้วถอดได้ค่าเดิม และ ciphertext ไม่มีข้อความเดิม", () => {
    const s = encryptSecret("odoo-api-key-ภาษาไทย-123", key);
    expect(decryptSecret(s, key)).toBe("odoo-api-key-ภาษาไทย-123");
    expect(s.ciphertext.toString("utf8")).not.toContain("odoo-api-key");
  });

  it("iv ไม่ซ้ำกันทุกครั้ง", () => {
    expect(encryptSecret("x", key).iv.equals(encryptSecret("x", key).iv)).toBe(false);
  });

  it("ciphertext หรือ tag ถูกแก้ หรือกุญแจไม่ตรง → ถอดไม่ผ่าน", () => {
    const s = encryptSecret("secret", key);
    const flipped = Buffer.from(s.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret({ ...s, ciphertext: flipped }, key)).toThrow();
    expect(() => decryptSecret({ ...s, tag: randomBytes(16) }, key)).toThrow();
    expect(() => decryptSecret(s, randomBytes(32))).toThrow();
  });

  it("กุญแจไม่มีหรือผิดขนาดหยุดพร้อมข้อความ", () => {
    expect(() => loadSecretKey("")).toThrow(SecretKeyError);
    expect(() => loadSecretKey(undefined)).toThrow(/ERP_SECRET_KEY/);
    expect(() => loadSecretKey("change-me")).toThrow(/ERP_SECRET_KEY/);
    expect(() => loadSecretKey("short-key")).toThrow(/24 ตัวอักษร/);
  });

  it("base64 ของ 32 ไบต์ใช้ตรง ๆ; ค่าสุ่มอื่นแปลงเป็น 32 ไบต์แบบคงที่", () => {
    expect(loadSecretKey(key.toString("base64")).equals(key)).toBe(true);
    const raw = randomBytes(24).toString("base64url");
    expect(loadSecretKey(raw)).toHaveLength(32);
    expect(loadSecretKey(raw).equals(loadSecretKey(raw))).toBe(true);
  });
});
