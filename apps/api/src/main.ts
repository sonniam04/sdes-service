import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { assertProductionEnv } from "@sdes/core";
import { DbLogger, SystemLogSink, type PrismaClient } from "@sdes/db";
import { AppModule } from "./app.module.js";
import { configureApp } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { PRISMA } from "./prisma.js";

async function bootstrap() {
  // production: ค่าตั้งไม่ครบให้หยุดพร้อมชื่อค่า ก่อนต่อฐานข้อมูลหรือรับคำขอ (design D6)
  assertProductionEnv("api");
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // warn/error เก็บลง system_logs ด้วย (spec system-logs) — ฐานล่มไม่กระทบคำขอ
  const sink = new SystemLogSink(app.get<PrismaClient>(PRISMA), "api");
  sink.start();
  app.useLogger(new DbLogger(sink));
  process.once("SIGTERM", () => void sink.stop());
  app.enableShutdownHooks();
  configureApp(app);
  await app.listen(loadConfig().port);
}
void bootstrap();
