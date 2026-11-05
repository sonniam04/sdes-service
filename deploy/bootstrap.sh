#!/bin/sh
# เตรียม VM Ubuntu 24.04 (ARM64 ของ Oracle Ampere A1 หรือ x86-64) ให้พร้อม deploy — รันด้วย root ครั้งเดียว (design D1, D2)
#   curl -fsSL <raw url ของไฟล์นี้> -o bootstrap.sh && sudo sh bootstrap.sh
# ทำ: Docker Engine + compose plugin, firewall เปิดเฉพาะ 22/80/443, swap 2 GB, ผู้ใช้ deploy, โฟลเดอร์ /opt/sdes
# รันซ้ำได้ (ข้ามขั้นที่ทำแล้ว) · ตั้ง SDES_SKIP_FIREWALL=1 เมื่อทดสอบใน container
set -eu
[ "$(id -u)" = 0 ] || { echo "ต้องรันด้วย root (sudo sh bootstrap.sh)" >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || echo "คำเตือน: ทดสอบกับ Ubuntu 24.04 เท่านั้น (เครื่องนี้ $PRETTY_NAME)" >&2
log() { echo "==> $*"; }
export DEBIAN_FRONTEND=noninteractive

log "แพ็กเกจพื้นฐาน"
apt-get update -q
apt-get install -y -q ca-certificates curl git openssl python3 cron ufw

if ! command -v docker >/dev/null 2>&1; then
  log "Docker Engine (repo ทางการของ Docker)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# log ของ container ทั้งเครื่องจำกัดขนาด (compose production ตั้งต่อ service อยู่แล้ว — ตัวนี้กันกรณีอื่น)
if [ ! -f /etc/docker/daemon.json ]; then
  mkdir -p /etc/docker
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "3" }\n}\n' >/etc/docker/daemon.json
fi
systemctl enable docker >/dev/null 2>&1 || true
systemctl restart docker >/dev/null 2>&1 || true

if [ "${SDES_SKIP_FIREWALL:-0}" != 1 ]; then
  log "firewall: เปิดเฉพาะ 22, 80, 443"
  # image ของ Oracle มี iptables rule ที่ปิดทุก port ยกเว้น 22 — ล้างแล้วให้ ufw คุมแทน
  if [ -f /etc/iptables/rules.v4 ]; then
    cp /etc/iptables/rules.v4 /etc/iptables/rules.v4.bak-sdes
    sed -i '/-j REJECT --reject-with icmp-host-prohibited/d' /etc/iptables/rules.v4
    iptables-restore </etc/iptables/rules.v4 || true
  fi
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable
fi

if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  log "swap 2 GB (กันการ build บนเครื่องโดน OOM)"
  [ -f /swapfile ] || { fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048; }
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile || echo "เปิด swap ไม่ได้ (เช่น ใน container) — ข้าม" >&2
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
sysctl -q vm.swappiness=10 2>/dev/null || true
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >>/etc/sysctl.conf

log "ผู้ใช้ deploy และ /opt/sdes"
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
usermod -aG docker deploy
install -d -o deploy -g deploy -m 750 /opt/sdes /opt/sdes/backups
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh

# ไม่บังคับ: DuckDNS ชี้ไป IP ปัจจุบันของเครื่องทุก 5 นาที (ephemeral IP เปลี่ยนเมื่อสร้าง VM ใหม่ — design D2)
#   sudo DUCKDNS_DOMAIN=sdes-demo DUCKDNS_TOKEN=<token> sh bootstrap.sh
if [ -n "${DUCKDNS_DOMAIN:-}" ] && [ -n "${DUCKDNS_TOKEN:-}" ]; then
  log "DuckDNS updater: ${DUCKDNS_DOMAIN}.duckdns.org"
  umask 077
  printf 'DUCKDNS_DOMAIN=%s\nDUCKDNS_TOKEN=%s\n' "${DUCKDNS_DOMAIN%.duckdns.org}" "$DUCKDNS_TOKEN" >/opt/sdes/duckdns.env
  chown deploy:deploy /opt/sdes/duckdns.env
  cat >/usr/local/bin/sdes-duckdns <<'EOF'
#!/bin/sh
. /opt/sdes/duckdns.env
curl -fsS --max-time 20 "https://www.duckdns.org/update?domains=$DUCKDNS_DOMAIN&token=$DUCKDNS_TOKEN&ip=" | grep -q OK || logger -t sdes-duckdns "อัปเดต DuckDNS ไม่สำเร็จ"
EOF
  chmod 755 /usr/local/bin/sdes-duckdns
  echo '*/5 * * * * deploy /usr/local/bin/sdes-duckdns' >/etc/cron.d/sdes-duckdns
  su deploy -s /bin/sh -c /usr/local/bin/sdes-duckdns || echo "อัปเดต DuckDNS ครั้งแรกไม่สำเร็จ — ตรวจ token" >&2
  umask 022
fi

log "เสร็จ — docker $(docker --version | cut -d' ' -f3 | tr -d ,), $(docker compose version --short 2>/dev/null || echo 'compose ?')"
cat <<'EOF'
ขั้นต่อไป (ดู docs/deploy ของรีโพหลัก):
  1. ใส่ public key ของผู้ดูแลใน /home/deploy/.ssh/authorized_keys
  2. sudo -iu deploy แล้ว clone repo: git clone <sdes-service> /opt/sdes/service && git clone <sdes-web> /opt/sdes/web
  3. sh /opt/sdes/service/deploy/init-env.sh
  4. sh /opt/sdes/service/deploy/deploy.sh --service main --web main --seed
EOF
