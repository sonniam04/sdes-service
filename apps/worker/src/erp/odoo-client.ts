// เรียก Odoo ผ่าน JSON-2 (Odoo 19+) หรือ JSON-RPC (Odoo 17–18) — design D3 transport
import { syncErrorForStatus, syncNetworkError, syncPermanent } from "./errors.js";

export type OdooConfig = {
  /** เช่น http://odoo:8069 (ไม่มี / ท้าย) */
  url: string;
  /** ระบุเมื่อ server มีหลายฐานข้อมูล */
  database?: string | null;
  apiMode: "json2" | "jsonrpc";
  /** ชื่อผู้ใช้ — ใช้กับ jsonrpc เท่านั้น */
  login?: string | null;
  apiKey: string;
  timeoutMs?: number;
};

type Domain = unknown[];
const TARGET = "Odoo";

/** เมธอดที่ adapter ใช้ — ซ่อนความต่างของ JSON-2 กับ JSON-RPC */
export interface OdooClient {
  searchRead<T>(model: string, domain: Domain, fields: string[], limit?: number): Promise<T[]>;
  read<T>(model: string, ids: number[], fields: string[]): Promise<T[]>;
  create(model: string, vals: Record<string, unknown>): Promise<number>;
  write(model: string, ids: number[], vals: Record<string, unknown>): Promise<void>;
}

export function createOdooClient(cfg: OdooConfig, fetchImpl: typeof fetch = fetch): OdooClient {
  return cfg.apiMode === "jsonrpc" ? new JsonRpcClient(cfg, fetchImpl) : new Json2Client(cfg, fetchImpl);
}

async function post(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs = 30_000) {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw syncNetworkError(e, TARGET);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = (json as { message?: string } | null)?.message ?? "";
    throw syncErrorForStatus(res.status, detail.slice(0, 300), TARGET);
  }
  return json;
}

/** JSON-2: POST /json/2/<model>/<method> + bearer API key (+ X-Odoo-Database) */
class Json2Client implements OdooClient {
  constructor(
    private readonly cfg: OdooConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private call<T>(model: string, method: string, body: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { Authorization: `bearer ${this.cfg.apiKey}` };
    if (this.cfg.database) headers["X-Odoo-Database"] = this.cfg.database;
    return post(this.fetchImpl, `${this.cfg.url}/json/2/${model}/${method}`, headers, body, this.cfg.timeoutMs) as Promise<T>;
  }

  searchRead<T>(model: string, domain: Domain, fields: string[], limit?: number) {
    return this.call<T[]>(model, "search_read", { domain, fields, ...(limit ? { limit } : {}) });
  }
  read<T>(model: string, ids: number[], fields: string[]) {
    return this.call<T[]>(model, "read", { ids, fields });
  }
  async create(model: string, vals: Record<string, unknown>) {
    const r = await this.call<number[] | number>(model, "create", { vals_list: [vals] });
    return Array.isArray(r) ? r[0]! : r;
  }
  async write(model: string, ids: number[], vals: Record<string, unknown>) {
    await this.call<boolean>(model, "write", { ids, vals });
  }
}

/** JSON-RPC (Odoo 17–18): /jsonrpc + execute_kw โดยใช้ API key แทนรหัสผ่าน */
class JsonRpcClient implements OdooClient {
  private uid: number | null = null;

  constructor(
    private readonly cfg: OdooConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    if (!cfg.login) throw syncPermanent("โหมด JSON-RPC ต้องระบุชื่อผู้ใช้ (login) ของ Odoo");
    if (!cfg.database) throw syncPermanent("โหมด JSON-RPC ต้องระบุชื่อฐานข้อมูลของ Odoo");
  }

  private async rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const body = { jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() };
    const r = (await post(this.fetchImpl, `${this.cfg.url}/jsonrpc`, {}, body, this.cfg.timeoutMs)) as {
      result?: T;
      error?: { message?: string; data?: { name?: string; message?: string } };
    };
    if (r?.error) {
      const name = r.error.data?.name ?? "";
      const message = r.error.data?.message ?? r.error.message ?? "";
      if (/AccessDenied|AccessError/.test(name)) throw syncPermanent(`${TARGET} ไม่รับ API key หรือผู้ใช้ไม่มีสิทธิ์: ${message}`);
      throw syncPermanent(`${TARGET} ปฏิเสธข้อมูล: ${message}`.slice(0, 400));
    }
    return r?.result as T;
  }

  private async exec<T>(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<T> {
    if (this.uid === null) {
      const uid = await this.rpc<number | false>("common", "login", [this.cfg.database, this.cfg.login, this.cfg.apiKey]);
      if (!uid) throw syncPermanent(`${TARGET} ไม่รับชื่อผู้ใช้หรือ API key`);
      this.uid = uid;
    }
    return this.rpc<T>("object", "execute_kw", [this.cfg.database, this.uid, this.cfg.apiKey, model, method, args, kwargs]);
  }

  searchRead<T>(model: string, domain: Domain, fields: string[], limit?: number) {
    return this.exec<T[]>(model, "search_read", [domain], { fields, ...(limit ? { limit } : {}) });
  }
  read<T>(model: string, ids: number[], fields: string[]) {
    return this.exec<T[]>(model, "read", [ids], { fields });
  }
  async create(model: string, vals: Record<string, unknown>) {
    const r = await this.exec<number | number[]>(model, "create", [vals]);
    return Array.isArray(r) ? r[0]! : r;
  }
  async write(model: string, ids: number[], vals: Record<string, unknown>) {
    await this.exec<boolean>(model, "write", [ids, vals]);
  }
}
