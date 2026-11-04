// ตรวจค่าตั้งตอนเริ่มเมื่อ NODE_ENV=production (spec production-deployment "Configuration and secrets", design D6)
// คืนเฉพาะชื่อค่าและปัญหา — ห้ามใส่ค่าของ secret ลงในข้อความ เพราะข้อความไปอยู่ใน log
import { z } from "zod";

export type ServiceKind = "api" | "worker";
export type ConfigIssue = { name: string; problem: string };
type Env = Record<string, string | undefined>;

const PLACEHOLDERS = ["change-me", "changeme", "example", "password", "secret", "your-"];
const isPlaceholder = (v: string) => PLACEHOLDERS.some((p) => v.toLowerCase().includes(p));
const EXTRACTION_PROVIDERS = ["fake", "fixture", "claude", "gemini"] as const;

/** ค่าสุ่มที่ยาวพอและไม่ใช่ค่าตัวอย่าง */
const secret = (min: number) =>
  z
    .string({ error: "ไม่ได้ตั้งค่า" })
    .min(min, `สั้นเกินไป (ต้องยาวอย่างน้อย ${min} ตัวอักษร)`)
    .refine((v) => !isPlaceholder(v), "ยังเป็นค่าตัวอย่าง");

/** URL ที่มีรหัสผ่านสุ่มยาวพอ (ฐานข้อมูล, Redis) */
const urlWithPassword = (min: number) =>
  z.string({ error: "ไม่ได้ตั้งค่า" }).superRefine((v, ctx) => {
    let password: string;
    try {
      password = decodeURIComponent(new URL(v).password);
    } catch {
      ctx.addIssue({ code: "custom", message: "รูปแบบ URL ไม่ถูกต้อง" });
      return;
    }
    if (password.length < min) ctx.addIssue({ code: "custom", message: `รหัสผ่านใน URL สั้นเกินไป (ต้องยาวอย่างน้อย ${min} ตัวอักษร)` });
    else if (isPlaceholder(password)) ctx.addIssue({ code: "custom", message: "รหัสผ่านใน URL ยังเป็นค่าตัวอย่าง" });
  });

const common = {
  DATABASE_URL: urlWithPassword(16),
  REDIS_URL: urlWithPassword(16),
  S3_ENDPOINT: z.string({ error: "ไม่ได้ตั้งค่า" }).url("รูปแบบ URL ไม่ถูกต้อง"),
  S3_ACCESS_KEY: secret(16),
  S3_SECRET_KEY: secret(24),
  ERP_SECRET_KEY: secret(24),
};

const apiSchema = z.object({
  ...common,
  JWT_SECRET: secret(32),
  COOKIE_SECURE: z.literal("true", { error: "ต้องเป็น true บน production (cookie ส่งผ่าน HTTPS เท่านั้น)" }),
  // ต้องชี้ proxy ที่กำหนด — "true"/"*" คือเชื่อ X-Forwarded-For จากทุกต้นทาง (spec platform-security "Client IP behind a reverse proxy")
  TRUST_PROXY: z
    .string({ error: "ไม่ได้ตั้งค่า — ต้องเป็น IP ของ reverse proxy" })
    .min(1, "ไม่ได้ตั้งค่า — ต้องเป็น IP ของ reverse proxy")
    .refine((v) => !["true", "*", "1"].includes(v.trim().toLowerCase()), "ต้องระบุ IP ของ reverse proxy ไม่ใช่เชื่อทุกต้นทาง"),
});

const workerSchema = z
  .object({
    ...common,
    EXTRACTION_PROVIDER: z.enum(EXTRACTION_PROVIDERS, { error: `ต้องเป็นหนึ่งใน ${EXTRACTION_PROVIDERS.join(", ")}` }).default("fake"),
    ANTHROPIC_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.EXTRACTION_PROVIDER === "claude" && !e.ANTHROPIC_API_KEY)
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "ต้องตั้งเมื่อ EXTRACTION_PROVIDER=claude" });
    if (e.EXTRACTION_PROVIDER === "gemini" && !e.GEMINI_API_KEY)
      ctx.addIssue({ code: "custom", path: ["GEMINI_API_KEY"], message: "ต้องตั้งเมื่อ EXTRACTION_PROVIDER=gemini" });
  });

/** ค่าว่างถือว่าไม่ได้ตั้ง (compose ส่ง "" เมื่อไม่มีค่าในไฟล์) */
const present = (env: Env) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));

export function checkProductionEnv(env: Env, kind: ServiceKind): ConfigIssue[] {
  const result = (kind === "api" ? apiSchema : workerSchema).safeParse(present(env));
  if (result.success) return [];
  // หนึ่งค่าต่อหนึ่งบรรทัด (ปัญหาแรกของค่านั้น)
  const seen = new Map<string, string>();
  for (const i of result.error.issues) {
    const name = String(i.path[0] ?? "");
    if (!seen.has(name)) seen.set(name, i.message);
  }
  return [...seen].map(([name, problem]) => ({ name, problem }));
}

/** เรียกก่อนเริ่ม Nest — production ที่ค่าไม่ครบหยุดทันทีพร้อมชื่อค่า */
export function assertProductionEnv(
  kind: ServiceKind,
  env: Env = process.env,
  log: (msg: string) => void = (m) => console.error(m),
  exit: (code: number) => never = (c) => process.exit(c),
): void {
  if (env.NODE_ENV !== "production") return;
  const issues = checkProductionEnv(env, kind);
  if (!issues.length) return;
  log(`[${kind}] ค่าตั้ง production ไม่ถูกต้อง ${issues.length} รายการ — แก้ในไฟล์ค่าตั้งของเครื่องแล้วเริ่มใหม่`);
  for (const i of issues) log(`  - ${i.name}: ${i.problem}`);
  exit(1);
}
