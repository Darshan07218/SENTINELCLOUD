# =========================================================================
# SentinelCloud frontend — PRODUCTION image (Phase 9 / Kubernetes).
#
# Stage 1 builds the static bundle with Vite. Stage 2 serves it with an
# unprivileged nginx that ALSO reverse-proxies /api, /ws and /health to
# the gateway Service. That makes the browser talk to a single origin:
#   - no CORS, no hard-coded gateway host baked into the JS bundle
#   - the same image works on Kind, Minikube, or behind any ingress,
#     because VITE_API_BASE_URL is the RELATIVE path "/api/v1"
#
# The development image (Vite dev server + hot reload) used by
# docker-compose.yml lives in Dockerfile.dev.
# =========================================================================
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# Vite inlines VITE_* variables at BUILD time, so this must be a build
# arg rather than a runtime env var. Relative = same-origin via nginx.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
# CARTO basemap key for the live maps (public by design; restrict it to
# your domains in CARTO). Pass with --build-arg CARTO_BASEMAP_KEY=...
ARG CARTO_BASEMAP_KEY=
ENV VITE_CARTO_BASEMAP_KEY=${CARTO_BASEMAP_KEY}
RUN npm run build

# nginx-unprivileged: runs as uid 101 and listens on 8080 (no root
# needed to bind <1024), so the pod can enforce runAsNonRoot.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Rendered by the image's entrypoint with envsubst at container start
# (only ${VARS} that exist in the environment are substituted — nginx's
# own $host, $uri etc. are left alone).
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
# Phase 12: browser security headers (CSP etc.), included by the site config.
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

# host:port of the gateway. The short Service name works both under
# Docker's embedded DNS and in Kubernetes (same namespace); the frontend
# ConfigMap sets it explicitly so it can be repointed without a rebuild.
ENV GATEWAY_UPSTREAM=gateway:8080

EXPOSE 8080
USER 101:101
