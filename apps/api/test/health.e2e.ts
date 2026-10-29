import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { HEALTH_CHECKS, type HealthCheck } from "../src/health/checks.js";
import { APP_CONFIG } from "../src/config.js";
import { setupSwagger } from "../src/swagger.js";

async function boot(checks: HealthCheck[]) {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue({})
    .overrideProvider(HEALTH_CHECKS)
    .useValue(checks)
    .compile();
  const app = mod.createNestApplication();
  setupSwagger(app);
  await app.init();
  return app;
}

const ok = (name: string): HealthCheck => ({ name, check: async () => {} });
const down = (name: string): HealthCheck => ({ name, check: () => Promise.reject(new Error(`${name} ล่ม`)) });

describe("GET /health", () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("ทุกบริการพร้อม → 200", async () => {
    app = await boot([ok("database"), ok("redis"), ok("storage"), ok("virus-scanner")]);
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks).toHaveLength(4);
  });

  it("มีบริการล่ม → 503 และบอกว่าตัวไหน", async () => {
    app = await boot([ok("database"), down("virus-scanner")]);
    const res = await request(app.getHttpServer()).get("/health").expect(503);
    expect(res.body.checks.find((c: { name: string }) => c.name === "virus-scanner")).toMatchObject({ ok: false });
  });

  it("Swagger JSON มี path /health", async () => {
    app = await boot([ok("database")]);
    const res = await request(app.getHttpServer()).get("/docs-json").expect(200);
    expect(Object.keys(res.body.paths)).toContain("/health");
  });
});
