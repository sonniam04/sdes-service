import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DbLogger, SystemLogSink, type PrismaClient } from "@sdes/db";
import { AppModule } from "./app.module.js";
import { configureApp } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { PRISMA } from "./prisma.js";

async function bootstrap() {
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
