import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { assertProductionEnv } from "@sdes/core";
import { DbLogger, SystemLogSink, createPrisma } from "@sdes/db";
import { loadWorkerConfig } from "./config.js";
import { WorkerModule } from "./worker.module.js";

const READY_FILE = "/tmp/worker-ready";

async function bootstrap() {
  // production: ค่าตั้งไม่ครบให้หยุดพร้อมชื่อค่า ก่อนต่อฐานข้อมูลหรือรับคำขอ (design D6)
  assertProductionEnv("worker");
  // warn/error เก็บลง system_logs ด้วย (spec system-logs) — ฐานล่มไม่กระทบงาน
  const sink = new SystemLogSink(createPrisma(loadWorkerConfig().databaseUrl), "worker");
  sink.start();
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(new DbLogger(sink));
  process.once("SIGTERM", () => void sink.stop());
  app.enableShutdownHooks();
  // heartbeat ให้ healthcheck ของ docker compose และทำให้ process ไม่จบเอง
  // (เมื่อมี BullMQ worker ใน task 6.5 การเชื่อมต่อ Redis จะค้าง event loop ไว้อยู่แล้ว)
  const beat = () => writeFileSync(READY_FILE, new Date().toISOString());
  beat();
  const timer = setInterval(beat, 15_000);
  process.once("SIGTERM", () => clearInterval(timer));
}
void bootstrap();
