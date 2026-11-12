import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Action, Role } from "@sdes/core";

/** ผู้ใช้ที่ล็อกอินแล้ว (มาจาก access token) */
export type Principal = {
  userId: string;
  roles: Role[];
  mustChangePassword: boolean;
  /** มีเมื่อเรียกด้วย API key: สิทธิ์ตามขอบเขตของ key ใช้แทน roles (spec api-keys) */
  apiKey?: { id: string; permissions: readonly Action[] };
};

export const IS_PUBLIC = "auth:public";
export const ALLOW_PASSWORD_CHANGE = "auth:allow-password-change";
export const REQUIRED_PERMISSION = "auth:permission";

/** ไม่ต้องล็อกอิน */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** เรียกได้แม้ยังต้องเปลี่ยนรหัสผ่านชั่วคราว */
export const AllowDuringPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);
/** ต้องมีสิทธิ์ตาม permission matrix ใน @sdes/core */
export const RequirePermission = (action: Action) => SetMetadata(REQUIRED_PERMISSION, action);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().user;
});
