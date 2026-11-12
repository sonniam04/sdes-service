import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import argon2 from "argon2";
import type { Role } from "@sdes/core";
import type { PrismaClient } from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import { temporaryPassword } from "../auth/tokens.js";
import { PRISMA, type Tx } from "../prisma.js";

type Ctx = { actorId: string; ip?: string };

const view = (u: { id: string; email: string; displayName: string; isActive: boolean; mustChangePassword: boolean; lockedUntil: Date | null; createdAt: Date; roles: { role: Role }[] }) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  roles: u.roles.map((r) => r.role).sort(),
  isActive: u.isActive,
  mustChangePassword: u.mustChangePassword,
  lockedUntil: u.lockedUntil,
  createdAt: u.createdAt,
});

/** จัดการผู้ใช้โดย System Admin — ไม่มีการลบบัญชี (ใช้ปิดใช้งานแทน) เพื่อรักษา audit trail */
@Injectable()
export class UsersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list() {
    // บัญชีของ API key จัดการที่หน้า API keys ไม่ใช่ที่นี่ (spec user-access "Service accounts")
    const users = await this.prisma.user.findMany({ where: { kind: "HUMAN" }, include: { roles: true }, orderBy: { createdAt: "asc" } });
    return users.map(view);
  }

  async create(input: { email: string; displayName: string; roles: Role[] }, ctx: Ctx) {
    const email = input.email.trim().toLowerCase();
    const roles = [...new Set(input.roles)];
    const password = temporaryPassword();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    return this.prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email } })) throw new ConflictException("มีผู้ใช้อีเมลนี้อยู่แล้ว");
      const user = await tx.user.create({
        data: { email, displayName: input.displayName.trim(), passwordHash, mustChangePassword: true, roles: { create: roles.map((role) => ({ role })) } },
        include: { roles: true },
      });
      await this.audit.record(tx, { actor: { kind: "user", userId: ctx.actorId }, action: "user.created", entityType: "user", entityId: user.id, ip: ctx.ip, details: { email, roles } });
      // ส่งรหัสผ่านชั่วคราวกลับครั้งเดียว ไม่เก็บและไม่บันทึกลง audit
      return { user: view(user), temporaryPassword: password };
    });
  }

  async setRoles(id: string, roles: Role[], ctx: Ctx) {
    const next = [...new Set(roles)].sort();
    return this.prisma.$transaction(async (tx) => {
      const user = await this.load(tx, id);
      const before = user.roles.map((r) => r.role).sort();
      if (before.includes("SYS_ADMIN") && !next.includes("SYS_ADMIN")) await this.assertNotLastAdmin(tx, id);
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: next.map((role) => ({ userId: id, role })) });
      await this.audit.recordChanges(tx, { actor: { kind: "user", userId: ctx.actorId }, action: "user.roles_changed", entityType: "user", entityId: id, ip: ctx.ip }, { roles: before }, { roles: next });
      return view({ ...user, roles: next.map((role) => ({ role })) });
    });
  }

  async setActive(id: string, isActive: boolean, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.load(tx, id);
      if (!isActive && user.isActive && user.roles.some((r) => r.role === "SYS_ADMIN")) await this.assertNotLastAdmin(tx, id);
      const updated = await tx.user.update({ where: { id }, data: { isActive }, include: { roles: true } });
      // ปิดใช้งาน → ยกเลิก refresh token ทันที (access token ที่ค้างอยู่หมดอายุภายใน 15 นาที)
      if (!isActive) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.recordChanges(tx, { actor: { kind: "user", userId: ctx.actorId }, action: isActive ? "user.activated" : "user.deactivated", entityType: "user", entityId: id, ip: ctx.ip }, { isActive: user.isActive }, { isActive });
      return view(updated);
    });
  }

  async resetPassword(id: string, ctx: Ctx) {
    const password = temporaryPassword();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    return this.prisma.$transaction(async (tx) => {
      await this.load(tx, id);
      const updated = await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
        include: { roles: true },
      });
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, { actor: { kind: "user", userId: ctx.actorId }, action: "user.password_reset", entityType: "user", entityId: id, ip: ctx.ip });
      return { user: view(updated), temporaryPassword: password };
    });
  }

  private async load(tx: Tx, id: string) {
    const user = await tx.user.findUnique({ where: { id }, include: { roles: true } });
    if (!user || user.kind !== "HUMAN") throw new NotFoundException("ไม่พบผู้ใช้");
    return user;
  }

  /** ห้ามทำให้ระบบไม่เหลือ System Admin ที่ใช้งานได้ */
  private async assertNotLastAdmin(tx: Tx, id: string) {
    const others = await tx.user.count({ where: { id: { not: id }, isActive: true, roles: { some: { role: "SYS_ADMIN" } } } });
    if (others === 0) throw new ConflictException("ต้องมี System Admin ที่ใช้งานได้อย่างน้อย 1 คน");
  }
}
