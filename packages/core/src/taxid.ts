// เลขประจำตัวผู้เสียภาษี 13 หลัก (สูตร mod 11) และรหัสสาขา 5 หลัก — spec invoice-validation "Tax ID format"

/** ตัดขีดและช่องว่างที่มักพิมพ์คั่นไว้ เช่น "0-1055-36000-01-3" */
export function normalizeTaxId(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** หลักที่ 13 = (11 − (Σ หลักที่ i × (14 − i)) mod 11) mod 10 สำหรับ i = 1..12 */
export function isValidTaxId(raw: string): boolean {
  const id = normalizeTaxId(raw);
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

/** รหัสสาขา 5 หลัก; "00000" คือสำนักงานใหญ่ */
export function isValidBranchCode(raw: string): boolean {
  return /^\d{5}$/.test(raw.trim());
}

export const HEAD_OFFICE_BRANCH = "00000";
