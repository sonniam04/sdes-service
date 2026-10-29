// Interface ที่สลับ implementation ได้ (design D8) — เลือกผ่าน config EXTRACTION_PROVIDER / ERP_ADAPTER

import { emptyHeader, type ExtractionResult } from "./extraction.js";

export interface ExtractionProvider {
  readonly name: string;
  extract(input: { file: Uint8Array; mime: string; pages?: number }): Promise<ExtractionResult>;
}

export type SignedErpPayload = { body: string; signature: string; idempotencyKey: string };

export interface ErpAdapter {
  readonly name: string;
  push(payload: SignedErpPayload): Promise<{ transactionId: string }>;
  health(): Promise<boolean>;
}

/** Provider จำลอง: คืนผลว่าง confidence 0 เพื่อพิสูจน์เส้นทาง ingestion */
export class FakeExtractionProvider implements ExtractionProvider {
  readonly name = "fake";

  async extract(): Promise<ExtractionResult> {
    return {
      provider: this.name,
      modelVersion: "fake-1",
      confidence: 0,
      header: emptyHeader(),
      items: [],
      raw: { note: "fake provider" },
    };
  }
}
