import { existsSync } from "node:fs";
import { resolve } from "node:path";

// โหลด Service/.env ตอน dev (CI ตั้ง env เอง)
const envFile = resolve(__dirname, "../../../.env");
if (!process.env.DATABASE_OWNER_URL && existsSync(envFile)) process.loadEnvFile(envFile);

/** URL ของ role owner (ใช้ migration, seed และ integration test) */
export function ownerUrl(): string {
  const e = process.env;
  if (e.DATABASE_OWNER_URL) return e.DATABASE_OWNER_URL;
  if (!e.POSTGRES_OWNER_PASSWORD) throw new Error("ไม่ได้ตั้ง DATABASE_OWNER_URL หรือ POSTGRES_OWNER_PASSWORD");
  return `postgresql://${e.POSTGRES_OWNER_USER ?? "sdes_owner"}:${e.POSTGRES_OWNER_PASSWORD}@127.0.0.1:${e.POSTGRES_HOST_PORT ?? "5433"}/${e.POSTGRES_DB ?? "sdes"}`;
}

export const hasDatabase = Boolean(process.env.DATABASE_OWNER_URL || process.env.POSTGRES_OWNER_PASSWORD);
