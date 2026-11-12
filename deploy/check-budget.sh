#!/bin/sh
# ตรวจงบ RAM ของ stack production จาก compose config (spec production-deployment "Resource budget", design D4)
#   sh deploy/check-budget.sh [ไฟล์ค่าตั้ง] [RAM เครื่องเป็น GB, ค่าเริ่มต้น 12]
# ผ่านเมื่อ: ทุก service ที่รันตลอดมี mem_limit และผลรวม ≤ 80% ของ RAM เครื่อง
set -e
cd "$(dirname "$0")/.."
ENV_FILE="${1:-/opt/sdes/.env.production}"
HOST_GB="${2:-12}"
docker compose -p sdes-prod --env-file "$ENV_FILE" -f docker-compose.prod.yml config --format json | python3 -c '
import json, sys
host_gb = float(sys.argv[1])
services = json.load(sys.stdin)["services"]
budget = host_gb * 1024 ** 3 * 0.8
total, missing = 0, []
for name, s in sorted(services.items()):
    limit = s.get("mem_limit")
    if limit is None:
        missing.append(name)
        continue
    total += int(limit)
    print(f"{name:10s} {int(limit) / 1024**2:7.0f} MB")
label = "รวม"
print(f"{label:10s} {total / 1024**3:7.2f} GB  (งบ {budget / 1024**3:.2f} GB = 80% ของ {host_gb:g} GB)")
if missing:
    sys.exit("ไม่มี mem_limit: " + ", ".join(missing))
if total > budget:
    sys.exit("เพดาน RAM รวมเกินงบ")
print("ผ่าน")
' "$HOST_GB"
