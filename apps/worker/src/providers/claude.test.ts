import Anthropic from "@anthropic-ai/sdk";
import { HEADER_FIELDS } from "@sdes/core";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ClaudeExtractionProvider, FALLBACK_BETA, type ClaudeClient } from "./claude.js";
import { classifyError } from "./errors.js";

const opts = { model: "claude-opus-5-5", effort: "low" as const, timeoutMs: 120_000 };
const PDF = Buffer.from("%PDF-1.4\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

const f = (value: string | null, confidence = 0.95) => ({ value, confidence, bbox: { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.03 } });
function modelOutput() {
  const header = Object.fromEntries(HEADER_FIELDS.map((k) => [k, f(null, 0)])) as Record<string, unknown>;
  Object.assign(header, { invoiceNo: f("INV-001"), grandTotal: f("10700.00"), vatExempt: { value: false, confidence: 1, bbox: null } });
  return { header, items: [] };
}

function client(response: Partial<{ stop_reason: string; parsed_output: unknown; model: string }> | Error) {
  const parse = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return { stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, parsed_output: modelOutput(), ...response };
  });
  return { parse, client: { beta: { messages: { parse } } } as unknown as ClaudeClient };
}

const apiError = (status: number) =>
  Anthropic.APIError.generate(status, { error: { type: "x", message: "x" } }, "x", new Headers());

describe("ClaudeExtractionProvider (task 3.1)", () => {
  it("PDF ส่งเป็น document พร้อมโมเดล effort fallback และ schema", async () => {
    const { parse, client: c } = client({});
    const r = await new ClaudeExtractionProvider(c, opts).extract({ file: PDF, mime: "application/pdf" });
    const [req, reqOpts] = parse.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(req).toMatchObject({ model: "claude-opus-5-5", betas: [FALLBACK_BETA], fallbacks: "default", output_config: { effort: "low" } });
    expect((req.output_config as { format: unknown }).format).toBeTruthy();
    const content = (req.messages as { content: { type: string; source?: { media_type: string } }[] }[])[0]!.content;
    expect(content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    expect(content.at(-1)!.type).toBe("text");
    expect(reqOpts).toEqual({ timeout: 120_000, maxRetries: 0 });
    expect(r).toMatchObject({ provider: "claude", modelVersion: "claude-opus-5-5", header: { invoiceNo: { value: "INV-001" } } });
  });

  it("ภาพส่งเป็น image ตามชนิดไฟล์", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).png().toBuffer();
    const { parse, client: c } = client({});
    await new ClaudeExtractionProvider(c, opts).extract({ file: png, mime: "image/png" });
    const req = (parse.mock.calls[0] as unknown[])[0] as { messages: { content: { type: string; source?: { media_type: string } }[] }[] };
    expect(req.messages[0]!.content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  });

  it("คำขอมีเฉพาะไฟล์และคำสั่งอ่าน ไม่มีข้อมูลผู้ใช้", () => {
    const req = new ClaudeExtractionProvider(client({}).client, opts).buildRequest({ kind: "pdf", data: PDF });
    expect(Object.keys(req).sort()).toEqual(["betas", "fallbacks", "max_tokens", "messages", "model", "output_config", "system"]);
    expect(req.messages).toHaveLength(1);
    expect(JSON.stringify(req)).not.toMatch(/@|uploaded|user_id/);
  });

  it.each([
    ["refusal", "ผู้ให้บริการ AI ปฏิเสธการอ่านเอกสารนี้"],
    ["max_tokens", "เอกสารยาวเกินกว่าที่อ่านได้ในครั้งเดียว"],
  ])("stop_reason %s เป็นข้อผิดพลาดถาวร", async (stop_reason, message) => {
    const p = new ClaudeExtractionProvider(client({ stop_reason }).client, opts);
    await expect(p.extract({ file: PDF, mime: "application/pdf" })).rejects.toMatchObject({ permanent: true, message });
  });

  it("ไม่มี parsed_output เป็นข้อผิดพลาดถาวร", async () => {
    const p = new ClaudeExtractionProvider(client({ parsed_output: null }).client, opts);
    await expect(p.extract({ file: PDF, mime: "application/pdf" })).rejects.toMatchObject({ permanent: true });
  });
});

describe("classifyError (task 3.3)", () => {
  it.each([429, 500, 503, 529, 408])("HTTP %i เป็นชั่วคราว", (status) => {
    expect(classifyError(apiError(status)).permanent).toBe(false);
  });

  it.each([400, 401, 404, 413])("HTTP %i เป็นถาวร", (status) => {
    expect(classifyError(apiError(status)).permanent).toBe(true);
  });

  it("หมดเวลาและเชื่อมต่อไม่ได้เป็นชั่วคราว", () => {
    expect(classifyError(new Anthropic.APIConnectionTimeoutError()).permanent).toBe(false);
    expect(classifyError(new Anthropic.APIConnectionError({ message: "x" })).permanent).toBe(false);
  });

  it("ข้อความชั่วคราวบอกให้กดอ่านใหม่", () => {
    expect(classifyError(apiError(503)).message).toMatch(/อ่านใหม่/);
  });
});
