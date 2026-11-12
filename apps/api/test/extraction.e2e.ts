// การอ่านเอกสารหลัง Phase 2 กับ dev stack จริง: retry/ล้มเหลวถาวร (3.3), fixture provider (3.4), ผลหลังอ่าน (3.5)
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import Redis from "ioredis";
import { emptyHeader, type ExtractJob, type ExtractionProvider, type ExtractionResult } from "@sdes/core";
import type { PrismaClient } from "@sdes/db";
import { PRISMA } from "../src/prisma.js";
import { loadWorkerConfig } from "../../worker/src/config.js";
import { createS3, startExtractWorker, type Deps } from "../../worker/src/extract.js";
import { FixtureExtractionProvider } from "../../worker/src/providers/fixture.js";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

const run = hasDatabase && process.env.INGESTION_STACK === "1";

const COMPANY = "0994000165617";
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(2048)]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const apiError = (status: number) => Anthropic.APIError.generate(status, { error: { type: "x", message: "x" } }, "x", new Headers());

const f = (value: string | boolean | null, confidence = 0.97) => ({ value, confidence, bbox: { page: 1, x: 0.6, y: 0.7, w: 0.2, h: 0.03 } });
/** เฉลยของใบกำกับภาษีที่ถูกต้องทุกกฎ ยกเว้นยอดรวมที่ตั้งใจให้ผิดเมื่อ wrongTotal */
function answer(opts: { wrongTotal?: boolean } = {}): Partial<ExtractionResult> {
  const header = emptyHeader();
  Object.assign(header, {
    invoiceNo: f("INV-2026-0099"),
    invoiceDate: f(new Date().toISOString().slice(0, 10)),
    vendorName: f("บริษัท ผู้ขาย จำกัด"),
    vendorTaxId: f("0105536000011"),
    vendorBranch: f("00000"),
    buyerTaxId: f(COMPANY),
    buyerBranch: f("00000"),
    subtotal: f("10000.00"),
    discount: f("0.00"),
    vatBase: f("10000.00"),
    vatRate: f("7"),
    vatAmount: f("700.00"),
    vatExempt: f(false),
    grandTotal: f(opts.wrongTotal ? "10070.00" : "10700.00"),
  });
  return {
    confidence: 0.96,
    header,
    items: [{ no: 1, description: f("ค่าบริการ"), quantity: f("2"), unitPrice: f("5000.00"), amount: f("10000.00") }],
  };
}

/** provider ที่เลือกพฤติกรรมตาม sha256 ของไฟล์: คิวของผลแต่ละครั้ง (Error = throw) */
class ScriptedProvider implements ExtractionProvider {
  readonly name = "scripted";
  readonly scripts = new Map<string, (Error | "fixture")[]>();
  readonly calls = new Map<string, number>();
  constructor(private readonly fixtures: FixtureExtractionProvider) {}

  async extract(input: { file: Uint8Array; mime: string }) {
    const key = createHash("sha256").update(input.file).digest("hex");
    const n = this.calls.get(key) ?? 0;
    this.calls.set(key, n + 1);
    const script = this.scripts.get(key) ?? ["fixture"];
    const step = script[Math.min(n, script.length - 1)]!;
    if (step instanceof Error) throw step;
    return this.fixtures.extract(input);
  }
}

describe.skipIf(!run)("extraction (spec document-extraction, phase 2 tasks 3.3–3.5)", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let h: Record<string, string>;
  let worker: Worker<ExtractJob>;
  let deps: Deps;
  let provider: ScriptedProvider;
  let fixtureDir: string;
  const http = () => request(app.getHttpServer());

  async function upload(data: Buffer, name = "inv.pdf") {
    const res = await http().post("/documents").set(h).attach("files", data, name).expect(201);
    expect(res.body.results[0].ok).toBe(true);
    return res.body.results[0].id as string;
  }

  async function waitForStatus(id: string, status: string, ms = 20_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const d = await db.document.findUnique({ where: { id } });
      if (d?.status === status) return d;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`เอกสาร ${id} ไม่ถึงสถานะ ${status}`);
  }

  const lastReason = async (id: string) =>
    (await db.documentStatusHistory.findFirstOrThrow({ where: { documentId: id, toStatus: "FAILED" }, orderBy: { createdAt: "desc" } })).reason;

  beforeAll(async () => {
    app = await bootApp();
    db = ownerDb();
    const clerk = await createUser(db, ["AP_CLERK"]);
    h = await authed(app, clerk.email);
    await db.setting.upsert({ where: { key: "company.tax_id" }, create: { key: "company.tax_id", value: COMPANY }, update: { value: COMPANY } });
    fixtureDir = mkdtempSync(join(tmpdir(), "sdes-fixtures-"));
    provider = new ScriptedProvider(new FixtureExtractionProvider(fixtureDir));
    const cfg = { ...loadWorkerConfig(), databaseUrl: process.env.DATABASE_URL!, queuePrefix: "sdes-test" };
    const connection = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    deps = { cfg, prisma: app.get(PRISMA), redis: new Redis(cfg.redisUrl), provider, s3: createS3(cfg) };
    worker = startExtractWorker(deps, connection);
  });

  afterAll(async () => {
    await worker?.close();
    deps?.redis.disconnect();
    await app?.close();
    await db?.$disconnect();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  const withFixture = (file: Buffer, a = answer()) => writeFileSync(join(fixtureDir, `${sha(file)}.json`), JSON.stringify(a));

  describe("3.3 retry และความล้มเหลวถาวร", () => {
    it("ถูกจำกัดอัตราครั้งแรกแล้วสำเร็จ → EXTRACTED โดยผู้ใช้ไม่ต้องทำอะไร", async () => {
      const file = pdf();
      withFixture(file);
      provider.scripts.set(sha(file), [apiError(429), "fixture"]);
      const id = await upload(file);
      await waitForStatus(id, "EXTRACTED");
      expect(provider.calls.get(sha(file))).toBe(2);
    });

    it("ขัดข้องทั้ง 3 ครั้ง → FAILED พร้อมเหตุผลให้อ่านใหม่ และเก็บทุกรอบที่ล้มเหลว", async () => {
      const file = pdf();
      provider.scripts.set(sha(file), [apiError(503)]);
      const id = await upload(file);
      await waitForStatus(id, "FAILED", 30_000);
      expect(provider.calls.get(sha(file))).toBe(3);
      expect(await lastReason(id)).toMatch(/อ่านใหม่/);
      const rounds = await db.documentExtraction.findMany({ where: { documentId: id } });
      expect(rounds).toHaveLength(3);
      expect(rounds.every((r) => r.error)).toBe(true);
    });

    it("คำขอถูกปฏิเสธ (400) → FAILED ทันทีโดยไม่ลองซ้ำ", async () => {
      const file = pdf();
      provider.scripts.set(sha(file), [apiError(400)]);
      const id = await upload(file);
      await waitForStatus(id, "FAILED");
      await new Promise((r) => setTimeout(r, 2500)); // เลยรอบ backoff แรกแล้วต้องไม่มีการลองซ้ำ
      expect(provider.calls.get(sha(file))).toBe(1);
      expect(await lastReason(id)).toMatch(/ปฏิเสธคำขอ \(400\)/);
    });
  });

  describe("3.4 + 3.5 fixture provider และผลหลังอ่าน", () => {
    it("เอกสารมีข้อมูล ความมั่นใจ/ตำแหน่ง ผลตรวจ และ column typed ครบ", async () => {
      const file = pdf();
      withFixture(file);
      const id = await upload(file);
      const d = await waitForStatus(id, "EXTRACTED");
      expect(d.provider).toBe("fixture");
      expect(d.data).toMatchObject({ invoiceNo: "INV-2026-0099", grandTotal: "10700.00", items: [{ amount: "10000.00" }] });
      expect(d.validationIssues).toEqual([]);
      expect((d.fieldMeta as Record<string, unknown>)["header.grandTotal"]).toMatchObject({ confidence: 0.97, aiValue: "10700.00", bbox: { page: 1 } });
      expect(d.grandTotal?.toString()).toBe("10700");
      expect(d.vendorTaxId).toBe("0105536000011");
      expect(Number(d.confidence)).toBeGreaterThan(0.9);
      const round = await db.documentExtraction.findFirstOrThrow({ where: { documentId: id } });
      expect(round.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("ยอดรวมผิด: มีผลตรวจ ERROR และความมั่นใจถูกลดตามกฎ", async () => {
      const file = pdf();
      withFixture(file, answer({ wrongTotal: true }));
      const id = await upload(file);
      const d = await waitForStatus(id, "EXTRACTED");
      expect(d.validationIssues).toEqual([expect.objectContaining({ code: "GRAND_TOTAL", severity: "ERROR", fields: ["header.grandTotal"] })]);
      expect((d.fieldMeta as Record<string, { confidence: number }>)["header.grandTotal"]!.confidence).toBe(0.5);
      expect(Number(d.confidence)).toBeLessThanOrEqual(0.5);
    });

    it("ไม่มีเฉลย → FAILED ทันที แล้วอ่านใหม่สำเร็จโดยยังเก็บผลรอบที่ล้มเหลว", async () => {
      const file = pdf();
      const id = await upload(file);
      await waitForStatus(id, "FAILED");
      expect(await lastReason(id)).toMatch(/ไม่มีเฉลย/);
      withFixture(file);
      await http().post(`/documents/${id}/retry`).set(h).expect(200);
      const d = await waitForStatus(id, "EXTRACTED");
      expect(d.provider).toBe("fixture");
      const rounds = await db.documentExtraction.findMany({ where: { documentId: id }, orderBy: { createdAt: "asc" } });
      expect(rounds.map((r) => Boolean(r.error))).toEqual([true, false]);
    });
  });
});
