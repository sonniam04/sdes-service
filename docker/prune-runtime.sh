#!/bin/sh
# ตัดไฟล์ที่ runtime ไม่ใช้ออกจากผล `pnpm deploy --prod` (design D3: image runtime < 300 MB)
#   sh docker/prune-runtime.sh /out/api
# ทุกข้อด้านล่างตรวจแล้วว่า api/worker เริ่มและ query ฐานข้อมูลได้หลังตัด
set -eu
OUT="$1"
P="$OUT/node_modules/.pnpm"

# 1) Prisma CLI และ dependency ของมัน — ติดมาเพราะเป็น peer ของ @prisma/client; runtime ใช้แค่ client ที่ generate แล้ว
rm -rf "$P"/prisma@* "$P"/@prisma+config@* "$P"/@prisma+engines@* "$P"/@prisma+fetch-engine@* "$P"/@prisma+get-platform@* \
  "$P"/effect@* "$P"/typescript@* "$P"/c12@* "$P"/jiti@* "$P"/giget@*

# 2) runtime ของ @prisma/client: ใช้เฉพาะ library engine (library.js) + index-browser — ตัด wasm/edge/react-native ของฐานข้อมูลอื่น
for rt in "$P"/@prisma+client@*/node_modules/@prisma/client/runtime; do
  [ -d "$rt" ] || continue
  find "$rt" -maxdepth 1 -type f ! -name 'library.*' ! -name 'index-browser.*' -delete
done

# 3) engine ของสถาปัตยกรรมอื่น (generate ไว้ทั้ง x86-64 และ ARM64)
case "$(uname -m)" in
  x86_64) other='libquery_engine-linux-musl-arm64-*' ;;
  aarch64) other='libquery_engine-linux-musl-openssl-*' ;;
  *) other='' ;;
esac
[ -n "$other" ] && find "$OUT/node_modules" -name "$other" -delete
find "$OUT/node_modules" -name 'query_engine-windows*' -delete

# 4) ไฟล์สำหรับนักพัฒนา (source map, type, เอกสาร)
find "$OUT" \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname 'README*' -o -iname 'CHANGELOG*' \) -type f -delete

# workspace package ใช้ dist อย่างเดียว
rm -rf "$OUT/src" "$OUT/test"
for pkg in "$OUT"/node_modules/@sdes/*; do rm -rf "$(readlink -f "$pkg")/src" "$(readlink -f "$pkg")/test"; done
du -sh "$OUT"
