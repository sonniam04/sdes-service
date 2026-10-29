// ส่ง payload เป็น JSON พร้อมลายเซ็น HMAC-SHA256 (spec erp-sync "Generic webhook adapter", design D4)
import { createHmac } from "node:crypto";
import type { ErpAdapter, ErpAttachment, ErpPayload, ErpPushResult } from "@sdes/core";
import { syncErrorForStatus, syncNetworkError, syncPermanent } from "./errors.js";

export type WebhookConfig = { url: string; secret: string; timeoutMs?: number };

const TARGET = "ปลายทาง webhook";

/** ลายเซ็นของ `${timestamp}.${body}` — ปลายทางคำนวณซ้ำด้วย secret เดียวกันแล้วเทียบ */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export class WebhookErpAdapter implements ErpAdapter {
  readonly name = "webhook";

  constructor(
    private readonly cfg: WebhookConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async push(payload: ErpPayload, attachment?: ErpAttachment): Promise<ErpPushResult> {
    const body = JSON.stringify({
      ...payload,
      attachment: attachment
        ? { name: attachment.name, mimeType: attachment.mimeType, data: Buffer.from(attachment.data).toString("base64") }
        : null,
    });
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SDES-Timestamp": timestamp,
          "X-SDES-Signature": signWebhook(this.cfg.secret, timestamp, body),
          "Idempotency-Key": payload.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw syncNetworkError(e, TARGET);
    }
    const text = await res.text();
    if (!res.ok) throw syncErrorForStatus(res.status, text.slice(0, 300), TARGET);
    let json: { transactionId?: unknown; reused?: unknown } | null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (typeof json?.transactionId !== "string" && typeof json?.transactionId !== "number")
      throw syncPermanent(`${TARGET} ตอบสำเร็จแต่ไม่มี transactionId`);
    return { transactionId: String(json.transactionId), reused: json.reused === true };
  }
}
