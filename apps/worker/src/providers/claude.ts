// อ่านเอกสารด้วย Claude vision + structured outputs (design D1)
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ModelExtractionSchema, type ExtractionProvider, type ExtractionResult } from "@sdes/core";
import { classifyError, permanent } from "./errors.js";
import { normalizeModelOutput } from "./normalize.js";
import { prepareInput, type PreparedInput } from "./prepare.js";

export type ClaudeOptions = {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
};

/** ส่วนของ client ที่ใช้ — ให้ test ส่ง client จำลองเข้ามาได้ */
export type ClaudeClient = { beta: { messages: Pick<Anthropic["beta"]["messages"], "parse"> } };

/** server-side fallback: คำขอที่ตัวกรองความปลอดภัยปฏิเสธจะถูกส่งต่อให้รุ่นสำรองในคำขอเดียว */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const SYSTEM_PROMPT = `You extract data from Thai tax invoices, invoices and receipts (ใบกำกับภาษี, ใบแจ้งหนี้, ใบเสร็จรับเงิน) for an accounts payable team.

Return every field in the schema. For each field give:
- value: exactly what the document states, or null when the document does not show it. Never guess or compute a value that is not printed.
- confidence: 0 to 1, how sure you are that the value is read correctly. Use low values for blurred, handwritten, cut-off or ambiguous characters (0/O, 1/l, 5/S, 8/B).
- bbox: where the value is printed, as fractions of the page (x, y = top-left corner, w, h = size, all between 0 and 1) and page number starting at 1. Use null if the value is not on the document.

Formatting rules:
- Money: plain decimal string without thousands separators or currency, e.g. "10700.00".
- Rates: number only, e.g. "7" for VAT 7%, "3" for withholding tax 3%.
- invoiceDate: YYYY-MM-DD in the Gregorian calendar. Thai documents often use the Buddhist year (พ.ศ.); subtract 543.
- Tax IDs: the 13 digits only, without dashes or spaces.
- Branch codes: 5 digits; "สำนักงานใหญ่" (head office) is "00000".
- vendor = the seller who issued the document; buyer = the customer it was issued to.
- subtotal is the total before VAT and before the document-level discount; vatBase is the amount VAT is charged on; grandTotal includes VAT.
- whtBase / whtRate / whtAmount: withholding tax (หัก ณ ที่จ่าย) if shown; whtBase can be only part of the subtotal (services only). netPayable is the amount payable after withholding tax.
- vatExempt is true only when the document says VAT does not apply (ยกเว้นภาษีมูลค่าเพิ่ม / ไม่มี VAT).

Line items: list every line in document order across all pages, without duplicating lines repeated in page headers or carried-forward subtotals.`;

const INSTRUCTION = "Extract the data from this document.";

export class ClaudeExtractionProvider implements ExtractionProvider {
  readonly name = "claude";

  constructor(
    private readonly client: ClaudeClient,
    private readonly opts: ClaudeOptions,
  ) {}

  /** สร้างคำขอ — มีเฉพาะไฟล์และคำสั่งอ่าน ไม่มีข้อมูลผู้ใช้ (spec "Data sent to the AI provider") */
  buildRequest(input: PreparedInput) {
    const files =
      input.kind === "pdf"
        ? [{ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: input.data.toString("base64") } }]
        : input.pages.map((p) => ({ type: "image" as const, source: { type: "base64" as const, media_type: p.mediaType, data: p.data.toString("base64") } }));
    return {
      model: this.opts.model,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default" as const,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: [...files, { type: "text" as const, text: INSTRUCTION }] }],
      output_config: { effort: this.opts.effort, format: betaZodOutputFormat(ModelExtractionSchema) },
    };
  }

  async extract(input: { file: Uint8Array; mime: string }): Promise<ExtractionResult> {
    const prepared = await prepareInput(input.file, input.mime);
    const started = Date.now();
    let res: Awaited<ReturnType<ClaudeClient["beta"]["messages"]["parse"]>>;
    try {
      // retry อยู่ที่ BullMQ ชั้นเดียว (design D1) จึงปิด retry ของ SDK
      res = await this.client.beta.messages.parse(this.buildRequest(prepared), { timeout: this.opts.timeoutMs, maxRetries: 0 });
    } catch (e) {
      throw classifyError(e);
    }
    if (res.stop_reason === "refusal") throw permanent("ผู้ให้บริการ AI ปฏิเสธการอ่านเอกสารนี้");
    if (res.stop_reason === "max_tokens") throw permanent("เอกสารยาวเกินกว่าที่อ่านได้ในครั้งเดียว");
    const parsed = res.parsed_output as unknown;
    if (!parsed) throw permanent("ผลการอ่านไม่ตรงรูปแบบที่กำหนด");

    const out = ModelExtractionSchema.safeParse(parsed);
    if (!out.success) throw permanent("ผลการอ่านไม่ตรงรูปแบบที่กำหนด", out.error);
    return normalizeModelOutput(out.data, {
      provider: this.name,
      modelVersion: res.model,
      raw: { output: parsed, usage: res.usage, stopReason: res.stop_reason, model: res.model, latencyMs: Date.now() - started },
    });
  }
}
