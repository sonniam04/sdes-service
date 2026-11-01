import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";
import Redis from "ioredis";
import { AppThrottlerGuard, RedisThrottlerStorage, THROTTLE_AUTH, THROTTLE_UPLOAD } from "./security/throttle.js";
import { APP_CONFIG, type AppConfig } from "./config.js";
import { ConfigModule } from "./config.module.js";
import { PrismaModule } from "./prisma.js";
import { HealthController } from "./health/health.controller.js";
import { buildHealthChecks, HEALTH_CHECKS } from "./health/checks.js";
import { AuditService } from "./audit/audit.service.js";
import { AuditController } from "./audit/audit.controller.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { AuthGuard, PermissionGuard } from "./auth/guards.js";
import { TokenService } from "./auth/tokens.js";
import { UsersController } from "./users/users.controller.js";
import { UsersService } from "./users/users.service.js";
import { DocumentsController } from "./documents/documents.controller.js";
import { DocumentsService } from "./documents/documents.service.js";
import { QueueService } from "./documents/queue.service.js";
import { ScannerService } from "./documents/scanner.service.js";
import { StatusGateway } from "./documents/status.gateway.js";
import { StorageService } from "./documents/storage.service.js";
import { ReviewService } from "./documents/review.service.js";
import { SettingsController } from "./settings/settings.controller.js";
import { ErpController } from "./erp/erp.controller.js";
import { OpsController } from "./erp/ops.controller.js";
import { OpsService } from "./erp/ops.service.js";
import { ErpService } from "./erp/erp.service.js";
import { ApiKeysController } from "./api-keys/api-keys.controller.js";
import { ApiKeysService } from "./api-keys/api-keys.service.js";
import { SystemLogsController } from "./system-logs/system-logs.controller.js";
import { VendorsController } from "./vendors/vendors.controller.js";
import { ReportMetrics } from "./reports/report-metrics.js";
import { ReportsController } from "./reports/reports.controller.js";

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        throttlers: [
          { name: THROTTLE_AUTH, ttl: 60_000, limit: cfg.rateLimit.authPerMinute },
          { name: THROTTLE_UPLOAD, ttl: 60_000, limit: cfg.rateLimit.uploadPerMinute },
        ],
        storage: new RedisThrottlerStorage(new Redis(cfg.redisUrl)),
      }),
    }),
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        secret: cfg.auth.jwtSecret,
        signOptions: { expiresIn: cfg.auth.accessTtlSeconds, algorithm: "HS256" },
        verifyOptions: { algorithms: ["HS256"] },
      }),
    }),
  ],
  controllers: [HealthController, AuthController, UsersController, AuditController, DocumentsController, SettingsController, ErpController, OpsController, ApiKeysController, SystemLogsController, VendorsController, ReportsController],
  providers: [
    { provide: HEALTH_CHECKS, useFactory: (cfg: AppConfig) => buildHealthChecks(cfg), inject: [APP_CONFIG] },
    AuditService,
    ReviewService,
    ErpService,
    ApiKeysService,
    AppThrottlerGuard,
    TokenService,
    AuthService,
    UsersService,
    ScannerService,
    StorageService,
    QueueService,
    ReportMetrics,
    OpsService,
    DocumentsService,
    StatusGateway,
    // ลำดับสำคัญ: ยืนยันตัวตนก่อน แล้วจึงตรวจสิทธิ์
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule {}
