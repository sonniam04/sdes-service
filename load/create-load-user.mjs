// สร้างผู้ใช้ AP_CLERK สำหรับ load test ใน DB dev (รหัสสุ่ม เขียนลง load/.load-user.env — ไม่ commit)
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createPrisma } = require("../packages/db/dist/index.js");
const argon2 = require("../packages/db/node_modules/argon2");

process.loadEnvFile(new URL("../.env", import.meta.url));
const e = process.env;
const prisma = createPrisma(`postgresql://${e.POSTGRES_OWNER_USER}:${e.POSTGRES_OWNER_PASSWORD}@127.0.0.1:${e.POSTGRES_HOST_PORT}/${e.POSTGRES_DB}`);
const email = "load-clerk@sdes.local";
const password = randomBytes(18).toString("base64url");
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
await prisma.user.upsert({
  where: { email },
  update: { passwordHash, mustChangePassword: false, isActive: true, failedLoginCount: 0, lockedUntil: null },
  create: { email, displayName: "Load test (ตัวอย่าง)", passwordHash, mustChangePassword: false, roles: { create: [{ role: "AP_CLERK" }] } },
});
await prisma.$disconnect();
writeFileSync(new URL("./.load-user.env", import.meta.url), `EMAIL=${email}\nPASSWORD=${password}\n`);
console.log(`พร้อม: ${email}`);
