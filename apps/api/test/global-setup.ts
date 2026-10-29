import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";
import { hasDatabase, TEST_DB, urls } from "./test-db.js";

/** สร้างฐาน sdes_test ใหม่ แล้วรัน migration จริงของ @sdes/db */
export default async function setup() {
  if (!hasDatabase || !urls) return;
  const admin = new Client({ connectionString: urls.admin });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    // CI สร้าง role ใน migration โดยไม่มีรหัสผ่าน — ตั้งให้ตรงกับ env (dev ได้ค่าเดิม)
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sdes_app') THEN CREATE ROLE sdes_app LOGIN; END IF; END $$`);
    await admin.query(`ALTER ROLE sdes_app PASSWORD ${quote(process.env.POSTGRES_APP_PASSWORD!)}`);
  } finally {
    await admin.end();
  }
  const dbPkg = resolve(__dirname, "../../../packages/db");
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: dbPkg,
    env: { ...process.env, DATABASE_OWNER_URL: urls.owner },
    stdio: "ignore",
    shell: process.platform === "win32",
  });
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
