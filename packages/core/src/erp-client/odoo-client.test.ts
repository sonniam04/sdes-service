import { describe, expect, it, vi } from "vitest";
import { SyncError } from "./errors.js";
import { createOdooClient, type OdooConfig } from "./odoo-client.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const base: OdooConfig = { url: "http://odoo:8069", database: "sdes_erp", apiMode: "json2", apiKey: "KEY", timeoutMs: 1000 };

function fake(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift()!;
    if (r instanceof Error) throw r;
    return r;
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}
const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

describe("OdooClient JSON-2 (task 3.1)", () => {
  it("search_read: URL, bearer key, X-Odoo-Database และ body แบบ argument ชื่อ", async () => {
    const f = fake(json(200, [{ id: 7, name: "A" }]));
    const r = await createOdooClient(base, f.fetchImpl).searchRead("res.partner", [["vat", "=", "0105536000011"]], ["name"], 5);
    expect(r).toEqual([{ id: 7, name: "A" }]);
    expect(f.calls[0]!.url).toBe("http://odoo:8069/json/2/res.partner/search_read");
    expect(f.calls[0]!.init.headers).toMatchObject({ Authorization: "bearer KEY", "X-Odoo-Database": "sdes_erp" });
    expect(body(f.calls[0]!)).toEqual({ domain: [["vat", "=", "0105536000011"]], fields: ["name"], limit: 5 });
  });

  it("create ส่ง vals_list และคืน id; write ส่ง ids + vals", async () => {
    const f = fake(json(200, [42]), json(200, true));
    const c = createOdooClient(base, f.fetchImpl);
    expect(await c.create("account.move", { ref: "X" })).toBe(42);
    await c.write("account.move", [42], { narration: "n" });
    expect(body(f.calls[0]!)).toEqual({ vals_list: [{ ref: "X" }] });
    expect(body(f.calls[1]!)).toEqual({ ids: [42], vals: { narration: "n" } });
  });

  it("ไม่ใส่ X-Odoo-Database เมื่อไม่ได้ตั้งฐาน", async () => {
    const f = fake(json(200, []));
    await createOdooClient({ ...base, database: null }, f.fetchImpl).read("res.users", [2], ["name"]);
    expect(f.calls[0]!.init.headers).not.toHaveProperty("X-Odoo-Database");
  });

  it.each([500, 502, 503, 429, 408])("HTTP %i เป็นชั่วคราว", async (status) => {
    const f = fake(json(status, { name: "x", message: "boom" }));
    await expect(createOdooClient(base, f.fetchImpl).read("x", [1], [])).rejects.toMatchObject({ permanent: false });
  });

  it.each([
    [401, /ไม่รับ API key/],
    [403, /ไม่มีสิทธิ์/],
    [422, /ปฏิเสธข้อมูล \(422\): Invalid field 'foo'/],
  ])("HTTP %i เป็นถาวรพร้อมข้อความ", async (status, message) => {
    const f = fake(json(status, { name: "odoo.exceptions.ValidationError", message: "Invalid field 'foo'" }));
    const err = await createOdooClient(base, f.fetchImpl).read("x", [1], []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err).toMatchObject({ permanent: true, message: expect.stringMatching(message) });
  });

  it("เชื่อมต่อไม่ได้หรือหมดเวลาเป็นชั่วคราว", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    await expect(createOdooClient(base, fake(new TypeError("fetch failed")).fetchImpl).read("x", [1], [])).rejects.toMatchObject({ permanent: false, message: "เชื่อมต่อ Odoo ไม่ได้" });
    await expect(createOdooClient(base, fake(timeout).fetchImpl).read("x", [1], [])).rejects.toMatchObject({ permanent: false, message: "Odoo ไม่ตอบภายในเวลาที่กำหนด" });
  });
});

describe("OdooClient JSON-RPC (task 3.1)", () => {
  const rpcCfg: OdooConfig = { ...base, apiMode: "jsonrpc", login: "sdes-integration" };

  it("login ครั้งเดียวแล้วใช้ execute_kw ด้วย uid + API key", async () => {
    const f = fake(json(200, { result: 9 }), json(200, { result: [{ id: 1 }] }), json(200, { result: 55 }));
    const c = createOdooClient(rpcCfg, f.fetchImpl);
    await c.searchRead("res.partner", [["vat", "=", "1"]], ["name"]);
    expect(await c.create("res.partner", { name: "A" })).toBe(55);
    expect(f.calls.map((x) => x.url)).toEqual(Array(3).fill("http://odoo:8069/jsonrpc"));
    expect(body(f.calls[0]!)).toMatchObject({ params: { service: "common", method: "login", args: ["sdes_erp", "sdes-integration", "KEY"] } });
    expect(body(f.calls[1]!)).toMatchObject({
      params: { service: "object", method: "execute_kw", args: ["sdes_erp", 9, "KEY", "res.partner", "search_read", [[["vat", "=", "1"]]], { fields: ["name"] }] },
    });
    expect(body(f.calls[2]!)).toMatchObject({ params: { args: ["sdes_erp", 9, "KEY", "res.partner", "create", [{ name: "A" }], {}] } });
  });

  it("login ไม่ผ่าน / AccessDenied / error อื่นเป็นถาวร", async () => {
    await expect(createOdooClient(rpcCfg, fake(json(200, { result: false })).fetchImpl).read("x", [1], [])).rejects.toMatchObject({ permanent: true });
    const denied = json(200, { error: { message: "Odoo Server Error", data: { name: "odoo.exceptions.AccessDenied", message: "Access Denied" } } });
    await expect(createOdooClient(rpcCfg, fake(denied).fetchImpl).read("x", [1], [])).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/ไม่รับ API key/) });
    const other = json(200, { error: { data: { name: "odoo.exceptions.UserError", message: "Missing journal" } } });
    await expect(createOdooClient(rpcCfg, fake(json(200, { result: 9 }), other).fetchImpl).read("x", [1], [])).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/Missing journal/),
    });
  });

  it("ไม่มี login หรือฐานข้อมูลเป็นข้อผิดพลาดของการตั้งค่า", () => {
    expect(() => createOdooClient({ ...rpcCfg, login: null })).toThrow(/login/);
    expect(() => createOdooClient({ ...rpcCfg, database: null })).toThrow(/ฐานข้อมูล/);
  });
});
