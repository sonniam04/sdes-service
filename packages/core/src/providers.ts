// Interface ที่สลับ implementation ได้ (design D8) — เลือกผ่าน config EXTRACTION_PROVIDER / ERP_ADAPTER

export type BBox = { page: number; x: number; y: number; w: number; h: number };

export type ExtractedField<T = string> = { value: T | null; confidence: number; bbox?: BBox };

export type ExtractedLineItem = {
  no: number;
  description: ExtractedField;
  quantity: ExtractedField;
  unitPrice: ExtractedField;
  amount: ExtractedField;
  vat?: ExtractedField;
};

export type ExtractionResult = {
  provider: string;
  modelVersion: string;
  /** ความมั่นใจรวมของเอกสาร 0–1 */
  confidence: number;
  header: {
    invoiceNo: ExtractedField;
    invoiceDate: ExtractedField;
    vendorName: ExtractedField;
    vendorTaxId: ExtractedField;
    vendorBranch: ExtractedField;
    buyerTaxId: ExtractedField;
    subtotal: ExtractedField;
    discount: ExtractedField;
    vatAmount: ExtractedField;
    grandTotal: ExtractedField;
  };
  items: ExtractedLineItem[];
  /** ผลดิบจาก provider เก็บไว้ตรวจย้อนหลัง */
  raw: unknown;
};

export interface ExtractionProvider {
  readonly name: string;
  extract(input: { file: Buffer; mime: string; pages?: number }): Promise<ExtractionResult>;
}

export type SignedErpPayload = { body: string; signature: string; idempotencyKey: string };

export interface ErpAdapter {
  readonly name: string;
  push(payload: SignedErpPayload): Promise<{ transactionId: string }>;
  health(): Promise<boolean>;
}

const empty = (): ExtractedField => ({ value: null, confidence: 0 });

/** Provider จำลองสำหรับ Phase 1: คืนผลว่าง confidence 0 เพื่อพิสูจน์เส้นทาง ingestion */
export class FakeExtractionProvider implements ExtractionProvider {
  readonly name = "fake";

  async extract(): Promise<ExtractionResult> {
    return {
      provider: this.name,
      modelVersion: "fake-1",
      confidence: 0,
      header: {
        invoiceNo: empty(),
        invoiceDate: empty(),
        vendorName: empty(),
        vendorTaxId: empty(),
        vendorBranch: empty(),
        buyerTaxId: empty(),
        subtotal: empty(),
        discount: empty(),
        vatAmount: empty(),
        grandTotal: empty(),
      },
      items: [],
      raw: { note: "fake provider" },
    };
  }
}
