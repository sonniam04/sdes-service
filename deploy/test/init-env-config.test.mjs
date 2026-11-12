// pnpm test:deploy — ค่าที่ init-env.sh สร้างต้องผ่านการตรวจค่าตั้ง production ของ api/worker
// ต้อง build packages/core ก่อน และต้องมี sh + openssl ใน PATH (Linux, WSL หรือ Git Bash)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const { checkProductionEnv } = createRequire(import.meta.url)("../../packages/core/dist/index.js");
const script = fileURLToPath(new URL("../init-env.sh", import.meta.url));
const inputs = { SDES_DOMAIN: "sdes.example.test", SEED_ADMIN_EMAIL: "admin@example.test", EXTRACTION_PROVIDER: "fake" };
const parse = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_0-9]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

test("ค่าที่ init-env.sh สร้างผ่านการตรวจค่าตั้ง production ของ api และ worker", () => {
  const out = join(mkdtempSync(join(tmpdir(), "sdes-env-")), ".env.production");
  const r = spawnSync("sh", [script, out], { env: { ...process.env, ...inputs }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const e = parse(readFileSync(out, "utf8"));
  // ค่าเดียวกับที่ docker-compose.prod.yml ประกอบให้ api/worker
  const common = {
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://sdes_app:${e.POSTGRES_APP_PASSWORD}@postgres:5432/sdes`,
    REDIS_URL: `redis://:${e.REDIS_PASSWORD}@redis:6379`,
    S3_ENDPOINT: "http://seaweedfs:8333",
    S3_ACCESS_KEY: e.S3_ACCESS_KEY,
    S3_SECRET_KEY: e.S3_SECRET_KEY,
    ERP_SECRET_KEY: e.ERP_SECRET_KEY,
  };
  assert.deepEqual(checkProductionEnv({ ...common, JWT_SECRET: e.JWT_SECRET, COOKIE_SECURE: "true", TRUST_PROXY: "172.30.0.10" }, "api"), []);
  assert.deepEqual(checkProductionEnv({ ...common, EXTRACTION_PROVIDER: e.EXTRACTION_PROVIDER }, "worker"), []);
});
