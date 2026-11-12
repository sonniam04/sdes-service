// วัดเวลาของ GET /dashboard กับข้อมูลจำลอง 12 เดือน × 3,500 ฉบับ (task 2.6 ของ overview-dashboard)
// ก่อนรัน: สร้างฐาน sdes_perf, migrate แล้วรัน load/reports-perf-seed.sql และ `pnpm build`
// รัน: node load/dashboard-perf.mjs  (ใช้ค่าจาก .env, เปิด api ชั่วคราวที่ port 3999 ชี้ไปฐาน sdes_perf)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(`${root}.env`);
const e = process.env;
const DB = e.PERF_DB ?? "sdes_perf";
const PORT = 3999;
const enc = encodeURIComponent;
const ownerUrl = `postgresql://${e.POSTGRES_OWNER_USER}:${enc(e.POSTGRES_OWNER_PASSWORD)}@127.0.0.1:${e.POSTGRES_HOST_PORT ?? 5433}/${DB}`;

// ผู้ใช้ที่มีทุก role (ได้ทุกส่วนของหน้าภาพรวม) สำหรับวัด (รหัสสุ่มต่อรอบ ไม่เขียนลงไฟล์)
const require = createRequire(`${root}packages/db/package.json`);
const argon2 = require("argon2");
const { createPrisma } = await import(`file://${root}packages/db/dist/index.js`);
const prisma = createPrisma(ownerUrl);
const email = "perf-dashboard@perf.local";
const roles = ["AP_LEAD", "FINANCE_EXEC", "SYS_ADMIN"];
const password = randomBytes(18).toString("base64url");
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
await prisma.user.upsert({
  where: { email },
  update: { passwordHash, mustChangePassword: false, isActive: true },
  create: { email, displayName: "Dashboard perf", passwordHash, mustChangePassword: false, roles: { create: roles.map((role) => ({ role })) } },
});
await prisma.$disconnect();

const api = spawn(process.execPath, [`${root}apps/api/dist/main.js`], {
  env: { ...e, PORT: String(PORT), DATABASE_URL: `postgresql://sdes_app:${enc(e.POSTGRES_APP_PASSWORD)}@127.0.0.1:${e.POSTGRES_HOST_PORT ?? 5433}/${DB}`, COOKIE_SECURE: "false", QUEUE_PREFIX: "sdes-perf" },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${PORT}`;
try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const { accessToken } = await login.json();
  const h = { Authorization: `Bearer ${accessToken}` };
  const times = [];
  let body;
  for (let i = 0; i < 11; i++) {
    const t = performance.now();
    const r = await fetch(`${base}/dashboard`, { headers: h });
    body = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body)}`);
    times.push(performance.now() - t);
  }
  const warm = times.slice(1).sort((a, b) => a - b);
  const out = [{ sections: Object.keys(body).filter((k) => k !== "generatedAt").join(","), first: Math.round(times[0]), median: Math.round(warm[5]), max: Math.round(warm.at(-1)) }];
  console.table(out);
} finally {
  api.kill();
}
