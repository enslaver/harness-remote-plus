# syntax=docker/dockerfile:1
#
# The hub image: the web app (built here), the hub server, and nothing else.
# Build context is the REPOSITORY ROOT (the web app lives outside hub/):
#
#   docker build -f hub/Dockerfile -t harness-remote-hub .
#
# `docker compose up` does this for you; see docs/HUB.md.

ARG NODE_VERSION=22

# ---- 1. build the web app ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS web
WORKDIR /repo/web
# web/ also holds the Electron and Android packaging. Electron's postinstall downloads a ~100 MB binary
# that a static web build never uses.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_audit=false npm_config_fund=false
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Type-checks (tsc -b) and bundles, exactly as CI does.
RUN npm run build

# ---- 2. production dependencies of the hub (pg, and nothing else) -----------------------------------
FROM node:${NODE_VERSION}-alpine AS hub-deps
WORKDIR /app
ENV npm_config_audit=false npm_config_fund=false
COPY hub/package.json hub/package-lock.json ./
RUN npm ci --omit=dev

# ---- 3. runtime -------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine
LABEL org.opencontainers.image.title="Harness Remote Hub" \
      org.opencontainers.image.description="Self-hosted web UI, machine registry and log collection for Harness Remote" \
      org.opencontainers.image.source="https://github.com/enslaver/harness-remote-plus" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    HUB_WEB_DIR=/app/web \
    HUB_PUBLIC_DIR=/app/public \
    HUB_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=hub-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node hub/package.json ./
COPY --chown=node:node hub/src ./src
COPY --chown=node:node hub/migrations ./migrations
COPY --chown=node:node hub/public ./public
COPY --from=web --chown=node:node /repo/web/dist ./web
# Runs unprivileged; the hub writes nothing to disk (state lives in Postgres and Loki), so the
# filesystem can be mounted read-only.
USER node
EXPOSE 8080
# Liveness only (does not touch the database): a database or Loki outage should not get the hub
# restarted in a loop. /readyz reports those.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HUB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.js"]
