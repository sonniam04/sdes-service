# api และ worker ใช้ Dockerfile เดียว (design D3)
#   runtime:  docker build --build-arg APP=api|worker .            → production deps + dist เท่านั้น
#   tools:    docker build --target tools .                         → Prisma CLI + migration + seed (one-shot)
# ทุก stage ไม่มี secret — ค่าตั้งมาจาก environment ตอนรันเท่านั้น
ARG NODE_IMAGE=node:22.23.4-alpine3.23
ARG ALPINE_IMAGE=alpine:3.23.7

FROM ${NODE_IMAGE} AS base
# Prisma engine บน Alpine ต้องใช้ openssl; เตรียม pnpm ไว้ใน image เพื่อไม่ต้องโหลดตอนรัน
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
# postinstall ของ @sdes/db รัน prisma generate จึงต้องมี schema ก่อน install
COPY packages/db/prisma packages/db/prisma
COPY packages/db/scripts packages/db/scripts
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# เฉพาะ production dependencies + dist ของแต่ละ app (Prisma client + engine musl อยู่ใน @sdes/db/dist/generated)
# --ignore-scripts: postinstall ของ @sdes/db ต้องใช้ Prisma CLI ซึ่งเป็น dev dependency และ client ถูก generate แล้ว
RUN pnpm --filter @sdes/api deploy --prod --legacy --ignore-scripts /out/api \
 && pnpm --filter @sdes/worker deploy --prod --legacy --ignore-scripts /out/worker \
 && sh docker/prune-runtime.sh /out/api && sh docker/prune-runtime.sh /out/worker

# migrate deploy / seed แบบ one-shot (deploy.sh รันก่อน api ใหม่เริ่ม)
FROM build AS tools
ENV NODE_ENV=production
WORKDIR /repo/packages/db
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# runtime: alpine + binary ของ node อย่างเดียว (ไม่มี npm/yarn/corepack) — เป้า < 300 MB
FROM ${NODE_IMAGE} AS node
FROM ${ALPINE_IMAGE} AS runtime
RUN apk add --no-cache libstdc++ libgcc openssl && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/${APP} /app
USER node
CMD ["node", "dist/main.js"]
