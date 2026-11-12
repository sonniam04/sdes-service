#!/bin/sh
# กู้คืนชุดสำรอง (spec production-deployment "Backup and restore", design D7)
#   sh deploy/restore.sh                 แสดงชุดที่มี
#   sh deploy/restore.sh <ชื่อชุด>        กู้ฐานข้อมูล + ไฟล์เอกสารจาก backups/daily/<ชื่อ>
#   sh deploy/restore.sh <ไฟล์ .dump>     กู้เฉพาะฐานข้อมูล (เช่น ชุดก่อน deploy ใน backups/pre-deploy/)
# ขั้นตอน: หยุด api/worker → pg_restore --clean → คืนไฟล์ → เริ่ม api/worker → รอ health
# ใช้บนเครื่องใหม่ได้: init-env.sh ด้วยไฟล์ค่าตั้งเดิม (รหัสฐานข้อมูล/ERP_SECRET_KEY ต้องตรงกับตอนสำรอง) → deploy.sh → restore.sh
set -eu
. "$(dirname "$0")/lib.sh"

if [ $# -lt 1 ]; then
  echo "ชุดสำรองใน $SDES_BACKUP_DIR/daily:"
  for d in "$SDES_BACKUP_DIR"/daily/*/; do [ -f "$d/manifest" ] && echo "  $(basename "$d")  $(grep -E '^(documents|audit_events|files)=' "$d/manifest" | tr '\n' ' ')"; done
  echo "ชุดก่อน deploy (ฐานข้อมูลอย่างเดียว):"
  ls -1 "$SDES_BACKUP_DIR"/pre-deploy/*.dump 2>/dev/null | sed 's/^/  /' || true
  exit 0
fi
SET="$1"
case "$SET" in
  "$SDES_BACKUP_DIR"/*) INSIDE="/backups/${SET#"$SDES_BACKUP_DIR"/}" ;;
  /*) die "ไฟล์ต้องอยู่ใต้ $SDES_BACKUP_DIR" ;;
  *) INSIDE="$SET" ;;
esac

log "หยุด api และ worker"
dc stop api worker
dc up -d --wait postgres seaweedfs backup
log "กู้คืน $SET"
dc exec -T backup restore-inside.sh "$INSIDE" || { dc up -d --no-build api worker; die "กู้คืนไม่สำเร็จ — เริ่ม api/worker กลับแล้ว (ข้อมูลอาจไม่ครบ ตรวจก่อนใช้งาน)"; }
log "เริ่ม api และ worker"
dc up -d --no-build api worker
wait_healthy api worker || die "api/worker ไม่ผ่าน health หลังกู้คืน"
log "กู้คืนสำเร็จ"
