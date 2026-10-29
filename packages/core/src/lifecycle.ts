// State machine ของเอกสารตาม spec document-lifecycle
import type { Role } from "./roles.js";

export const DOCUMENT_STATUSES = [
  "UPLOADED",
  "PROCESSING",
  "FAILED",
  "EXTRACTED",
  "VERIFIED",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "SYNCING",
  "SYNCED",
  "SYNC_FAILED",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const INITIAL_STATUS: DocumentStatus = "UPLOADED";
export const TERMINAL_STATUSES: readonly DocumentStatus[] = ["SYNCED", "REJECTED"];

export type Actor = { kind: "system" } | { kind: "user"; userId: string; roles: readonly Role[] };

type Who = "system" | readonly Role[];

/** การเปลี่ยนสถานะที่อนุญาต และผู้ที่ทำได้ */
export const TRANSITIONS: readonly { from: DocumentStatus; to: DocumentStatus; by: Who; reasonRequired?: true }[] = [
  { from: "UPLOADED", to: "PROCESSING", by: "system" },
  { from: "PROCESSING", to: "EXTRACTED", by: "system" },
  { from: "PROCESSING", to: "FAILED", by: "system" },
  { from: "FAILED", to: "PROCESSING", by: ["AP_CLERK", "AP_LEAD"] },
  { from: "EXTRACTED", to: "VERIFIED", by: ["AP_CLERK", "AP_LEAD"] },
  { from: "VERIFIED", to: "PENDING_APPROVAL", by: "system" },
  { from: "VERIFIED", to: "SYNCING", by: "system" },
  { from: "PENDING_APPROVAL", to: "APPROVED", by: ["AP_LEAD"] },
  { from: "PENDING_APPROVAL", to: "REJECTED", by: ["AP_LEAD"], reasonRequired: true },
  { from: "APPROVED", to: "SYNCING", by: "system" },
  { from: "SYNCING", to: "SYNCED", by: "system" },
  { from: "SYNCING", to: "SYNC_FAILED", by: "system" },
  { from: "SYNC_FAILED", to: "SYNCING", by: ["SYS_ADMIN"] },
];

export type TransitionErrorCode = "terminal" | "not_allowed" | "forbidden" | "reason_required";

export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    readonly from: DocumentStatus,
    readonly to: DocumentStatus,
  ) {
    super(`เปลี่ยนสถานะ ${from} → ${to} ไม่ได้ (${code})`);
    this.name = "TransitionError";
  }
}

/** ตรวจว่าเปลี่ยนสถานะได้หรือไม่ — throw TransitionError เมื่อไม่ได้ */
export function assertTransition(from: DocumentStatus, to: DocumentStatus, actor: Actor, reason?: string): void {
  if (TERMINAL_STATUSES.includes(from)) throw new TransitionError("terminal", from, to);
  const rule = TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!rule) throw new TransitionError("not_allowed", from, to);
  const allowed =
    rule.by === "system" ? actor.kind === "system" : actor.kind === "user" && actor.roles.some((r) => rule.by.includes(r));
  if (!allowed) throw new TransitionError("forbidden", from, to);
  if (rule.reasonRequired && !reason?.trim()) throw new TransitionError("reason_required", from, to);
}

export function canTransition(from: DocumentStatus, to: DocumentStatus, actor: Actor, reason?: string): boolean {
  try {
    assertTransition(from, to, actor, reason);
    return true;
  } catch {
    return false;
  }
}
