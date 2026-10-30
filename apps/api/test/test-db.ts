import { existsSync } from "node:fs";
import { resolve } from "node:path";

// e2e ใช้ฐานข้อมูลแยก sdes_test ที่สร้างใหม่และ migrate ทุกครั้ง (global-setup.ts)
const envFile = resolve(__dirname, "../../../.env");
if (!process.env.DATABASE_OWNER_URL && existsSync(envFile)) process.loadEnvFile(envFile);

export const TEST_DB = "sdes_test";

function baseOwnerUrl(): URL | null {
  const e = process.env;
  if (e.DATABASE_OWNER_URL) return new URL(e.DATABASE_OWNER_URL);
  if (!e.POSTGRES_OWNER_PASSWORD) return null;
  return new URL(
    `postgresql://${e.POSTGRES_OWNER_USER ?? "sdes_owner"}:${encodeURIComponent(e.POSTGRES_OWNER_PASSWORD)}@127.0.0.1:${e.POSTGRES_HOST_PORT ?? "5433"}/${e.POSTGRES_DB ?? "sdes"}`,
  );
}

const withDb = (u: URL, db: string, user?: string, password?: string) => {
  const n = new URL(u.toString());
  n.pathname = `/${db}`;
  if (user) n.username = user;
  if (password !== undefined) n.password = encodeURIComponent(password);
  return n.toString();
};

const base = baseOwnerUrl();
export const hasDatabase = base !== null && Boolean(process.env.POSTGRES_APP_PASSWORD);

export const urls = base
  ? {
      /** owner ต่อฐาน postgres เพื่อสร้าง/ลบฐานทดสอบ */
      admin: withDb(base, "postgres"),
      owner: withDb(base, TEST_DB),
      app: withDb(base, TEST_DB, "sdes_app", process.env.POSTGRES_APP_PASSWORD ?? ""),
    }
  : null;

/** ให้แอปที่บูตใน test ชี้ไปที่ฐานทดสอบ */
export function useTestDatabase() {
  if (!urls) return;
  process.env.DATABASE_URL = urls.app;
  process.env.DATABASE_OWNER_URL = urls.owner;
  process.env.QUEUE_PREFIX = "sdes-test";
  // test ล็อกอินถี่จาก IP เดียว — test ของ rate limit ตั้งค่าตาม spec เอง
  process.env.RATE_LIMIT_AUTH ??= "100000";
  process.env.RATE_LIMIT_UPLOAD ??= "100000";
}
