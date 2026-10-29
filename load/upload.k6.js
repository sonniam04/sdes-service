// Load test: อัปโหลดพร้อมกัน 50 ไฟล์ × 5 MB (spec document-ingestion: Concurrent upload capacity)
// รัน: ดู load/README.md — ข้อมูลเป็นไฟล์สุ่ม ไม่ใช่เอกสารจริง
import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";

const API = __ENV.API ?? "http://api:3000";

export const options = {
  scenarios: { burst: { executor: "shared-iterations", vus: 50, iterations: 50, maxDuration: "5m" } },
  thresholds: { checks: ["rate==1"] },
};

export function setup() {
  const r = http.post(`${API}/auth/login`, JSON.stringify({ email: __ENV.EMAIL, password: __ENV.PASSWORD }), {
    headers: { "Content-Type": "application/json" },
  });
  if (r.status !== 200) throw new Error(`login ไม่สำเร็จ: ${r.status}`);
  return { token: r.json("accessToken") };
}

export default function (data) {
  const header = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]); // %PDF-1.7
  const body = new Uint8Array(header.length + 5 * 1024 * 1024);
  body.set(header);
  body.set(new Uint8Array(crypto.randomBytes(5 * 1024 * 1024)), header.length);
  const res = http.post(
    `${API}/documents`,
    { files: http.file(body.buffer, `load-${__VU}-${__ITER}.pdf`, "application/pdf") },
    { headers: { Authorization: `Bearer ${data.token}` }, timeout: "120s" },
  );
  check(res, {
    "status 201": (r) => r.status === 201,
    "ได้เลขเอกสารและเข้าคิว": (r) => r.status === 201 && r.json("results.0.ok") === true && /^DOC-/.test(r.json("results.0.docNo")),
  });
}
