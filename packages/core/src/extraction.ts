// โครงผลการอ่านเอกสาร (design D2) — ใช้ร่วมกันระหว่าง provider, worker, api และ web
// มีสองชั้น: ModelExtractionSchema ส่งให้โมเดล (JSON schema แบบเรียบ) และ ExtractionResultSchema ที่ตรวจรูปแบบเข้ม
import { z } from "zod";

/** พิกัดสัดส่วนของหน้า (0–1) จึงไม่ขึ้นกับความละเอียดภาพ; page เริ่มที่ 1 */
export const BBoxSchema = z.object({
  page: z.number().int().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type BBox = z.infer<typeof BBoxSchema>;

/** เงินและอัตราเป็นสตริงทศนิยม เพื่อไม่เสียความแม่นยำก่อนเข้า Decimal */
export const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;
export const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
/** วันที่ ค.ศ. เท่านั้น — ปีเกิน 2400 คือ พ.ศ. ที่ยังไม่ได้แปลง */
export const ISO_DATE_RE = /^(19|20|21|22|23)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const confidence = z.number().min(0).max(1);

function field<T extends z.ZodTypeAny>(value: T) {
  return z.object({ value: value.nullable(), confidence, bbox: BBoxSchema.nullable().optional() });
}

const text = field(z.string());
const money = field(z.string().regex(MONEY_RE, "ยอดเงินต้องเป็นสตริงทศนิยมไม่เกิน 2 ตำแหน่ง"));
const decimal = field(z.string().regex(DECIMAL_RE, "ต้องเป็นสตริงทศนิยม"));
const date = field(z.string().regex(ISO_DATE_RE, "วันที่ต้องเป็น YYYY-MM-DD แบบ ค.ศ."));

export const HeaderSchema = z.object({
  invoiceNo: text,
  invoiceDate: date,
  vendorName: text,
  vendorTaxId: text,
  vendorBranch: text,
  buyerTaxId: text,
  buyerBranch: text,
  subtotal: money,
  discount: money,
  vatBase: money,
  vatRate: decimal,
  vatAmount: money,
  vatExempt: field(z.boolean()),
  grandTotal: money,
  whtBase: money,
  whtRate: decimal,
  whtAmount: money,
  netPayable: money,
});
export type ExtractedHeader = z.infer<typeof HeaderSchema>;
export const HEADER_FIELDS = Object.keys(HeaderSchema.shape) as (keyof ExtractedHeader)[];

export const LineItemSchema = z.object({
  no: z.number().int().min(1),
  description: text,
  quantity: decimal,
  unitPrice: money,
  discount: money.optional(),
  vat: money.optional(),
  amount: money,
});
export type ExtractedLineItem = z.infer<typeof LineItemSchema>;

export const ExtractionResultSchema = z.object({
  provider: z.string().min(1),
  modelVersion: z.string().min(1),
  /** ความมั่นใจรวมของเอกสาร 0–1 */
  confidence,
  header: HeaderSchema,
  items: z.array(LineItemSchema),
  /** ผลดิบจาก provider เก็บไว้ตรวจย้อนหลัง */
  raw: z.unknown(),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ExtractedField<T = string> = { value: T | null; confidence: number; bbox?: BBox | null };

/** ตรวจผลการอ่านแบบเข้ม — provider ทุกตัวต้องผ่านก่อนบันทึก */
export function parseExtractionResult(input: unknown): ExtractionResult {
  return ExtractionResultSchema.parse(input);
}

// ---------- schema ที่ส่งให้โมเดล ----------
// ไม่ใช้ regex/ขอบเขตตัวเลข เพราะ structured outputs รองรับ JSON schema เพียงบางส่วน รูปแบบตรวจซ้ำด้วย ExtractionResultSchema
const modelBBox = z.object({ page: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() });
function modelField<T extends z.ZodTypeAny>(value: T) {
  return z.object({ value: value.nullable(), confidence: z.number(), bbox: modelBBox.nullable() });
}
const mText = modelField(z.string());
const mBool = modelField(z.boolean());

export const ModelExtractionSchema = z.object({
  header: z.object(
    Object.fromEntries(HEADER_FIELDS.map((k) => [k, k === "vatExempt" ? mBool : mText])) as Record<
      keyof ExtractedHeader,
      typeof mText
    >,
  ),
  items: z.array(
    z.object({
      no: z.number(),
      description: mText,
      quantity: mText,
      unitPrice: mText,
      discount: mText,
      vat: mText,
      amount: mText,
    }),
  ),
});
export type ModelExtraction = z.infer<typeof ModelExtractionSchema>;

const emptyField = () => ({ value: null, confidence: 0, bbox: null });

/** ผลว่างทุก field — ใช้กับ provider จำลองและเป็นค่าตั้งต้น */
export function emptyHeader(): ExtractedHeader {
  return Object.fromEntries(HEADER_FIELDS.map((k) => [k, emptyField()])) as ExtractedHeader;
}

/** ความมั่นใจ ตำแหน่ง และค่าที่ AI อ่านได้ของแต่ละ field (เก็บใน documents.field_meta) */
export type FieldMetaEntry = { confidence: number; bbox: BBox | null; aiValue: string | boolean | null };
/** key คือ FieldPath เช่น `header.grandTotal`, `items[0].amount` */
export type FieldMeta = Record<string, FieldMetaEntry>;

export function buildFieldMeta(r: Pick<ExtractionResult, "header" | "items">): FieldMeta {
  const meta: FieldMeta = {};
  const put = (path: string, f: { value: string | boolean | null; confidence: number; bbox?: BBox | null } | undefined) => {
    if (f) meta[path] = { confidence: f.confidence, bbox: f.bbox ?? null, aiValue: f.value };
  };
  for (const k of HEADER_FIELDS) put(`header.${k}`, r.header[k]);
  r.items.forEach((item, i) => {
    for (const k of ["description", "quantity", "unitPrice", "discount", "vat", "amount"] as const) put(`items[${i}].${k}`, item[k]);
  });
  return meta;
}
