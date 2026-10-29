// อ่านเอกสารด้วย Gemini ผ่าน interactions API + JSON schema output (design D1b)
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { ModelExtractionSchema, type ExtractionProvider, type ExtractionResult } from "@sdes/core";
import { SYSTEM_PROMPT } from "./claude.js";
import { ExtractionError, permanent, transient } from "./errors.js";
import { normalizeModelOutput } from "./normalize.js";
import { prepareInput, type PreparedInput } from "./prepare.js";

export type GeminiOptions = { model: string; timeoutMs: number };

/** ส่วนของ client ที่ใช้ — ให้ test ส่ง client จำลองเข้ามาได้ */
export type GeminiClient = { interactions: Pick<GoogleGenAI["interactions"], "create"> };

/** JSON schema ของผลที่ต้องการ — Gemini รองรับ JSON Schema บางส่วน จึงตรวจซ้ำด้วย zod เสมอ */
export const GEMINI_SCHEMA = (() => {
  const s = z.toJSONSchema(ModelExtractionSchema) as Record<string, unknown>;
  delete s.$schema;
  return s;
})();

const INSTRUCTION = "Extract the data from this document.";
const TEMPORARY = 'ระบบอ่านเอกสารไม่สำเร็จชั่วคราว กรุณากด "อ่านใหม่"';
const NETWORK_ERRORS = new Set(["ConnectionError", "RequestTimeoutError", "RequestAbortedError"]);

/** จำแนกข้อผิดพลาดของ Gemini SDK: 429/408/5xx และปัญหาการเชื่อมต่อ = ชั่วคราว, 4xx อื่น = ถาวร */
export function classifyGeminiError(e: unknown): ExtractionError {
  if (e instanceof ExtractionError) return e;
  const err = e as { name?: string; status?: unknown; statusCode?: unknown; httpMeta?: { response?: { status?: unknown } } };
  const status = [err?.status, err?.statusCode, err?.httpMeta?.response?.status].find((x): x is number => typeof x === "number");
  if (status === undefined) {
    if (err?.name && NETWORK_ERRORS.has(err.name)) return transient(`${TEMPORARY} (เชื่อมต่อผู้ให้บริการ AI ไม่ได้หรือหมดเวลา)`, e);
    return transient(TEMPORARY, e);
  }
  if (status === 429) return transient(`${TEMPORARY} (เกินอัตราที่ผู้ให้บริการ AI กำหนด)`, e);
  if (status === 408 || status >= 500) return transient(`${TEMPORARY} (ผู้ให้บริการ AI ขัดข้อง)`, e);
  return permanent(`ผู้ให้บริการ AI ปฏิเสธคำขอ (${status})`, e);
}

export class GeminiExtractionProvider implements ExtractionProvider {
  readonly name = "gemini";

  constructor(
    private readonly client: GeminiClient,
    private readonly opts: GeminiOptions,
  ) {}

  /** สร้างคำขอ — มีเฉพาะไฟล์และคำสั่งอ่าน ไม่มีข้อมูลผู้ใช้ (spec "Data sent to the AI provider") */
  buildRequest(input: PreparedInput) {
    const files =
      input.kind === "pdf"
        ? [{ type: "document" as const, mime_type: "application/pdf" as const, data: input.data.toString("base64") }]
        : input.pages.map((p) => ({ type: "image" as const, mime_type: p.mediaType, data: p.data.toString("base64") }));
    return {
      model: this.opts.model,
      system_instruction: SYSTEM_PROMPT,
      input: [...files, { type: "text" as const, text: INSTRUCTION }],
      response_format: { type: "text" as const, mime_type: "application/json" as const, schema: GEMINI_SCHEMA },
    };
  }

  async extract(input: { file: Uint8Array; mime: string }): Promise<ExtractionResult> {
    const prepared = await prepareInput(input.file, input.mime);
    const started = Date.now();
    let res: { status?: string; output_text?: string; usage?: unknown; model?: string };
    try {
      // retry อยู่ที่ BullMQ ชั้นเดียว (design D1) จึงปิด retry ของ SDK
      res = (await this.client.interactions.create(this.buildRequest(prepared) as never, {
        timeout_ms: this.opts.timeoutMs,
        retries: { strategy: "none" },
      })) as typeof res;
    } catch (e) {
      throw classifyGeminiError(e);
    }
    if (res.status && res.status !== "completed") throw permanent(`ผู้ให้บริการ AI อ่านเอกสารนี้ไม่สำเร็จ (${res.status})`);
    if (!res.output_text) throw permanent("ผลการอ่านไม่ตรงรูปแบบที่กำหนด");

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.output_text);
    } catch (e) {
      throw permanent("ผลการอ่านไม่ตรงรูปแบบที่กำหนด", e);
    }
    const out = ModelExtractionSchema.safeParse(parsed);
    if (!out.success) throw permanent("ผลการอ่านไม่ตรงรูปแบบที่กำหนด", out.error);
    return normalizeModelOutput(out.data, {
      provider: this.name,
      modelVersion: res.model ?? this.opts.model,
      // รูปแบบ usage เดียวกับ Claude เพื่อให้ชุดวัดผลคิดค่าใช้จ่ายได้
      raw: { output: parsed, usage: toUsage(res.usage), status: res.status, model: res.model ?? this.opts.model, latencyMs: Date.now() - started },
    });
  }
}

function toUsage(u: unknown) {
  const x = (u ?? {}) as { total_input_tokens?: number; total_output_tokens?: number };
  return { input_tokens: x.total_input_tokens ?? 0, output_tokens: x.total_output_tokens ?? 0 };
}
