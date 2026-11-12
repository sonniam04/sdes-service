import { randomUUID } from "node:crypto";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import argon2 from "argon2";
import request from "supertest";
import type { Role } from "@sdes/core";
import { createPrisma, type PrismaClient } from "@sdes/db";
import { useTestDatabase, urls } from "./test-db.js";

useTestDatabase();

export const PASSWORD = "correct-horse-battery-staple";

/** override ใช้แทน provider บางตัว เช่น นาฬิกาของหน้าภาพรวม */
export async function bootApp(override?: (b: TestingModuleBuilder) => TestingModuleBuilder): Promise<INestApplication> {
  const { AppModule } = await import("../src/app.module.js");
  const { configureApp } = await import("../src/bootstrap.js");
  const builder = Test.createTestingModule({ imports: [AppModule] });
  const mod = await (override ? override(builder) : builder).compile();
  const app = configureApp(mod.createNestApplication());
  // listen ครั้งเดียว ให้ supertest ใช้ server เดียวกันได้แม้มีคำขอซ้อนกัน
  await app.listen(0, "127.0.0.1");
  return app;
}

/** client ฐานทดสอบในฐานะ owner — ใช้เตรียมข้อมูลและตรวจผล */
export function ownerDb(): PrismaClient {
  return createPrisma(urls!.owner);
}

export async function createUser(
  db: PrismaClient,
  roles: Role[],
  opts: { mustChangePassword?: boolean; isActive?: boolean; password?: string } = {},
) {
  const email = `u-${randomUUID()}@test.local`;
  const user = await db.user.create({
    data: {
      email,
      displayName: `ผู้ทดสอบ ${roles.join("+")}`,
      passwordHash: await argon2.hash(opts.password ?? PASSWORD, { type: argon2.argon2id }),
      mustChangePassword: opts.mustChangePassword ?? false,
      isActive: opts.isActive ?? true,
      roles: { create: roles.map((role) => ({ role })) },
    },
  });
  return { ...user, password: opts.password ?? PASSWORD };
}

export async function login(app: INestApplication, email: string, password = PASSWORD) {
  const res = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("sdes_rt="));
  return { res, token: res.body.accessToken as string | undefined, cookie };
}

/** login แล้วคืน header Authorization */
export async function authed(app: INestApplication, email: string, password = PASSWORD) {
  const { token } = await login(app, email, password);
  if (!token) throw new Error(`login ไม่สำเร็จ: ${email}`);
  return { Authorization: `Bearer ${token}` };
}
