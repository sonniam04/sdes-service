// ขนาด connection pool ของ Prisma ต่อ client (design D5: api 10, worker 5) — PostgreSQL production ตั้ง max_connections=50
// ต่อท้ายเป็น query string แทนการ parse URL ใหม่ เพื่อไม่แตะรหัสผ่านที่ encode ไว้; ค่าที่ตั้งใน URL อยู่แล้วชนะ
export function withConnectionLimit(url: string, limit: number): string {
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${limit}`;
}
