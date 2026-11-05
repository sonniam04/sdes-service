#!/bin/sh
# deploy เวอร์ชันที่ระบุบนเครื่อง production ด้วยคำสั่งเดียว (spec production-deployment "Repeatable deploy and rollback", design D7)
#   sh deploy/deploy.sh --service <git ref> --web <git ref> [--seed]
# ขั้นตอน: checkout ref → build image (tag ด้วย short SHA) → สำรองฐานข้อมูล → migrate แบบ one-shot (ล้ม = หยุด, ของเดิมยังทำงาน)
#          → up → รอ health ≤ 120 วินาที → บันทึก releases.log   ·   --seed = deploy ครั้งแรก (สร้าง Admin + ค่าเริ่มต้น)
# ถ้า health ไม่ผ่าน: รายงานล้มเหลว แล้วใช้ deploy/rollback.sh กลับไปเวอร์ชันก่อนหน้า
set -eu
SVC_REF="" WEB_REF="" SEED=0 FETCH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --service) SVC_REF="$2"; shift 2 ;;
    --web) WEB_REF="$2"; shift 2 ;;
    --seed) SEED=1; shift ;;
    --no-fetch) FETCH=0; shift ;;
    *) echo "ไม่รู้จัก $1 — ใช้: deploy.sh --service <ref> --web <ref> [--seed]" >&2; exit 2 ;;
  esac
done
[ -n "$SVC_REF" ] && [ -n "$WEB_REF" ] || { echo "ต้องระบุ --service และ --web" >&2; exit 2; }
. "$(dirname "$0")/lib.sh"

checkout() { # checkout <dir> <ref> → พิมพ์ short SHA
  [ "$FETCH" = 1 ] && git -C "$1" fetch --quiet --tags origin
  git -C "$1" -c advice.detachedHead=false checkout --quiet --detach "$( git -C "$1" rev-parse --verify --quiet "origin/$2^{commit}" || git -C "$1" rev-parse --verify "$2^{commit}")"
  git -C "$1" rev-parse --short=8 HEAD
}

log "checkout service=$SVC_REF web=$WEB_REF"
SVC_SHA=$(checkout "$SERVICE_DIR" "$SVC_REF")
WEB_SHA=$(checkout "$SDES_WEB_DIR" "$WEB_REF")
export SDES_TAG="$SVC_SHA-$WEB_SHA"
PREV_TAG=$(current_tag || true)
log "build $SDES_TAG (ก่อนหน้า: ${PREV_TAG:-ไม่มี})"
dc --profile tools build api worker web migrate backup || { record "$SVC_REF" "$WEB_REF" "$SDES_TAG" failed; die "build ไม่ผ่าน — ระบบเดิมยังทำงาน"; }
# ไม่ใช้ BuildKit cache ของ image เก่าแล้ว — ลบ dangling layer กัน disk เต็ม
docker image prune -f >/dev/null 2>&1 || true

dc up -d --wait postgres
if [ -n "$PREV_TAG" ]; then
  mkdir -p "$SDES_BACKUP_DIR/pre-deploy"
  DUMP="$SDES_BACKUP_DIR/pre-deploy/$(date +%Y%m%d-%H%M%S)-$PREV_TAG.dump"
  log "สำรองฐานข้อมูลก่อน migrate → $DUMP"
  dc exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' >"$DUMP" || die "สำรองฐานข้อมูลไม่สำเร็จ — ยังไม่ได้ migrate"
  # เก็บชุดก่อน deploy 5 ชุดล่าสุด
  ls -1t "$SDES_BACKUP_DIR/pre-deploy/"*.dump 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

log "migrate"
dc --profile tools run --rm migrate || { record "$SVC_REF" "$WEB_REF" "$SDES_TAG" failed; die "migration ไม่ผ่าน — container เดิมยังทำงาน"; }
if [ "$SEED" = 1 ]; then
  log "seed (Admin คนแรก + ค่าเริ่มต้น)"
  dc --profile tools run --rm migrate node dist/seed-cli.js
fi

log "สลับไปเวอร์ชัน $SDES_TAG"
dc up -d --no-build --remove-orphans
if wait_healthy; then
  record "$SVC_REF" "$WEB_REF" "$SDES_TAG" ok
  log "deploy สำเร็จ: $SDES_TAG"
else
  record "$SVC_REF" "$WEB_REF" "$SDES_TAG" failed
  dc logs --tail 30 api worker web >&2 || true
  die "เวอร์ชัน $SDES_TAG ไม่ผ่าน health check — สั่ง sh deploy/rollback.sh เพื่อกลับไป ${PREV_TAG:-เวอร์ชันก่อนหน้า}"
fi
