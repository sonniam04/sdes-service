import argon2 from "argon2";
import type { PrismaClient } from "./generated/client/index.js";

/** ค่าเริ่มต้นของการตั้งค่า — seed จะไม่เขียนทับค่าที่ Admin แก้แล้ว */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  "risk.confidence_threshold": 0.85,
  // รอฝ่ายบัญชีกำหนด (design Open Questions) — null = ยังไม่ใช้เกณฑ์ยอดเงินสูง
  "risk.high_amount_threshold": null,
};

export type SeedOptions = { adminEmail: string; adminPassword: string };
export type SeedResult = { adminCreated: boolean; settingsCreated: string[] };

/**
 * สร้าง System Admin คนแรก (รหัสผ่านชั่วคราว ต้องเปลี่ยนตอนล็อกอินครั้งแรก) และการตั้งค่าเริ่มต้น
 * รันซ้ำได้: ไม่สร้างข้อมูลซ้ำ และไม่แก้ข้อมูลที่มีอยู่แล้ว
 */
export async function seed(prisma: PrismaClient, opts: SeedOptions): Promise<SeedResult> {
  const email = opts.adminEmail.trim().toLowerCase();
  if (opts.adminPassword.length < 12) throw new Error("SEED_ADMIN_PASSWORD ต้องยาวอย่างน้อย 12 ตัวอักษร");

  return prisma.$transaction(async (tx) => {
    let adminCreated = false;
    const existing = await tx.user.findUnique({ where: { email } });
    if (!existing) {
      const admin = await tx.user.create({
        data: {
          email,
          displayName: "ผู้ดูแลระบบ",
          passwordHash: await argon2.hash(opts.adminPassword, { type: argon2.argon2id }),
          mustChangePassword: true,
          roles: { create: [{ role: "SYS_ADMIN" }] },
        },
      });
      await tx.auditEvent.create({
        data: { actorType: "SYSTEM", action: "user.seeded", entityType: "user", entityId: admin.id, details: { email, roles: ["SYS_ADMIN"] } },
      });
      adminCreated = true;
    }

    const settingsCreated: string[] = [];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const found = await tx.setting.findUnique({ where: { key } });
      if (found) continue;
      await tx.setting.create({ data: { key, value: value as never } });
      settingsCreated.push(key);
    }
    if (settingsCreated.length) {
      await tx.auditEvent.create({
        data: { actorType: "SYSTEM", action: "settings.seeded", entityType: "setting", details: { keys: settingsCreated } },
      });
    }
    return { adminCreated, settingsCreated };
  });
}
