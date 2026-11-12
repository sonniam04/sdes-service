import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { can, isRole, type Action } from "@sdes/core";
import { ApiKeysService } from "../api-keys/api-keys.service.js";
import { ALLOW_PASSWORD_CHANGE, IS_PUBLIC, REQUIRED_PERMISSION, type Principal } from "./decorators.js";

type AccessClaims = { sub: string; roles: string[]; pwc: boolean };

const INVALID_KEY = "API key ไม่ถูกต้อง หมดอายุ หรือถูกเพิกถอน";

/** ตรวจ access token (หรือ API key ของระบบภายนอก) ทุก route ยกเว้น @Public และบังคับเปลี่ยนรหัสผ่านชั่วคราวก่อนใช้งานอื่น */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const apiKey = token?.startsWith("sdes_") ? token : (req.headers["x-api-key"] as string | undefined);
    if (apiKey) {
      // spec api-keys "Authenticate with API key": key ผิด/หมดอายุ/เพิกถอน ตอบข้อความเดียวกัน
      const principal = await this.apiKeys.authenticate(apiKey);
      if (!principal) throw new UnauthorizedException(INVALID_KEY);
      req.user = principal;
      return true;
    }
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
    const targets = [ctx.getHandler(), ctx.getClass()];
    const action = this.reflector.getAllAndOverride<Action | undefined>(REQUIRED_PERMISSION, targets);
    const user: Principal | undefined = ctx.switchToHttp().getRequest().user;
    if (!action) {
      // route ที่ล็อกอินแล้วทุกคนใช้ได้ (เช่น /auth/me) เป็นของคนเท่านั้น — API key ใช้ได้เฉพาะ route ในขอบเขตของ key
      if (user?.apiKey && !this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) throw new ForbiddenException("ไม่มีสิทธิ์ทำรายการนี้");
      return true;
    }
    const allowed = user?.apiKey ? user.apiKey.permissions.includes(action) : !!user && can(user.roles, action);
    if (!allowed) throw new ForbiddenException("ไม่มีสิทธิ์ทำรายการนี้");
    return true;
  }
}
