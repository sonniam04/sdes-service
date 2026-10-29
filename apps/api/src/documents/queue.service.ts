import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import Redis from "ioredis";
import {
  ERP_SYNC_QUEUE,
  EXTRACT_QUEUE,
  erpSyncJobOptions,
  extractJobOptions,
  STATUS_CHANNEL,
  type ErpSyncJob,
  type ExtractJob,
  type StatusEvent,
} from "@sdes/core";
import { APP_CONFIG, type AppConfig } from "../config.js";

/** ส่งงานเข้าคิวประมวลผล และกระจายการเปลี่ยนสถานะผ่าน Redis pub/sub */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly publisher: Redis;
  readonly extract: Queue<ExtractJob>;
  readonly sync: Queue<ErpSyncJob>;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    this.publisher = new Redis(cfg.redisUrl);
    this.extract = new Queue<ExtractJob>(EXTRACT_QUEUE, { connection: this.connection, prefix: cfg.queuePrefix });
    this.sync = new Queue<ErpSyncJob>(ERP_SYNC_QUEUE, { connection: this.connection, prefix: cfg.queuePrefix });
  }

  /** ใส่งานส่ง ERP (worker ตัดสินเองว่าจะส่งหรือรอตามสวิตช์การส่งอัตโนมัติ) — งานที่จบแล้วถูกแทนที่ */
  async enqueueSync(documentIds: string[]) {
    for (const documentId of documentIds) {
      const existing = await this.sync.getJob(documentId);
      if (existing && ((await existing.isFailed()) || (await existing.isCompleted()))) await existing.remove();
      await this.sync.add("sync", { documentId }, erpSyncJobOptions(documentId));
    }
  }

  /** jobId = document id จึง enqueue ซ้ำได้อย่างปลอดภัย (idempotent) */
  async enqueueExtract(documentId: string) {
    const existing = await this.extract.getJob(documentId);
    if (existing && (await existing.isFailed())) await existing.remove();
    await this.extract.add("extract", { documentId }, extractJobOptions(documentId));
  }

  async publishStatus(e: StatusEvent) {
    await this.publisher.publish(STATUS_CHANNEL, JSON.stringify(e));
  }

  async onModuleDestroy() {
    await this.extract.close();
    await this.sync.close();
    this.publisher.disconnect();
    this.connection.disconnect();
  }
}
