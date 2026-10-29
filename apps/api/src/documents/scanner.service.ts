import { createReadStream } from "node:fs";
import { connect } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config.js";

export class ScannerUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`ตัวสแกนไวรัสไม่พร้อม: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ScannerUnavailableError";
  }
}

export type ScanResult = { clean: true } | { clean: false; signature: string };

const TIMEOUT_MS = 30_000;

/**
 * สแกนไฟล์ด้วย clamd ผ่านคำสั่ง zINSTREAM
 * fail closed: ถ้าเชื่อมต่อไม่ได้, หมดเวลา หรือได้คำตอบแปลก → ScannerUnavailableError (ห้ามข้ามการสแกน)
 */
@Injectable()
export class ScannerService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  scanFile(path: string): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const fail = (e: unknown) => {
        sock.destroy();
        reject(new ScannerUnavailableError(e));
      };
      const sock = connect(this.cfg.clamd.port, this.cfg.clamd.host);
      sock.setTimeout(TIMEOUT_MS, () => fail(new Error("หมดเวลา")));
      let reply = "";
      sock.on("error", fail);
      sock.on("data", (d) => (reply += d.toString()));
      sock.on("end", () => {
        const text = reply.replace(/\0/g, "").trim();
        const found = /^stream: (.+) FOUND$/.exec(text);
        if (text === "stream: OK") resolve({ clean: true });
        else if (found) resolve({ clean: false, signature: found[1]! });
        else fail(new Error(`คำตอบไม่รู้จัก: ${text}`));
      });
      sock.on("connect", () => {
        sock.write("zINSTREAM\0");
        const file = createReadStream(path, { highWaterMark: 64 * 1024 });
        file.on("data", (chunk) => {
          const buf = chunk as Buffer;
          const len = Buffer.alloc(4);
          len.writeUInt32BE(buf.length);
          sock.write(len);
          sock.write(buf);
        });
        file.on("end", () => sock.write(Buffer.alloc(4)));
        file.on("error", fail);
      });
    });
  }
}
