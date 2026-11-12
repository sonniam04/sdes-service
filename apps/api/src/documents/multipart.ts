import { BadRequestException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import busboy from "busboy";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 50;

export type IncomingFile = {
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  /** ไฟล์ใหญ่เกินจึงถูกตัด — ต้องปฏิเสธ */
  truncated: boolean;
  head: Buffer;
};

/**
 * รับ multipart แบบ stream ลงดิสก์ชั่วคราว (ไม่เก็บทั้งไฟล์ใน memory) พร้อมคำนวณ SHA-256
 * ไฟล์ที่เกิน 20 MB ถูกตัดและทำเครื่องหมาย แต่ไฟล์อื่นในชุดยังรับต่อได้
 */
export async function receiveFiles(req: Request): Promise<{ files: IncomingFile[]; dir: string; tooMany: boolean }> {
  // ไม่ใช่ multipart = คำขอผิดรูปแบบ (400) ไม่ใช่ข้อผิดพลาดของระบบ
  if (!/^multipart\/form-data/i.test(req.headers["content-type"] ?? ""))
    throw new BadRequestException({ code: "NOT_MULTIPART", message: "ต้องส่งไฟล์แบบ multipart/form-data ในช่อง files" });
  const dir = await mkdtemp(join(tmpdir(), "sdes-upload-"));
  const files: IncomingFile[] = [];
  let tooMany = false;

  await new Promise<void>((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES }, defParamCharset: "utf8" });
    const writes: Promise<void>[] = [];

    bb.on("file", (_field, stream, info) => {
      const path = join(dir, randomUUID());
      const hash = createHash("sha256");
      const out = createWriteStream(path);
      let size = 0;
      let head = Buffer.alloc(0);
      const entry: IncomingFile = { fileName: info.filename || "unnamed", path, sizeBytes: 0, sha256: "", truncated: false, head };
      files.push(entry); // คงลำดับตามที่ผู้ใช้ส่งมา
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
      });
      stream.on("limit", () => (entry.truncated = true));
      stream.pipe(out);
      writes.push(
        new Promise((done, fail) => {
          out.on("finish", () => {
            Object.assign(entry, { sizeBytes: size, sha256: hash.digest("hex"), head });
            done();
          });
          out.on("error", fail);
        }),
      );
    });
    bb.on("filesLimit", () => (tooMany = true));
    bb.on("error", reject);
    bb.on("close", () => Promise.all(writes).then(() => resolve(), reject));
    req.pipe(bb);
  });

  return { files, dir, tooMany };
}

export const cleanup = (dir: string) => rm(dir, { recursive: true, force: true });
