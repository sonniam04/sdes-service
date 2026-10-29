import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ErpPayload } from "@sdes/core";
import { WebhookErpAdapter, signWebhook } from "./webhook.js";

const SECRET = "whsec-test-1234567890";
const payload: ErpPayload = {
  idempotencyKey: "sdes:doc-1",
  documentId: "doc-1",
  docNo: "DOC-000120",
  vendor: { name: "ผู้ขาย", taxId: "0105536000011", branch: "00000", erpPartnerId: null },
  invoice: { number: "INV-1", date: "2026-10-15" },
  currency: "THB",
  lines: [{ description: "ค่าบริการ", quantity: "1", unitPrice: "10000.00", discount: "0.00", amount: "10000.00" }],
  totals: { subtotal: "10000.00", discount: "0.00", vatBase: "10000.00", vatRate: "7", vatAmount: "700.00", vatExempt: false, grandTotal: "10700.00" },
  withholding: null,
};

/** ปลายทางจำลอง: ตอบตามคิว และเก็บคำขอที่ได้รับ */
type Received = { headers: IncomingMessage["headers"]; body: string };
let server: Server;
let url: string;
const received: Received[] = [];
const replies: { status: number; body: unknown }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      const r = replies.shift() ?? { status: 200, body: { transactionId: "T-1" } };
      res.writeHead(r.status, { "Content-Type": "application/json" }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/erp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("WebhookErpAdapter (task 3.3)", () => {
  it("ปลายทางตรวจลายเซ็นด้วย secret เดียวกันได้ และได้ transactionId", async () => {
    received.length = 0;
    const r = await new WebhookErpAdapter({ url, secret: SECRET }).push(payload, { name: "a.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF") });
    expect(r).toEqual({ transactionId: "T-1", reused: false });
    const req = received[0]!;
    const expected = `sha256=${createHmac("sha256", SECRET).update(`${req.headers["x-sdes-timestamp"]}.${req.body}`).digest("hex")}`;
    expect(timingSafeEqual(Buffer.from(String(req.headers["x-sdes-signature"])), Buffer.from(expected))).toBe(true);
    expect(JSON.parse(req.body)).toMatchObject({ docNo: "DOC-000120", attachment: { name: "a.pdf", data: Buffer.from("%PDF").toString("base64") } });
  });

  it("ส่งซ้ำได้ idempotency key เดิม", async () => {
    received.length = 0;
    const a = new WebhookErpAdapter({ url, secret: SECRET });
    await a.push(payload);
    await a.push(payload);
    expect(received.map((r) => r.headers["idempotency-key"])).toEqual(["sdes:doc-1", "sdes:doc-1"]);
  });

  it("ลายเซ็นเปลี่ยนเมื่อ body ถูกแก้", () => {
    expect(signWebhook(SECRET, "1", '{"a":1}')).not.toBe(signWebhook(SECRET, "1", '{"a":2}'));
  });

  it.each([
    [503, false],
    [429, false],
    [400, true],
    [401, true],
  ])("HTTP %i → permanent=%s", async (status, permanent) => {
    replies.push({ status, body: { error: "x" } });
    await expect(new WebhookErpAdapter({ url, secret: SECRET }).push(payload)).rejects.toMatchObject({ permanent });
  });

  it("2xx แต่ไม่มี transactionId เป็นถาวร", async () => {
    replies.push({ status: 200, body: { ok: true } });
    await expect(new WebhookErpAdapter({ url, secret: SECRET }).push(payload)).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/transactionId/) });
  });

  it("ปลายทางไม่ตอบหรือเชื่อมต่อไม่ได้เป็นชั่วคราว", async () => {
    await expect(new WebhookErpAdapter({ url: "http://127.0.0.1:1/erp", secret: SECRET }).push(payload)).rejects.toMatchObject({ permanent: false });
  });
});
