import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { can, isRole, type Action } from "@sdes/core";
import { ALLOW_PASSWORD_CHANGE, IS_PUBLIC, REQUIRED_PERMISSION, type Principal } from "./decorators.js";

type AccessClaims = { sub: string; roles: string[]; pwc: boolean };

/** ตรวจ access token ทุก route ยกเว้น @Public และบังคับเปลี่ยนรหัสผ่านชั่วคราวก่อนใช้งานอื่น */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException("กรุณาเข้าสู่ระบบ");

    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token);
    } catch {
      throw new UnauthorizedException("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    }
    const principal: Principal = { userId: claims.sub, roles: claims.roles.filter(isRole), mustChangePassword: claims.pwc };
    req.user = principal;

    if (principal.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE, targets)) {
      throw new ForbiddenException({ code: "password_change_required", message: "กรุณาเปลี่ยนรหัสผ่านชั่วคราวก่อนใช้งาน" });
    }
    return true;
  }
}

/** ตรวจสิทธิ์ตาม permission matrix (บังคับที่ server เสมอ) */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<Action | undefined>(REQUIRED_PERMISSION, [ctx.getHandler(), ctx.getClass()]);
    if (!action) return true;
    const user: Principal | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || !can(user.roles, action)) throw new ForbiddenException("ไม่มีสิทธิ์ทำรายการนี้");
    return true;
  }
}
