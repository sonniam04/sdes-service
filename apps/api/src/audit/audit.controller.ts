import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import type { Prisma, PrismaClient } from "@sdes/db";
import { RequirePermission } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";

class AuditQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() actorUserId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @IsString() entityId?: string;
  /** id ของรายการสุดท้ายจากหน้าก่อน (เรียงใหม่ → เก่า) */
  @IsOptional() @IsString() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/** ค้นหา audit trail — อ่านอย่างเดียว ไม่มี endpoint แก้ไขหรือลบ (spec audit-trail) */
@ApiTags("audit")
@ApiBearerAuth()
@RequirePermission("audit.view_all")
@Controller("audit-events")
export class AuditController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  async search(@Query() q: AuditQuery) {
    const where: Prisma.AuditEventWhereInput = {
      actorUserId: q.actorUserId,
      action: q.action,
      entityType: q.entityType,
      entityId: q.entityId,
      occurredAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
      id: q.before ? { lt: BigInt(q.before) } : undefined,
    };
    const limit = q.limit ?? 50;
    const rows = await this.prisma.auditEvent.findMany({ where, orderBy: { id: "desc" }, take: limit });
    return {
      items: rows.map((r) => ({ ...r, id: r.id.toString() })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.id.toString() : null,
    };
  }
}
