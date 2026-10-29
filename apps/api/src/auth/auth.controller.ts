import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";
import type { Request, Response } from "express";
import { AuthService, type Session } from "./auth.service.js";
import { AllowDuringPasswordChange, CurrentUser, Public, type Principal } from "./decorators.js";
import { REFRESH_COOKIE, TokenService } from "./tokens.js";

class LoginDto {
  @IsEmail({}, { message: "กรอกอีเมลให้ถูกต้อง" })
  email!: string;

  @IsString()
  @MinLength(1, { message: "กรอกรหัสผ่าน" })
  @MaxLength(200)
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @MaxLength(200)
  newPassword!: string;
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  @ApiOperation({ summary: "ล็อกอินด้วยอีเมลและรหัสผ่าน — refresh token อยู่ใน cookie HttpOnly" })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto.email, dto.password, req.ip));
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  @ApiOperation({ summary: "ขอ access token ใหม่ (refresh token ใช้ได้ครั้งเดียว)" })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], req.ip));
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE], req.ip);
    res.clearCookie(REFRESH_COOKIE, { path: "/auth" });
  }

  @AllowDuringPasswordChange()
  @ApiBearerAuth()
  @Post("change-password")
  @HttpCode(200)
  changePassword(@CurrentUser() user: Principal, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    return this.auth.changePassword(user.userId, dto.currentPassword, dto.newPassword, req.ip);
  }

  @AllowDuringPasswordChange()
  @ApiBearerAuth()
  @Get("me")
  me(@CurrentUser() user: Principal) {
    return this.auth.me(user.userId);
  }

  private respond(res: Response, s: Session) {
    res.cookie(REFRESH_COOKIE, s.refresh.raw, this.tokens.cookieOptions(s.refresh.expiresAt));
    return { accessToken: s.accessToken, expiresIn: s.expiresIn, user: s.user };
  }
}
