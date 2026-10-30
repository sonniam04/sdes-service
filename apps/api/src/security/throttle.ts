// จำกัดอัตราการเรียก (spec platform-security "Rate limiting", design D9) — นับใน Redis จึงใช้ได้กับหลาย instance
import { HttpException, HttpStatus, Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail, type ThrottlerStorage } from "@nestjs/throttler";
import type { Response } from "express";
import type Redis from "ioredis";

export const THROTTLE_AUTH = "auth";
export const THROTTLE_UPLOAD = "upload";

/** fixed window ต่อ key: INCR + PEXPIRE ครั้งแรก — เกิน limit = ถูกบล็อกจนหมดช่วงเวลา */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, _blockDuration: number, throttlerName: string) {
    const k = `throttle:${throttlerName}:${key}`;
    const [[, hits], [, pttl]] = (await this.redis.multi().incr(k).pttl(k).exec()) as [[null, number], [null, number]];
    let remaining = pttl;
    if (pttl < 0) {
      await this.redis.pexpire(k, ttl);
      remaining = ttl;
    }
    const seconds = Math.ceil(remaining / 1000);
    return { totalHits: hits, timeToExpire: seconds, isBlocked: hits > limit, timeToBlockExpire: hits > limit ? seconds : 0 };
  }
}

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  /** หลังล็อกอิน (เช่น อัปโหลด) นับต่อผู้ใช้; ก่อนล็อกอินนับต่อ IP */
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { userId?: string } | undefined;
    return user?.userId ? `user:${user.userId}` : `ip:${String(req.ip)}`;
  }

  protected override async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    // header มาตรฐาน (throttler ตั้งชื่อตาม throttler เช่น Retry-After-auth)
    context.switchToHttp().getResponse<Response>().setHeader("Retry-After", String(Math.max(1, detail.timeToBlockExpire || detail.timeToExpire)));
    throw new HttpException({ code: "RATE_LIMITED", message: "ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
