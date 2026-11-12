import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import type { Request } from "express";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { API_KEY_SCOPES, ApiKeysService, type ApiKeyScope } from "./api-keys.service.js";

class CreateApiKeyDto {
  @IsString()
  @MinLength(1, { message: "กรอกชื่อ API key" })
  @MaxLength(100)
  name!: string;

  @IsArray()
  @ArrayMinSize(1, { message: "เลือกขอบเขตสิทธิ์อย่างน้อยหนึ่งอย่าง" })
  @IsIn(API_KEY_SCOPES, { each: true, message: "ขอบเขตสิทธิ์ไม่ถูกต้อง" })
  scopes!: ApiKeyScope[];

  @IsOptional()
  @IsInt({ message: "อายุต้องเป็นจำนวนวัน" })
  @Min(1, { message: "อายุต้องอยู่ระหว่าง 1 ถึง 365 วัน" })
  @Max(365, { message: "อายุต้องอยู่ระหว่าง 1 ถึง 365 วัน" })
  expiresInDays?: number;
}

@ApiTags("admin")
@ApiBearerAuth()
@RequirePermission("apikey.manage")
@Controller("admin/api-keys")
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list() {
    return this.keys.list();
  }

  /** คืนค่า key เต็มครั้งเดียว */
  @Post()
  create(@Body() dto: CreateApiKeyDto, @CurrentUser() me: Principal, @Req() req: Request) {
    return this.keys.create(dto, { actorId: me.userId, ip: req.ip });
  }

  @Post(":id/revoke")
  @HttpCode(200)
  revoke(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: Principal, @Req() req: Request) {
    return this.keys.revoke(id, { actorId: me.userId, ip: req.ip });
  }
}
