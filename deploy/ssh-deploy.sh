#!/bin/sh
# forced command ของ SSH key ที่ GitHub Actions ใช้ (design D7) — key นี้สั่งได้แค่ deploy/rollback เท่านั้น
# ใส่ใน /home/deploy/.ssh/authorized_keys บรรทัดเดียว:
#   command="/opt/sdes/service/deploy/ssh-deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... github-actions
# คำสั่งที่รับ (จาก $SSH_ORIGINAL_COMMAND):  deploy <service ref> <web ref>   |   rollback
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
# ref ที่อนุญาต: ชื่อ branch/tag หรือ SHA — ไม่มีช่องว่าง, ไม่ขึ้นต้นด้วย "-", ไม่มีอักขระของ shell
REF='^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'
set -f
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
set +f
case "${1:-}" in
  deploy)
    [ $# -eq 3 ] || { echo "ใช้: deploy <service ref> <web ref>" >&2; exit 2; }
    for r in "$2" "$3"; do printf '%s' "$r" | grep -Eq "$REF" && ! printf '%s' "$r" | grep -q '\.\.' || { echo "ref ไม่ถูกต้อง: $r" >&2; exit 2; }; done
    exec sh "$DIR/deploy.sh" --service "$2" --web "$3"
    ;;
  rollback)
    [ $# -eq 1 ] || { echo "ใช้: rollback" >&2; exit 2; }
    exec sh "$DIR/rollback.sh"
    ;;
  *)
    echo "key นี้สั่งได้เฉพาะ: deploy <service ref> <web ref> | rollback" >&2
    exit 2
    ;;
esac
