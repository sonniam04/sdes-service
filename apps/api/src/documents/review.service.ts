// ตรวจแก้ ยืนยัน และอนุมัติเอกสาร (spec document-review, risk-assessment; design D6, D8)
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { z } from "zod";
import {
  HEADER_FIELDS,
  TransitionError,
  assessRisk,
  hasErrors,
  validateDocument,
  type Actor,
  type DocumentData,
  type DocumentItem,
  type FieldMeta,
  type RiskFlag,
} from "@sdes/core";
import {
  CONFIRMED_STATUSES,
  Prisma,
  StaleDocumentError,
  findDuplicateInvoice,
  loadReviewSettings,
  projectDocumentData,
  transitionDocument,
  type PrismaClient,
  type Tx,
} from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import type { Principal } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";
import { QueueService } from "./queue.service.js";

export const FIELD_EDITED = "document.field_edited";

// ---- รูปแบบคำขอแก้ข้อมูล: ค่าเป็นสตริงตามที่ผู้ใช้พิมพ์ (ผิดรูปแบบได้ — กฎตรวจจะแจ้ง) ----
const text = z.string().max(500).nullable();
const ItemSchema = z.object({
  no: z.number().int().min(1),
  description: text,
  quantity: text,
  unitPrice: text,
  discount: text.optional(),
  vat: text.optional(),
  amount: text,
});
const headerShape = Object.fromEntries(HEADER_FIELDS.map((k) => [k, k === "vatExempt" ? z.boolean() : text])) as Record<
  (typeof HEADER_FIELDS)[number],
  typeof text
>;
export const PatchSchema = z.object({
  version: z.number().int().min(1),
  changes: z
    .object({ ...headerShape, items: z.array(ItemSchema).max(500) })
    .partial()
    .strict(),
});
export type PatchBody = z.infer<typeof PatchSchema>;

const actorOf = (u: Principal): Actor => ({ kind: "user", userId: u.userId, roles: u.roles });

@Injectable()
export class ReviewService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  /** ประวัติการแก้ราย field (ค่าที่ AI อ่าน/ก่อน/หลัง และผู้แก้) — ใช้ในหน้าตรวจและโหมดอนุมัติ */
  async editHistory(documentId: string) {
    const events = await this.prisma.auditEvent.findMany({
      where: { entityType: "document", entityId: documentId, action: FIELD_EDITED },
      orderBy: { id: "asc" },
    });
    const ids = [...new Set(events.map((e) => e.actorUserId).filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
    const name = new Map(users.map((u) => [u.id, u.displayName]));
    return events.map((e) => {
      const d = (e.details ?? {}) as { field?: string; aiValue?: unknown; before?: unknown; after?: unknown };
      return {
        field: d.field ?? "",
        aiValue: d.aiValue ?? null,
        before: d.before ?? null,
        after: d.after ?? null,
        by: { id: e.actorUserId, name: e.actorUserId ? (name.get(e.actorUserId) ?? null) : null },
        at: e.occurredAt,
      };
    });
  }

  /** แก้ข้อมูลเอกสาร EXTRACTED แบบ optimistic lock แล้วตรวจใหม่ */
  async patchData(id: string, body: unknown, user: Principal, ip?: string) {
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ message: "รูปแบบข้อมูลไม่ถูกต้อง", issues: parsed.error.issues });
    const { version, changes } = parsed.data;

    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.findUnique({ where: { id } });
      if (!doc) throw new NotFoundException("ไม่พบเอกสาร");
      if (doc.status !== "EXTRACTED") throw new ConflictException({ code: "NOT_EDITABLE", message: "แก้ได้เฉพาะเอกสารที่รอตรวจ" });
      if (doc.version !== version)
        throw new ConflictException({ code: "STALE", message: "ข้อมูลถูกแก้ไปแล้ว กรุณาดูค่าล่าสุดก่อนแก้ต่อ", latest: this.view(doc) });

      const before = doc.data as unknown as DocumentData;
      const after = { ...before, ...changes } as DocumentData;
      const meta = (doc.fieldMeta ?? {}) as FieldMeta;
      for (const c of diffData(before, after)) {
        await this.audit.record(tx, {
          actor: { kind: "user", userId: user.userId },
          action: FIELD_EDITED,
          entityType: "document",
          entityId: id,
          ip,
          details: { field: c.field, aiValue: meta[c.field]?.aiValue ?? null, before: c.before, after: c.after },
        });
      }
      const issues = await this.validate(tx, after, doc.id, doc.createdAt);
      const updated = await tx.document.updateMany({
        where: { id, version, status: "EXTRACTED" },
        data: {
          data: after as unknown as Prisma.InputJsonValue,
          validationIssues: issues as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
          ...projectDocumentData(after),
        },
      });
      if (updated.count === 0) throw new ConflictException({ code: "STALE", message: "ข้อมูลถูกแก้ไปแล้ว กรุณาดูค่าล่าสุดก่อนแก้ต่อ" });
      return this.view(await tx.document.findUniqueOrThrow({ where: { id } }));
    });
  }

  /** ยืนยันเอกสาร: ตรวจซ้ำ → VERIFIED → จับคู่ผู้ขาย → ประเมินความเสี่ยง → PENDING_APPROVAL ถ้าเสี่ยง */
  async verify(id: string, version: number | undefined, user: Principal, ip?: string) {
    let flags: RiskFlag[] = [];
    const doc = await this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const current = await tx.document.findUnique({ where: { id } });
        if (!current) throw new NotFoundException("ไม่พบเอกสาร");
        const data = current.data as unknown as DocumentData;
        const issues = await this.validate(tx, data, id, current.createdAt);
        if (current.status === "EXTRACTED" && hasErrors(issues)) {
          await tx.document.update({ where: { id }, data: { validationIssues: issues as unknown as Prisma.InputJsonValue } });
          throw new UnprocessableEntityException({ code: "HAS_ERRORS", message: "ยังมีรายการที่ต้องแก้ก่อนยืนยัน", issues });
        }

        const verified = await transitionDocument(tx, { documentId: id, to: "VERIFIED", actor: actorOf(user), ip, expectedVersion: version });
        const vendor = await upsertVendor(tx, data);
        const isNewVendor =
          (await tx.document.count({
            where: { vendorId: vendor.id, id: { not: id }, status: { in: CONFIRMED_STATUSES.filter((s) => s !== "PENDING_APPROVAL") } },
          })) === 0;
        const edited = await tx.auditEvent.findMany({
          where: { entityType: "document", entityId: id, action: FIELD_EDITED },
          select: { details: true },
        });
        const settings = await loadReviewSettings(tx);
        flags = assessRisk(
          {
            confidence: current.confidence === null ? null : Number(current.confidence),
            grandTotal: data.grandTotal,
            isNewVendor,
            editedFields: edited.map((e) => String((e.details as { field?: string } | null)?.field ?? "")),
            issues,
          },
          settings.thresholds,
        );
        await tx.document.update({
          where: { id },
          data: {
            vendorId: vendor.id,
            verifiedById: user.userId,
            verifiedAt: new Date(),
            riskFlags: flags as unknown as Prisma.InputJsonValue,
            validationIssues: issues as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.record(tx, {
          actor: { kind: "system" },
          action: "document.risk_assessed",
          entityType: "document",
          entityId: id,
          details: { flags, thresholds: settings.thresholds },
        });
        if (!flags.length) return verified;
        return transitionDocument(tx, {
          documentId: id,
          to: "PENDING_APPROVAL",
          actor: { kind: "system" },
          reason: flags.map((f) => f.message).join(", "),
        });
      }),
    );
    await this.queue.publishStatus({ id: doc.id, docNo: doc.docNo, status: doc.status, at: new Date().toISOString() }).catch(() => {});
    const next = await this.prisma.document.findFirst({
      where: { status: "EXTRACTED", id: { not: id } },
      orderBy: { createdAt: "asc" },
      select: { id: true, docNo: true },
    });
    return { id: doc.id, docNo: doc.docNo, status: doc.status, riskFlags: flags, next };
  }

  /** คิวรออนุมัติ เรียงจากเก่าไปใหม่ */
  async approvals() {
    const rows = await this.prisma.document.findMany({
      where: { status: "PENDING_APPROVAL" },
      orderBy: { updatedAt: "asc" },
      include: { vendor: { select: { name: true } } },
      take: 500,
    });
    return {
      items: rows.map((d) => ({
        id: d.id,
        docNo: d.docNo,
        vendorName: d.vendor?.name ?? d.vendorName,
        invoiceNo: d.invoiceNo,
        grandTotal: d.grandTotal?.toFixed(2) ?? null,
        riskFlags: d.riskFlags,
        verifiedAt: d.verifiedAt,
      })),
    };
  }

  async decide(id: string, decision: "APPROVED" | "REJECTED", reason: string | undefined, version: number | undefined, user: Principal, ip?: string) {
    if (decision === "REJECTED" && !reason?.trim()) throw new BadRequestException({ code: "REASON_REQUIRED", message: "กรุณาระบุเหตุผลที่ปฏิเสธ" });
    const doc = await this.guard(() =>
      this.prisma.$transaction(async (tx) => {
        const current = await tx.document.findUnique({ where: { id }, select: { verifiedById: true } });
        if (!current) throw new NotFoundException("ไม่พบเอกสาร");
        const edited = await tx.auditEvent.count({
          where: { entityType: "document", entityId: id, action: FIELD_EDITED, actorUserId: user.userId },
        });
        // แยกหน้าที่: ผู้ยืนยันหรือผู้แก้ข้อมูลอนุมัติ/ปฏิเสธเองไม่ได้ (design D8)
        if (current.verifiedById === user.userId || edited > 0)
          throw new ForbiddenException({ code: "SELF_APPROVAL", message: "อนุมัติเอกสารที่คุณยืนยันหรือแก้ไขเองไม่ได้" });
        return transitionDocument(tx, { documentId: id, to: decision, actor: actorOf(user), reason, ip, expectedVersion: version });
      }),
    );
    await this.queue.publishStatus({ id: doc.id, docNo: doc.docNo, status: doc.status, at: new Date().toISOString() }).catch(() => {});
    return { id: doc.id, docNo: doc.docNo, status: doc.status };
  }

  private async validate(tx: Tx, data: DocumentData, id: string, uploadedAt: Date) {
    const settings = await loadReviewSettings(tx);
    return validateDocument(data, {
      companyTaxId: settings.companyTaxId,
      uploadedAt,
      duplicateDocNo: await findDuplicateInvoice(tx, data, id),
    });
  }

  private view(d: { id: string; docNo: string; status: string; version: number; data: unknown; validationIssues: unknown; fieldMeta: unknown }) {
    return { id: d.id, docNo: d.docNo, status: d.status, version: d.version, data: d.data, validationIssues: d.validationIssues, fieldMeta: d.fieldMeta };
  }

  /** แปลงข้อผิดพลาดของ state machine และ unique index เป็น HTTP */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof StaleDocumentError) throw new ConflictException({ code: "STALE", message: "เอกสารนี้ถูกเปลี่ยนสถานะไปแล้ว กรุณาโหลดข้อมูลล่าสุด" });
      if (e instanceof TransitionError) {
        if (e.code === "forbidden") throw new ForbiddenException("ไม่มีสิทธิ์เปลี่ยนสถานะนี้");
        if (e.code === "reason_required") throw new BadRequestException({ code: "REASON_REQUIRED", message: "กรุณาระบุเหตุผล" });
        throw new ConflictException({ code: "INVALID_TRANSITION", message: `เปลี่ยนสถานะจาก ${e.from} เป็น ${e.to} ไม่ได้` });
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
        throw new ConflictException({ code: "DUPLICATE_INVOICE", message: "เลขที่เอกสารนี้ของผู้ขายรายนี้ถูกยืนยันไปแล้ว" });
      throw e;
    }
  }
}

/** หาผู้ขายจาก Tax ID + สาขา หรือสร้างใหม่จากข้อมูลในเอกสาร */
async function upsertVendor(tx: Tx, d: DocumentData) {
  const p = projectDocumentData(d);
  if (!p.vendorTaxId) throw new UnprocessableEntityException({ code: "HAS_ERRORS", message: "ยังไม่มีเลขประจำตัวผู้เสียภาษีของผู้ขาย" });
  const branchCode = p.vendorBranch ?? "00000";
  return tx.vendor.upsert({
    where: { taxId_branchCode: { taxId: p.vendorTaxId, branchCode } },
    create: { taxId: p.vendorTaxId, branchCode, name: p.vendorName ?? "ไม่ทราบชื่อผู้ขาย" },
    update: {},
  });
}

type Change = { field: string; before: unknown; after: unknown };

/** เทียบข้อมูลก่อน/หลังเป็นราย field: หัวเอกสาร และรายการสินค้าเป็นรายช่อง (แถวที่เพิ่ม/ลบเป็นทั้งแถว) */
export function diffData(before: Partial<DocumentData>, after: Partial<DocumentData>): Change[] {
  const out: Change[] = [];
  for (const k of HEADER_FIELDS) {
    const b = before[k] ?? null;
    const a = after[k] ?? null;
    if (b !== a) out.push({ field: `header.${k}`, before: b, after: a });
  }
  const bi = before.items ?? [];
  const ai = after.items ?? [];
  for (let i = 0; i < Math.max(bi.length, ai.length); i++) {
    const b = bi[i];
    const a = ai[i];
    if (!b || !a) {
      out.push({ field: `items[${i}]`, before: b ?? null, after: a ?? null });
      continue;
    }
    for (const k of ["description", "quantity", "unitPrice", "discount", "vat", "amount"] as (keyof DocumentItem)[]) {
      const bv = b[k] ?? null;
      const av = a[k] ?? null;
      if (bv !== av) out.push({ field: `items[${i}].${k}`, before: bv, after: av });
    }
  }
  return out;
}
