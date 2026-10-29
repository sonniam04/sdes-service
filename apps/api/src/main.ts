import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";
import { setupSwagger } from "./swagger.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  setupSwagger(app);
  await app.listen(loadConfig().port);
}
void bootstrap();
