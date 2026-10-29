import { assertTransition, type Actor, type DocumentStatus } from "@sdes/core";
import { recordAudit, type Tx } from "./audit.js";

/** เอกสารถูกเปลี่ยนไปก่อนแล้ว (optimistic lock ไม่ผ่าน) → API ตอบ 409 */
export class StaleDocumentError extends Error {
  constructor(readonly documentId: string) {
    super(`เอกสาร ${documentId} ถูกเปลี่ยนสถานะไปแล้ว`);
    this.name = "StaleDocumentError";
  }
}

export type TransitionInput = {
  documentId: string;
  to: DocumentStatus;
  actor: Actor;
  reason?: string;
  ip?: string;
  /** ถ้าระบุ ต้องตรงกับ version ปัจจุบัน (กันผู้ใช้สองคนกดพร้อมกัน) */
  expectedVersion?: number;
};

/**
 * เปลี่ยนสถานะเอกสารตาม state machine ใน @sdes/core
 * UPDATE ... WHERE status = from AND version = v แล้วเขียนประวัติ + audit ใน transaction เดียวกัน
 */
export async function transitionDocument(tx: Tx, input: TransitionInput) {
  const doc = await tx.document.findUnique({ where: { id: input.documentId } });
  if (!doc) throw new Error(`ไม่พบเอกสาร ${input.documentId}`);
  if (input.expectedVersion !== undefined && input.expectedVersion !== doc.version) {
    throw new StaleDocumentError(doc.id);
  }
  assertTransition(doc.status, input.to, input.actor, input.reason);

  const updated = await tx.document.updateMany({
    where: { id: doc.id, status: doc.status, version: doc.version },
    data: { status: input.to, version: { increment: 1 } },
  });
  if (updated.count === 0) throw new StaleDocumentError(doc.id);

  const actorUserId = input.actor.kind === "user" ? input.actor.userId : null;
  await tx.documentStatusHistory.create({
    data: {
      documentId: doc.id,
      fromStatus: doc.status,
      toStatus: input.to,
      actorType: input.actor.kind === "user" ? "USER" : "SYSTEM",
      actorUserId,
      reason: input.reason?.trim() || null,
    },
  });
  await recordAudit(tx, {
    actor: actorUserId ? { kind: "user", userId: actorUserId } : { kind: "system" },
    action: "document.status_changed",
    entityType: "document",
    entityId: doc.id,
    ip: input.ip,
    details: { field: "status", before: doc.status, after: input.to, reason: input.reason ?? null },
  });
  return { ...doc, status: input.to, version: doc.version + 1 };
}
