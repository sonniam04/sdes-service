// ภาพรวมคิว + คิวที่ส่งไม่สำเร็จ + ส่งใหม่ (spec operations-monitoring, erp-sync "Resend failed documents")
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import { DOCUMENT_STATUSES, TransitionError } from "@sdes/core";
import { StaleDocumentError, loadErpConnection, transitionDocument, type PrismaClient } from "@sdes/db";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { QueueService } from "../documents/queue.service.js";
import { PRISMA } from "../prisma.js";

const ResendBody = z.object({ ids: z.array(z.string().uuid("รหัสเอกสารไม่ถูกต้อง")).min(1, "เลือกอย่างน้อยหนึ่งฉบับ").max(100, "ส่งใหม่ได้ครั้งละไม่เกิน 100 ฉบับ") });

@ApiTags("operations")
@ApiBearerAuth()
@Controller()
export class OpsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queue: QueueService,
  ) {}

  @Get("ops/overview")
  @RequirePermission("ops.view")
  async overview() {
    const [grouped, last, conn, extract, sync] = await Promise.all([
      this.prisma.document.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.document.aggregate({ _max: { syncedAt: true } }),
      loadErpConnection(this.prisma),
      this.queue.extract.getJobCounts("waiting", "active", "delayed"),
      this.queue.sync.getJobCounts("waiting", "active", "delayed"),
    ]);
    const counts = Object.fromEntries(DOCUMENT_STATUSES.map((s) => [s, 0]));
    for (const g of grouped) counts[g.status] = g._count._all;
    const pending = (c: Record<string, number>) => (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0);
    return {
      counts,
      queues: { extract: pending(extract), sync: pending(sync) },
      lastSyncedAt: last._max.syncedAt,
      autoSync: conn?.autoSync ?? false,
      connected: !!conn,
      serverTime: new Date().toISOString(),
    };
  }

  @Get("ops/sync-failed")
  @RequirePermission("ops.view")
  async syncFailed() {
    const rows = await this.prisma.document.findMany({
      where: { status: "SYNC_FAILED" },
      orderBy: { updatedAt: "asc" },
      take: 500,
      include: { vendor: { select: { name: true } }, _count: { select: { syncAttempts: true } } },
    });
    return {
      items: rows.map((d) => ({
        id: d.id,
        docNo: d.docNo,
        vendorName: d.vendor?.name ?? d.vendorName,
        grandTotal: d.grandTotal?.toFixed(2) ?? null,
        attempts: d._count.syncAttempts,
        syncError: d.syncError,
        failedAt: d.updatedAt,
      })),
    };
  }

  /** SYNC_FAILED → SYNCING ในนาม Admin แล้วใส่คิว — ผลแยกรายฉบับ */
  @Post("documents/resend")
  @HttpCode(200)
  @RequirePermission("sync.resend")
  @ApiBody({ schema: { example: { ids: ["00000000-0000-0000-0000-000000000000"] } } })
  async resend(@Body() body: unknown, @CurrentUser() user: Principal, @Req() req: Request) {
    const parsed = ResendBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" });
    const results: { id: string; ok: boolean; message?: string }[] = [];
    const queued: string[] = [];
    for (const id of [...new Set(parsed.data.ids)]) {
      try {
        const doc = await this.prisma.$transaction((tx) =>
          transitionDocument(tx, { documentId: id, to: "SYNCING", actor: { kind: "user", userId: user.userId, roles: user.roles }, reason: "ส่งใหม่", ip: req.ip }),
        );
        await this.prisma.document.update({ where: { id }, data: { syncError: null } });
        await this.queue.publishStatus({ id: doc.id, docNo: doc.docNo, status: doc.status, at: new Date().toISOString() }).catch(() => {});
        queued.push(id);
        results.push({ id, ok: true });
      } catch (e) {
        const message =
          e instanceof StaleDocumentError ? "เอกสารถูกเปลี่ยนสถานะไปแล้ว" : e instanceof TransitionError ? "ส่งใหม่ได้เฉพาะเอกสารที่ส่งไม่สำเร็จ" : e instanceof Error && e.message.startsWith("ไม่พบเอกสาร") ? "ไม่พบเอกสาร" : "ส่งใหม่ไม่สำเร็จ";
        results.push({ id, ok: false, message });
      }
    }
    await this.queue.enqueueSync(queued).catch(() => {});
    return { results };
  }
}
