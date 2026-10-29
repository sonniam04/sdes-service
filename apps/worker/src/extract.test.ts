import { describe, expect, it } from "vitest";
import { createProvider } from "./extract.js";

describe("createProvider (task 3.4)", () => {
  it("fake เป็นค่าเริ่มต้นที่ไม่ต้องตั้งค่าอะไร", () => {
    expect(createProvider("fake").name).toBe("fake");
  });

  it("fixture ต้องมีโฟลเดอร์เฉลย", () => {
    expect(() => createProvider("fixture")).toThrow(/EXTRACTION_FIXTURE_DIR/);
    expect(createProvider("fixture", { fixtureDir: "/tmp/x" }).name).toBe("fixture");
  });

  it("claude ไม่มี ANTHROPIC_API_KEY → worker หยุดพร้อมข้อความชัดเจน", () => {
    expect(() => createProvider("claude", {})).toThrow("EXTRACTION_PROVIDER=claude ต้องตั้ง ANTHROPIC_API_KEY ใน .env");
  });

  it("claude มี key → สร้าง provider ได้", () => {
    expect(createProvider("claude", { anthropicApiKey: "sk-test", model: "claude-opus-5-5" }).name).toBe("claude");
  });

  it("ชื่อที่ไม่รู้จักบอกตัวเลือกที่ใช้ได้", () => {
    expect(() => createProvider("gpt")).toThrow(/fake, fixture, claude/);
  });
});
