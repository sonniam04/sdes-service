// pnpm test:deploy  (ต้องมี sh และ openssl — Linux, WSL หรือ Git Bash; การตรวจ mode 600 ข้ามบน Windows)
// phase 4 task 3.1: ค่าทุกตัวยาวพอ, ไม่มีค่าซ้ำกัน, mode 600, รันซ้ำแล้วไฟล์เดิมไม่เปลี่ยน
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("../init-env.sh", import.meta.url));
const inputs = { SDES_DOMAIN: "sdes.example.test", SEED_ADMIN_EMAIL: "admin@example.test", EXTRACTION_PROVIDER: "fake" };
const run = (out, extra = {}) =>
  spawnSync("sh", [script, out], { env: { ...process.env, ...inputs, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const parse = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_0-9]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
const fresh = () => join(mkdtempSync(join(tmpdir(), "sdes-env-")), ".env.production");

const SECRETS = {
  POSTGRES_OWNER_PASSWORD: 40,
  POSTGRES_APP_PASSWORD: 40,
  REDIS_PASSWORD: 40,
  S3_ACCESS_KEY: 20,
  S3_SECRET_KEY: 40,
  JWT_SECRET: 60,
  ERP_SECRET_KEY: 44,
  SEED_ADMIN_PASSWORD: 16,
};

test("สร้างไฟล์ด้วยค่าสุ่มที่ยาวพอ ไม่ซ้ำกัน และ mode 600 โดยไม่พิมพ์ค่าออกหน้าจอ", () => {
  const out = fresh();
  const r = run(out);
  assert.equal(r.status, 0, r.stderr);
  const env = parse(readFileSync(out, "utf8"));
  for (const [k, min] of Object.entries(SECRETS)) assert.ok(env[k]?.length >= min, `${k} สั้นเกินไป`);
  const values = Object.keys(SECRETS).map((k) => env[k]);
  assert.equal(new Set(values).size, values.length, "มีค่าซ้ำกัน");
  assert.equal(Buffer.from(env.ERP_SECRET_KEY, "base64").length, 32);
  assert.equal(env.SDES_DOMAIN, inputs.SDES_DOMAIN);
  // NTFS ไม่มี mode แบบ POSIX
  if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
  for (const v of values) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), "ค่า secret ถูกพิมพ์ออกหน้าจอ");
});

test("รันซ้ำไม่เขียนทับไฟล์เดิม", () => {
  const out = fresh();
  assert.equal(run(out).status, 0);
  const before = readFileSync(out, "utf8");
  assert.notEqual(run(out).status, 0);
  assert.equal(readFileSync(out, "utf8"), before);
});

test("รอบใหม่ได้ค่าสุ่มคนละชุด", () => {
  const a = fresh();
  const b = fresh();
  run(a);
  run(b);
  assert.notEqual(parse(readFileSync(a, "utf8")).JWT_SECRET, parse(readFileSync(b, "utf8")).JWT_SECRET);
});

test("ขาดโดเมน → หยุดและไม่สร้างไฟล์; provider ผิด → หยุด", () => {
  const x = fresh();
  assert.notEqual(run(x, { SDES_DOMAIN: "" }).status, 0);
  assert.throws(() => statSync(x));
  assert.notEqual(run(fresh(), { EXTRACTION_PROVIDER: "gpt" }).status, 0);
});
