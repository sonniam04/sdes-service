import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "./audit-gate.mjs";

const audit = {
  advisories: {
    1: { id: 1, module_name: "evil", severity: "critical", github_advisory_id: "GHSA-aaaa", title: "RCE", url: "u" },
    2: { id: 2, module_name: "meh", severity: "high", github_advisory_id: "GHSA-bbbb", title: "DoS", url: "u" },
  },
  metadata: { vulnerabilities: { critical: 1, high: 1 } },
};
const now = new Date("2026-10-30T00:00:00Z");

test("critical ที่ไม่ได้ยกเว้นทำให้ไม่ผ่าน; high ไม่ทำให้ไม่ผ่าน", () => {
  const r = evaluate(audit, [], now);
  assert.deepEqual(r.failures.map((f) => f.id), ["GHSA-aaaa"]);
});

test("ข้อยกเว้นที่ยังไม่หมดอายุและมีเหตุผลทำให้ผ่าน", () => {
  const r = evaluate(audit, [{ id: "GHSA-aaaa", package: "evil", reason: "ไม่ได้ใช้ฟังก์ชันที่มีช่องโหว่", expires: "2026-12-31" }], now);
  assert.equal(r.failures.length, 0);
  assert.equal(r.expired.length, 0);
});

test("ข้อยกเว้นที่หมดอายุแล้วไม่นับ และถูกรายงาน", () => {
  const ex = [{ id: "GHSA-aaaa", package: "evil", reason: "ชั่วคราว", expires: "2026-10-29" }];
  const r = evaluate(audit, ex, now);
  assert.equal(r.failures.length, 1);
  assert.deepEqual(r.expired, ex);
});

test("ข้อยกเว้นไม่มีวันหมดอายุหรือไม่มีเหตุผลถือว่าไม่ถูกต้อง", () => {
  const r = evaluate(audit, [{ id: "GHSA-aaaa", reason: "x" }, { id: "GHSA-aaaa", reason: " ", expires: "2027-01-01" }], now);
  assert.equal(r.failures.length, 1);
  assert.equal(r.expired.length, 1);
  assert.equal(r.invalid.length, 1);
});

test("ไม่มีช่องโหว่ = ผ่าน", () => {
  assert.equal(evaluate({ advisories: {} }, [], now).failures.length, 0);
});
