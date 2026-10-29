import { ValidationPipe, type INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { setupSwagger } from "./swagger.js";

/** ตั้งค่าที่ใช้ร่วมกันระหว่าง main.ts และ e2e test */
export function configureApp(app: INestApplication) {
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  setupSwagger(app);
  return app;
}
