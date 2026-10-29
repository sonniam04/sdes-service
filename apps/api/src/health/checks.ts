import { connect } from "node:net";
import { Client } from "pg";
import Redis from "ioredis";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";

export type HealthCheck = { name: string; check: () => Promise<void> };
export const HEALTH_CHECKS = Symbol("HEALTH_CHECKS");

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} ไม่ตอบใน ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** ส่งคำสั่ง zPING ไปยัง clamd แล้วรอ PONG */
export function pingClamd(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, host);
    let reply = "";
    sock.on("connect", () => sock.write("zPING\0"));
    sock.on("data", (d) => (reply += d.toString()));
    sock.on("end", () => (reply.startsWith("PONG") ? resolve() : reject(new Error("clamd ไม่ตอบ PONG"))));
    sock.on("error", reject);
  });
}

export function buildHealthChecks(cfg: AppConfig): HealthCheck[] {
  return [
    {
      name: "database",
      check: async () => {
        const c = new Client({ connectionString: cfg.databaseUrl, connectionTimeoutMillis: 2000 });
        try {
          await c.connect();
          await c.query("SELECT 1");
        } finally {
          await c.end().catch(() => {});
        }
      },
    },
    {
      name: "redis",
      check: async () => {
        const r = new Redis(cfg.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 2000 });
        try {
          await r.connect();
          if ((await r.ping()) !== "PONG") throw new Error("redis ไม่ตอบ PONG");
        } finally {
          r.disconnect();
        }
      },
    },
    {
      name: "storage",
      check: async () => {
        const s3 = new S3Client({
          endpoint: cfg.s3.endpoint,
          region: cfg.s3.region,
          forcePathStyle: true,
          credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
        });
        try {
          await withTimeout(s3.send(new ListBucketsCommand({})), 2000, "storage");
        } finally {
          s3.destroy();
        }
      },
    },
    { name: "virus-scanner", check: () => withTimeout(pingClamd(cfg.clamd.host, cfg.clamd.port), 2000, "virus-scanner") },
  ];
}
