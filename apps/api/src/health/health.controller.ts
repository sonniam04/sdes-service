import { Controller, Get, HttpStatus, Inject, Logger, Res } from "@nestjs/common";
import { Public } from "../auth/decorators.js";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { HEALTH_CHECKS, type HealthCheck } from "./checks.js";

type CheckResult = { name: string; ok: boolean; error?: string };

@ApiTags("system")
@Public()
@Controller("health")
export class HealthController {
  private readonly log = new Logger(HealthController.name);

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
    // production: ข้อความ error อาจมีชื่อ host ภายใน — คำตอบมีเฉพาะชื่อ + ok ส่วนข้อความเต็มไปที่ System logs (design D9)
    if (process.env.NODE_ENV === "production") {
      for (const r of results) if (!r.ok) this.log.warn(`health: ${r.name} ไม่พร้อม — ${r.error}`);
      return { status: ok ? "ok" : "degraded", checks: results.map(({ name, ok }) => ({ name, ok })) };
    }
    return { status: ok ? "ok" : "degraded", checks: results };
  }
}
