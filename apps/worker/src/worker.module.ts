import { Injectable, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Queue, type Worker } from "bullmq";
import Redis from "ioredis";
import { EXTRACT_QUEUE, type ExtractJob } from "@sdes/core";
import { createPrisma } from "@sdes/db";
import { loadWorkerConfig } from "./config.js";
import { createProvider, createS3, reconcileOnce, startExtractWorker, type Deps } from "./extract.js";

@Injectable()
class ExtractRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("ExtractWorker");
  private deps!: Deps;
  private connection!: Redis;
  private worker!: Worker<ExtractJob>;
  private queue!: Queue<ExtractJob>;
  private timer?: NodeJS.Timeout;

  onModuleInit() {
    const cfg = loadWorkerConfig();
    this.connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    this.deps = { cfg, prisma: createPrisma(cfg.databaseUrl), redis: new Redis(cfg.redisUrl), provider: createProvider(cfg.extractionProvider), s3: createS3(cfg) };
    this.queue = new Queue<ExtractJob>(EXTRACT_QUEUE, { connection: this.connection, prefix: cfg.queuePrefix });
    this.worker = startExtractWorker(this.deps, this.connection);
    this.worker.on("completed", (job) => this.log.log(`อ่านเอกสาร ${job.data.documentId} เสร็จ`));
    this.worker.on("failed", (job, err) => this.log.warn(`อ่านเอกสาร ${job?.data.documentId} ไม่สำเร็จ (ครั้งที่ ${job?.attemptsMade}): ${err.message}`));
    this.timer = setInterval(() => {
      reconcileOnce(this.deps, this.queue)
        .then((n) => n && this.log.log(`reconciler enqueue เอกสารที่ค้าง ${n} ฉบับ`))
        .catch((e) => this.log.error(`reconciler ล้มเหลว: ${e}`));
    }, cfg.reconcileIntervalMs);
    this.log.log(`พร้อมทำงาน provider=${cfg.extractionProvider} concurrency=${cfg.concurrency}`);
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
    await this.deps?.prisma.$disconnect();
    this.deps?.redis.disconnect();
    this.connection?.disconnect();
  }
}

@Module({ providers: [ExtractRunner] })
export class WorkerModule {}
