import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import type { Request, Response } from "express";
import type { Prisma, PrismaClient } from "@sdes/db";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";
import { AuditService } from "./audit.service.js";

class AuditFilter {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() actorUserId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @IsString() entityId?: string;
  /** เลขเอกสาร เช่น DOC-000120 (แปลงเป็น entityId ของเอกสารนั้น) */
  @IsOptional() @IsString() docNo?: string;
}

class AuditQuery extends AuditFilter {
  /** id ของรายการสุดท้ายจากหน้าก่อน (เรียงใหม่ → เก่า) */
  @IsOptional() @IsString() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/** จำนวนแถวสูงสุดต่อการส่งออก (spec audit-trail "Audit export") */
export const EXPORT_MAX_ROWS = 50_000;
const EXPORT_CHUNK = 1000;

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** เวลาไทย (UTC+7) ในรูป YYYY-MM-DD HH:mm:ss */
const bangkok = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().replace("T", " ").slice(0, 19);

/** ค้นหาและส่งออก audit trail — อ่านอย่างเดียว ไม่มี endpoint แก้ไขหรือลบ (spec audit-trail) */
@ApiTags("audit")
@ApiBearerAuth()
@RequirePermission("audit.view_all")
@Controller("audit-events")
export class AuditController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async search(@Query() q: AuditQuery) {
    const where = await this.where(q);
    const limit = q.limit ?? 50;
    const rows = where ? await this.prisma.auditEvent.findMany({ where: { ...where, id: q.before ? { lt: BigInt(q.before) } : undefined }, orderBy: { id: "desc" }, take: limit }) : [];
    const names = await this.names(rows);
    return {
      items: rows.map((r) => ({ ...r, id: r.id.toString(), actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : null })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.id.toString() : null,
    };
  }

  /** ตัวเลือกของตัวกรองในหน้า Audit trail — Exec ไม่มีสิทธิ์อ่านรายชื่อผู้ใช้จาก /admin/users จึงให้ชื่อผ่านที่นี่ */
  @Get("facets")
  async facets() {
    const [users, actions] = await Promise.all([
      this.prisma.user.findMany({ select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
      this.prisma.auditEvent.groupBy({ by: ["action"], orderBy: { action: "asc" } }),
    ]);
    return { actors: users, actions: actions.map((a) => a.action) };
  }

  /** CSV UTF-8 + BOM (เปิดใน Excel ภาษาไทยได้) ตามตัวกรองเดียวกับการค้นหา — stream ทีละชุด */
  @Get("export")
  async export(@Query() q: AuditFilter, @CurrentUser() user: Principal, @Req() req: Request, @Res() res: Response) {
    const where = await this.where(q);
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, {
        actor: { kind: "user", userId: user.userId },
        action: "audit.exported",
        entityType: "audit",
        ip: req.ip,
        details: { filters: q, maxRows: EXPORT_MAX_ROWS },
      }),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.write("﻿");
    res.write(["เวลา (Asia/Bangkok)", "รหัส", "ผู้กระทำ", "ประเภทผู้กระทำ", "การกระทำ", "สิ่งที่ถูกกระทำ", "รหัสสิ่งที่ถูกกระทำ", "IP", "รายละเอียด"].map(csvCell).join(",") + "\r\n");
    let before: bigint | undefined;
    let written = 0;
    while (where && written < EXPORT_MAX_ROWS) {
      const rows = await this.prisma.auditEvent.findMany({
        where: { ...where, id: before ? { lt: before } : undefined },
        orderBy: { id: "desc" },
        take: Math.min(EXPORT_CHUNK, EXPORT_MAX_ROWS - written),
      });
      if (!rows.length) break;
      const names = await this.names(rows);
      res.write(
        rows
          .map((r) =>
            [bangkok(r.occurredAt), r.id.toString(), r.actorUserId ? (names.get(r.actorUserId) ?? r.actorUserId) : "ระบบ", r.actorType, r.action, r.entityType, r.entityId, r.ip, r.details]
              .map(csvCell)
              .join(","),
          )
          .join("\r\n") + "\r\n",
      );
      written += rows.length;
      before = rows[rows.length - 1]!.id;
    }
    res.end();
  }

  /** ตัวกรองร่วม — null = ไม่มีผลลัพธ์ (เช่น เลขเอกสารที่ไม่มี) */
  private async where(q: AuditFilter): Promise<Prisma.AuditEventWhereInput | null> {
    let entityId = q.entityId;
    if (q.docNo) {
      const doc = await this.prisma.document.findUnique({ where: { docNo: q.docNo.trim().toUpperCase() }, select: { id: true } });
      if (!doc) return null;
      entityId = doc.id;
    }
    return {
      actorUserId: q.actorUserId,
      action: q.action,
      entityType: q.entityType,
      entityId,
      occurredAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
    };
  }

  private async names(rows: { actorUserId: string | null }[]) {
    const ids = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }) : [];
    return new Map(users.map((u) => [u.id, u.displayName]));
  }
}
