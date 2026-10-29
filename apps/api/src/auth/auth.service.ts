import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import argon2 from "argon2";
import type { Role } from "@sdes/core";
import type { PrismaClient } from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { PRISMA } from "../prisma.js";
import { hashToken, TokenService } from "./tokens.js";

const INVALID = "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
const MIN_PASSWORD = 12;
// verify กับ hash หลอก เมื่อไม่พบอีเมล เพื่อไม่ให้เวลาตอบบอกได้ว่าอีเมลมีอยู่จริง
const DUMMY_HASH = argon2.hash("dummy-password-for-timing", { type: argon2.argon2id });

export type Session = {
  accessToken: string;
  expiresIn: number;
  refresh: { raw: string; expiresAt: Date };
  user: { id: string; email: string; displayName: string; roles: Role[]; mustChangePassword: boolean };
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(emailInput: string, password: string, ip?: string): Promise<Session> {
    const email = emailInput.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email }, include: { roles: true } });

    if (!user?.passwordHash) {
      await argon2.verify(await DUMMY_HASH, password).catch(() => false);
      await this.prisma.$transaction((tx) =>
        this.audit.record(tx, { actor: { kind: "system" }, action: "auth.login_failed", entityType: "user", ip, details: { email, reason: "unknown_email" } }),
      );
      throw new UnauthorizedException(INVALID);
    }

    const actor = { kind: "user" as const, userId: user.id };
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.prisma.$transaction((tx) =>
        this.audit.record(tx, { actor: { kind: "system" }, action: "auth.login_blocked", entityType: "user", entityId: user.id, ip, details: { lockedUntil: user.lockedUntil } }),
      );
      throw new HttpException("บัญชีถูกล็อกชั่วคราวเพราะใส่รหัสผ่านผิดหลายครั้ง ลองใหม่ภายหลัง", HttpStatus.LOCKED);
    }

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= this.cfg.auth.maxFailedLogins;
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: lock
            ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + this.cfg.auth.lockMinutes * 60_000) }
            : { failedLoginCount: failed },
        });
        await this.audit.record(tx, { actor: { kind: "system" }, action: "auth.login_failed", entityType: "user", entityId: user.id, ip, details: { attempt: failed } });
        if (lock) await this.audit.record(tx, { actor: { kind: "system" }, action: "auth.locked", entityType: "user", entityId: user.id, ip, details: { minutes: this.cfg.auth.lockMinutes } });
      });
      throw new UnauthorizedException(INVALID);
    }

    if (!user.isActive) {
      await this.prisma.$transaction((tx) =>
        this.audit.record(tx, { actor: { kind: "system" }, action: "auth.login_inactive", entityType: "user", entityId: user.id, ip }),
      );
      throw new UnauthorizedException(INVALID);
    }

    const roles = user.roles.map((r) => r.role);
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      const refresh = await this.tokens.issueRefresh(tx, user.id);
      await this.audit.record(tx, { actor, action: "auth.login", entityType: "user", entityId: user.id, ip });
      return this.session(user, roles, refresh);
    });
  }

  /** หมุน refresh token: ใช้ได้ครั้งเดียว ใช้ซ้ำ = ยกเลิกทั้งตระกูล */
  async refresh(raw: string | undefined, ip?: string): Promise<Session> {
    if (!raw) throw new UnauthorizedException("กรุณาเข้าสู่ระบบ");
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const token = await tx.refreshToken.findUnique({
        where: { tokenHash: hashToken(raw) },
        include: { user: { include: { roles: true } } },
      });
      if (!token || token.revokedAt || token.expiresAt <= now) return { error: "expired" as const };

      if (token.usedAt) {
        await tx.refreshToken.updateMany({ where: { familyId: token.familyId, revokedAt: null }, data: { revokedAt: now } });
        await this.audit.record(tx, {
          actor: { kind: "system" },
          action: "auth.refresh_reuse_detected",
          entityType: "user",
          entityId: token.userId,
          ip,
          details: { familyId: token.familyId },
        });
        return { error: "reuse" as const };
      }

      // ตรวจสถานะและ role ปัจจุบันจาก DB ทุกครั้ง — การปิดใช้งาน/เปลี่ยน role จึงมีผลภายในอายุ access token
      if (!token.user.isActive) {
        await tx.refreshToken.updateMany({ where: { familyId: token.familyId, revokedAt: null }, data: { revokedAt: now } });
        return { error: "inactive" as const };
      }

      const claimed = await tx.refreshToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) return { error: "reuse" as const };
      const refresh = await this.tokens.issueRefresh(tx, token.userId, { id: token.familyId, expiresAt: token.expiresAt });
      return { session: this.session(token.user, token.user.roles.map((r) => r.role), refresh) };
    });
    if ("error" in result) throw new UnauthorizedException("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    return result.session;
  }

  async logout(raw: string | undefined, ip?: string): Promise<void> {
    if (!raw) return;
    await this.prisma.$transaction(async (tx) => {
      const token = await tx.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) } });
      if (!token) return;
      await tx.refreshToken.updateMany({ where: { familyId: token.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, { actor: { kind: "user", userId: token.userId }, action: "auth.logout", entityType: "user", entityId: token.userId, ip });
    });
  }

  async changePassword(userId: string, current: string, next: string, ip?: string) {
    if (next.length < MIN_PASSWORD) throw new BadRequestException(`รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`);
    if (next === current) throw new BadRequestException("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม");
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
    if (!user?.passwordHash || !user.isActive) throw new UnauthorizedException("กรุณาเข้าสู่ระบบใหม่");
    if (!(await argon2.verify(user.passwordHash, current))) throw new ForbiddenException("รหัสผ่านปัจจุบันไม่ถูกต้อง");

    const passwordHash = await argon2.hash(next, { type: argon2.argon2id });
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false }, include: { roles: true } });
      await this.audit.record(tx, { actor: { kind: "user", userId }, action: "user.password_changed", entityType: "user", entityId: userId, ip });
      return u;
    });
    const roles = updated.roles.map((r) => r.role);
    return { accessToken: this.tokens.signAccess({ id: userId, roles, mustChangePassword: false }), expiresIn: this.tokens.accessTtlSeconds };
  }

  async me(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
    if (!u) throw new UnauthorizedException("กรุณาเข้าสู่ระบบใหม่");
    return { id: u.id, email: u.email, displayName: u.displayName, roles: u.roles.map((r) => r.role), mustChangePassword: u.mustChangePassword };
  }

  private session(
    user: { id: string; email: string; displayName: string; mustChangePassword: boolean },
    roles: Role[],
    refresh: { raw: string; expiresAt: Date },
  ): Session {
    return {
      accessToken: this.tokens.signAccess({ id: user.id, roles, mustChangePassword: user.mustChangePassword }),
      expiresIn: this.tokens.accessTtlSeconds,
      refresh,
      user: { id: user.id, email: user.email, displayName: user.displayName, roles, mustChangePassword: user.mustChangePassword },
    };
  }
}
