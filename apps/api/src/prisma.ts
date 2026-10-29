import { Global, Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { createPrisma, type PrismaClient } from "@sdes/db";
import { APP_CONFIG, type AppConfig } from "./config.js";

export const PRISMA = Symbol("PRISMA");
/** client ภายใน $transaction */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

@Injectable()
class PrismaLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}
  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }
}

/** แอปเชื่อมต่อด้วย role sdes_app (DATABASE_URL) ไม่ใช่ owner */
@Global()
@Module({
  providers: [
    { provide: PRISMA, useFactory: (cfg: AppConfig) => createPrisma(cfg.databaseUrl), inject: [APP_CONFIG] },
    PrismaLifecycle,
  ],
  exports: [PRISMA],
})
export class PrismaModule {}
