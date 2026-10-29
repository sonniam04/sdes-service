import { HEADER_FIELDS } from "@sdes/core";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { GEMINI_SCHEMA, GeminiExtractionProvider, classifyGeminiError, type GeminiClient } from "./gemini.js";

const opts = { model: "gemini-3.8-flash", timeoutMs: 120_000 };
const PDF = Buffer.from("%PDF-1.4\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

const f = (value: string | null, confidence = 0.95) => ({ value, confidence, bbox: { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.03 } });
function modelOutput() {
  const header = Object.fromEntries(HEADER_FIELDS.map((k) => [k, f(null, 0)])) as Record<string, unknown>;
  Object.assign(header, { invoiceNo: f("INV-001"), grandTotal: f("10,700.00"), vatExempt: { value: false, confidence: 1, bbox: null } });
  return { header, items: [] };
}

function client(response: Partial<{ status: string; output_text: string; usage: unknown; model: string }> | Error) {
  const create = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return { status: "completed", output_text: JSON.stringify(modelOutput()), usage: { total_input_tokens: 1200, total_output_tokens: 3400 }, ...response };
  });
  return { create, client: { interactions: { create } } as unknown as GeminiClient };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("GeminiExtractionProvider (task 3.7)", () => {
  it("PDF ส่งเป็น document พร้อม system instruction, JSON schema และปิด retry ของ SDK", async () => {
    const { create, client: c } = client({});
    const r = await new GeminiExtractionProvider(c, opts).extract({ file: PDF, mime: "application/pdf" });
    const [req, reqOpts] = create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(req).toMatchObject({ model: "gemini-3.8-flash", response_format: { type: "text", mime_type: "application/json" } });
    expect((req.input as { type: string; mime_type?: string }[])[0]).toMatchObject({ type: "document", mime_type: "application/pdf" });
    expect((req.input as { type: string }[]).at(-1)!.type).toBe("text");
    expect(String(req.system_instruction)).toMatch(/Thai tax invoices/);
    expect(reqOpts).toEqual({ timeout_ms: 120_000, retries: { strategy: "none" } });
    expect(r).toMatchObject({ provider: "gemini", modelVersion: "gemini-3.8-flash", header: { grandTotal: { value: "10700.00" } } });
    expect((r.raw as { usage: unknown }).usage).toEqual({ input_tokens: 1200, output_tokens: 3400 });
  });

  it("TIFF/ภาพส่งเป็น image ทีละหน้า", async () => {
    const page = (c: string) => sharp({ create: { width: 20, height: 20, channels: 3, background: c } }).png().toBuffer();
    const tiff = await sharp(await Promise.all([page("#f00"), page("#00f")]), { join: { animated: true } }).tiff().toBuffer();
    const { create, client: c } = client({});
    await new GeminiExtractionProvider(c, opts).extract({ file: tiff, mime: "image/tiff" });
    const req = (create.mock.calls[0] as unknown[])[0] as { input: { type: string; mime_type?: string }[] };
    expect(req.input.map((i) => i.type)).toEqual(["image", "image", "text"]);
    expect(req.input[0]!.mime_type).toBe("image/png");
  });

  it("คำขอมีเฉพาะไฟล์และคำสั่งอ่าน ไม่มีข้อมูลผู้ใช้", () => {
    const req = new GeminiExtractionProvider(client({}).client, opts).buildRequest({ kind: "pdf", data: PDF });
    expect(Object.keys(req).sort()).toEqual(["input", "model", "response_format", "system_instruction"]);
    expect(JSON.stringify(req)).not.toMatch(/@|uploaded|user_id/);
  });

  it("schema ไม่มี $schema และเป็น object ที่มี header/items", () => {
    expect(GEMINI_SCHEMA).not.toHaveProperty("$schema");
    expect(GEMINI_SCHEMA).toMatchObject({ type: "object", required: expect.arrayContaining(["header", "items"]) });
  });

  it.each([
    [{ status: "incomplete" }, /อ่านเอกสารนี้ไม่สำเร็จ \(incomplete\)/],
    [{ output_text: "" }, /ไม่ตรงรูปแบบ/],
    [{ output_text: "{not json" }, /ไม่ตรงรูปแบบ/],
    [{ output_text: JSON.stringify({ header: {} }) }, /ไม่ตรงรูปแบบ/],
  ])("ผลที่ใช้ไม่ได้ %o เป็นข้อผิดพลาดถาวร", async (response, message) => {
    const p = new GeminiExtractionProvider(client(response).client, opts);
    await expect(p.extract({ file: PDF, mime: "application/pdf" })).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(message) });
  });

  it("ข้อผิดพลาดจาก SDK ถูกจำแนกก่อนส่งต่อ", async () => {
    const p = new GeminiExtractionProvider(client(httpError(429)).client, opts);
    await expect(p.extract({ file: PDF, mime: "application/pdf" })).rejects.toMatchObject({ permanent: false });
  });
});

describe("classifyGeminiError", () => {
  it.each([429, 408, 500, 503])("HTTP %i เป็นชั่วคราว", (status) => {
    expect(classifyGeminiError(httpError(status)).permanent).toBe(false);
  });

  it.each([400, 401, 403, 404])("HTTP %i เป็นถาวร", (status) => {
    expect(classifyGeminiError(httpError(status))).toMatchObject({ permanent: true, message: `ผู้ให้บริการ AI ปฏิเสธคำขอ (${status})` });
  });

  it("status ใน statusCode หรือ httpMeta ก็อ่านได้", () => {
    expect(classifyGeminiError(Object.assign(new Error("x"), { statusCode: 400 })).permanent).toBe(true);
    expect(classifyGeminiError(Object.assign(new Error("x"), { httpMeta: { response: { status: 503 } } })).permanent).toBe(false);
  });

  it("เชื่อมต่อไม่ได้/หมดเวลาเป็นชั่วคราว", () => {
    const e = Object.assign(new Error("timeout"), { name: "RequestTimeoutError" });
    expect(classifyGeminiError(e)).toMatchObject({ permanent: false, message: expect.stringMatching(/หมดเวลา/) });
  });
});
