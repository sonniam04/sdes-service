#!/bin/sh
# สำรองฐานข้อมูล + ไฟล์เอกสารหนึ่งชุด แล้วเก็บไว้ BACKUP_KEEP ชุดล่าสุด (spec production-deployment "Backup and restore")
# รันใน service backup: cron เรียกทุกวัน 02:00 หรือสั่งเอง: docker compose ... exec backup backup.sh
#   BACKUP_NAME  ชื่อชุด (ค่าเริ่มต้น = วันเวลาปัจจุบัน YYYY-MM-DD_HHMM — เรียงตามชื่อ = เรียงตามเวลา)
# /backups เป็น bind mount ของ /opt/sdes/backups บนเครื่อง (นอก volume ข้อมูล)
set -eu
[ -f /run/backup.env ] && . /run/backup.env
NAME="${BACKUP_NAME:-$(date +%Y-%m-%d_%H%M)}"
KEEP="${BACKUP_KEEP:-7}"
DEST="/backups/daily/$NAME"
TMP="/backups/daily/.tmp-$NAME"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') backup: $*"; }

rm -rf "$TMP"
mkdir -p "$TMP/files"
log "pg_dump → $NAME"
pg_dump -Fc -f "$TMP/db.dump"
log "คัดลอก bucket $S3_BUCKET"
rclone copy --quiet "src:$S3_BUCKET" "$TMP/files"
# ใช้ตรวจหลังกู้คืน: จำนวน audit event และเอกสาร ณ เวลาสำรอง
{
  echo "name=$NAME"
  echo "created_at=$(date -Iseconds)"
  echo "documents=$(psql -Atc 'select count(*) from documents')"
  echo "audit_events=$(psql -Atc 'select count(*) from audit_events')"
  echo "files=$(find "$TMP/files" -type f | wc -l | tr -d ' ')"
} >"$TMP/manifest"
mv "$TMP" "$DEST"
log "เสร็จ: $(tr '\n' ' ' <"$DEST/manifest")"

# เก็บ KEEP ชุดล่าสุด (ชื่อเรียงตามเวลา)
ls -1 /backups/daily | grep -v '^\.' | sort | head -n "-$KEEP" 2>/dev/null | while read -r old; do
  log "ลบชุดเก่า $old"
  rm -rf "/backups/daily/$old"
done

# ไม่บังคับ: ส่งออกนอกเครื่อง (Object Storage แบบ S3) และเก็บ KEEP วันเช่นกัน
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  log "อัปโหลดไป offsite:$BACKUP_S3_BUCKET/$NAME"
  rclone copy --quiet "$DEST" "offsite:$BACKUP_S3_BUCKET/$NAME"
  rclone lsf --dirs-only "offsite:$BACKUP_S3_BUCKET" | sed 's#/$##' | sort | head -n "-$KEEP" | while read -r old; do
    rclone purge --quiet "offsite:$BACKUP_S3_BUCKET/$old"
  done
fi
