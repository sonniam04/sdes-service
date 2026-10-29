import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ArrayMinSize, IsArray, IsEmail, IsIn, IsString, MaxLength, MinLength } from "class-validator";
import type { Request } from "express";
import { ROLES, type Role } from "@sdes/core";
import { CurrentUser, RequirePermission, type Principal } from "../auth/decorators.js";
import { UsersService } from "./users.service.js";

class RolesDto {
  @IsArray()
  @ArrayMinSize(1, { message: "ต้องเลือกอย่างน้อยหนึ่ง role" })
  @IsIn(ROLES, { each: true, message: "role ไม่ถูกต้อง" })
  roles!: Role[];
}

class CreateUserDto extends RolesDto {
  @IsEmail({}, { message: "กรอกอีเมลให้ถูกต้อง" })
  email!: string;

  @IsString()
  @MinLength(1, { message: "กรอกชื่อที่แสดง" })
  @MaxLength(120)
  displayName!: string;
}

@ApiTags("admin")
@ApiBearerAuth()
@RequirePermission("user.manage")
@Controller("admin/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() me: Principal, @Req() req: Request) {
    return this.users.create(dto, { actorId: me.userId, ip: req.ip });
  }

  @Patch(":id/roles")
  setRoles(@Param("id", ParseUUIDPipe) id: string, @Body() dto: RolesDto, @CurrentUser() me: Principal, @Req() req: Request) {
    return this.users.setRoles(id, dto.roles, { actorId: me.userId, ip: req.ip });
  }

  @Post(":id/deactivate")
  @HttpCode(200)
  deactivate(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: Principal, @Req() req: Request) {
    return this.users.setActive(id, false, { actorId: me.userId, ip: req.ip });
  }

  @Post(":id/activate")
  @HttpCode(200)
  activate(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: Principal, @Req() req: Request) {
    return this.users.setActive(id, true, { actorId: me.userId, ip: req.ip });
  }

  @Post(":id/reset-password")
  @HttpCode(200)
  resetPassword(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: Principal, @Req() req: Request) {
    return this.users.resetPassword(id, { actorId: me.userId, ip: req.ip });
  }
}
