// Permission matrix ตาม spec user-access — แหล่งความจริงเดียวของทั้ง api และ worker
export const ROLES = ["AP_CLERK", "AP_LEAD", "FINANCE_EXEC", "SYS_ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "document.upload",
  "document.view",
  "document.view_file",
  "document.edit",
  "document.retry",
  "document.verify",
  "document.approve",
  "report.view",
  "audit.view_all",
  "user.manage",
  "settings.manage",
  "erp.configure",
  "apikey.manage",
  "sync.resend",
  /** ดูภาพรวมคิวและการส่งเข้า ERP (spec operations-monitoring) */
  "ops.view",
  /** ทะเบียนผู้ขาย (spec vendor-directory) */
  "vendor.view",
  /** ค้น system logs ของ api/worker (spec system-logs) */
  "logs.view",
] as const;
export type Action = (typeof ACTIONS)[number];

const CLERK: Action[] = [
  "document.upload",
  "document.view",
  "document.view_file",
  "document.edit",
  "document.retry",
  "document.verify",
  "vendor.view",
];

export const PERMISSIONS: Record<Role, readonly Action[]> = {
  AP_CLERK: CLERK,
  AP_LEAD: [...CLERK, "document.approve"],
  FINANCE_EXEC: ["document.view", "document.view_file", "report.view", "audit.view_all", "ops.view"],
  // ผู้ดูแลระบบไม่ได้สิทธิ์งานบัญชีโดยอัตโนมัติ (แยกหน้าที่)
  SYS_ADMIN: ["user.manage", "settings.manage", "erp.configure", "apikey.manage", "audit.view_all", "sync.resend", "ops.view", "logs.view"],
};

/** ผู้ใช้หลาย role ได้สิทธิ์รวมของทุก role */
export function can(roles: readonly Role[], action: Action): boolean {
  return roles.some((r) => PERMISSIONS[r].includes(action));
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
