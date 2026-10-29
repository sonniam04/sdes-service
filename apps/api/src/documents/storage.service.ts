import { createReadStream } from "node:fs";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { APP_CONFIG, type AppConfig } from "../config.js";

export const FILE_URL_TTL_SECONDS = 5 * 60;

/** เก็บไฟล์ต้นฉบับใน S3 — เขียนครั้งเดียว ไม่เขียนทับ, เปิดอ่านผ่าน presigned URL อายุ 5 นาที */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private readonly s3: S3Client;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.s3 = new S3Client({
      endpoint: cfg.s3.endpoint,
      region: cfg.s3.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
    });
  }

  async onModuleInit() {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.cfg.s3.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.cfg.s3.bucket })).catch((e) => {
        this.log.warn(`สร้าง bucket ${this.cfg.s3.bucket} ไม่ได้: ${e instanceof Error ? e.message : e}`);
      });
    }
  }

  async putOriginal(key: string, path: string, contentType: string, sizeBytes: number, sha256: string) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.cfg.s3.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: sizeBytes,
        ContentType: contentType,
        // เข้ารหัสขณะจัดเก็บ (AES-256) — บังคับใน production ผ่าน S3_SSE=true
        ServerSideEncryption: this.cfg.s3.sse ? "AES256" : undefined,
        // ป้องกันการเขียนทับต้นฉบับเดิม
        IfNoneMatch: "*",
        Metadata: { sha256 },
      }),
    );
  }

  /** อ่านไฟล์ต้นฉบับทั้งไฟล์ (ไม่เกิน 20 MB) — ใช้ส่งให้ตัวแสดงเอกสารผ่าน API */
  async getOriginal(key: string): Promise<Buffer> {
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.s3.bucket, Key: key }));
    return Buffer.from(await obj.Body!.transformToByteArray());
  }

  fileUrl(key: string, fileName: string) {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.cfg.s3.bucket,
        Key: key,
        ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      }),
      { expiresIn: FILE_URL_TTL_SECONDS },
    );
  }
}
