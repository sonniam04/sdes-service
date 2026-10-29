import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import { Public } from "../auth/decorators.js";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { HEALTH_CHECKS, type HealthCheck } from "./checks.js";

type CheckResult = { name: string; ok: boolean; error?: string };

@ApiTags("system")
@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(HEALTH_CHECKS) private readonly checks: HealthCheck[]) {}

  @Get()
  @ApiOperation({ summary: "ตรวจสถานะ DB, Redis, storage และตัวสแกนไวรัส" })
  @ApiResponse({ status: 200, description: "ทุกบริการพร้อม" })
  @ApiResponse({ status: 503, description: "มีบริการที่ไม่พร้อม" })
  async health(@Res({ passthrough: true }) res: Response) {
    const results: CheckResult[] = await Promise.all(
      this.checks.map(async (c) => {
        try {
          await c.check();
          return { name: c.name, ok: true };
        } catch (e) {
          return { name: c.name, ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    const ok = results.every((r) => r.ok);
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? "ok" : "degraded", checks: results };
  }
}
