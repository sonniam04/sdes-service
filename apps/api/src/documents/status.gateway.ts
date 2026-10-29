import { Inject, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection } from "@nestjs/websockets";
import Redis from "ioredis";
import type { Server, Socket } from "socket.io";
import { can, isRole, STATUS_CHANNEL } from "@sdes/core";
import { APP_CONFIG, type AppConfig } from "../config.js";

const ROOM = "documents";

/**
 * ส่งการเปลี่ยนสถานะเอกสารแบบ real-time ผ่าน socket.io
 * api และ worker publish ลง Redis → gateway ทุก instance รับแล้วส่งต่อให้ client
 */
@WebSocketGateway({ path: "/ws", cors: { origin: true, credentials: true } })
export class StatusGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger(StatusGateway.name);
  private sub?: Redis;

  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async onModuleInit() {
    this.sub = new Redis(this.cfg.redisUrl);
    await this.sub.subscribe(STATUS_CHANNEL);
    this.sub.on("message", (_ch, raw) => {
      try {
        this.server?.to(ROOM).emit("document.status", JSON.parse(raw));
      } catch (e) {
        this.log.warn(`ข้อความสถานะไม่ถูกต้อง: ${e}`);
      }
    });
  }

  onModuleDestroy() {
    this.sub?.disconnect();
  }

  /** ต้องส่ง access token ใน handshake.auth.token และมีสิทธิ์ดูเอกสาร */
  async handleConnection(client: Socket) {
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; roles: string[]; pwc: boolean }>(String(client.handshake.auth?.token ?? ""));
      if (claims.pwc || !can(claims.roles.filter(isRole), "document.view")) throw new Error("forbidden");
      await client.join(ROOM);
      client.emit("ready", { serverTime: new Date().toISOString() });
    } catch {
      client.emit("unauthorized", { message: "กรุณาเข้าสู่ระบบใหม่" });
      client.disconnect(true);
    }
  }
}
