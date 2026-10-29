import { existsSync } from "node:fs";
import { resolve } from "node:path";

// dev: อ่าน Service/.env และชี้ไปยัง port ฝั่งเครื่องของ docker compose
// ใน container ค่าเหล่านี้มาจาก environment ของ compose อยู่แล้ว
const envFile = resolve(__dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`ไม่ได้ตั้งค่า environment ${k}`);
  return v;
};

const hostPort = (key: string, def: string) => `localhost:${process.env[key] ?? def}`;

export function loadConfig() {
  const db = env("POSTGRES_DB", "sdes");
  return {
    port: Number(env("PORT", "3000")),
    databaseUrl: process.env.DATABASE_URL ?? `postgresql://sdes_app:${env("POSTGRES_APP_PASSWORD")}@${hostPort("POSTGRES_HOST_PORT", "5433")}/${db}`,
    databaseOwnerUrl:
      process.env.DATABASE_OWNER_URL ??
      `postgresql://${env("POSTGRES_OWNER_USER", "sdes_owner")}:${env("POSTGRES_OWNER_PASSWORD")}@${hostPort("POSTGRES_HOST_PORT", "5433")}/${db}`,
    redisUrl: process.env.REDIS_URL ?? `redis://:${env("REDIS_PASSWORD")}@${hostPort("REDIS_HOST_PORT", "6379")}`,
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? `http://${hostPort("S3_HOST_PORT", "8333")}`,
      accessKey: env("S3_ACCESS_KEY"),
      secretKey: env("S3_SECRET_KEY"),
      bucket: env("S3_BUCKET", "sdes-documents"),
      region: env("S3_REGION", "ap-southeast-1"),
      sse: env("S3_SSE", "false") === "true",
    },
    clamd: {
      host: env("CLAMD_HOST", "localhost"),
      port: Number(process.env.CLAMD_PORT ?? process.env.CLAMD_HOST_PORT ?? "3310"),
    },
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
export const APP_CONFIG = Symbol("APP_CONFIG");
