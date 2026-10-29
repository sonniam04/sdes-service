import { Injectable } from "@nestjs/common";
import { recordAudit, type AuditInput, type Tx } from "@sdes/db";

export type { AuditActor, AuditInput } from "@sdes/db";

/**
 * เขียน audit event ภายใน transaction เดียวกับการกระทำ (spec audit-trail: Atomic recording)
 * ถ้าเขียนไม่ได้ จะ throw และทำให้ทั้ง transaction rollback
 */
@Injectable()
export class AuditService {
  record(tx: Tx, e: AuditInput): Promise<void> {
    return recordAudit(tx, e);
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
