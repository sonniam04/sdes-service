import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
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

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        secret: cfg.auth.jwtSecret,
        signOptions: { expiresIn: cfg.auth.accessTtlSeconds, algorithm: "HS256" },
        verifyOptions: { algorithms: ["HS256"] },
      }),
    }),
  ],
  controllers: [HealthController, AuthController, UsersController, AuditController],
  providers: [
    { provide: HEALTH_CHECKS, useFactory: (cfg: AppConfig) => buildHealthChecks(cfg), inject: [APP_CONFIG] },
    AuditService,
    TokenService,
    AuthService,
    UsersService,
    // ลำดับสำคัญ: ยืนยันตัวตนก่อน แล้วจึงตรวจสิทธิ์
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule {}
