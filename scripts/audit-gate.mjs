// ด่านตรวจช่องโหว่ของ dependency ที่ใช้งานจริง (spec platform-security "Dependency vulnerability gate", design D9)
// ใช้: node scripts/audit-gate.mjs — รัน `pnpm audit --prod --json` แล้วไม่ผ่านเมื่อพบระดับ critical ที่ไม่ได้ยกเว้น
// ยกเว้นได้ใน security/audit-exceptions.json: { "exceptions": [{ "id": "GHSA-…", "package": "x", "reason": "…", "expires": "YYYY-MM-DD" }] }
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GATE_SEVERITY = "critical";

/** คืน { failures, expired, report } — failures = ช่องโหว่ critical ที่ไม่มีข้อยกเว้นที่ยังไม่หมดอายุ */
export function evaluate(audit, exceptions = [], now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const expired = exceptions.filter((e) => !e.expires || e.expires < today);
  const invalid = exceptions.filter((e) => !e.id || !e.reason?.trim());
  const active = exceptions.filter((e) => e.expires && e.expires >= today && e.id && e.reason?.trim());
  const advisories = Object.values(audit?.advisories ?? {});
  const failures = advisories
    .filter((a) => a.severity === GATE_SEVERITY)
    .filter((a) => !active.some((e) => e.id === a.github_advisory_id || e.id === String(a.id)))
    .map((a) => ({ id: a.github_advisory_id ?? String(a.id), package: a.module_name, title: a.title, url: a.url }));
  return { failures, expired, invalid, counts: audit?.metadata?.vulnerabilities ?? {} };
}

function main() {
  let json;
  try {
    json = execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["audit", "--prod", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // pnpm audit ออกด้วยรหัสไม่เป็นศูนย์เมื่อพบช่องโหว่ใด ๆ — ผลยังอยู่ใน stdout
    json = e.stdout;
  }
  const file = "security/audit-exceptions.json";
  const exceptions = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).exceptions ?? [] : [];
  const r = evaluate(JSON.parse(json), exceptions);
  console.log(`ช่องโหว่ใน dependency ที่ใช้งานจริง: ${JSON.stringify(r.counts)}`);
  for (const e of r.expired) console.error(`ข้อยกเว้นหมดอายุหรือไม่มีวันหมดอายุ: ${e.id} (${e.package ?? "-"})`);
  for (const e of r.invalid) console.error(`ข้อยกเว้นต้องมี id และเหตุผล: ${JSON.stringify(e)}`);
  for (const f of r.failures) console.error(`ช่องโหว่ระดับ critical: ${f.package} ${f.id} — ${f.title} ${f.url ?? ""}`);
  if (r.failures.length || r.expired.length || r.invalid.length) process.exit(1);
  console.log("ไม่พบช่องโหว่ระดับ critical ที่ไม่ได้ยกเว้น");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
