import { describe, expect, it } from "vitest";
import { withConnectionLimit } from "./pool.js";

describe("connection pool ของ Prisma (design D5)", () => {
  it("เติม connection_limit เมื่อ URL ยังไม่มี", () => {
    expect(withConnectionLimit("postgresql://sdes_app:pw@postgres:5432/sdes", 10)).toBe("postgresql://sdes_app:pw@postgres:5432/sdes?connection_limit=10");
  });

  it("คง query เดิมไว้และไม่ทับค่าที่ผู้ดูแลตั้งเอง", () => {
    expect(withConnectionLimit("postgresql://u:p@h/db?schema=public", 5)).toBe("postgresql://u:p@h/db?schema=public&connection_limit=5");
    expect(withConnectionLimit("postgresql://u:p@h/db?connection_limit=3", 5)).toBe("postgresql://u:p@h/db?connection_limit=3");
  });

  it("รหัสผ่านที่มีอักขระพิเศษไม่ถูกแปลง", () => {
    const url = "postgresql://u:a%2Fb%40c@h:5432/db";
    expect(withConnectionLimit(url, 10)).toBe(`${url}?connection_limit=10`);
  });
});
