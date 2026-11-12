// หน้าภาพรวม (spec overview-dashboard)
import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { DashboardService } from "./dashboard.service.js";

const EXAMPLE = {
  generatedAt: "2026-11-01T05:00:00.000Z",
  backlog: {
    waiting: { count: 4, oldestAt: "2026-11-01T02:00:00.000Z" },
    failed: { count: 1, oldestAt: "2026-10-31T09:12:00.000Z" },
    reading: { count: 2, oldestAt: "2026-11-01T04:59:30.000Z" },
    approval: { count: 1, oldestAt: "2026-11-01T03:10:00.000Z" },
    syncFailed: { count: 0, oldestAt: null },
  },
  throughput: { days: [{ date: "2026-11-01", uploaded: 12, verified: 9, synced: 8 }] },
  indicators: { windowDays: 7, avgSecondsToExtracted: 21, noEditRate: 0.94, approvalRate: 0.12, targets: { seconds: 30, noEditRate: 0.92 } },
  finance: {
    month: "2026-11",
    current: { documentCount: 120, subtotal: "350000.00", vat: "24500.00", wht: "3000.00", grandTotal: "371500.00" },
    previous: { documentCount: 310, subtotal: "910000.00", vat: "63700.00", wht: "8100.00", grandTotal: "965600.00" },
  },
  health: {
    queues: { extract: 2, sync: 0 },
    connected: true,
    autoSync: true,
    lastSyncedAt: "2026-11-01T04:58:00.000Z",
    syncFailed: 0,
    errors24h: 3,
    expiringKeys: [{ id: "00000000-0000-0000-0000-000000000000", name: "เครื่องสแกนชั้น 2", expiresAt: "2026-11-09T00:00:00.000Z" }],
  },
};

@ApiTags("dashboard")
@ApiBearerAuth()
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** แต่ละส่วนมีเฉพาะเมื่อผู้เรียกมีสิทธิ์ดูข้อมูลชนิดนั้น (ส่วนที่ไม่มีสิทธิ์ไม่มี key ในผลลัพธ์) */
  @Get()
  @RequirePermission("dashboard.view")
  @ApiOkResponse({ description: "ภาพรวมตามสิทธิ์ของผู้เรียก — ตัวอย่างนี้คือผู้ใช้ที่ได้ทุกส่วน", schema: { example: EXAMPLE } })
  get(@CurrentUser() user: Principal) {
    return this.dashboard.build(user);
  }
}
