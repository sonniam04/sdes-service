// รายงานยอดซื้อ ภาษี และตัวชี้วัดกระบวนการ (spec finance-reports, design D6)
import { BadRequestException, Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsOptional, Matches } from "class-validator";
import type { Request, Response } from "express";
import { DOCUMENT_STATUSES } from "@sdes/core";
import { CONFIRMED_STATUSES, Prisma, type PrismaClient } from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 24;

class PeriodQuery {
  @IsOptional() @Matches(MONTH, { message: "เดือนต้องอยู่ในรูปแบบ YYYY-MM" }) from?: string;
  @IsOptional() @Matches(MONTH, { message: "เดือนต้องอยู่ในรูปแบบ YYYY-MM" }) to?: string;
}

type Money = { subtotal: string; vat: string; wht: string; grandTotal: string };
type MonthRow = { month: string; documentCount: number } & Money;

// เงินคำนวณเป็น numeric ใน SQL แล้วจัดรูปเป็นสตริง 2 ตำแหน่ง (ไม่ผ่าน float)
const fmt = (expr: Prisma.Sql) => Prisma.sql`to_char(coalesce(${expr}, 0), 'FM999999999999990.00')`;
const counted = Prisma.sql`ARRAY[${Prisma.join(CONFIRMED_STATUSES.map((s) => Prisma.sql`${s}::"DocumentStatus"`))}]`;
const moneyCols = Prisma.sql`
  ${fmt(Prisma.sql`sum(coalesce(d.subtotal, 0) - coalesce(d.discount, 0))`)} AS subtotal,
  ${fmt(Prisma.sql`sum(d.vat_amount)`)} AS vat,
  ${fmt(Prisma.sql`sum(d.wht_amount)`)} AS wht,
  ${fmt(Prisma.sql`sum(d.grand_total)`)} AS "grandTotal"`;

/** เดือนปัจจุบันตามเวลาไทย */
const currentMonth = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

export function resolvePeriod(q: PeriodQuery) {
  const from = q.from ?? q.to ?? currentMonth();
  const to = q.to ?? q.from ?? currentMonth();
  const span = monthIndex(to) - monthIndex(from) + 1;
  if (span < 1) throw new BadRequestException("เดือนเริ่มต้องไม่หลังเดือนสิ้นสุด");
  if (span > MAX_MONTHS) throw new BadRequestException(`เลือกช่วงเวลาได้ไม่เกิน ${MAX_MONTHS} เดือน`);
  const next = monthIndex(to) + 1;
  const end = `${Math.floor(next / 12)}-${String((next % 12) + 1).padStart(2, "0")}-01`;
  return { from, to, start: `${from}-01`, end };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

@ApiTags("reports")
@ApiBearerAuth()
@RequirePermission("report.view")
@Controller("reports")
export class ReportsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get("summary")
  summary(@Query() q: PeriodQuery) {
    return this.build(resolvePeriod(q));
  }

  @Get("summary/export")
  async export(@Query() q: PeriodQuery, @CurrentUser() user: Principal, @Req() req: Request, @Res() res: Response) {
    const p = resolvePeriod(q);
    const r = await this.build(p);
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, { actor: { kind: "user", userId: user.userId }, action: "report.exported", entityType: "report", ip: req.ip, details: { from: p.from, to: p.to } }),
    );
    const line = (cells: unknown[]) => cells.map(csvCell).join(",");
    const m = (x: Money) => [x.subtotal, x.vat, x.wht, x.grandTotal];
    const lines = [
      line([`รายงานยอดซื้อ ${p.from} ถึง ${p.to} (ตามวันที่ในใบกำกับ เอกสารที่ยืนยันแล้วขึ้นไป ไม่รวมที่ถูกปฏิเสธ)`]),
      line(["เดือน", "จำนวนเอกสาร", "ยอดก่อนภาษี", "ภาษีซื้อ", "ภาษีหัก ณ ที่จ่าย", "ยอดรวม"]),
      ...r.months.map((x) => line([x.month, x.documentCount, ...m(x)])),
      line(["รวม", r.totals.documentCount, ...m(r.totals)]),
      "",
      line(["ผู้ขายยอดสูงสุด"]),
      line(["ลำดับ", "ผู้ขาย", "เลขประจำตัวผู้เสียภาษี", "สาขา", "จำนวนเอกสาร", "ยอดรวม"]),
      ...r.topVendors.map((v, i) => line([i + 1, v.name, v.taxId, v.branchCode, v.documentCount, v.grandTotal])),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="report-${p.from}-${p.to}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.send("﻿" + lines.join("\r\n") + "\r\n");
  }

  private async build(p: ReturnType<typeof resolvePeriod>) {
    const inPeriod = Prisma.sql`d.status = ANY(${counted}) AND d.invoice_date >= ${p.start}::date AND d.invoice_date < ${p.end}::date`;
    const [months, [totals], topVendors, process, statusRows] = await Promise.all([
      this.prisma.$queryRaw<MonthRow[]>`
        WITH agg AS (
          SELECT to_char(d.invoice_date, 'YYYY-MM') AS month, count(*)::int AS n, ${moneyCols}
          FROM documents d WHERE ${inPeriod} GROUP BY 1)
        SELECT to_char(m, 'YYYY-MM') AS month, coalesce(agg.n, 0) AS "documentCount",
               coalesce(agg.subtotal, '0.00') AS subtotal, coalesce(agg.vat, '0.00') AS vat,
               coalesce(agg.wht, '0.00') AS wht, coalesce(agg."grandTotal", '0.00') AS "grandTotal"
        FROM generate_series(${p.start}::date, (${p.end}::date - interval '1 month'), interval '1 month') m
        LEFT JOIN agg ON agg.month = to_char(m, 'YYYY-MM')
        ORDER BY m`,
      this.prisma.$queryRaw<[{ documentCount: number } & Money]>`
        SELECT count(*)::int AS "documentCount", ${moneyCols} FROM documents d WHERE ${inPeriod}`,
      this.prisma.$queryRaw<{ vendorId: string; name: string; taxId: string; branchCode: string; documentCount: number; grandTotal: string }[]>`
        SELECT v.id AS "vendorId", v.name, v.tax_id AS "taxId", v.branch_code AS "branchCode", count(*)::int AS "documentCount",
               ${fmt(Prisma.sql`sum(d.grand_total)`)} AS "grandTotal"
        FROM documents d JOIN vendors v ON v.id = d.vendor_id
        WHERE ${inPeriod}
        GROUP BY v.id ORDER BY sum(d.grand_total) DESC NULLS LAST, v.name LIMIT 10`,
      this.process(p),
      this.prisma.$queryRaw<{ status: string; n: number }[]>`
        SELECT d.status::text AS status, count(*)::int AS n FROM documents d
        WHERE (d.created_at AT TIME ZONE 'Asia/Bangkok') >= ${p.start}::timestamp AND (d.created_at AT TIME ZONE 'Asia/Bangkok') < ${p.end}::timestamp
        GROUP BY 1`,
    ]);
    const statusCounts = Object.fromEntries(DOCUMENT_STATUSES.map((s) => [s, 0]));
    for (const r of statusRows) statusCounts[r.status] = r.n;
    return { period: { from: p.from, to: p.to }, months, totals: totals!, topVendors, process: { ...process, statusCounts } };
  }

  /** ตัวชี้วัดตามวันที่อัปโหลด (เวลาไทย): เวลาเฉลี่ยแต่ละขั้นจากประวัติสถานะ, สัดส่วนที่ต้องอนุมัติ และที่ไม่ต้องแก้ค่าที่ AI อ่าน */
  private async process(p: ReturnType<typeof resolvePeriod>) {
    const first = (status: string) =>
      Prisma.sql`(SELECT min(h.created_at) FROM document_status_history h WHERE h.document_id = d.id AND h.to_status = ${status}::"DocumentStatus")`;
    const [r] = await this.prisma.$queryRaw<
      [{ uploaded: number; toExtracted: number | null; toVerified: number | null; toSynced: number | null; confirmed: number; approvals: number; noEdit: number }]
    >`
      WITH ds AS (
        SELECT d.id, d.created_at, ${first("EXTRACTED")} AS ex, ${first("VERIFIED")} AS ve, ${first("SYNCED")} AS sy,
               EXISTS (SELECT 1 FROM document_status_history h WHERE h.document_id = d.id AND h.to_status = 'PENDING_APPROVAL') AS pa,
               EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_type = 'document' AND a.entity_id = d.id::text AND a.action = 'document.field_edited') AS edited
        FROM documents d
        WHERE (d.created_at AT TIME ZONE 'Asia/Bangkok') >= ${p.start}::timestamp AND (d.created_at AT TIME ZONE 'Asia/Bangkok') < ${p.end}::timestamp)
      SELECT count(*)::int AS uploaded,
             avg(extract(epoch FROM ex - created_at))::float8 AS "toExtracted",
             avg(extract(epoch FROM ve - ex))::float8 AS "toVerified",
             avg(extract(epoch FROM sy - ve))::float8 AS "toSynced",
             count(*) FILTER (WHERE ve IS NOT NULL)::int AS confirmed,
             count(*) FILTER (WHERE ve IS NOT NULL AND pa)::int AS approvals,
             count(*) FILTER (WHERE ve IS NOT NULL AND NOT edited)::int AS "noEdit"
      FROM ds`;
    const round = (n: number | null) => (n === null ? null : Math.round(n));
    return {
      uploaded: r.uploaded,
      avgSeconds: { toExtracted: round(r.toExtracted), toVerified: round(r.toVerified), toSynced: round(r.toSynced) },
      approvalRate: r.confirmed ? r.approvals / r.confirmed : null,
      noEditRate: r.confirmed ? r.noEdit / r.confirmed : null,
    };
  }
}
