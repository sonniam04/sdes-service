// ข้อมูลภาพรวมคิวและการเชื่อมต่อ ERP ใช้ร่วมกันระหว่าง /ops/overview และ /dashboard (overview-dashboard design D2)
import { Inject, Injectable } from "@nestjs/common";
import { loadErpConnection, type PrismaClient } from "@sdes/db";
import { QueueService } from "../documents/queue.service.js";
import { PRISMA } from "../prisma.js";

const pending = (c: Record<string, number>) => (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0);

@Injectable()
export class OpsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queue: QueueService,
  ) {}

  /** งานที่รอ/กำลังทำ/หน่วงไว้ในคิวอ่านและคิวส่ง */
  async queues() {
    const [extract, sync] = await Promise.all([
      this.queue.extract.getJobCounts("waiting", "active", "delayed"),
      this.queue.sync.getJobCounts("waiting", "active", "delayed"),
    ]);
    return { extract: pending(extract), sync: pending(sync) };
  }

  /** สถานะการเชื่อมต่อ ERP, การส่งอัตโนมัติ และเวลาส่งสำเร็จล่าสุด */
  async erpStatus() {
    const [conn, last] = await Promise.all([loadErpConnection(this.prisma), this.prisma.document.aggregate({ _max: { syncedAt: true } })]);
    return { connected: !!conn, autoSync: conn?.autoSync ?? false, lastSyncedAt: last._max.syncedAt };
  }
}
