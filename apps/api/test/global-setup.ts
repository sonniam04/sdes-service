import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { connect } from "node:net";
import { Client } from "pg";
import { hasDatabase, TEST_DB, urls } from "./test-db.js";

/** สร้างฐาน sdes_test ใหม่ แล้วรัน migration จริงของ @sdes/db */
export default async function setup() {
  // ingestion e2e ต้องมี S3 + clamd จริง (dev stack) — CI ไม่มีจึงข้าม
  const e = process.env;
  const s3 = await reachable("127.0.0.1", Number(e.S3_HOST_PORT ?? 8333));
  const clamd = await reachable("127.0.0.1", Number(e.CLAMD_HOST_PORT ?? 3310));
  if (s3 && clamd && !e.S3_ENDPOINT) process.env.INGESTION_STACK = "1";
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

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, host);
    sock.setTimeout(1000, () => (sock.destroy(), resolve(false)));
    sock.on("connect", () => (sock.end(), resolve(true)));
    sock.on("error", () => resolve(false));
  });
}
