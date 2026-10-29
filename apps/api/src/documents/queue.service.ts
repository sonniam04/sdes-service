import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { EXTRACT_QUEUE, extractJobOptions, STATUS_CHANNEL, type ExtractJob, type StatusEvent } from "@sdes/core";
import { APP_CONFIG, type AppConfig } from "../config.js";

/** ส่งงานเข้าคิวประมวลผล และกระจายการเปลี่ยนสถานะผ่าน Redis pub/sub */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly publisher: Redis;
  readonly extract: Queue<ExtractJob>;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    this.publisher = new Redis(cfg.redisUrl);
    this.extract = new Queue<ExtractJob>(EXTRACT_QUEUE, { connection: this.connection, prefix: cfg.queuePrefix });
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
    this.publisher.disconnect();
    this.connection.disconnect();
  }
}
