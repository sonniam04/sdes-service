// pnpm --filter @sdes/db seed — อ่าน SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (และ COMPANY_TAX_ID / COMPANY_NAME ถ้ามี) จาก env หรือ Service/.env
import { ownerUrl } from "./test-env.js";
import { createPrisma, seed } from "./index.js";

async function main() {
  const prisma = createPrisma(ownerUrl());
  try {
    const email = process.env.SEED_ADMIN_EMAIL;
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!email || !password) throw new Error("ต้องตั้ง SEED_ADMIN_EMAIL และ SEED_ADMIN_PASSWORD");
    const r = await seed(prisma, {
      adminEmail: email,
      adminPassword: password,
      companyTaxId: process.env.COMPANY_TAX_ID || undefined,
      companyName: process.env.COMPANY_NAME || undefined,
    });
    console.log(r.adminCreated ? `สร้าง System Admin ${email} แล้ว (ต้องเปลี่ยนรหัสผ่านตอนล็อกอินครั้งแรก)` : "มี System Admin นี้อยู่แล้ว");
    if (r.settingsCreated.length) console.log(`ตั้งค่าเริ่มต้น: ${r.settingsCreated.join(", ")}`);
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
