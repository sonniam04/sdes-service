import Anthropic from "@anthropic-ai/sdk";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import {
  EXTRACT_QUEUE,
  applyValidationPenalty,
  buildFieldMeta,
  extractJobOptions,
  FakeExtractionProvider,
  overallConfidence,
  STATUS_CHANNEL,
  toDocumentData,
  validateDocument,
  type ExtractionProvider,
  type ExtractJob,
  type StatusEvent,
} from "@sdes/core";
import {
  Prisma,
  StaleDocumentError,
  findDuplicateInvoice,
  loadReviewSettings,
  projectDocumentData,
  transitionDocument,
  type PrismaClient,
} from "@sdes/db";
import type { WorkerConfig } from "./config.js";
import { ClaudeExtractionProvider } from "./providers/claude.js";
import { classifyError } from "./providers/errors.js";
import { FixtureExtractionProvider } from "./providers/fixture.js";

const SYSTEM = { kind: "system" } as const;

/** เลือก provider ตาม EXTRACTION_PROVIDER (design D1) — ตั้งค่าไม่ครบให้หยุดตั้งแต่เริ่ม worker */
export function createProvider(name: string, opts: Partial<WorkerConfig["extraction"]> = {}): ExtractionProvider {
  switch (name) {
    case "fake":
      return new FakeExtractionProvider();
    case "fixture":
      if (!opts.fixtureDir) throw new Error("EXTRACTION_PROVIDER=fixture ต้องตั้ง EXTRACTION_FIXTURE_DIR");
      return new FixtureExtractionProvider(opts.fixtureDir);
    case "claude":
      if (!opts.anthropicApiKey) throw new Error("EXTRACTION_PROVIDER=claude ต้องตั้ง ANTHROPIC_API_KEY ใน .env");
      return new ClaudeExtractionProvider(new Anthropic({ apiKey: opts.anthropicApiKey }), {
        model: opts.model ?? "claude-opus-5-5",
        effort: opts.effort ?? "low",
        timeoutMs: opts.timeoutMs ?? 120_000,
      });
    default:
      throw new Error(`ไม่รู้จัก EXTRACTION_PROVIDER=${name} (ใช้ได้: fake, fixture, claude)`);
  }
}

export type Deps = {
  cfg: WorkerConfig;
  prisma: PrismaClient;
  redis: Redis;
  provider: ExtractionProvider;
  s3: S3Client;
};

export function createS3(cfg: WorkerConfig) {
  return new S3Client({
    endpoint: cfg.s3.endpoint,
    region: cfg.s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
  });
}

async function publish(redis: Redis, d: { id: string; docNo: string; status: string }) {
  const e: StatusEvent = { id: d.id, docNo: d.docNo, status: d.status, at: new Date().toISOString() };
  await redis.publish(STATUS_CHANNEL, JSON.stringify(e)).catch(() => {});
}

/**
 * อ่านเอกสารหนึ่งฉบับ: UPLOADED → PROCESSING → EXTRACTED
 * ล้มเหลวชั่วคราว → throw ให้ BullMQ retry; ล้มเหลวถาวร → UnrecoverableError (FAILED ทันที)
 */
export async function processExtract(deps: Deps, documentId: string) {
  const { prisma, redis, provider, s3, cfg } = deps;
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) return { skipped: "not_found" as const };

  let current = doc;
  if (doc.status === "UPLOADED") {
    try {
      current = await prisma.$transaction((tx) => transitionDocument(tx, { documentId, to: "PROCESSING", actor: SYSTEM }));
    } catch (e) {
      if (e instanceof StaleDocumentError) return { skipped: "raced" as const };
      throw e;
    }
    await publish(redis, current);
  } else if (doc.status !== "PROCESSING") {
    // อ่านไปแล้ว หรือถูกเปลี่ยนสถานะโดยทางอื่น — ไม่ทำซ้ำ
    return { skipped: doc.status };
  }

  const started = Date.now();
  let result;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: current.storageKey }));
    const file = Buffer.from(await obj.Body!.transformToByteArray());
    result = await provider.extract({ file, mime: current.mimeType });
  } catch (e) {
    const err = classifyError(e);
    // เก็บรอบที่ล้มเหลวไว้ตรวจย้อนหลัง (spec "Extraction provenance")
    await prisma.documentExtraction.create({
      data: {
        documentId,
        provider: provider.name,
        modelVersion: "-",
        confidence: new Prisma.Decimal(0),
        raw: { error: err.message, permanent: err.permanent } as Prisma.InputJsonValue,
        durationMs: Date.now() - started,
        error: err.message.slice(0, 500),
      },
    });
    throw err.permanent ? new UnrecoverableError(err.message) : err;
  }
  const durationMs = Date.now() - started;

  const done = await prisma.$transaction(async (tx) => {
    const settings = await loadReviewSettings(tx);
    const data = toDocumentData(result);
    const issues = validateDocument(data, {
      companyTaxId: settings.companyTaxId,
      uploadedAt: current.createdAt,
      duplicateDocNo: await findDuplicateInvoice(tx, data, documentId),
    });
    // ความมั่นใจที่โมเดลรายงานเองถูกลดลงตามผลกฎตรวจ (design D3)
    const penalized = applyValidationPenalty(result, issues);
    const confidence = new Prisma.Decimal(overallConfidence(penalized));
    await tx.documentExtraction.create({
      data: {
        documentId,
        provider: result.provider,
        modelVersion: result.modelVersion,
        confidence: new Prisma.Decimal(result.confidence),
        raw: result.raw as Prisma.InputJsonValue,
        items: result.items as unknown as Prisma.InputJsonValue,
        durationMs,
      },
    });
    await tx.document.update({
      where: { id: documentId },
      data: {
        provider: result.provider,
        modelVersion: result.modelVersion,
        confidence,
        data: data as unknown as Prisma.InputJsonValue,
        fieldMeta: buildFieldMeta(penalized) as unknown as Prisma.InputJsonValue,
        validationIssues: issues as unknown as Prisma.InputJsonValue,
        ...projectDocumentData(data),
      },
    });
    return transitionDocument(tx, { documentId, to: "EXTRACTED", actor: SYSTEM });
  });
  await publish(redis, done);
  return { status: done.status };
}

/** หลัง retry ครบ: ทำเครื่องหมาย FAILED ให้ผู้ใช้กด "อ่านใหม่" ได้ */
export async function markFailed(deps: Deps, documentId: string, error: string) {
  const doc = await deps.prisma.document.findUnique({ where: { id: documentId } });
  if (doc?.status !== "PROCESSING") return;
  const failed = await deps.prisma.$transaction((tx) =>
    transitionDocument(tx, { documentId, to: "FAILED", actor: SYSTEM, reason: error.slice(0, 500) }),
  );
  await publish(deps.redis, failed);
}

export function startExtractWorker(deps: Deps, connection: Redis) {
  const worker = new Worker<ExtractJob>(EXTRACT_QUEUE, (job: Job<ExtractJob>) => processExtract(deps, job.data.documentId), {
    connection,
    prefix: deps.cfg.queuePrefix,
    concurrency: deps.cfg.concurrency,
  });
  worker.on("failed", (job, err) => {
    // UnrecoverableError = ล้มเหลวถาวร ไม่ต้องรอให้ครบจำนวนครั้ง
    const finished = err instanceof UnrecoverableError || err.name === "UnrecoverableError" || (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
    if (job && finished) void markFailed(deps, job.data.documentId, err.message);
  });
  return worker;
}

/**
 * Reconciler (design D6): เอกสาร UPLOADED ที่ค้างเกินเวลาโดยไม่มี job → enqueue ใหม่
 * กันกรณี commit DB แล้วแต่ enqueue ไม่สำเร็จ หรือ Redis หาย
 */
export async function reconcileOnce(deps: Pick<Deps, "prisma" | "cfg">, queue: Queue<ExtractJob>) {
  const stuck = await deps.prisma.document.findMany({
    where: { status: "UPLOADED", createdAt: { lt: new Date(Date.now() - deps.cfg.stuckAfterMs) } },
    select: { id: true },
    take: 500,
  });
  let enqueued = 0;
  for (const { id } of stuck) {
    const existing = await queue.getJob(id);
    if (existing && !(await existing.isFailed())) continue;
    if (existing) await existing.remove();
    await queue.add("extract", { documentId: id }, extractJobOptions(id));
    enqueued++;
  }
  return enqueued;
}
