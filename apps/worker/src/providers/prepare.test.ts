import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ExtractionError } from "./errors.js";
import { isPasswordProtectedPdf, prepareInput } from "./prepare.js";

const page = (background: string, width = 40, height = 60) =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

const PLAIN_PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
const LOCKED_PDF = Buffer.from(
  "%PDF-1.6\n1 0 obj << /Type /Catalog >> endobj\n5 0 obj << /Filter /Standard /V 4 >> endobj\ntrailer << /Root 1 0 R /Encrypt 5 0 R /ID [<00><00>] >>\n%%EOF\n",
  "latin1",
);

describe("prepareInput (task 3.2)", () => {
  it("TIFF 3 หน้าได้ภาพ PNG 3 ภาพตามลำดับ", async () => {
    const tiff = await sharp(await Promise.all([page("#f00"), page("#0f0"), page("#00f")]), { join: { animated: true } })
      .tiff()
      .toBuffer();
    const r = await prepareInput(tiff, "image/tiff");
    expect(r.kind).toBe("images");
    if (r.kind !== "images") return;
    expect(r.pages).toHaveLength(3);
    // สีหลัก (ช่องที่สว่างที่สุด) ของแต่ละหน้า — ค่าอาจคลาดได้เล็กน้อยจากการบีบอัด
    const dominant = async (buf: Buffer) => {
      const [r, g, b] = (await sharp(buf).raw().toBuffer()).subarray(0, 3);
      return ["red", "green", "blue"][[r!, g!, b!].indexOf(Math.max(r!, g!, b!))];
    };
    expect(await Promise.all(r.pages.map((p) => dominant(p.data)))).toEqual(["red", "green", "blue"]);
    expect(r.pages.every((p) => p.mediaType === "image/png")).toBe(true);
  });

  it("PDF ที่ล็อกรหัสผ่านเป็นข้อผิดพลาดถาวรพร้อมข้อความ", async () => {
    const err = await prepareInput(LOCKED_PDF, "application/pdf").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err).toMatchObject({ permanent: true, message: "ไฟล์ PDF ถูกล็อกด้วยรหัสผ่าน" });
  });

  it("PDF ปกติส่งทั้งไฟล์", async () => {
    expect(isPasswordProtectedPdf(PLAIN_PDF)).toBe(false);
    expect(await prepareInput(PLAIN_PDF, "application/pdf")).toEqual({ kind: "pdf", data: PLAIN_PDF });
  });

  it("ภาพเล็กส่งตามเดิม ภาพใหญ่ถูกย่อ", async () => {
    const small = await page("#fff");
    const r1 = await prepareInput(small, "image/png");
    expect(r1).toEqual({ kind: "images", pages: [{ mediaType: "image/png", data: small }] });

    const big = await sharp({ create: { width: 5000, height: 3000, channels: 3, background: "#eee" } }).jpeg().toBuffer();
    const r2 = await prepareInput(big, "image/jpeg");
    if (r2.kind !== "images") throw new Error("expected images");
    const meta = await sharp(r2.pages[0]!.data).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(2400);
  });

  it("ไฟล์ภาพเสียเป็นข้อผิดพลาดถาวร", async () => {
    await expect(prepareInput(Buffer.from("not an image"), "image/png")).rejects.toMatchObject({ permanent: true });
    await expect(prepareInput(Buffer.from("not a tiff"), "image/tiff")).rejects.toMatchObject({ permanent: true });
  });
});
