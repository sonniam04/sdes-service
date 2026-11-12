#!/bin/sh
# กู้ชุดสำรองหนึ่งชุดกลับเข้า PostgreSQL + bucket เอกสาร — เรียกจาก deploy/restore.sh (หลังหยุด api/worker แล้ว)
#   restore-inside.sh <ชื่อชุด>      ชุดอยู่ใน /backups/daily/<ชื่อ> หรือระบุ path ของไฟล์ .dump (ชุดก่อน deploy — ฐานข้อมูลอย่างเดียว)
set -eu
[ -f /run/backup.env ] && . /run/backup.env
SRC="$1"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') restore: $*"; }

if [ -f "$SRC" ]; then
  DUMP="$SRC" FILES=""
elif [ -d "/backups/daily/$SRC" ]; then
  DUMP="/backups/daily/$SRC/db.dump" FILES="/backups/daily/$SRC/files"
else
  echo "ไม่พบชุดสำรอง $SRC" >&2
  exit 1
fi

log "pg_restore $DUMP"
# --clean --if-exists: แทนที่ object เดิม (ฐานใหม่ที่ว่างก็ใช้ได้) · trigger กันแก้ audit_events ไม่กระทบ เพราะสร้างตารางใหม่ทั้งตาราง
pg_restore --clean --if-exists --single-transaction --exit-on-error -d "$PGDATABASE" "$DUMP"
if [ -n "$FILES" ]; then
  log "คืนไฟล์เอกสารไปที่ bucket $S3_BUCKET"
  rclone mkdir "src:$S3_BUCKET"
  rclone sync --quiet "$FILES" "src:$S3_BUCKET"
fi
log "เสร็จ: documents=$(psql -Atc 'select count(*) from documents') audit_events=$(psql -Atc 'select count(*) from audit_events')"
