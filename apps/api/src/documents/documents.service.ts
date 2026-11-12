import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import sharp from "sharp";
import { DOCUMENT_STATUSES, TransitionError, asDocumentData, type Actor, type DocumentStatus } from "@sdes/core";
import { Prisma, StaleDocumentError, transitionDocument, type PrismaClient } from "@sdes/db";
import { AuditService } from "../audit/audit.service.js";
import type { Principal } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";
import { cleanup, MAX_FILES, receiveFiles, type IncomingFile } from "./multipart.js";
import { QueueService } from "./queue.service.js";
import { ScannerService, ScannerUnavailableError } from "./scanner.service.js";
import { EXTENSION, sniffMime } from "./sniff.js";
import { FILE_URL_TTL_SECONDS, StorageService } from "./storage.service.js";

export type UploadResult =
  | { fileName: string; ok: true; id: string; docNo: string; status: DocumentStatus }
  | { fileName: string; ok: false; code: RejectCode; message: string; duplicateOf?: string };

type RejectCode = "too_large" | "empty" | "unsupported" | "malware" | "scanner_unavailable" | "duplicate";

const REJECT: Record<RejectCode, string> = {
  too_large: "ไฟล์ใหญ่เกิน 20 MB",
  empty: "ไฟล์ว่าง",
  unsupported: "ชนิดไฟล์ไม่รองรับ (รองรับ PDF, TIFF, JPG, PNG)",
  malware: "ตรวจพบไฟล์อันตราย",
  scanner_unavailable: "ระบบสแกนไวรัสไม่พร้อม กรุณาลองใหม่ภายหลัง",
  duplicate: "ไฟล์ซ้ำกับเอกสาร",
};

const CONCURRENCY = 4;

@Injectable()
export class DocumentsService {
  private readonly log = new Logger(DocumentsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly scanner: ScannerService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  /** รับหลายไฟล์ ตัดสินผลแยกรายไฟล์ ไฟล์ที่ไม่ผ่านไม่กระทบไฟล์อื่น */
  async upload(req: Request, user: Principal) {
    const { files, dir, tooMany } = await receiveFiles(req);
    try {
      const results: UploadResult[] = new Array(files.length);
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const i = next++;
          results[i] = await this.ingestOne(files[i]!, user, req.ip);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
      return { results, ...(tooMany ? { warning: `รับได้ครั้งละไม่เกิน ${MAX_FILES} ไฟล์ ไฟล์ที่เกินไม่ถูกรับ` } : {}) };
    } finally {
      await cleanup(dir);
    }
  }

  private async ingestOne(f: IncomingFile, user: Principal, ip?: string): Promise<UploadResult> {
    const reject = async (code: RejectCode, extra: { signature?: string; duplicateOf?: string } = {}): Promise<UploadResult> => {
      await this.prisma.$transaction((tx) =>
        this.audit.record(tx, {
          actor: { kind: "user", userId: user.userId },
          action: "document.upload_rejected",
          entityType: "document",
          entityId: extra.duplicateOf ?? null,
          ip,
          details: { fileName: f.fileName, sha256: f.truncated ? null : f.sha256, sizeBytes: f.sizeBytes, reason: code, ...extra },
        }),
      );
      const message = code === "duplicate" ? `${REJECT.duplicate} ${extra.duplicateOf}` : REJECT[code];
      return { fileName: f.fileName, ok: false, code, message, ...(extra.duplicateOf ? { duplicateOf: extra.duplicateOf } : {}) };
    };

    if (f.truncated) return reject("too_large");
    if (f.sizeBytes === 0) return reject("empty");
    try {
      const scan = await this.scanner.scanFile(f.path);
      if (!scan.clean) return reject("malware", { signature: scan.signature });
    } catch (e) {
      if (e instanceof ScannerUnavailableError) {
        this.log.error(e.message);
        return reject("scanner_unavailable");
      }
      throw e;
    }

    // ตรวจชนิดหลังสแกน เพื่อให้ไฟล์อันตรายทุกชนิดถูกบันทึกว่าเป็นมัลแวร์
    const mime = sniffMime(f.head);
    if (!mime) return reject("unsupported");

    const dup = await this.findActiveDuplicate(f.sha256);
    if (dup) return reject("duplicate", { duplicateOf: dup });

    const now = new Date();
    const id = randomUUID();
    const key = `originals/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.${EXTENSION[mime]}`;
    await this.storage.putOriginal(key, f.path, mime, f.sizeBytes, f.sha256);

    let doc: { id: string; docNo: string; status: DocumentStatus };
    try {
      doc = await this.prisma.$transaction(async (tx) => {
        const created = await tx.document.create({
          data: { id, sha256: f.sha256, fileName: f.fileName, mimeType: mime, sizeBytes: f.sizeBytes, storageKey: key, uploadedById: user.userId },
          select: { id: true, docNo: true, status: true },
        });
        await tx.documentStatusHistory.create({
          data: { documentId: id, fromStatus: null, toStatus: "UPLOADED", actorType: "USER", actorUserId: user.userId },
        });
        await this.audit.record(tx, {
          actor: { kind: "user", userId: user.userId },
          action: "document.uploaded",
          entityType: "document",
          entityId: id,
          ip,
          details: { docNo: created.docNo, fileName: f.fileName, sha256: f.sha256, sizeBytes: f.sizeBytes, mimeType: mime },
        });
        return created;
      });
    } catch (e) {
      // อัปโหลดไฟล์เดียวกันพร้อมกัน: partial unique index ตัดสินให้ฝ่ายเดียวชนะ
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const winner = await this.findActiveDuplicate(f.sha256);
        return reject("duplicate", { duplicateOf: winner ?? "เอกสารอื่น" });
      }
      throw e;
    }

    await this.afterCommit(doc.id, doc.docNo, doc.status);
    return { fileName: f.fileName, ok: true, ...doc };
  }

  private async findActiveDuplicate(sha256: string) {
    const d = await this.prisma.document.findFirst({ where: { sha256, status: { not: "FAILED" } }, select: { docNo: true } });
    return d?.docNo;
  }

  /** เข้าคิวและแจ้งสถานะหลัง commit — ถ้า enqueue พลาด reconciler ของ worker จะเก็บตกให้ */
  private async afterCommit(id: string, docNo: string, status: DocumentStatus) {
    await this.queue.enqueueExtract(id).catch((e) => this.log.warn(`enqueue ${docNo} ไม่สำเร็จ (reconciler จะเก็บตก): ${e}`));
    await this.queue.publishStatus({ id, docNo, status, at: new Date().toISOString() }).catch(() => {});
  }

  async list(q: { status?: string; limit?: number; updatedSince?: string }) {
    const statuses = q.status
      ?.split(",")
      .map((s) => s.trim())
      .filter((s): s is DocumentStatus => (DOCUMENT_STATUSES as readonly string[]).includes(s));
    const rows = await this.prisma.document.findMany({
      where: {
        status: statuses?.length ? { in: statuses } : undefined,
        updatedAt: q.updatedSince ? { gte: new Date(q.updatedSince) } : undefined,
      },
      orderBy: { createdAt: "desc" },
      take: q.limit ?? 100,
      include: { vendor: { select: { name: true, taxId: true } } },
    });
    return {
      items: rows.map((d) => ({
        id: d.id,
        docNo: d.docNo,
        status: d.status,
        fileName: d.fileName,
        vendorName: d.vendor?.name ?? d.vendorName ?? null,
        invoiceNo: d.invoiceNo,
        // จำนวนรายการที่ต้องแก้ก่อนยืนยัน (ผลตรวจระดับ ERROR) แสดงในคิว
        issueCount: Array.isArray(d.validationIssues)
          ? (d.validationIssues as { severity?: string }[]).filter((i) => i.severity === "ERROR").length
          : 0,
        invoiceDate: d.invoiceDate,
        grandTotal: d.grandTotal?.toFixed(2) ?? null,
        confidence: d.confidence?.toString() ?? null,
        riskFlags: d.riskFlags,
        erpTransactionId: d.erpTransactionId,
        syncError: d.status === "SYNC_FAILED" ? d.syncError : null,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      serverTime: new Date().toISOString(),
    };
  }

  async get(id: string) {
    const d = await this.prisma.document.findUnique({
      where: { id },
      include: {
        statusHistory: { orderBy: { id: "asc" } },
        vendor: true,
        uploadedBy: { select: { displayName: true } },
        syncAttempts: { orderBy: [{ requestedAt: "asc" }, { attempt: "asc" }] },
      },
    });
    if (!d) throw new NotFoundException("ไม่พบเอกสาร");
    const actorIds = [...new Set(d.statusHistory.map((h) => h.actorUserId).filter((x): x is string => !!x))];
    const actors = await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } });
    const name = new Map(actors.map((a) => [a.id, a.displayName]));
    const { statusHistory, syncAttempts, storageKey: _key, ...doc } = d;
    return {
      ...doc,
      // jsonb ค่าเริ่มต้นเป็น {} — ส่งให้หน้าตรวจครบทุก field เสมอ
      data: asDocumentData(doc.data),
      // ประวัติการส่งเข้า ERP ทุกครั้ง (spec erp-sync "Attempt history")
      syncAttempts: syncAttempts.map((a) => ({
        attempt: a.attempt,
        adapter: a.adapter,
        status: a.status,
        transactionId: a.transactionId,
        reused: a.reused,
        error: a.error,
        requestedAt: a.requestedAt,
        respondedAt: a.respondedAt,
      })),
      confidence: d.confidence?.toString() ?? null,
      history: statusHistory.map((h) => ({
        id: h.id.toString(),
        from: h.fromStatus,
        to: h.toStatus,
        actor: h.actorType === "SYSTEM" ? { kind: "system" } : { kind: "user", id: h.actorUserId, name: name.get(h.actorUserId!) ?? null },
        reason: h.reason,
        at: h.createdAt,
      })),
    };
  }

  async fileUrl(id: string, user: Principal, ip?: string) {
    const d = await this.prisma.document.findUnique({ where: { id }, select: { id: true, storageKey: true, fileName: true, sha256: true } });
    if (!d) throw new NotFoundException("ไม่พบเอกสาร");
    const url = await this.storage.fileUrl(d.storageKey, d.fileName);
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, { actor: { kind: "user", userId: user.userId }, action: "document.file_viewed", entityType: "document", entityId: id, ip }),
    );
    return { url, expiresIn: FILE_URL_TTL_SECONDS, sha256: d.sha256 };
  }

  /** ไฟล์ต้นฉบับสำหรับตัวแสดงเอกสาร: PDF/JPG/PNG ส่งตามเดิม, TIFF ส่งเป็น PNG ทีละหน้า */
  async fileContent(id: string, page: number | undefined, user: Principal, ip?: string) {
    const d = await this.prisma.document.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } });
    if (!d) throw new NotFoundException("ไม่พบเอกสาร");
    const original = await this.storage.getOriginal(d.storageKey);
    // บันทึกการเปิดครั้งเดียวต่อการเปิดเอกสาร (หน้าแรก) ไม่ใช่ทุกหน้า
    if (!page || page === 1) {
      await this.prisma.$transaction((tx) =>
        this.audit.record(tx, { actor: { kind: "user", userId: user.userId }, action: "document.file_viewed", entityType: "document", entityId: id, ip }),
      );
    }
    if (d.mimeType !== "image/tiff") return { contentType: d.mimeType, body: original };
    const pageCount = (await sharp(original).metadata()).pages ?? 1;
    const index = Math.min(Math.max((page ?? 1) - 1, 0), pageCount - 1);
    return { contentType: "image/png", body: await sharp(original, { page: index }).png().toBuffer(), pageCount };
  }

  /** "อ่านใหม่" สำหรับเอกสาร FAILED โดยไม่ต้องอัปโหลดใหม่ */
  async retry(id: string, user: Principal, ip?: string) {
    const actor: Actor = { kind: "user", userId: user.userId, roles: user.roles };
    const doc = await this.transition(() =>
      this.prisma.$transaction((tx) => transitionDocument(tx, { documentId: id, to: "PROCESSING", actor, ip })),
    );
    await this.afterCommit(doc.id, doc.docNo, doc.status);
    return { id: doc.id, docNo: doc.docNo, status: doc.status };
  }

  /** แปลงข้อผิดพลาดของ state machine เป็น HTTP */
  private async transition<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof StaleDocumentError) throw new ConflictException("เอกสารนี้ถูกเปลี่ยนสถานะไปแล้ว กรุณาโหลดข้อมูลล่าสุด");
      if (e instanceof TransitionError) {
        if (e.code === "forbidden") throw new ForbiddenException("ไม่มีสิทธิ์เปลี่ยนสถานะนี้");
        throw new ConflictException(`เปลี่ยนสถานะจาก ${e.from} เป็น ${e.to} ไม่ได้`);
      }
      if (e instanceof Error && e.message.startsWith("ไม่พบเอกสาร")) throw new NotFoundException("ไม่พบเอกสาร");
      throw e;
    }
  }
}
