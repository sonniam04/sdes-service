import { Body, Controller, Get, HttpCode, Post, Put, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiTags } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";
import type { Request } from "express";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { ErpService } from "./erp.service.js";

class AutoSyncBody {
  @IsBoolean({ message: "enabled ต้องเป็น true หรือ false" }) enabled!: boolean;
}

@ApiTags("erp")
@ApiBearerAuth()
@Controller("erp")
export class ErpController {
  constructor(private readonly erp: ErpService) {}

  @Get("connection")
  @RequirePermission("erp.configure")
  get() {
    return this.erp.get();
  }

  @Put("connection")
  @RequirePermission("erp.configure")
  @ApiBody({
    schema: {
      example: {
        adapter: "odoo",
        url: "http://odoo:8069",
        database: "sdes_erp",
        apiMode: "json2",
        journalId: 2,
        purchaseTaxId: 7,
        expenseAccountId: 40,
        secret: "<Odoo API key — ส่งเฉพาะเมื่อเปลี่ยน>",
      },
    },
  })
  save(@Body() body: unknown, @CurrentUser() user: Principal, @Req() req: Request) {
    return this.erp.save(body, user, req.ip);
  }

  @Post("connection/test")
  @HttpCode(200)
  @RequirePermission("erp.configure")
  test(@CurrentUser() user: Principal, @Req() req: Request) {
    return this.erp.test(user, req.ip);
  }

  @Put("connection/auto-sync")
  @RequirePermission("erp.configure")
  autoSync(@Body() body: AutoSyncBody, @CurrentUser() user: Principal, @Req() req: Request) {
    return this.erp.setAutoSync(body.enabled, user, req.ip);
  }
}
