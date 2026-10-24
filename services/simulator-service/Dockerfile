# simulator-service (Phase 16) — zero runtime dependencies (Node core and
# its built-in fetch), so no npm install / build stage.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src

EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://localhost:8090/health || exit 1

# Numeric uid so the pod's runAsNonRoot check can verify it (Phase 9).
USER 1000:1000
CMD ["node", "src/index.js"]