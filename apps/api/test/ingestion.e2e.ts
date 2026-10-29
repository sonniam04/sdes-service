// ingestion ตลอดเส้นทางกับ dev stack จริง: Postgres (sdes_test), Redis, SeaweedFS (S3), ClamAV
import { createHash, randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import Redis from "ioredis";
import type { ExtractJob, StatusEvent } from "@sdes/core";
import { StaleDocumentError, transitionDocument, type PrismaClient } from "@sdes/db";
import { QueueService } from "../src/documents/queue.service.js";
import { PRISMA } from "../src/prisma.js";
import { loadWorkerConfig } from "../../worker/src/config.js";
import { createProvider, createS3, reconcileOnce, startExtractWorker, type Deps } from "../../worker/src/extract.js";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

const run = hasDatabase && process.env.INGESTION_STACK === "1";

// ไฟล์ตัวอย่าง: header จริงของแต่ละชนิด + เนื้อหาสุ่ม (ไม่ซ้ำกันทุกครั้ง)
const body = (header: number[] | string, size = 2048) =>
  Buffer.concat([Buffer.isBuffer(header) ? header : Buffer.from(header as never), randomBytes(size)]);
const PDF = () => body("%PDF-1.7\n");
const PNG = () => body([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = () => body([0xff, 0xd8, 0xff, 0xe0]);
const TIFF = () => body([0x49, 0x49, 0x2a, 0x00]);
const EXE = () => body("MZ\x90\x00");
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");

describe.skipIf(!run)("ingestion (spec document-ingestion + document-lifecycle)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let clerk: { id: string; email: string };
  let h: Record<string, string>;
  let worker: Worker<ExtractJob>;
  let deps: Deps;
  const http = () => request(app.getHttpServer());

  const upload = (files: { name: string; data: Buffer }[], headers = h) => {
    const r = http().post("/documents").set(headers);
    for (const f of files) r.attach("files", f.data, f.name);
    return r;
  };

  async function waitForStatus(id: string, status: string, ms = 10_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const d = await db.document.findUnique({ where: { id } });
      if (d?.status === status) return d;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`เอกสาร ${id} ไม่ถึงสถานะ ${status}`);
  }

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    clerk = await createUser(db, ["AP_CLERK"]);
    h = await authed(app, clerk.email);
    // worker ตัวจริงรันในโปรเซสเดียวกับ test (คิว prefix sdes-test)
    const cfg = { ...loadWorkerConfig(), databaseUrl: process.env.DATABASE_URL!, queuePrefix: "sdes-test" };
    const connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    deps = { cfg, prisma: app.get(PRISMA), redis: new Redis(cfg.redisUrl), provider: createProvider("fake"), s3: createS3(cfg) };
    worker = startExtractWorker(deps, connection);
  });

  afterAll(async () => {
    await worker?.close();
    deps?.redis.disconnect();
    await app?.close();
    await db?.$disconnect();
  });

  describe("6.1 ชนิด/ขนาดไฟล์ และหลายไฟล์", () => {
    it("รับ PDF, TIFF, JPG, PNG", async () => {
      const res = await upload([
        { name: "a.pdf", data: PDF() },
        { name: "b.tiff", data: TIFF() },
        { name: "c.jpg", data: JPG() },
        { name: "d.png", data: PNG() },
      ]).expect(201);
      expect(res.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true, true]);
      expect(res.body.results[0].docNo).toMatch(/^DOC-\d{6}$/);
      expect(res.body.results[0].status).toBe("UPLOADED");
    });

    it("ไฟล์ปฏิบัติการที่เปลี่ยนชื่อเป็น .pdf ถูกปฏิเสธ", async () => {
      const res = await upload([{ name: "invoice.pdf", data: EXE() }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ ok: false, code: "unsupported", message: "ชนิดไฟล์ไม่รองรับ (รองรับ PDF, TIFF, JPG, PNG)" });
    });

    it("ชุด 5 ไฟล์ที่มีไฟล์ 21 MB ปน: รับ 4 ไฟล์ และบอกเหตุผลรายไฟล์", async () => {
      const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(21 * 1024 * 1024)]);
      const res = await upload([
        { name: "1.pdf", data: PDF() },
        { name: "big.pdf", data: big },
        { name: "3.png", data: PNG() },
        { name: "4.jpg", data: JPG() },
        { name: "5.tiff", data: TIFF() },
      ]).expect(201);
      const rs = res.body.results as { fileName: string; ok: boolean; message?: string }[];
      expect(rs.map((r) => r.fileName)).toEqual(["1.pdf", "big.pdf", "3.png", "4.jpg", "5.tiff"]);
      expect(rs.filter((r) => r.ok)).toHaveLength(4);
      expect(rs[1]).toMatchObject({ ok: false, message: "ไฟล์ใหญ่เกิน 20 MB" });
    });

    it("SYS_ADMIN อัปโหลดไม่ได้ (แยกหน้าที่)", async () => {
      const admin = await createUser(db, ["SYS_ADMIN"]);
      await upload([{ name: "x.pdf", data: PDF() }], await authed(app, admin.email)).expect(403);
    });
  });

  describe("6.2 สแกนไวรัส fail closed", () => {
    it("ไฟล์ EICAR ถูกปฏิเสธว่าเป็นไฟล์อันตราย และบันทึก audit พร้อม signature", async () => {
      const res = await upload([{ name: "invoice.pdf", data: EICAR }]).expect(201);
      expect(res.body.results[0]).toMatchObject({ ok: false, code: "malware", message: "ตรวจพบไฟล์อันตราย" });
      const ev = await db.auditEvent.findFirstOrThrow({ where: { action: "document.upload_rejected", actorUserId: clerk.id }, orderBy: { id: "desc" } });
      expect(ev.details).toMatchObject({ fileName: "invoice.pdf", reason: "malware" });
      expect(String((ev.details as { signature: string }).signature)).toMatch(/Eicar/i);
      expect(await db.document.count({ where: { fileName: "invoice.pdf" } })).toBe(0);
    });

    it("ตัวสแกนไม่พร้อม → ปฏิเสธการอัปโหลด ไม่ข้ามการสแกน", async () => {
      const port = process.env.CLAMD_HOST_PORT;
      process.env.CLAMD_HOST_PORT = "1"; // port ที่ไม่มี clamd
      const down = await bootApp();
      process.env.CLAMD_HOST_PORT = port;
      try {
        const r = request(down.getHttpServer()).post("/documents").set(h);
        const res = await r.attach("files", PDF(), "scan-down.pdf").expect(201);
        expect(res.body.results[0]).toMatchObject({ ok: false, code: "scanner_unavailable" });
        expect(await db.document.count({ where: { fileName: "scan-down.pdf" } })).toBe(0);
      } finally {
        await down.close();
      }
    });
  });

  describe("6.3 ไฟล์ซ้ำ", () => {
    it("ไฟล์เดิมซ้ำถูกปฏิเสธพร้อมเลขเอกสารเดิม; ถ้าเอกสารเดิม FAILED อัปโหลดซ้ำได้", async () => {
      const data = PDF();
      const first = await upload([{ name: "dup.pdf", data }]).expect(201);
      const docNo = first.body.results[0].docNo;
      const again = await upload([{ name: "dup-again.pdf", data }]).expect(201);
      expect(again.body.results[0]).toMatchObject({ ok: false, code: "duplicate", message: `ไฟล์ซ้ำกับเอกสาร ${docNo}` });

      await db.document.update({ where: { id: first.body.results[0].id }, data: { status: "FAILED" } });
      const retried = await upload([{ name: "dup-3.pdf", data }]).expect(201);
      expect(retried.body.results[0].ok).toBe(true);
    });
  });

  describe("6.4 เก็บต้นฉบับ + ลิงก์ 5 นาที", () => {
    it("hash ของไฟล์ที่ดาวน์โหลดตรงกับตอนอัปโหลด และมี audit การเปิดดู", async () => {
      const data = PDF();
      const up = await upload([{ name: "orig.pdf", data }]).expect(201);
      const id = up.body.results[0].id;
      const f = await http().get(`/documents/${id}/file`).set(h).expect(200);
      expect(f.body.expiresIn).toBe(300);
      expect(new URL(f.body.url).searchParams.get("X-Amz-Expires")).toBe("300");
      const downloaded = Buffer.from(await (await fetch(f.body.url)).arrayBuffer());
      expect(createHash("sha256").update(downloaded).digest("hex")).toBe(createHash("sha256").update(data).digest("hex"));
      expect(await db.auditEvent.count({ where: { action: "document.file_viewed", entityId: id } })).toBe(1);
    });

    it("SYS_ADMIN เปิดไฟล์ไม่ได้", async () => {
      const up = await upload([{ name: "o2.pdf", data: PDF() }]).expect(201);
      const admin = await createUser(db, ["SYS_ADMIN"]);
      await http().get(`/documents/${up.body.results[0].id}/file`).set(await authed(app, admin.email)).expect(403);
    });
  });

  describe("6.5 worker + optimistic lock", () => {
    it("UPLOADED → PROCESSING → EXTRACTED ด้วย fake provider", async () => {
      const up = await upload([{ name: "w.pdf", data: PDF() }]).expect(201);
      const id = up.body.results[0].id;
      const done = await waitForStatus(id, "EXTRACTED");
      expect(done.provider).toBe("fake");
      expect(await db.documentExtraction.count({ where: { documentId: id } })).toBe(1);
      const hist = await db.documentStatusHistory.findMany({ where: { documentId: id }, orderBy: { id: "asc" } });
      expect(hist.map((x) => x.toStatus)).toEqual(["UPLOADED", "PROCESSING", "EXTRACTED"]);
    });

    it("สองคำขอเปลี่ยนสถานะชนกัน → สำเร็จหนึ่ง อีกหนึ่งได้ stale (409)", async () => {
      const up = await upload([{ name: "race.pdf", data: PDF() }]).expect(201);
      const id = up.body.results[0].id;
      await waitForStatus(id, "EXTRACTED");
      const v = (await db.document.findUniqueOrThrow({ where: { id } })).version;
      const prisma = app.get<PrismaClient>(PRISMA);
      const actor = { kind: "user" as const, userId: clerk.id, roles: ["AP_CLERK" as const] };
      const attempt = () => prisma.$transaction((tx) => transitionDocument(tx, { documentId: id, to: "VERIFIED", actor, expectedVersion: v }));
      const results = await Promise.allSettled([attempt(), attempt()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(StaleDocumentError);
    });
  });

  describe("6.6 อ่านใหม่", () => {
    it("FAILED → PROCESSING → EXTRACTED โดยไม่ต้องอัปโหลดใหม่", async () => {
      const up = await upload([{ name: "retry.pdf", data: PDF() }]).expect(201);
      const id = up.body.results[0].id;
      await waitForStatus(id, "EXTRACTED");
      await db.document.update({ where: { id }, data: { status: "FAILED" } });
      const r = await http().post(`/documents/${id}/retry`).set(h).expect(200);
      expect(r.body.status).toBe("PROCESSING");
      await waitForStatus(id, "EXTRACTED");
    });

    it("อ่านใหม่จากสถานะที่ไม่ใช่ FAILED → 409", async () => {
      const up = await upload([{ name: "nr.pdf", data: PDF() }]).expect(201);
      const id = up.body.results[0].id;
      await waitForStatus(id, "EXTRACTED");
      await http().post(`/documents/${id}/retry`).set(h).expect(409);
    });
  });

  describe("6.7 reconciler", () => {
    it("เอกสาร UPLOADED ที่ค้างเกิน 2 นาทีและไม่มี job ถูก enqueue แล้วประมวลผลจนเสร็จ", async () => {
      const queue = app.get(QueueService).extract;
      await worker.pause();
      try {
        const up = await upload([{ name: "stuck.pdf", data: PDF() }]).expect(201);
        const id = up.body.results[0].id;
        await (await queue.getJob(id))?.remove(); // จำลอง job หาย
        await db.document.update({ where: { id }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
        expect(await reconcileOnce(deps, queue)).toBeGreaterThanOrEqual(1);
        expect(await queue.getJob(id)).toBeTruthy();
        worker.resume();
        await waitForStatus(id, "EXTRACTED");
      } finally {
        worker.resume();
      }
    });
  });

  describe("6.8 real-time + resync, 6.9 รายละเอียด", () => {
    it("client ได้ event การเปลี่ยนสถานะภายใน 3 วินาที", async () => {
      const port = (app.getHttpServer().address() as { port: number }).port;
      const token = h.Authorization!.slice(7);
      const socket: Socket = io(`http://127.0.0.1:${port}`, { path: "/ws", auth: { token }, transports: ["websocket"] });
      await new Promise<void>((resolve, reject) => {
        socket.on("ready", () => resolve());
        socket.on("connect_error", reject);
      });
      const seen: StatusEvent[] = [];
      socket.on("document.status", (e: StatusEvent) => seen.push(e));
      try {
        const started = Date.now();
        const up = await upload([{ name: "rt.pdf", data: PDF() }]).expect(201);
        const id = up.body.results[0].id;
        while (!seen.some((e) => e.id === id && e.status === "EXTRACTED") && Date.now() - started < 3000) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(seen.filter((e) => e.id === id).map((e) => e.status)).toEqual(expect.arrayContaining(["UPLOADED", "PROCESSING", "EXTRACTED"]));
        expect(Date.now() - started).toBeLessThan(3000);
      } finally {
        socket.disconnect();
      }
    });

    it("token ไม่ถูกต้อง → ถูกตัดการเชื่อมต่อ", async () => {
      const port = (app.getHttpServer().address() as { port: number }).port;
      const socket = io(`http://127.0.0.1:${port}`, { path: "/ws", auth: { token: "bad" }, transports: ["websocket"] });
      const msg = await new Promise((resolve) => socket.on("unauthorized", resolve));
      expect(msg).toMatchObject({ message: "กรุณาเข้าสู่ระบบใหม่" });
      socket.disconnect();
    });

    it("GET /documents?updatedSince ใช้ resync ได้", async () => {
      const since = new Date().toISOString();
      const up = await upload([{ name: "rs.pdf", data: PDF() }]).expect(201);
      const list = await http().get("/documents").query({ updatedSince: since }).set(h).expect(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).toContain(up.body.results[0].id);
    });

    it("GET /documents/:id มีประวัติสถานะเรียงตามเวลา พร้อมผู้กระทำ", async () => {
      const up = await upload([{ name: "hist.pdf", data: PDF() }]).expect(201);
      const id = up.body.results[0].id;
      await waitForStatus(id, "EXTRACTED");
      const d = await http().get(`/documents/${id}`).set(h).expect(200);
      expect(d.body.history.map((x: { to: string }) => x.to)).toEqual(["UPLOADED", "PROCESSING", "EXTRACTED"]);
      expect(d.body.history[0].actor).toMatchObject({ kind: "user", id: clerk.id });
      expect(d.body.history[1].actor).toEqual({ kind: "system" });
      expect(d.body.storageKey).toBeUndefined();
    });

    it("Finance Exec ดูเอกสารได้แต่อัปโหลดไม่ได้", async () => {
      const exec = await createUser(db, ["FINANCE_EXEC"]);
      const eh = await authed(app, exec.email);
      await http().get("/documents").set(eh).expect(200);
      await upload([{ name: "e.pdf", data: PDF() }], eh).expect(403);
    });
  });
});
