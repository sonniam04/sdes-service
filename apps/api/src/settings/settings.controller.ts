// ตั้งค่าเกณฑ์ความเสี่ยงและข้อมูลบริษัท (spec risk-assessment "Configurable thresholds")
import { BadRequestException, Body, Controller, Get, Inject, Put, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import { MONEY_RE, isValidTaxId, normalizeTaxId } from "@sdes/core";
import { Prisma, loadReviewSettings, type PrismaClient } from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";

const RiskSettingsSchema = z
  .object({
    confidenceThreshold: z.number({ error: "เกณฑ์ความมั่นใจต้องเป็นตัวเลข" }).min(0, "เกณฑ์ความมั่นใจต้องอยู่ระหว่าง 0 ถึง 1").max(1, "เกณฑ์ความมั่นใจต้องอยู่ระหว่าง 0 ถึง 1"),
    highAmountThreshold: z.string().regex(MONEY_RE, "เกณฑ์ยอดสูงต้องเป็นจำนวนเงินทศนิยมไม่เกิน 2 ตำแหน่ง").nullable(),
    companyTaxId: z
      .string()
      .refine((v) => isValidTaxId(v), "เลขประจำตัวผู้เสียภาษีของบริษัทไม่ถูกต้อง")
      .transform(normalizeTaxId)
      .nullable(),
    companyName: z.string().trim().max(200).nullable(),
  })
  .strict();

const KEYS = {
  confidenceThreshold: "risk.confidence_threshold",
  highAmountThreshold: "risk.high_amount_threshold",
  companyTaxId: "company.tax_id",
  companyName: "company.name",
} as const;

@ApiTags("settings")
@ApiBearerAuth()
@Controller("settings")
export class SettingsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get("risk")
  @RequirePermission("settings.manage")
  async get() {
    const s = await loadReviewSettings(this.prisma);
    return {
      confidenceThreshold: s.thresholds.confidence,
      highAmountThreshold: s.thresholds.highAmount,
      companyTaxId: s.companyTaxId,
      companyName: s.companyName,
    };
  }

  @Put("risk")
  @RequirePermission("settings.manage")
  @ApiBody({
    schema: {
      example: { confidenceThreshold: 0.85, highAmountThreshold: "500000.00", companyTaxId: "0994000165617", companyName: "บริษัท ตัวอย่าง จำกัด" },
    },
  })
  async put(@Body() body: unknown, @CurrentUser() user: Principal, @Req() req: Request) {
    const parsed = RiskSettingsSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({ message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง", issues: parsed.error.issues });
    const before = await this.get();
    await this.prisma.$transaction(async (tx) => {
      for (const [field, key] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
        const value = parsed.data[field];
        if (JSON.stringify(before[field]) === JSON.stringify(value)) continue;
        await tx.setting.upsert({
          where: { key },
          create: { key, value: (value ?? Prisma.JsonNull) as Prisma.InputJsonValue },
          update: { value: (value ?? Prisma.JsonNull) as Prisma.InputJsonValue },
        });
        await this.audit.record(tx, {
          actor: { kind: "user", userId: user.userId },
          action: "settings.updated",
          entityType: "setting",
          entityId: null,
          ip: req.ip,
          details: { field: key, before: before[field], after: value },
        });
      }
    });
    return this.get();
  }
}
