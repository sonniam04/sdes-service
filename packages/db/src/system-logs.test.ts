// System logs (spec system-logs, task 3.1 ของ complete-missing-features) — ไม่ต้องใช้ฐานข้อมูลจริง
import { afterEach, describe, expect, it, vi } from "vitest";
import { DbLogger, SystemLogSink, maskLogText, type SystemLogRow } from "./system-logs.js";

/** prisma จำลองที่เก็บแถวที่ createMany ส่งมา */
function fakeDb(opts: { fail?: boolean } = {}) {
  const rows: SystemLogRow[] = [];
  const db = {
    systemLog: {
      createMany: vi.fn(async ({ data }: { data: SystemLogRow[] }) => {
        if (opts.fail) throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
        rows.push(...data);
        return { count: data.length };
      }),
    },
  };
  return { db, rows };
}

describe("maskLogText (spec system-logs \"Log redaction\")", () => {
  it("ปิดบัง Bearer token, API key, connection string และเลข 13 หลัก", () => {
    const out = maskLogText(
      "Authorization: Bearer eyJhbGciOi.abc.def key=sdes_AbCdEfGh_" + "x".repeat(43) + " db=postgresql://sdes_app:s3cret@db:5432/sdes tax 0105536000011 id 1101700203451",
    );
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).not.toContain("x".repeat(43));
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("0105536000011");
    expect(out).not.toContain("1101700203451");
    expect(out).toContain("postgresql://[REDACTED]@db:5432/sdes");
  });
});

describe("SystemLogSink", () => {
  afterEach(() => vi.useRealTimers());

  it("flush เป็นชุดพร้อมปิดบัง secret ใน details และตัดข้อความยาว", async () => {
    const { db, rows } = fakeDb();
    const sink = new SystemLogSink(db as never, "worker");
    sink.add({ level: "error", context: "ExtractWorker", message: "อ่าน DOC-000123 ไม่สำเร็จ " + "ก".repeat(5000), details: { headers: { authorization: "Bearer abc" }, url: "redis://:pw@redis:6379" } });
    sink.add({ level: "warn", context: null, message: "ช้า" });
    await sink.flush();
    expect(db.systemLog.createMany).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ service: "worker", level: "error", context: "ExtractWorker" });
    expect(rows[0]!.message.length).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(rows[0]!.details)).not.toContain("Bearer abc");
    expect(JSON.stringify(rows[0]!.details)).not.toContain(":pw@");
  });

  it("คิวเต็มแล้วทิ้งรายการเก่าที่สุด", async () => {
    const { db, rows } = fakeDb();
    const sink = new SystemLogSink(db as never, "api", { maxQueue: 3 });
    for (const m of ["1", "2", "3", "4", "5"]) sink.add({ level: "warn", context: null, message: m });
    await sink.flush();
    expect(rows.map((r) => r.message)).toEqual(["3", "4", "5"]);
  });

  it("flush ล้มเหลวไม่ throw, ทิ้งชุดนั้น และเตือนลง stdout ไม่เกินนาทีละครั้ง", async () => {
    const { db } = fakeDb({ fail: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = new SystemLogSink(db as never, "api");
    sink.add({ level: "error", context: null, message: "x" });
    await expect(sink.flush()).resolves.toBeUndefined();
    sink.add({ level: "error", context: null, message: "y" });
    await sink.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sink.pending).toBe(0);
    warn.mockRestore();
  });

  it("flush อัตโนมัติตามรอบเวลา", async () => {
    vi.useFakeTimers();
    const { db, rows } = fakeDb();
    const sink = new SystemLogSink(db as never, "api", { flushMs: 2000 });
    sink.start();
    sink.add({ level: "warn", context: null, message: "a" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(rows).toHaveLength(1);
    await sink.stop();
  });
});

describe("DbLogger", () => {
  it("ส่งเฉพาะ warn/error พร้อม context และ stack; log ระดับอื่นพิมพ์อย่างเดียว", async () => {
    const { db, rows } = fakeDb();
    const sink = new SystemLogSink(db as never, "api");
    const logger = new DbLogger(sink);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logger.log("เริ่มทำงาน", "Bootstrap");
    logger.warn("เกือบเต็ม", "Storage");
    logger.error("พัง", "Error: พัง\n    at foo (a.ts:1:1)", "DocumentsService");
    logger.error(new Error("วัตถุ error"));
    vi.restoreAllMocks();
    await sink.flush();
    expect(rows.map((r) => [r.level, r.context, r.message])).toEqual([
      ["warn", "Storage", "เกือบเต็ม"],
      ["error", "DocumentsService", "พัง"],
      ["error", null, "วัตถุ error"],
    ]);
    expect(String((rows[1]!.details as { stack: string }).stack)).toContain("at foo");
    expect(String((rows[2]!.details as { stack: string }).stack)).toContain("Error: วัตถุ error");
  });
});
