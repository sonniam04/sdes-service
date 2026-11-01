// การคำนวณของรายงาน ใช้ร่วมกันระหว่าง /reports และ /dashboard (spec finance-reports, overview-dashboard design D2)
import { Inject, Injectable } from "@nestjs/common";
import { DOCUMENT_STATUSES } from "@sdes/core";
import { CONFIRMED_STATUSES, Prisma, type PrismaClient } from "@sdes/db";
import { PRISMA } from "../prisma.js";

export type Money = { subtotal: string; vat: string; wht: string; grandTotal: string };
type MonthRow = { month: string; documentCount: number } & Money;

// เงินคำนวณเป็น numeric ใน SQL แล้วจัดรูปเป็นสตริง 2 ตำแหน่ง (ไม่ผ่าน float)
const fmt = (expr: Prisma.Sql) => Prisma.sql`to_char(coalesce(${expr}, 0), 'FM999999999999990.00')`;
const counted = Prisma.sql`ARRAY[${Prisma.join(CONFIRMED_STATUSES.map((s) => Prisma.sql`${s}::"DocumentStatus"`))}]`;
const moneyCols = Prisma.sql`
  ${fmt(Prisma.sql`sum(coalesce(d.subtotal, 0) - coalesce(d.discount, 0))`)} AS subtotal,
  ${fmt(Prisma.sql`sum(d.vat_amount)`)} AS vat,
  ${fmt(Prisma.sql`sum(d.wht_amount)`)} AS wht,
  ${fmt(Prisma.sql`sum(d.grand_total)`)} AS "grandTotal"`;

/** ช่วงวันแบบ [start, end) เป็นวันที่ YYYY-MM-DD ตามเวลาไทย */
export type DateRange = { start: string; end: string };
export type Period = DateRange & { from: string; to: string };

/** เอกสารที่อัปโหลดในช่วง (เวลาไทย) — เทียบ created_at ตรง ๆ ให้ planner ใช้สถิติได้ */
export const uploadedIn = (p: DateRange) =>
  Prisma.sql`d.created_at >= (${p.start}::timestamp AT TIME ZONE 'Asia/Bangkok') AND d.created_at < (${p.end}::timestamp AT TIME ZONE 'Asia/Bangkok')`;

/** เอกสารที่นับได้ตามวันที่ในใบกำกับ — ชุดเดียวกับรายงานและทะเบียนผู้ขาย */
export const invoicedIn = (r: DateRange) =>
  Prisma.sql`d.status = ANY(${counted}) AND d.invoice_date >= ${r.start}::date AND d.invoice_date < ${r.end}::date`;

@Injectable()
export class ReportMetrics {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** ยอดรวมของเอกสารที่นับได้ ตามวันที่ในใบกำกับในช่วง */
  async totals(r: DateRange): Promise<{ documentCount: number } & Money> {
    const [row] = await this.prisma.$queryRaw<[{ documentCount: number } & Money]>`
      SELECT count(*)::int AS "documentCount", ${moneyCols} FROM documents d WHERE ${invoicedIn(r)}`;
    return row!;
  }

  async summary(p: Period) {
    const inPeriod = invoicedIn(p);
    const [months, totals, topVendors, process, statusRows] = await Promise.all([
      this.prisma.$queryRaw<MonthRow[]>`
        WITH agg AS (
          SELECT to_char(d.invoice_date, 'YYYY-MM') AS month, count(*)::int AS n, ${moneyCols}
          FROM documents d WHERE ${inPeriod} GROUP BY 1)
        SELECT to_char(m, 'YYYY-MM') AS month, coalesce(agg.n, 0) AS "documentCount",
               coalesce(agg.subtotal, '0.00') AS subtotal, coalesce(agg.vat, '0.00') AS vat,
               coalesce(agg.wht, '0.00') AS wht, coalesce(agg."grandTotal", '0.00') AS "grandTotal"
        FROM generate_series(${p.start}::date, (${p.end}::date - interval '1 month'), interval '1 month') m
        LEFT JOIN agg ON agg.month = to_char(m, 'YYYY-MM')
        ORDER BY m`,
      this.totals(p),
      this.prisma.$queryRaw<{ vendorId: string; name: string; taxId: string; branchCode: string; documentCount: number; grandTotal: string }[]>`
        SELECT v.id AS "vendorId", v.name, v.tax_id AS "taxId", v.branch_code AS "branchCode", count(*)::int AS "documentCount",
               ${fmt(Prisma.sql`sum(d.grand_total)`)} AS "grandTotal"
        FROM documents d JOIN vendors v ON v.id = d.vendor_id
        WHERE ${inPeriod}
        GROUP BY v.id ORDER BY sum(d.grand_total) DESC NULLS LAST, v.name LIMIT 10`,
      this.process(p),
      this.prisma.$queryRaw<{ status: string; n: number }[]>`
        SELECT d.status::text AS status, count(*)::int AS n FROM documents d
        WHERE ${uploadedIn(p)}
        GROUP BY 1`,
    ]);
    const statusCounts = Object.fromEntries(DOCUMENT_STATUSES.map((s) => [s, 0]));
    for (const r of statusRows) statusCounts[r.status] = r.n;
    return { period: { from: p.from, to: p.to }, months, totals, topVendors, process: { ...process, statusCounts } };
  }

  /**
   * ตัวชี้วัดตามวันที่อัปโหลด (เวลาไทย): เวลาเฉลี่ยแต่ละขั้นจากประวัติสถานะ, สัดส่วนที่ต้องอนุมัติ และที่ไม่ต้องแก้ค่าที่ AI อ่าน
   * join + group by ครั้งเดียว (subquery ต่อเอกสารช้าเกิน 1 วินาทีที่ 42,000 ฉบับ — task 4.4)
   */
  async process(p: DateRange) {
    const [r] = await this.prisma.$queryRaw<
      [{ uploaded: number; toExtracted: number | null; toVerified: number | null; toSynced: number | null; confirmed: number; approvals: number; noEdit: number }]
    >`
      SELECT count(*)::int AS uploaded,
             avg(extract(epoch FROM x.ex - x.created_at))::float8 AS "toExtracted",
             avg(extract(epoch FROM x.ve - x.ex))::float8 AS "toVerified",
             avg(extract(epoch FROM x.sy - x.ve))::float8 AS "toSynced",
             count(*) FILTER (WHERE x.ve IS NOT NULL)::int AS confirmed,
             count(*) FILTER (WHERE x.ve IS NOT NULL AND x.pa)::int AS approvals,
             count(*) FILTER (WHERE x.ve IS NOT NULL AND e.entity_id IS NULL)::int AS "noEdit"
      FROM (
        SELECT d.id, d.created_at,
               min(h.created_at) FILTER (WHERE h.to_status = 'EXTRACTED') AS ex,
               min(h.created_at) FILTER (WHERE h.to_status = 'VERIFIED') AS ve,
               min(h.created_at) FILTER (WHERE h.to_status = 'SYNCED') AS sy,
               coalesce(bool_or(h.to_status = 'PENDING_APPROVAL'), false) AS pa
        FROM documents d LEFT JOIN document_status_history h ON h.document_id = d.id
        WHERE ${uploadedIn(p)}
        GROUP BY d.id, d.created_at) x
      LEFT JOIN (SELECT DISTINCT entity_id FROM audit_events WHERE action = 'document.field_edited' AND entity_type = 'document') e
        ON e.entity_id = x.id::text`;
    const round = (n: number | null) => (n === null ? null : Math.round(n));
    return {
      uploaded: r.uploaded,
      avgSeconds: { toExtracted: round(r.toExtracted), toVerified: round(r.toVerified), toSynced: round(r.toSynced) },
      approvalRate: r.confirmed ? r.approvals / r.confirmed : null,
      noEditRate: r.confirmed ? r.noEdit / r.confirmed : null,
    };
  }
}
