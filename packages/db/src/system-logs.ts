// เก็บ log ระดับ warn/error ของ api/worker ลงฐานข้อมูลแบบไม่บล็อก (spec system-logs, design D4)
import { ConsoleLogger } from "@nestjs/common";
import { REDACTED, redact } from "@sdes/core";
import type { Prisma, PrismaClient } from "./generated/client/index.js";

export type LogService = "api" | "worker";
export type LogLevel = "warn" | "error";
export type LogEntry = { level: LogLevel; context: string | null; message: string; details?: Record<string, unknown> };
export type SystemLogRow = { service: LogService; level: LogLevel; context: string | null; message: string; details: Prisma.InputJsonValue | undefined };

/** วันที่เก็บ log ก่อนลบอัตโนมัติ (spec "Log retention") */
export const SYSTEM_LOG_RETENTION_DAYS = 30;
const MAX_MESSAGE = 4000;

// secret ในข้อความอิสระ (key ของ object ถูกจัดการโดย redact() ของ core อยู่แล้ว)
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY = /\bsdes_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20,}/g;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;
/** เลข 13 หลัก (Tax ID/บัตรประชาชน) — log อ้างอิงเอกสารด้วยเลข DOC-xxxxxx ได้แทน */
const THIRTEEN_DIGITS = /\b\d[- ]?\d{4}[- ]?\d{5}[- ]?\d{2}[- ]?\d\b/g;

export function maskLogText(s: string): string {
  return s
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(API_KEY, REDACTED)
    .replace(URL_CREDENTIALS, (_m, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(THIRTEEN_DIGITS, REDACTED);
}

function maskDeep(v: unknown): unknown {
  if (typeof v === "string") return maskLogText(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
}

type Db = Pick<PrismaClient, "systemLog">;

/**
 * คิวในหน่วยความจำ + flush เป็นชุดตามรอบเวลา
 * ฐานข้อมูลล่มต้องไม่ทำให้งานที่กำลังทำล้ม: flush ไม่ throw และทิ้งชุดที่ส่งไม่สำเร็จ
 */
export class SystemLogSink {
  private queue: SystemLogRow[] = [];
  private timer?: NodeJS.Timeout;
  private lastFailureWarn = 0;
  private readonly maxQueue: number;
  private readonly flushMs: number;

  constructor(
    private readonly db: Db,
    private readonly service: LogService,
    opts: { maxQueue?: number; flushMs?: number } = {},
  ) {
    this.maxQueue = opts.maxQueue ?? 1000;
    this.flushMs = opts.flushMs ?? 2000;
  }

  get pending() {
    return this.queue.length;
  }

  add(e: LogEntry) {
    const message = maskLogText(e.message).slice(0, MAX_MESSAGE);
    const details = e.details ? (maskDeep(redact(e.details)) as Prisma.InputJsonValue) : undefined;
    this.queue.push({ service: this.service, level: e.level, context: e.context, message, details });
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
  }

  async flush(): Promise<void> {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    try {
      await this.db.systemLog.createMany({ data: batch });
    } catch (e) {
      // ไม่ log ความล้มเหลวนี้ลงฐาน (กันวนซ้ำ) — เตือนลง stdout ไม่เกินนาทีละครั้ง
      if (Date.now() - this.lastFailureWarn >= 60_000) {
        this.lastFailureWarn = Date.now();
        console.warn(`[system-logs] เก็บ log ${batch.length} รายการลงฐานไม่สำเร็จ: ${maskLogText(String((e as Error)?.message ?? e))}`);
      }
    }
  }

  start() {
    this.timer ??= setInterval(() => void this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}

const isStack = (s: unknown): s is string => typeof s === "string" && /\n\s+at /.test(s);

/** Logger ของ Nest: พิมพ์ stdout เหมือนเดิม และส่ง warn/error เข้า SystemLogSink */
export class DbLogger extends ConsoleLogger {
  constructor(private readonly sink: SystemLogSink) {
    super();
  }

  override warn(message: unknown, ...params: unknown[]) {
    super.warn(message, ...params);
    this.capture("warn", message, params);
  }

  override error(message: unknown, ...params: unknown[]) {
    super.error(message, ...params);
    this.capture("error", message, params);
  }

  private capture(level: LogLevel, message: unknown, params: unknown[]) {
    try {
      const stack = params.find(isStack) ?? (message instanceof Error ? message.stack : undefined);
      const rest = params.filter((p) => !isStack(p));
      const last = rest.at(-1);
      const context = typeof last === "string" ? last : null;
      const text = message instanceof Error ? message.message : typeof message === "string" ? message : JSON.stringify(message);
      this.sink.add({ level, context, message: text, details: stack ? { stack } : undefined });
    } catch {
      // การเก็บ log ต้องไม่ทำให้ผู้เรียกล้ม
    }
  }
}

/** ลบ log ที่เก่ากว่าระยะเก็บ — worker เรียกวันละครั้ง */
export async function purgeSystemLogs(db: Db, days = SYSTEM_LOG_RETENTION_DAYS, now = new Date()): Promise<number> {
  const r = await db.systemLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - days * 86_400_000) } } });
  return r.count;
}
