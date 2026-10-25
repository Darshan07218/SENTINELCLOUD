#!/usr/bin/env bash
# Builds every SentinelCloud image with the tag the Kubernetes manifests
# expect (sentinelcloud/<name>:1.0.0), then optionally loads them into a
# local cluster.
#
#   ./scripts/k8s-build-images.sh            # build only (local Docker)
#   ./scripts/k8s-build-images.sh kind       # build, then `kind load` into cluster "sentinelcloud"
#   ./scripts/k8s-build-images.sh minikube   # build directly inside Minikube (`minikube image build`)
#
# Run from the repository root. Windows users: run from Git Bash / WSL,
# or copy the individual commands from docs/PHASE-9-KUBERNETES.md.
set -euo pipefail

TAG="${TAG:-1.0.0}"
TARGET="${1:-docker}"
KIND_CLUSTER="${KIND_CLUSTER:-sentinelcloud}"

case "$TARGET" in
  docker|kind|minikube) ;;
  *) echo "usage: $0 [docker|kind|minikube]" >&2; exit 2 ;;
esac

# image-name : build-context
IMAGES=(
  "gateway:services/gateway"
  "auth-service:services/auth-service"
  "hospital-service:services/hospital-service"
  "ambulance-service:services/ambulance-service"
  "blood-bank-service:services/blood-bank-service"
  "power-service:services/power-service"
  "disaster-service:services/disaster-service"
  "notification-service:services/notification-service"
  "resilience-service:services/resilience-service"
  "response-service:services/response-service"
  "simulator-service:services/simulator-service"
  "intake-service:services/intake-service"
  "frontend:frontend"
)

cd "$(dirname "$0")/.."

# The CARTO basemap key is baked into the frontend bundle at build time
# (keyless tiles are watermarked "API KEY REQUIRED"): from the environment,
# else from .env (gitignored; the same value Compose uses).
CARTO_KEY="${CARTO_BASEMAP_KEY:-}"
if [[ -z "$CARTO_KEY" && -f .env ]]; then
  CARTO_KEY=$(grep -E '^[[:space:]]*CARTO_BASEMAP_KEY=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"'[:space:]')
fi
[[ -n "$CARTO_KEY" ]] || echo "warning: no CARTO_BASEMAP_KEY (environment or .env): map tiles will be watermarked" >&2

built=()
for entry in "${IMAGES[@]}"; do
  name="${entry%%:*}"
  context="${entry#*:}"
  image="sentinelcloud/${name}:${TAG}"
  extra=()
  [[ "$name" == "frontend" && -n "$CARTO_KEY" ]] && extra=(--build-arg "CARTO_BASEMAP_KEY=$CARTO_KEY")
  echo ">>> building ${image} from ${context}"
  if [[ "$TARGET" == "minikube" ]]; then
    minikube image build -t "$image" "${extra[@]}" "$context"
  else
    docker build -t "$image" "${extra[@]}" "$context"
  fi
  built+=("$image")
done

if [[ "$TARGET" == "kind" ]]; then
  echo ">>> loading ${#built[@]} images into kind cluster '${KIND_CLUSTER}'"
  kind load docker-image "${built[@]}" --name "$KIND_CLUSTER"
fi

echo ">>> done: ${built[*]}"

# The local overlay pins newTag "1.0.0" (k8s/overlays/local/kustomization.yaml).
if [[ "$TAG" != "1.0.0" ]]; then
  echo ">>> NOTE: built tag ${TAG}, but k8s/overlays/local/kustomization.yaml deploys 1.0.0." >&2
  echo "    Update its newTag values (or: cd k8s/overlays/local && kustomize edit set image sentinelcloud/<name>=sentinelcloud/<name>:${TAG})." >&2
fi
# Rebuilding the SAME tag doesn't change the Deployment spec, so Kubernetes
# keeps the old pods. Restart them to pick up the new image:
echo ">>> if SentinelCloud is already deployed with this tag, roll the pods onto the new images:"
echo "    kubectl -n sentinelcloud rollout restart deployment"
