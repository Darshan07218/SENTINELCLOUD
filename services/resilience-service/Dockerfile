# resilience-service (Phase 11) — zero runtime dependencies, so no
# npm install / build stage: just the source on a slim Node runtime.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src

EXPOSE 8088
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://localhost:8088/health || exit 1

# Numeric uid so the pod's runAsNonRoot check can verify it (Phase 9).
USER 1000:1000
CMD ["node", "src/index.js"]
