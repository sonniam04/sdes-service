// API key ของระบบภายนอก (spec api-keys, design D1–D3)
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Action } from "@sdes/core";
import type { PrismaClient } from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import type { Principal } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";

export const API_KEY_SCOPES = ["document.upload", "document.read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** ขอบเขตของ key → permission ใน matrix (ไม่มีทางได้สิทธิ์แก้/อนุมัติ/งาน admin) */
const SCOPE_PERMISSIONS: Record<ApiKeyScope, Action[]> = {
  "document.upload": ["document.upload", "document.view"],
  "document.read": ["document.view"],
};

const KEY_RE = /^sdes_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{40,})$/;
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** อัปเดตเวลาใช้ล่าสุดไม่เกินนาทีละครั้งต่อ key */
const LAST_USED_EVERY_MS = 60_000;

type Ctx = { actorId: string; ip?: string };
type Row = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedById: string | null;
  createdById: string;
  createdAt: Date;
};

function newKey() {
  const prefix = Array.from(randomBytes(8), (b) => ALNUM[b % ALNUM.length]).join("");
  return { prefix, key: `sdes_${prefix}_${randomBytes(32).toString("base64url")}` };
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
    return this.view(rows);
  }

  async create(input: { name: string; scopes: ApiKeyScope[]; expiresInDays?: number }, ctx: Ctx) {
    const name = input.name.trim();
    const scopes = [...new Set(input.scopes)].sort();
    const days = input.expiresInDays ?? 90;
    if (!scopes.length) throw new BadRequestException("เลือกขอบเขตสิทธิ์อย่างน้อยหนึ่งอย่าง");
    const { prefix, key } = newKey();
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const row = await this.prisma.$transaction(async (tx) => {
      const clash = await tx.apiKey.count({ where: { name, revokedAt: null, expiresAt: { gt: new Date() } } });
      if (clash) throw new ConflictException("มี API key ชื่อนี้ที่ยังใช้งานได้อยู่แล้ว");
      // บัญชีบริการ: ไม่มีรหัสผ่าน (ล็อกอินไม่ได้) และไม่มี role — สิทธิ์มาจากขอบเขตของ key เท่านั้น (design D1)
      const service = await tx.user.create({
        data: { email: `apikey-${prefix.toLowerCase()}@service.sdes.local`, displayName: name, kind: "SERVICE", passwordHash: null, mustChangePassword: false },
      });
      const created = await tx.apiKey.create({
        data: { serviceUserId: service.id, name, prefix, keyHash: sha256(key), scopes, expiresAt, createdById: ctx.actorId },
      });
      // บันทึกแค่ prefix — ไม่มีค่า key (spec "API key storage")
      await this.audit.record(tx, {
        actor: { kind: "user", userId: ctx.actorId },
        action: "apikey.created",
        entityType: "api_key",
        entityId: created.id,
        ip: ctx.ip,
        details: { name, prefix, scopes, expiresAt: expiresAt.toISOString() },
      });
      return created;
    });
    // ส่งค่าเต็มกลับครั้งเดียว
    return { key, apiKey: (await this.view([row]))[0]! };
  }

  async revoke(id: string, ctx: Ctx) {
    const row = await this.prisma.$transaction(async (tx) => {
      const key = await tx.apiKey.findUnique({ where: { id } });
      if (!key) throw new NotFoundException("ไม่พบ API key");
      if (key.revokedAt) return key;
      const updated = await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date(), revokedById: ctx.actorId } });
      await tx.user.update({ where: { id: key.serviceUserId }, data: { isActive: false } });
      await this.audit.record(tx, { actor: { kind: "user", userId: ctx.actorId }, action: "apikey.revoked", entityType: "api_key", entityId: id, ip: ctx.ip, details: { name: key.name, prefix: key.prefix } });
      return updated;
    });
    return (await this.view([row]))[0]!;
  }

  /** ตรวจ key จาก header — คืน null เมื่อใช้ไม่ได้ (ผู้เรียกตอบ 401 ข้อความเดียวกันทุกกรณี) */
  async authenticate(key: string): Promise<Principal | null> {
    const m = KEY_RE.exec(key);
    if (!m) return null;
    const row = await this.prisma.apiKey.findUnique({ where: { prefix: m[1] } });
    if (!row) return null;
    const a = Buffer.from(row.keyHash, "hex");
    const b = Buffer.from(sha256(key), "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const now = new Date();
    if (row.revokedAt || row.expiresAt <= now) return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS)
      await this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: now } }).catch(() => {});
    const permissions = [...new Set(row.scopes.flatMap((s) => SCOPE_PERMISSIONS[s as ApiKeyScope] ?? []))];
    return { userId: row.serviceUserId, roles: [], mustChangePassword: false, apiKey: { id: row.id, permissions } };
  }

  private async view(rows: Row[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.createdById, r.revokedById]).filter((x): x is string => !!x))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }) : [];
    const name = new Map(users.map((u) => [u.id, u.displayName]));
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      expiresAt: r.expiresAt,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
      createdBy: name.get(r.createdById) ?? null,
      revokedAt: r.revokedAt,
      revokedBy: r.revokedById ? (name.get(r.revokedById) ?? null) : null,
      status: r.revokedAt ? ("revoked" as const) : r.expiresAt <= now ? ("expired" as const) : ("active" as const),
    }));
  }
}
