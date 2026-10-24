FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# Phase 12: exact versions from the lockfile when there is one (npm ci).
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations

EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD wget -qO- http://localhost:8081/health || exit 1

# Phase 9: run as the image's built-in unprivileged "node" user, by
# NUMERIC uid — Kubernetes' runAsNonRoot check can only verify a
# numeric USER (a name like "node" makes the kubelet refuse to start
# the pod). The app only reads its own files and binds a port >1024,
# so it needs no root privileges at all.
USER 1000:1000

CMD ["node", "src/index.js"]
