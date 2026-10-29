// เรียก prisma CLI พร้อม DATABASE_OWNER_URL จาก Service/.env (dev) — ใน CI/production ตั้ง env เอง
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (!process.env.DATABASE_OWNER_URL) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const e = process.env;
  e.DATABASE_OWNER_URL = `postgresql://${e.POSTGRES_OWNER_USER ?? "sdes_owner"}:${e.POSTGRES_OWNER_PASSWORD}@127.0.0.1:${e.POSTGRES_HOST_PORT ?? "5433"}/${e.POSTGRES_DB ?? "sdes"}`;
}
const r = spawnSync("prisma", process.argv.slice(2), { stdio: "inherit", shell: true, env: process.env });
process.exit(r.status ?? 1);
