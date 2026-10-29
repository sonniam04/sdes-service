import { redact } from "@sdes/core";
import type { Prisma, PrismaClient } from "./generated/client/index.js";

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

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

/** เขียน audit event ภายใน transaction ของการกระทำ — ถ้าเขียนไม่ได้ทั้ง transaction rollback */
export async function recordAudit(tx: Tx, e: AuditInput): Promise<void> {
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
