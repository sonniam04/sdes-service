import { PrismaClient } from "./generated/client/index.js";

export * from "./generated/client/index.js";
export { seed, DEFAULT_SETTINGS, type SeedOptions, type SeedResult } from "./seed.js";
export { recordAudit, type AuditActor, type AuditInput, type Tx } from "./audit.js";
export { transitionDocument, StaleDocumentError, type TransitionInput } from "./transitions.js";

/** แอปเชื่อมต่อด้วย role sdes_app (ไม่ใช่ owner) — ส่ง url ของ DATABASE_URL */
export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: url });
}
