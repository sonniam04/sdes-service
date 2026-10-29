import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import type { Request } from "express";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { DocumentsService } from "./documents.service.js";

class ListQuery {
  /** คั่นด้วย comma เช่น EXTRACTED,FAILED */
  @IsOptional() @IsString() status?: string;
  /** ใช้ resync หลังการเชื่อมต่อ real-time หลุด */
  @IsOptional() @IsDateString() updatedSince?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@ApiTags("documents")
@ApiBearerAuth()
@Controller("documents")
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Post()
  @RequirePermission("document.upload")
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

  @Get(":id")
  @RequirePermission("document.view")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.docs.get(id);
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
