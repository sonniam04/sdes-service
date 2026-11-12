// ข้อมูลหน้าภาพรวม ประกอบตามสิทธิ์ของผู้เรียก (spec overview-dashboard, design D1–D4)
import { Inject, Injectable } from "@nestjs/common";
import { can, type Action, type DocumentStatus } from "@sdes/core";
import { Prisma, type PrismaClient } from "@sdes/db";
import type { Principal } from "../auth/decorators.js";
import { OpsService } from "../erp/ops.service.js";
import { PRISMA } from "../prisma.js";
import { ReportMetrics, uploadedIn, type DateRange } from "../reports/report-metrics.js";

/** นาฬิกาของหน้าภาพรวม — test แทนค่าเพื่อให้ช่วงเวลาไม่ชนกับข้อมูลอื่น */
export const DASHBOARD_CLOCK = Symbol("DASHBOARD_CLOCK");
export type Clock = () => Date;

const DAY = 86_400_000;
const THROUGHPUT_DAYS = 14;
const INDICATOR_DAYS = 7;
const KEY_WARNING_DAYS = 14;
export const TARGETS = { seconds: 30, noEditRate: 0.92 } as const;

type BacklogGroup = "waiting" | "failed" | "reading" | "approval" | "syncFailed";
const BACKLOG: Record<BacklogGroup, DocumentStatus[]> = {
  waiting: ["EXTRACTED"],
  failed: ["FAILED"],
  reading: ["UPLOADED", "PROCESSING"],
  approval: ["PENDING_APPROVAL"],
  syncFailed: ["SYNC_FAILED"],
};

/** วันที่ YYYY-MM-DD ตามเวลาไทย */
const thaiDate = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monthStart = (day: string, offset = 0) => {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 10);
};

type Backlog = Record<BacklogGroup, { count: number; oldestAt: Date | null }>;

@Injectable()
export class DashboardService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(DASHBOARD_CLOCK) private readonly clock: Clock,
    private readonly metrics: ReportMetrics,
    private readonly ops: OpsService,
  ) {}

  async build(user: Principal) {
    const may = (a: Action) => !user.apiKey && can(user.roles, a);
    const now = this.clock();
    const today = thaiDate(now);
    const docs = may("document.view");
    const health = may("ops.view");

    const [backlog, throughput, indicators, finance, healthPart] = await Promise.all([
      docs || health ? this.backlog() : undefined,
      docs ? this.throughput(today) : undefined,
      docs ? this.indicators(today) : undefined,
      may("report.view") ? this.finance(today) : undefined,
      health ? this.health(now, may("logs.view"), may("apikey.manage")) : undefined,
    ]);

    return {
      generatedAt: now.toISOString(),
      ...(docs && { backlog, throughput, indicators }),
      ...(finance && { finance }),
      ...(healthPart && { health: { ...healthPart, syncFailed: backlog!.syncFailed.count } }),
    };
  }

  /** จำนวนและเวลาที่เข้าสถานะของฉบับที่รอนานที่สุด ต่อกลุ่ม (design D3) */
  private async backlog(): Promise<Backlog> {
    const rows = await this.prisma.document.groupBy({
      by: ["status"],
      where: { status: { in: Object.values(BACKLOG).flat() } },
      _count: { _all: true },
      _min: { updatedAt: true },
    });
    const out = {} as Backlog;
    for (const [group, statuses] of Object.entries(BACKLOG) as [BacklogGroup, DocumentStatus[]][]) {
      const mine = rows.filter((r) => statuses.includes(r.status));
      const oldest = mine.map((r) => r._min.updatedAt).filter((d): d is Date => !!d);
      out[group] = {
        count: mine.reduce((n, r) => n + r._count._all, 0),
        oldestAt: oldest.length ? new Date(Math.min(...oldest.map((d) => d.getTime()))) : null,
      };
    }
    return out;
  }

  /** อัปโหลด / ตรวจแล้วครั้งแรก / ส่งสำเร็จครั้งแรก รายวัน 14 วันรวมวันนี้ (เวลาไทย) */
  private async throughput(today: string) {
    const range: DateRange = { start: addDays(today, -(THROUGHPUT_DAYS - 1)), end: addDays(today, 1) };
    const from = Prisma.sql`(${range.start}::timestamp AT TIME ZONE 'Asia/Bangkok')`;
    const to = Prisma.sql`(${range.end}::timestamp AT TIME ZONE 'Asia/Bangkok')`;
    const days = await this.prisma.$queryRaw<{ date: string; uploaded: number; verified: number; synced: number }[]>`
      WITH up AS (
        SELECT (d.created_at AT TIME ZONE 'Asia/Bangkok')::date AS day, count(*)::int AS n
        FROM documents d WHERE ${uploadedIn(range)} GROUP BY 1),
      firsts AS (
        SELECT (min(h.created_at) AT TIME ZONE 'Asia/Bangkok')::date AS day, h.to_status
        FROM document_status_history h
        WHERE h.to_status IN ('VERIFIED', 'SYNCED') AND h.created_at >= ${from} AND h.created_at < ${to}
          AND NOT EXISTS (
            SELECT 1 FROM document_status_history p
            WHERE p.document_id = h.document_id AND p.to_status = h.to_status AND p.created_at < ${from})
        GROUP BY h.document_id, h.to_status),
      fin AS (
        SELECT day, count(*) FILTER (WHERE to_status = 'VERIFIED')::int AS verified, count(*) FILTER (WHERE to_status = 'SYNCED')::int AS synced
        FROM firsts GROUP BY day)
      SELECT to_char(g.day, 'YYYY-MM-DD') AS date, coalesce(up.n, 0) AS uploaded, coalesce(fin.verified, 0) AS verified, coalesce(fin.synced, 0) AS synced
      FROM generate_series(${range.start}::date, ${today}::date, interval '1 day') AS g(day)
      LEFT JOIN up ON up.day = g.day::date
      LEFT JOIN fin ON fin.day = g.day::date
      ORDER BY g.day`;
    return { days };
  }

  /** ตัวชี้วัดตาม BRD ของเอกสารที่อัปโหลด 7 วันล่าสุด — คำนวณชุดเดียวกับหน้ารายงาน */
  private async indicators(today: string) {
    const p = await this.metrics.process({ start: addDays(today, -(INDICATOR_DAYS - 1)), end: addDays(today, 1) });
    return {
      windowDays: INDICATOR_DAYS,
      avgSecondsToExtracted: p.avgSeconds.toExtracted,
      noEditRate: p.noEditRate,
      approvalRate: p.approvalRate,
      targets: TARGETS,
    };
  }

  /** ยอดเดือนนี้และเดือนก่อน ตามวันที่ในใบกำกับ — ชุดเดียวกับ /reports/summary */
  private async finance(today: string) {
    const [current, previous] = await Promise.all([
      this.metrics.totals({ start: monthStart(today), end: monthStart(today, 1) }),
      this.metrics.totals({ start: monthStart(today, -1), end: monthStart(today) }),
    ]);
    return { month: today.slice(0, 7), current, previous };
  }

  private async health(now: Date, withErrors: boolean, withKeys: boolean) {
    const [queues, erp, errors24h, expiringKeys] = await Promise.all([
      this.ops.queues(),
      this.ops.erpStatus(),
      withErrors ? this.prisma.systemLog.count({ where: { level: "error", createdAt: { gt: new Date(now.getTime() - DAY), lte: now } } }) : undefined,
      withKeys
        ? this.prisma.apiKey.findMany({
            where: { revokedAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + KEY_WARNING_DAYS * DAY) } },
            orderBy: { expiresAt: "asc" },
            select: { id: true, name: true, expiresAt: true },
          })
        : undefined,
    ]);
    return {
      queues,
      ...erp,
      ...(errors24h !== undefined && { errors24h }),
      ...(expiringKeys && { expiringKeys }),
    };
  }
}
