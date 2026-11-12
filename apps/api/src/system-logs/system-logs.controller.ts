import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import type { Prisma, PrismaClient } from "@sdes/db";
import { RequirePermission } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";

class SystemLogQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(["warn", "error"], { message: "ระดับต้องเป็น warn หรือ error" }) level?: string;
  @IsOptional() @IsIn(["api", "worker"], { message: "บริการต้องเป็น api หรือ worker" }) service?: string;
  /** คำในข้อความหรือส่วนของระบบ */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  /** id ของรายการสุดท้ายจากหน้าก่อน (เรียงใหม่ → เก่า) */
  @IsOptional() @Matches(/^\d+$/) before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/** ค้น log ระดับ warn/error ของ api/worker — อ่านอย่างเดียว (spec system-logs "Log viewer") */
@ApiTags("admin")
@ApiBearerAuth()
@RequirePermission("logs.view")
@Controller("admin/system-logs")
export class SystemLogsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  async search(@Query() q: SystemLogQuery) {
    const limit = q.limit ?? 50;
    const where: Prisma.SystemLogWhereInput = {
      level: q.level,
      service: q.service,
      id: q.before ? { lt: BigInt(q.before) } : undefined,
      createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
      OR: q.q ? [{ message: { contains: q.q, mode: "insensitive" } }, { context: { contains: q.q, mode: "insensitive" } }] : undefined,
    };
    // id เพิ่มตามลำดับที่เก็บ จึงใช้เรียงและแบ่งหน้าได้ตรงกับเวลา
    const rows = await this.prisma.systemLog.findMany({ where, orderBy: { id: "desc" }, take: limit });
    return {
      items: rows.map((r) => ({ ...r, id: r.id.toString() })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.id.toString() : null,
    };
  }
}
