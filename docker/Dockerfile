# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f docker/Dockerfile -t budget-app .
#
# Behind a TLS-intercepting proxy, pass its CA as an optional build secret:
#   docker build --secret id=build_ca,src=/path/to/ca.crt -f docker/Dockerfile .
# Without the secret nothing changes; the CA never ends up in an image layer.

ARG NODE_VERSION=22

# --- Web app: pure JS output, so build once on the build host's platform. ---
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --frozen-lockfile --filter @budget/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @budget/web build

# --- Server: built on the target platform because better-sqlite3 is native. ---
FROM node:${NODE_VERSION}-bookworm AS server
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
# The full bookworm image has python3/make/g++ for the source-build fallback
# when no better-sqlite3 prebuilt binary can be downloaded.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --frozen-lockfile --filter @budget/server...
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @budget/shared build \
 && pnpm --filter @budget/server build \
 && pnpm --filter @budget/server deploy --prod --legacy /out \
 && node -e "require('/out/node_modules/better-sqlite3')(':memory:').close()"

# --- Runtime ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP_VERSION
ARG APP_COMMIT
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/public \
    APP_VERSION=${APP_VERSION} \
    APP_COMMIT=${APP_COMMIT}
WORKDIR /app
COPY --from=server --chown=root:root /out ./
COPY --from=web --chown=root:root /src/apps/web/dist ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.title="budget-app" \
      org.opencontainers.image.description="Household budget web app (가계부)" \
      org.opencontainers.image.licenses="UNLICENSED"
