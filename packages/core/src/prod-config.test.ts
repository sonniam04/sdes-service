import { describe, expect, it, vi } from "vitest";
import { assertProductionEnv, checkProductionEnv } from "./index.js";

const strong = (n: number, c = "a") => `${c.repeat(n - 4)}Z9x!`;
const API_OK = {
  NODE_ENV: "production",
  DATABASE_URL: `postgresql://sdes_app:${strong(32)}@postgres:5432/sdes`,
  REDIS_URL: `redis://:${strong(32, "r")}@redis:6379`,
  S3_ENDPOINT: "http://seaweedfs:8333",
  S3_ACCESS_KEY: strong(20, "k"),
  S3_SECRET_KEY: strong(40, "s"),
  ERP_SECRET_KEY: strong(44, "e"),
  JWT_SECRET: strong(48, "j"),
  COOKIE_SECURE: "true",
  TRUST_PROXY: "172.30.0.10",
};
const WORKER_OK = { ...API_OK, JWT_SECRET: undefined, COOKIE_SECURE: undefined, TRUST_PROXY: undefined, EXTRACTION_PROVIDER: "fake" };
const names = (issues: { name: string }[]) => issues.map((i) => i.name);

describe("ค่าตั้ง production (spec production-deployment 'Configuration and secrets', design D6)", () => {
  it("ค่าครบ → ไม่มีปัญหา ทั้ง api และ worker", () => {
    expect(checkProductionEnv(API_OK, "api")).toEqual([]);
    expect(checkProductionEnv(WORKER_OK, "worker")).toEqual([]);
  });

  it("ขาด JWT_SECRET → ระบุชื่อค่า", () => {
    expect(names(checkProductionEnv({ ...API_OK, JWT_SECRET: undefined }, "api"))).toEqual(["JWT_SECRET"]);
  });

  it("รหัสผ่านสั้น / ค่าตัวอย่าง / COOKIE_SECURE=false ถูกจับทุกตัว", () => {
    const issues = checkProductionEnv(
      {
        ...API_OK,
        DATABASE_URL: "postgresql://sdes_app:short@postgres:5432/sdes",
        REDIS_URL: "redis://:change-me@redis:6379",
        S3_SECRET_KEY: "change-me",
        JWT_SECRET: "x".repeat(10),
        COOKIE_SECURE: "false",
      },
      "api",
    );
    expect(names(issues).sort()).toEqual(["COOKIE_SECURE", "DATABASE_URL", "JWT_SECRET", "REDIS_URL", "S3_SECRET_KEY"]);
  });

  it("TRUST_PROXY ต้องชี้ proxy ที่กำหนด ไม่ใช่เชื่อทุกต้นทาง", () => {
    expect(names(checkProductionEnv({ ...API_OK, TRUST_PROXY: undefined }, "api"))).toEqual(["TRUST_PROXY"]);
    expect(names(checkProductionEnv({ ...API_OK, TRUST_PROXY: "true" }, "api"))).toEqual(["TRUST_PROXY"]);
  });

  it("worker: provider ที่ต้องใช้ key แต่ไม่มี key / provider ไม่รู้จัก", () => {
    expect(names(checkProductionEnv({ ...WORKER_OK, EXTRACTION_PROVIDER: "gemini" }, "worker"))).toEqual(["GEMINI_API_KEY"]);
    expect(names(checkProductionEnv({ ...WORKER_OK, EXTRACTION_PROVIDER: "claude" }, "worker"))).toEqual(["ANTHROPIC_API_KEY"]);
    expect(names(checkProductionEnv({ ...WORKER_OK, EXTRACTION_PROVIDER: "gpt" }, "worker"))).toEqual(["EXTRACTION_PROVIDER"]);
    expect(checkProductionEnv({ ...WORKER_OK, EXTRACTION_PROVIDER: "gemini", GEMINI_API_KEY: "AIza-test-key" }, "worker")).toEqual([]);
  });

  it("ข้อความไม่มีค่าของ secret", () => {
    const secretValue = "change-me-but-long-enough-to-pass-length";
    const issues = checkProductionEnv({ ...API_OK, JWT_SECRET: "short-secret-value", S3_SECRET_KEY: secretValue, DATABASE_URL: "postgresql://u:pw123@db/x" }, "api");
    const text = JSON.stringify(issues);
    expect(text).not.toContain("short-secret-value");
    expect(text).not.toContain(secretValue);
    expect(text).not.toContain("pw123");
  });

  it("assert: production ที่มีปัญหา → log ชื่อค่าแล้ว exit 1; dev ไม่ตรวจ", () => {
    const log = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    assertProductionEnv("api", { ...API_OK, JWT_SECRET: undefined }, log, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join("\n")).toContain("JWT_SECRET");

    const exit2 = vi.fn() as unknown as (code: number) => never;
    assertProductionEnv("api", { NODE_ENV: "development" }, log, exit2);
    assertProductionEnv("api", API_OK, log, exit2);
    expect(exit2).not.toHaveBeenCalled();
  });
});
