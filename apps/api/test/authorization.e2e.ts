// Authorization regression test (spec platform-security, design D9, phase 3 task 5.4)
// ไล่ทุก route จาก metadata ของ controller: ต้องประกาศ permission (หรืออยู่ในรายการล็อกอินอย่างเดียว) และผล 403 ตรงกับ permission matrix
import { randomUUID } from "node:crypto";
import { Controller, Get, RequestMethod, type INestApplication, type Type } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, can, type Action, type Role } from "@sdes/core";
import { IS_PUBLIC, REQUIRED_PERMISSION } from "../src/auth/decorators.js";
import { hasDatabase } from "./test-db.js";
import { authed, bootApp, createUser, ownerDb } from "./helpers.js";

type RouteInfo = { method: string; path: string; permission: Action | null; isPublic: boolean };

/** route ที่ต้องล็อกอินแต่ทุก role ใช้ได้ — ต้องมีเหตุผลกำกับทุกรายการ */
const AUTH_ONLY: Record<string, string> = {
  "GET /auth/me": "ข้อมูลของผู้ใช้ที่ล็อกอินเอง",
  "POST /auth/change-password": "เปลี่ยนรหัสผ่านของตัวเอง",
};

const join = (...parts: (string | undefined)[]) => "/" + parts.flatMap((p) => (p ?? "").split("/")).filter(Boolean).join("/");

/** อ่าน route ทั้งหมดของ controller จาก metadata ของ Nest */
export function routesOf(controllers: Type[]): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const c of controllers) {
    const base = Reflect.getMetadata(PATH_METADATA, c) as string | undefined;
    const classPermission = Reflect.getMetadata(REQUIRED_PERMISSION, c) as Action | undefined;
    const classPublic = Reflect.getMetadata(IS_PUBLIC, c) === true;
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      const handler = c.prototype[name];
      if (name === "constructor" || typeof handler !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      out.push({
        method: RequestMethod[method]!,
        path: join(base, Reflect.getMetadata(PATH_METADATA, handler) as string),
        permission: (Reflect.getMetadata(REQUIRED_PERMISSION, handler) as Action | undefined) ?? classPermission ?? null,
        isPublic: Reflect.getMetadata(IS_PUBLIC, handler) === true || classPublic,
      });
    }
  }
  return out;
}

/** route ที่ต้องล็อกอินแต่ไม่ได้ประกาศ permission และไม่อยู่ในรายการล็อกอินอย่างเดียว */
export const undeclared = (routes: RouteInfo[]) =>
  routes.filter((r) => !r.isPublic && !r.permission && !AUTH_ONLY[`${r.method} ${r.path}`]).map((r) => `${r.method} ${r.path}`);

/** controller ทดลองที่ลืมกำหนดสิทธิ์ — ใช้ยืนยันว่า test จับได้ */
@Controller("forgotten")
class ForgottenController {
  @Get()
  list() {
    return [];
  }
}

describe.skipIf(!hasDatabase)("authorization regression (spec platform-security)", () => {
  let app: INestApplication;
  let routes: RouteInfo[];
  const headers: Partial<Record<Role, Record<string, string>>> = {};

  beforeAll(async () => {
    app = await bootApp();
    // ไล่ controller จากทุกโมดูลที่ Nest โหลด (รวมโมดูลย่อย) ไม่ใช่เฉพาะที่ประกาศใน AppModule
    const controllers = [...app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()].map((w) => w.metatype as Type));
    routes = routesOf(controllers);
    const db = ownerDb();
    for (const role of ROLES) headers[role] = await authed(app, (await createUser(db, [role])).email);
    await db.$disconnect();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("พบ route ครบ และทุก route ที่ต้องล็อกอินประกาศ permission", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(undeclared(routes)).toEqual([]);
  });

  it("route ใหม่ที่ไม่ได้ประกาศ permission ทำให้ test ไม่ผ่านพร้อมชื่อ endpoint", () => {
    expect(undeclared([...routes, ...routesOf([ForgottenController])])).toEqual(["GET /forgotten"]);
  });

  it("ทุก route: role ที่ไม่มีสิทธิ์ได้ 403 และ role ที่มีสิทธิ์ไม่ได้ 403", async () => {
    const mismatches: string[] = [];
    const call = (r: RouteInfo, h: Record<string, string>) => {
      const path = r.path.replace(/:\w+/g, randomUUID());
      const agent = request(app.getHttpServer());
      const req = { GET: agent.get(path), POST: agent.post(path), PUT: agent.put(path), PATCH: agent.patch(path), DELETE: agent.delete(path) }[r.method as "GET"];
      return req.set(h).send(r.method === "GET" ? undefined : {});
    };
    for (const r of routes.filter((x) => x.permission)) {
      for (const role of ROLES) {
        const res = await call(r, headers[role]!);
        const allowed = can([role], r.permission!);
        if (allowed === (res.status === 403)) mismatches.push(`${r.method} ${r.path} (${r.permission}) ${role}: ${res.status}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("route ที่ไม่ได้ล็อกอินได้ 401 (ยกเว้น public)", async () => {
    const wrong: string[] = [];
    for (const r of routes.filter((x) => !x.isPublic)) {
      const path = r.path.replace(/:\w+/g, randomUUID());
      const agent = request(app.getHttpServer());
      const res = await { GET: agent.get(path), POST: agent.post(path), PUT: agent.put(path), PATCH: agent.patch(path), DELETE: agent.delete(path) }[r.method as "GET"];
      if (res.status !== 401) wrong.push(`${r.method} ${r.path}: ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });
});
