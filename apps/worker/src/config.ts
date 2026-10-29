import { existsSync } from "node:fs";
import { resolve } from "node:path";

// dev: อ่าน Service/.env (ใน container ค่ามาจาก environment ของ compose)
const envFile = resolve(__dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

const need = (k: string) => {
  const v = process.env[k];
  if (v === undefined) throw new Error(`ไม่ได้ตั้งค่า environment ${k}`);
  return v;
};
const local = (key: string, def: string) => `127.0.0.1:${process.env[key] ?? def}`;

export function loadWorkerConfig() {
  const e = process.env;
  return {
    databaseUrl: e.DATABASE_URL ?? `postgresql://sdes_app:${need("POSTGRES_APP_PASSWORD")}@${local("POSTGRES_HOST_PORT", "5433")}/${e.POSTGRES_DB ?? "sdes"}`,
    redisUrl: e.REDIS_URL ?? `redis://:${need("REDIS_PASSWORD")}@${local("REDIS_HOST_PORT", "6379")}`,
    s3: {
      endpoint: e.S3_ENDPOINT ?? `http://${local("S3_HOST_PORT", "8333")}`,
      accessKey: need("S3_ACCESS_KEY"),
      secretKey: need("S3_SECRET_KEY"),
      bucket: e.S3_BUCKET ?? "sdes-documents",
      region: e.S3_REGION ?? "ap-southeast-1",
    },
    /** design D8: เลือก provider ผ่าน config — Phase 1 มีแค่ fake */
    queuePrefix: e.QUEUE_PREFIX ?? "bull",
    extractionProvider: e.EXTRACTION_PROVIDER ?? "fake",
    concurrency: Number(e.WORKER_CONCURRENCY ?? "2"),
    reconcileIntervalMs: 60_000,
    /** เอกสาร UPLOADED ที่ค้างนานกว่านี้โดยไม่มี job จะถูก enqueue ใหม่ */
    stuckAfterMs: 2 * 60_000,
  };
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
