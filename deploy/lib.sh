# ใช้ร่วมกันใน deploy.sh / rollback.sh / restore.sh (source ไฟล์นี้) — design D7
# ตำแหน่งบนเครื่อง production (แทนที่ได้ด้วย environment สำหรับทดสอบบนเครื่อง dev):
#   SDES_ROOT=/opt/sdes  ├─ service/  (repo sdes-service)   ├─ web/  (repo sdes-web)
#                        ├─ .env.production                 ├─ releases.log  ├─ backups/
SDES_ROOT="${SDES_ROOT:-/opt/sdes}"
SERVICE_DIR="${SDES_SERVICE_DIR:-$SDES_ROOT/service}"
export SDES_WEB_DIR="${SDES_WEB_DIR:-$SDES_ROOT/web}"
ENV_FILE="${SDES_ENV_FILE:-$SDES_ROOT/.env.production}"
RELEASES="$SDES_ROOT/releases.log"
export SDES_BACKUP_DIR="${SDES_BACKUP_DIR:-$SDES_ROOT/backups}"
HEALTH_TIMEOUT="${SDES_HEALTH_TIMEOUT:-120}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die() { log "ล้มเหลว: $*"; exit 1; }

[ -f "$ENV_FILE" ] || die "ไม่พบไฟล์ค่าตั้ง $ENV_FILE (สร้างด้วย deploy/init-env.sh)"

dc() { docker compose -p sdes-prod --env-file "$ENV_FILE" -f "$SERVICE_DIR/docker-compose.prod.yml" "$@"; }

# tag ของ release ที่ใช้อยู่ — แถวสุดท้ายที่สำเร็จใน releases.log
current_tag() { [ -f "$RELEASES" ] && awk -F'\t' '$5 == "ok" { t = $4 } END { if (t) print t }' "$RELEASES"; }

# image ที่ compose ใช้ = release ปัจจุบัน (deploy.sh ตั้งค่าใหม่เอง)
export SDES_TAG="${SDES_TAG:-$(current_tag || true)}"
[ -n "$SDES_TAG" ] || SDES_TAG=local

# รอ health ของ service ที่ระบุ (ค่าเริ่มต้น api web worker caddy) ภายใน HEALTH_TIMEOUT วินาที
wait_healthy() {
  services="${*:-api web worker caddy}"
  deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  while :; do
    bad=""
    for s in $services; do
      id=$(dc ps -q "$s" 2>/dev/null | head -n 1)
      st=$( [ -n "$id" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
      [ "$st" = "healthy" ] || bad="$bad $s=$st"
    done
    [ -z "$bad" ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && { log "health ไม่ผ่านภายใน ${HEALTH_TIMEOUT}s:$bad"; return 1; }
    sleep 3
  done
}

record() { # record <service ref> <web ref> <tag> <ok|failed|rollback>
  mkdir -p "$SDES_ROOT"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" >>"$RELEASES"
}
