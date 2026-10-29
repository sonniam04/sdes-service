import { Injectable } from "@nestjs/common";
import { redact } from "@sdes/core";
import type { Prisma } from "@sdes/db";
import type { Tx } from "../prisma.js";

export type AuditActor = { kind: "system" } | { kind: "user"; userId: string };

export type AuditInput = {
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  ip?: string | null;
  /** รายละเอียด เช่น { field, before, after } — ผ่าน redact() ก่อนเขียนเสมอ */
  details?: Record<string, unknown>;
};

/**
 * เขียน audit event ภายใน transaction เดียวกับการกระทำ (spec audit-trail: Atomic recording)
 * ถ้าเขียนไม่ได้ จะ throw และทำให้ทั้ง transaction rollback
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, e: AuditInput): Promise<void> {
    await tx.auditEvent.create({
      data: {
        actorType: e.actor.kind === "user" ? "USER" : "SYSTEM",
        actorUserId: e.actor.kind === "user" ? e.actor.userId : null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        ip: e.ip ?? null,
        details: e.details ? (redact(e.details) as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  /** บันทึกการแก้ field: ค่าก่อนและหลังของ field ที่เปลี่ยนจริงเท่านั้น */
  async recordChanges(
    tx: Tx,
    base: Omit<AuditInput, "details">,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    for (const field of Object.keys(after)) {
      if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
      await this.record(tx, { ...base, details: { field, before: before[field] ?? null, after: after[field] ?? null } });
    }
  }
}
