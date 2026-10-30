import { Injectable, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Queue, type Job, type Worker } from "bullmq";
import Redis from "ioredis";
import { ERP_SYNC_QUEUE, EXTRACT_QUEUE, type ErpSyncJob, type ExtractJob } from "@sdes/core";
import { createPrisma, purgeSystemLogs, type PrismaClient } from "@sdes/db";
import { loadWorkerConfig } from "./config.js";
import { createProvider, createS3, reconcileOnce, startExtractWorker, type Deps } from "./extract.js";
import { defaultAdapterFor, reconcileSync, s3AttachmentLoader, startSyncWorker, type SyncDeps } from "./erp/sync.js";

/** ครั้งสุดท้ายที่จะไม่ลองอีก → error, ครั้งที่ยังลองใหม่ได้ → warn */
const isFinal = (job: Job | undefined, err: Error) => !job || err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);

/** ลบ system logs ที่เก่ากว่า 30 วัน — ครั้งแรกตอนเริ่มแล้ววันละครั้ง (spec system-logs "Log retention") */
@Injectable()
class LogRetentionRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("LogRetention");
  private prisma!: PrismaClient;
  private timer?: NodeJS.Timeout;

  onModuleInit() {
    this.prisma = createPrisma(loadWorkerConfig().databaseUrl);
    const run = () =>
      purgeSystemLogs(this.prisma)
        .then((n) => n && this.log.log(`ลบ system logs ที่เก่ากว่า 30 วัน ${n} รายการ`))
        .catch((e) => this.log.error(`ลบ system logs เก่าไม่สำเร็จ: ${e}`));
    void run();
    this.timer = setInterval(run, 24 * 3600_000);
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.prisma?.$disconnect();
  }
}

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
    this.deps = { cfg, prisma: createPrisma(cfg.databaseUrl), redis: new Redis(cfg.redisUrl), provider: createProvider(cfg.extractionProvider, cfg.extraction), s3: createS3(cfg) };
    this.queue = new Queue<ExtractJob>(EXTRACT_QUEUE, { connection: this.connection, prefix: cfg.queuePrefix });
    this.worker = startExtractWorker(this.deps, this.connection);
    this.worker.on("completed", (job) => this.log.log(`อ่านเอกสาร ${job.data.documentId} เสร็จ`));
    this.worker.on("failed", (job, err) =>
      this.log[isFinal(job, err) ? "error" : "warn"](`อ่านเอกสาร ${job?.data.documentId} ไม่สำเร็จ (ครั้งที่ ${job?.attemptsMade}): ${err.message}`, "ExtractWorker"),
    );
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

/** คิวส่งเอกสารเข้า ERP + reconciler (design D1) */
@Injectable()
class SyncRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("ErpSyncWorker");
  private deps!: SyncDeps;
  private connection!: Redis;
  private worker!: Worker<ErpSyncJob>;
  private queue!: Queue<ErpSyncJob>;
  private timer?: NodeJS.Timeout;

  onModuleInit() {
    const cfg = loadWorkerConfig();
    this.connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    this.deps = {
      prisma: createPrisma(cfg.databaseUrl),
      redis: new Redis(cfg.redisUrl),
      adapterFor: defaultAdapterFor,
      loadAttachment: s3AttachmentLoader(createS3(cfg), cfg.s3.bucket),
      queuePrefix: cfg.queuePrefix,
    };
    this.queue = new Queue<ErpSyncJob>(ERP_SYNC_QUEUE, { connection: this.connection, prefix: cfg.queuePrefix });
    this.worker = startSyncWorker(this.deps, this.connection);
    this.worker.on("completed", (job, r) => r?.status && this.log.log(`ส่ง ${job.data.documentId} เข้า ERP แล้ว (${r.transactionId})`));
    this.worker.on("failed", (job, err) =>
      this.log[isFinal(job, err) ? "error" : "warn"](`ส่ง ${job?.data.documentId} เข้า ERP ไม่สำเร็จ (ครั้งที่ ${job?.attemptsMade}): ${err.message}`, "ErpSyncWorker"),
    );
    this.timer = setInterval(() => {
      reconcileSync(this.deps, this.queue)
        .then((n) => n && this.log.log(`reconciler ใส่งานส่ง ERP ที่ค้าง ${n} ฉบับ`))
        .catch((e) => this.log.error(`reconciler ส่ง ERP ล้มเหลว: ${e}`));
    }, cfg.reconcileIntervalMs);
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

@Module({ providers: [ExtractRunner, SyncRunner, LogRetentionRunner] })
export class WorkerModule {}
