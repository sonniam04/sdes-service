#!/bin/sh
# ย้อนกลับไป release ก่อนหน้าที่สำเร็จ ด้วยคำสั่งเดียว โดยไม่ build (design D7)
#   sh deploy/rollback.sh [tag]        ไม่ระบุ = แถว ok ก่อนแถว ok ล่าสุดใน releases.log
#                                      (ถ้า deploy ล่าสุดล้มเหลว = แถว ok ล่าสุด คือเวอร์ชันที่ใช้งานได้ก่อน deploy)
# migration ทุก phase เป็นแบบเพิ่ม (additive) โค้ดเวอร์ชันก่อนจึงทำงานกับ schema ใหม่ได้
# ถ้าไม่ใช่ ให้กู้ฐานข้อมูลจาก backups/pre-deploy ด้วย deploy/restore.sh (ดูคู่มือ)
set -eu
. "$(dirname "$0")/lib.sh"
[ -f "$RELEASES" ] || die "ยังไม่มี releases.log — ยังไม่เคย deploy"

if [ $# -ge 1 ]; then
  TARGET="$1"
else
  LAST=$(tail -n 1 "$RELEASES" | cut -f5)
  if [ "$LAST" = "ok" ]; then
    TARGET=$(awk -F'\t' '$5 == "ok" { prev = cur; cur = $4 } END { print prev }' "$RELEASES")
  else
    TARGET=$(current_tag)
  fi
fi
[ -n "$TARGET" ] || die "ไม่พบ release ก่อนหน้าที่สำเร็จ"
for img in sdes-api sdes-worker sdes-web; do
  docker image inspect "$img:$TARGET" >/dev/null 2>&1 || die "ไม่มี image $img:$TARGET บนเครื่อง (ถูกลบไปแล้ว) — deploy ref นั้นใหม่แทน"
done

export SDES_TAG="$TARGET"
REFS=$(awk -F'\t' -v t="$TARGET" '$4 == t { r = $2 "\t" $3 } END { print r }' "$RELEASES")
log "rollback → $TARGET"
dc up -d --no-build --remove-orphans
if wait_healthy; then
  record "$(printf '%s' "$REFS" | cut -f1)" "$(printf '%s' "$REFS" | cut -f2)" "$TARGET" ok
  log "rollback สำเร็จ: $TARGET"
else
  record "$(printf '%s' "$REFS" | cut -f1)" "$(printf '%s' "$REFS" | cut -f2)" "$TARGET" failed
  die "เวอร์ชัน $TARGET ก็ไม่ผ่าน health check — ดู docker compose logs"
fi
