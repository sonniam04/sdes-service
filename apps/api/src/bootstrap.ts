import { ValidationPipe, type INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { setupSwagger } from "./swagger.js";

/** ตั้งค่าที่ใช้ร่วมกันระหว่าง main.ts และ e2e test */
export function configureApp(app: INestApplication) {
  // หลัง reverse proxy (เช่น Next rewrite ใน production) ให้ req.ip เป็น IP จริงของผู้ใช้ — ใช้กับ rate limit และ audit
  const raw = process.env.TRUST_PROXY;
  if (raw) {
    // "true"/"false" = boolean, ตัวเลข = จำนวน hop, อื่น ๆ = รายการ subnet เช่น "loopback, uniquelocal"
    const value = raw === "true" ? true : raw === "false" ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set("trust proxy", value);
  }
  // security headers (spec platform-security) — CSP ปิดเพราะ API ตอบ JSON และ Swagger UI ใช้ inline script; CSP ของหน้าเว็บอยู่ใน sdes-web
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  setupSwagger(app);
  return app;
}
