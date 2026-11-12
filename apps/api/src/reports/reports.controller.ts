// รายงานยอดซื้อ ภาษี และตัวชี้วัดกระบวนการ (spec finance-reports, design D6)
import { BadRequestException, Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsOptional, Matches } from "class-validator";
import type { Request, Response } from "express";
import type { PrismaClient } from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";
import { ReportMetrics, type Money } from "./report-metrics.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 24;

class PeriodQuery {
  @IsOptional() @Matches(MONTH, { message: "เดือนต้องอยู่ในรูปแบบ YYYY-MM" }) from?: string;
  @IsOptional() @Matches(MONTH, { message: "เดือนต้องอยู่ในรูปแบบ YYYY-MM" }) to?: string;
}

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
    private readonly metrics: ReportMetrics,
  ) {}

  @Get("summary")
  summary(@Query() q: PeriodQuery) {
    return this.metrics.summary(resolvePeriod(q));
  }

  @Get("summary/export")
  async export(@Query() q: PeriodQuery, @CurrentUser() user: Principal, @Req() req: Request, @Res() res: Response) {
    const p = resolvePeriod(q);
    const r = await this.metrics.summary(p);
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
}
