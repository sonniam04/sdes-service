import { Body, Controller, UseGuards, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import type { Request, Response } from "express";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { DocumentsService } from "./documents.service.js";
import { ReviewService } from "./review.service.js";
import { SkipThrottle } from "@nestjs/throttler";
import { AppThrottlerGuard, THROTTLE_AUTH } from "../security/throttle.js";

class ListQuery {
  /** คั่นด้วย comma เช่น EXTRACTED,FAILED */
  @IsOptional() @IsString() status?: string;
  /** ใช้ resync หลังการเชื่อมต่อ real-time หลุด */
  @IsOptional() @IsDateString() updatedSince?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

class VersionBody {
  /** version ที่หน้าจอเห็นล่าสุด (optimistic lock) */
  @IsOptional() @IsInt() @Min(1) version?: number;
}

class RejectBody extends VersionBody {
  @IsOptional() @IsString() reason?: string;
}

@ApiTags("documents")
@ApiBearerAuth()
@Controller("documents")
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    private readonly review: ReviewService,
  ) {}

  @Post()
  @RequirePermission("document.upload")
  @UseGuards(AppThrottlerGuard)
  @SkipThrottle({ [THROTTLE_AUTH]: true })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { files: { type: "array", items: { type: "string", format: "binary" } } } } })
  upload(@Req() req: Request, @CurrentUser() user: Principal) {
    return this.docs.upload(req, user);
  }

  @Get()
  @RequirePermission("document.view")
  list(@Query() q: ListQuery) {
    return this.docs.list(q);
  }

  /** คิวรออนุมัติ — ประกาศก่อน :id เพื่อไม่ให้ถูกตีความเป็น id */
  @Get("approvals")
  @RequirePermission("document.approve")
  approvals() {
    return this.review.approvals();
  }

  @Get(":id")
  @RequirePermission("document.view")
  async get(@Param("id", ParseUUIDPipe) id: string) {
    return { ...(await this.docs.get(id)), edits: await this.review.editHistory(id) };
  }

  @Patch(":id/data")
  @RequirePermission("document.edit")
  @ApiBody({ schema: { example: { version: 3, changes: { grandTotal: "10700.00", vatAmount: "700.00" } } } })
  patchData(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: Principal, @Req() req: Request) {
    return this.review.patchData(id, body, user, req.ip);
  }

  @Post(":id/verify")
  @HttpCode(200)
  @RequirePermission("document.verify")
  verify(@Param("id", ParseUUIDPipe) id: string, @Body() body: VersionBody, @CurrentUser() user: Principal, @Req() req: Request) {
    return this.review.verify(id, body.version, user, req.ip);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("document.approve")
  approve(@Param("id", ParseUUIDPipe) id: string, @Body() body: VersionBody, @CurrentUser() user: Principal, @Req() req: Request) {
    return this.review.decide(id, "APPROVED", undefined, body.version, user, req.ip);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermission("document.approve")
  @ApiBody({ schema: { example: { reason: "ผู้ขายไม่อยู่ในรายชื่อที่ทำสัญญา", version: 5 } } })
  reject(@Param("id", ParseUUIDPipe) id: string, @Body() body: RejectBody, @CurrentUser() user: Principal, @Req() req: Request) {
    return this.review.decide(id, "REJECTED", body.reason, body.version, user, req.ip);
  }

  /** ไฟล์ต้นฉบับผ่าน API สำหรับตัวแสดงเอกสาร (TIFF ส่งเป็น PNG ราย ?page=N) */
  @Get(":id/file/content")
  @RequirePermission("document.view_file")
  async fileContent(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("page", new ParseIntPipe({ optional: true })) page: number | undefined,
    @CurrentUser() user: Principal,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const f = await this.docs.fileContent(id, page, user, req.ip);
    res.setHeader("Content-Type", f.contentType);
    res.setHeader("Cache-Control", "private, no-store");
    if (f.pageCount) res.setHeader("X-Page-Count", String(f.pageCount));
    res.send(f.body);
  }

  @Get(":id/file")
  @RequirePermission("document.view_file")
  file(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: Principal, @Req() req: Request) {
    return this.docs.fileUrl(id, user, req.ip);
  }

  @Post(":id/retry")
  @HttpCode(200)
  @RequirePermission("document.retry")
  retry(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: Principal, @Req() req: Request) {
    return this.docs.retry(id, user, req.ip);
  }
}
