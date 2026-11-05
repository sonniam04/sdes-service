#!/bin/sh
# สร้างไฟล์ค่าตั้ง production ด้วยค่าสุ่ม (design D6) — รันบนเครื่อง production ครั้งเดียว
#   sh deploy/init-env.sh [ไฟล์ปลายทาง]                  (ค่าเริ่มต้น /opt/sdes/.env.production)
# ถามค่าที่สุ่มไม่ได้ทีละข้อ หรือส่งมาทาง environment เพื่อรันแบบไม่โต้ตอบ:
#   SDES_DOMAIN SEED_ADMIN_EMAIL COMPANY_TAX_ID COMPANY_NAME EXTRACTION_PROVIDER GEMINI_API_KEY ANTHROPIC_API_KEY
# ไม่เขียนทับไฟล์เดิม · ไฟล์ mode 600 · ไม่พิมพ์ค่า secret ออกหน้าจอ
set -eu
OUT="${1:-/opt/sdes/.env.production}"

if [ -e "$OUT" ]; then
  echo "มีไฟล์ค่าตั้งอยู่แล้ว: $OUT — ไม่เขียนทับ (ลบเองก่อนถ้าต้องการสร้างใหม่ แต่ค่าเดิมของฐานข้อมูลจะใช้ไม่ได้)" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "ต้องมี openssl" >&2; exit 1; }

# ค่าสุ่มแบบ URL-safe (ใช้ใน URL ของฐานข้อมูล/Redis ได้โดยไม่ต้อง encode)
rand() { openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'; }

ask() { # ask <ชื่อ> <คำถาม> [ค่าเริ่มต้น]
  eval "cur=\${$1:-}"
  if [ -z "$cur" ] && [ -t 0 ]; then
    printf '%s%s: ' "$2" "${3:+ [$3]}" >&2
    read -r cur
  fi
  [ -n "$cur" ] || cur="${3:-}"
  eval "$1=\$cur"
}

ask SDES_DOMAIN "โดเมนของระบบ (เช่น sdes-demo.duckdns.org)"
ask SEED_ADMIN_EMAIL "อีเมลของ System Admin คนแรก"
ask COMPANY_TAX_ID "เลขประจำตัวผู้เสียภาษีของบริษัท (เว้นว่างได้ แก้ภายหลังในหน้าตั้งค่า)" ""
ask COMPANY_NAME "ชื่อบริษัท (เว้นว่างได้)" ""
ask EXTRACTION_PROVIDER "การอ่านเอกสาร fake | gemini | claude" "fake"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
[ "$EXTRACTION_PROVIDER" = "gemini" ] && ask GEMINI_API_KEY "GEMINI_API_KEY"
[ "$EXTRACTION_PROVIDER" = "claude" ] && ask ANTHROPIC_API_KEY "ANTHROPIC_API_KEY"

for v in SDES_DOMAIN SEED_ADMIN_EMAIL; do
  eval "[ -n \"\${$v}\" ]" || { echo "ต้องระบุ $v" >&2; exit 1; }
done
case "$EXTRACTION_PROVIDER" in fake | fixture | gemini | claude) ;; *) echo "EXTRACTION_PROVIDER ต้องเป็น fake, gemini หรือ claude" >&2; exit 1 ;; esac

mkdir -p "$(dirname "$OUT")"
umask 077
TMP="$OUT.tmp.$$"
cat >"$TMP" <<EOF
# ค่าตั้ง production ของ SDES — สร้างโดย deploy/init-env.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)
# ห้าม commit / ส่งต่อ / แสดงในที่สาธารณะ · สำรองไฟล์นี้แยกไว้ (หายแล้วกู้ชุดสำรองฐานข้อมูลไม่ได้)
SDES_DOMAIN=$SDES_DOMAIN

POSTGRES_DB=sdes
POSTGRES_OWNER_USER=sdes_owner
POSTGRES_OWNER_PASSWORD=$(rand 33)
POSTGRES_APP_PASSWORD=$(rand 33)
REDIS_PASSWORD=$(rand 33)
S3_ACCESS_KEY=$(rand 18)
S3_SECRET_KEY=$(rand 33)
S3_BUCKET=sdes-documents
S3_REGION=ap-southeast-1
JWT_SECRET=$(rand 48)
ERP_SECRET_KEY=$(openssl rand -base64 32 | tr -d '\n')

# System Admin คนแรก — รหัสชั่วคราว ระบบบังคับเปลี่ยนตอนล็อกอินครั้งแรก
SEED_ADMIN_EMAIL=$SEED_ADMIN_EMAIL
SEED_ADMIN_PASSWORD=$(rand 15)
COMPANY_TAX_ID=$COMPANY_TAX_ID
COMPANY_NAME=$COMPANY_NAME

# fake = สาธิต (ไม่ใช้ AI) · gemini แผนฟรีอาจนำข้อมูลไปใช้ — ใช้กับเอกสารตัวอย่างเท่านั้น
EXTRACTION_PROVIDER=$EXTRACTION_PROVIDER
GEMINI_API_KEY=$GEMINI_API_KEY
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
EXTRACTION_MODEL=

# ไม่บังคับ: อัปโหลดชุดสำรองไป Object Storage (S3-compatible)
BACKUP_S3_ENDPOINT=
BACKUP_S3_BUCKET=
BACKUP_S3_ACCESS_KEY=
BACKUP_S3_SECRET_KEY=
EOF
chmod 600 "$TMP"
mv "$TMP" "$OUT"
echo "สร้าง $OUT แล้ว (mode 600) — รหัสชั่วคราวของ Admin: grep SEED_ADMIN_PASSWORD $OUT"
