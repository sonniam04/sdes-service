// ทะเบียนผู้ขาย — อ่านอย่างเดียว (spec vendor-directory, design D5)
import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { CONFIRMED_STATUSES, ESTABLISHED_VENDOR_STATUSES, Prisma, type PrismaClient } from "@sdes/db";
import { RequirePermission } from "../auth/decorators.js";
import { PRISMA } from "../prisma.js";

class VendorQuery {
  /** ตัวเลข = Tax ID แบบขึ้นต้น, อื่น ๆ = ชื่อบางส่วน */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

type VendorRow = {
  id: string;
  name: string;
  taxId: string;
  branchCode: string;
  erpPartnerId: string | null;
  documentCount: number;
  totalAmount: string;
  lastInvoiceDate: string | null;
  isNew: boolean;
  total?: bigint;
};

// ยอดรวมนับเฉพาะเอกสารที่ยืนยันแล้วขึ้นไป (ไม่รวมที่ถูกปฏิเสธ) — ชุดสถานะเดียวกับรายงาน
const counted = Prisma.sql`ARRAY[${Prisma.join(CONFIRMED_STATUSES.map((s) => Prisma.sql`${s}::"DocumentStatus"`))}]`;
// ผู้ขายรายใหม่ = นิยามเดียวกับเหตุผลความเสี่ยง NEW_VENDOR
const established = Prisma.sql`ARRAY[${Prisma.join(ESTABLISHED_VENDOR_STATUSES.map((s) => Prisma.sql`${s}::"DocumentStatus"`))}]`;

const select = Prisma.sql`
  SELECT v.id, v.name, v.tax_id AS "taxId", v.branch_code AS "branchCode", v.erp_partner_id AS "erpPartnerId",
         count(d.id)::int AS "documentCount",
         to_char(coalesce(sum(d.grand_total) FILTER (WHERE d.status = ANY(${counted})), 0), 'FM999999999999990.00') AS "totalAmount",
         to_char(max(d.invoice_date), 'YYYY-MM-DD') AS "lastInvoiceDate",
         NOT coalesce(bool_or(d.status = ANY(${established})), false) AS "isNew"
  FROM vendors v LEFT JOIN documents d ON d.vendor_id = v.id`;

@ApiTags("vendors")
@ApiBearerAuth()
@RequirePermission("vendor.view")
@Controller("vendors")
export class VendorsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  async list(@Query() q: VendorQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const term = q.q?.trim() ?? "";
    const where = !term
      ? Prisma.empty
      : /^\d+$/.test(term)
        ? Prisma.sql`WHERE v.tax_id LIKE ${`${term}%`}`
        : Prisma.sql`WHERE v.name ILIKE ${`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`;
    const rows = await this.prisma.$queryRaw<VendorRow[]>`
      ${select} ${where}
      GROUP BY v.id
      ORDER BY max(d.created_at) DESC NULLS LAST, v.name, v.branch_code
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const [{ n }] = await this.prisma.$queryRaw<[{ n: number }]>`SELECT count(*)::int AS n FROM vendors v ${where}`;
    return { items: rows, total: n, page, pageSize };
  }

  @Get(":id")
  async detail(@Param("id", ParseUUIDPipe) id: string) {
    const [vendor] = await this.prisma.$queryRaw<VendorRow[]>`${select} WHERE v.id = ${id}::uuid GROUP BY v.id`;
    if (!vendor) throw new NotFoundException("ไม่พบผู้ขาย");
    const docs = await this.prisma.document.findMany({
      where: { vendorId: id },
      orderBy: [{ invoiceDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 100,
      select: { id: true, docNo: true, invoiceNo: true, invoiceDate: true, grandTotal: true, status: true, createdAt: true },
    });
    return {
      vendor,
      documents: docs.map((d) => ({
        ...d,
        invoiceDate: d.invoiceDate?.toISOString().slice(0, 10) ?? null,
        grandTotal: d.grandTotal?.toFixed(2) ?? null,
      })),
    };
  }
}
