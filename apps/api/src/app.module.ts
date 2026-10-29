import { Module } from "@nestjs/common";
import { APP_CONFIG, loadConfig, type AppConfig } from "./config.js";
import { HealthController } from "./health/health.controller.js";
import { buildHealthChecks, HEALTH_CHECKS } from "./health/checks.js";

@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useFactory: loadConfig },
    { provide: HEALTH_CHECKS, useFactory: (cfg: AppConfig) => buildHealthChecks(cfg), inject: [APP_CONFIG] },
  ],
})
export class AppModule {}
