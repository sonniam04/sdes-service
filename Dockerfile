# ใช้ image เดียวสำหรับ api และ worker: docker build --build-arg APP=api|worker
FROM node:22-alpine AS build
# Prisma engine บน Alpine ต้องใช้ openssl
RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo
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

FROM node:22-alpine
RUN apk add --no-cache openssl
ARG APP
ENV NODE_ENV=production APP=${APP}
WORKDIR /repo
COPY --from=build /repo /repo
USER node
CMD ["sh", "-c", "node apps/${APP}/dist/main.js"]
