import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Role } from "@sdes/core";
import { APP_CONFIG, type AppConfig } from "../config.js";
import type { Tx } from "../prisma.js";

export const REFRESH_COOKIE = "sdes_rt";

export const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** รหัสผ่านชั่วคราวที่ Admin ส่งให้ผู้ใช้ (ต้องเปลี่ยนตอนล็อกอินครั้งแรก) */
export const temporaryPassword = () => randomBytes(12).toString("base64url");

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  signAccess(user: { id: string; roles: Role[]; mustChangePassword: boolean }): string {
    return this.jwt.sign({ sub: user.id, roles: user.roles, pwc: user.mustChangePassword });
  }

  /**
   * ออก refresh token ใหม่ (เก็บเฉพาะ hash)
   * ตระกูลเดิมใช้วันหมดอายุเดิม เพื่อให้ session ยาวไม่เกิน 8 ชั่วโมงนับจากล็อกอิน
   */
  async issueRefresh(tx: Tx, userId: string, family?: { id: string; expiresAt: Date }) {
    const raw = randomBytes(32).toString("base64url");
    const expiresAt = family?.expiresAt ?? new Date(Date.now() + this.cfg.auth.refreshTtlSeconds * 1000);
    await tx.refreshToken.create({
      data: { userId, tokenHash: hashToken(raw), familyId: family?.id ?? randomUUID(), expiresAt },
    });
    return { raw, expiresAt };
  }

  cookieOptions(expiresAt: Date) {
    return {
      httpOnly: true,
      secure: this.cfg.auth.cookieSecure,
      sameSite: "strict" as const,
      path: "/auth",
      expires: expiresAt,
    };
  }

  get accessTtlSeconds() {
    return this.cfg.auth.accessTtlSeconds;
  }
}
