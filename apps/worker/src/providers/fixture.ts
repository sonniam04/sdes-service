// Provider ที่คืนเฉลยของชุดทดสอบตาม sha256 ของไฟล์ — ใช้ใน E2E/CI โดยไม่เรียก AI จริง (design D2)
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseExtractionResult, type ExtractionProvider, type ExtractionResult } from "@sdes/core";
import { permanent } from "./errors.js";

export class FixtureExtractionProvider implements ExtractionProvider {
  readonly name = "fixture";

  /** dir มีไฟล์ `<sha256>.json` แต่ละไฟล์เป็น ExtractionResult (ไม่ต้องมี provider/modelVersion/raw) */
  constructor(private readonly dir: string) {}

  async extract(input: { file: Uint8Array }): Promise<ExtractionResult> {
    const sha256 = createHash("sha256").update(input.file).digest("hex");
    let json: string;
    try {
      json = await readFile(join(this.dir, `${sha256}.json`), "utf8");
    } catch {
      throw permanent(`ไม่มีเฉลยของไฟล์นี้ในชุดทดสอบ (${sha256.slice(0, 12)})`);
    }
    const answer = JSON.parse(json) as Partial<ExtractionResult>;
    return parseExtractionResult({ modelVersion: "fixture-1", raw: { fixture: sha256 }, ...answer, provider: this.name });
  }
}
