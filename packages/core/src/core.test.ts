import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  DOCUMENT_STATUSES,
  FakeExtractionProvider,
  PERMISSIONS,
  REDACTED,
  ROLES,
  TRANSITIONS,
  TransitionError,
  assertTransition,
  can,
  canTransition,
  redact,
  type Action,
  type Actor,
  type DocumentStatus,
  type Role,
} from "./index.js";

const system: Actor = { kind: "system" };
const user = (...roles: Role[]): Actor => ({ kind: "user", userId: "u1", roles });

describe("state machine (spec document-lifecycle)", () => {
  it("มี 11 สถานะ", () => {
    expect(DOCUMENT_STATUSES).toHaveLength(11);
  });

  // ทุก transition ที่อนุญาต พร้อมผู้ทำที่ถูกต้อง
  it.each(TRANSITIONS.map((t) => [t.from, t.to, t.by] as const))("%s → %s ทำได้โดย %s", (from, to, by) => {
    const actor = by === "system" ? system : user(by[0]!);
    expect(() => assertTransition(from, to, actor, "เหตุผลทดสอบ")).not.toThrow();
  });

  it.each([
    ["EXTRACTED", "SYNCING"],
    ["UPLOADED", "EXTRACTED"],
    ["VERIFIED", "APPROVED"],
    ["FAILED", "EXTRACTED"],
    ["APPROVED", "SYNCED"],
  ] as [DocumentStatus, DocumentStatus][])("%s → %s ไม่อนุญาต", (from, to) => {
    expect(() => assertTransition(from, to, system)).toThrowError(expect.objectContaining({ code: "not_allowed" }));
  });

  it.each(["SYNCED", "REJECTED"] as DocumentStatus[])("ออกจากสถานะสิ้นสุด %s ไม่ได้", (from) => {
    expect(() => assertTransition(from, "SYNCING", system)).toThrowError(expect.objectContaining({ code: "terminal" }));
  });

  it("Clerk อนุมัติไม่ได้", () => {
    expect(() => assertTransition("PENDING_APPROVAL", "APPROVED", user("AP_CLERK"))).toThrowError(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("ผู้ใช้ทำ transition ของระบบไม่ได้ และระบบทำ transition ของคนไม่ได้", () => {
    expect(canTransition("UPLOADED", "PROCESSING", user("AP_LEAD"))).toBe(false);
    expect(canTransition("EXTRACTED", "VERIFIED", system)).toBe(false);
  });

  it("Admin ส่ง sync ใหม่ได้ แต่ Clerk ไม่ได้", () => {
    expect(canTransition("SYNC_FAILED", "SYNCING", user("SYS_ADMIN"))).toBe(true);
    expect(canTransition("SYNC_FAILED", "SYNCING", user("AP_CLERK"))).toBe(false);
  });

  it("ปฏิเสธต้องมีเหตุผล", () => {
    expect(() => assertTransition("PENDING_APPROVAL", "REJECTED", user("AP_LEAD"), "  ")).toThrowError(
      expect.objectContaining({ code: "reason_required" }),
    );
    expect(canTransition("PENDING_APPROVAL", "REJECTED", user("AP_LEAD"), "ยอดไม่ตรงใบสั่งซื้อ")).toBe(true);
  });

  it("error เป็น TransitionError พร้อม from/to", () => {
    try {
      assertTransition("EXTRACTED", "SYNCING", system);
    } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
      expect(e).toMatchObject({ from: "EXTRACTED", to: "SYNCING" });
    }
  });
});

describe("permission matrix (spec user-access)", () => {
  const expected: Record<Role, Action[]> = {
    AP_CLERK: ["document.upload", "document.view", "document.view_file", "document.edit", "document.retry", "document.verify"],
    AP_LEAD: [
      "document.upload",
      "document.view",
      "document.view_file",
      "document.edit",
      "document.retry",
      "document.verify",
      "document.approve",
    ],
    FINANCE_EXEC: ["document.view", "document.view_file", "report.view", "audit.view_all"],
    SYS_ADMIN: ["audit.view_all", "user.manage", "settings.manage", "erp.configure", "apikey.manage", "sync.resend"],
  };

  // ตาราง role × action ครบทุกช่อง
  for (const role of ROLES) {
    for (const action of ACTIONS) {
      const allowed = expected[role].includes(action);
      it(`${role} ${allowed ? "ทำได้" : "ทำไม่ได้"}: ${action}`, () => {
        expect(can([role], action)).toBe(allowed);
      });
    }
  }

  it("PERMISSIONS ตรงกับตารางที่คาดไว้", () => {
    for (const role of ROLES) expect([...PERMISSIONS[role]].sort()).toEqual([...expected[role]].sort());
  });

  it("หลาย role ได้สิทธิ์รวม", () => {
    expect(can(["AP_CLERK", "FINANCE_EXEC"], "report.view")).toBe(true);
    expect(can(["AP_CLERK", "FINANCE_EXEC"], "document.upload")).toBe(true);
  });

  it("ไม่มี role → ทำอะไรไม่ได้", () => {
    expect(ACTIONS.some((a) => can([], a))).toBe(false);
  });
});

describe("FakeExtractionProvider", () => {
  it("คืนผลรูปตรง type ความมั่นใจ 0", async () => {
    const r = await new FakeExtractionProvider().extract();
    expect(r.provider).toBe("fake");
    expect(r.confidence).toBe(0);
    expect(r.items).toEqual([]);
    expect(Object.values(r.header).every((f) => f.value === null && f.confidence === 0)).toBe(true);
  });
});

describe("redact (spec audit-trail)", () => {
  it("ตัด password/token/secret ทุกระดับ", () => {
    const out = redact({
      email: "a@b.com",
      password: "hunter2",
      nested: { accessToken: "abc", list: [{ apiKey: "k", ok: 1 }] },
      headers: { Authorization: "Bearer x" },
    });
    expect(out).toEqual({
      email: "a@b.com",
      password: REDACTED,
      nested: { accessToken: REDACTED, list: [{ apiKey: REDACTED, ok: 1 }] },
      headers: { Authorization: REDACTED },
    });
  });

  it("mask เลขบัตรประชาชนในข้อความ แต่คงเลขผู้เสียภาษีนิติบุคคล", () => {
    const out = redact({ note: "ผู้ติดต่อ 3-1012-34567-89-1 บริษัท 0105569012345" });
    expect(out.note).toBe("ผู้ติดต่อ xxxxxxxxxx891 บริษัท 0105569012345");
  });

  it("field ภาษีไม่ถูก mask แม้เป็นเลขบุคคล", () => {
    expect(redact({ vendorTaxId: "3101234567891" })).toEqual({ vendorTaxId: "3101234567891" });
  });

  it("mask เลขบัญชีธนาคาร เหลือ 4 ตัวท้าย", () => {
    expect(redact({ remark: "โอนเข้า 123-4-56789-0" }).remark).toBe("โอนเข้า xxxxxx7890");
    expect(redact({ bankAccount: "1234567890" })).toEqual({ bankAccount: "xxxxxx7890" });
  });

  it("ไม่แตะยอดเงินและค่าที่ไม่ใช่ string", () => {
    const input = { grand_total: "48,150.00", qty: 6, ok: true, at: new Date(0), nothing: null };
    expect(redact(input)).toEqual(input);
  });
});
