import { PrismaClient } from "./generated/client/index.js";

export * from "./generated/client/index.js";
export { seed, DEFAULT_SETTINGS, type SeedOptions, type SeedResult } from "./seed.js";
export { recordAudit, type AuditActor, type AuditInput, type Tx } from "./audit.js";
export { transitionDocument, StaleDocumentError, type TransitionInput } from "./transitions.js";
export { loadErpConnection, loadErpConnectionWithSecret, toErpConnection, connectionHash, ERP_CONNECTION_ID, type ErpConnection, type ErpConnectionOptions, type ErpAdapterName } from "./erp-connection.js";
export { encryptSecret, decryptSecret, loadSecretKey, SecretKeyError, type EncryptedSecret } from "./secrets.js";
export { projectDocumentData, loadReviewSettings, findDuplicateInvoice, CONFIRMED_STATUSES, ESTABLISHED_VENDOR_STATUSES, type ReviewSettings } from "./review.js";

/** แอปเชื่อมต่อด้วย role sdes_app (ไม่ใช่ owner) — ส่ง url ของ DATABASE_URL */
export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: url });
}
export { DbLogger, SystemLogSink, maskLogText, purgeSystemLogs, SYSTEM_LOG_RETENTION_DAYS, type LogService, type LogLevel, type LogEntry, type SystemLogRow } from "./system-logs.js";
