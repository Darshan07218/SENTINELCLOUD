#!/usr/bin/env bash
# =========================================================================
# Phase 12: generate the secrets SentinelCloud needs, instead of copying
# example files full of well-known passwords.
#
#   ./scripts/generate-secrets.sh            # both files below
#   ./scripts/generate-secrets.sh compose    # .env (Docker Compose)
#   ./scripts/generate-secrets.sh k8s        # k8s/overlays/local/secrets.env
#
# Windows: run it from Git Bash or WSL (same as the other scripts/).
#
# What it does, per file:
#   - creates it from its .example if it doesn't exist yet;
#   - keeps every value that is already a real secret;
#   - replaces missing, placeholder (CHANGE_ME, change_me_dev_only…,
#     ChangeMe123!, sentinel_dev_password…) or too-short secrets with
#     random ones from the OS random generator (openssl or /dev/urandom);
#   - adds keys that are new in the example (upgrading from older phases);
#   - drops keys that no longer exist and contained credentials;
#   - writes the file readable by you only (chmod 600).
# Running it again is safe: nothing that is already strong is changed.
#
# The generated files are gitignored — never commit them.
# =========================================================================
set -euo pipefail
# Associative arrays (declare -A) need bash 4+. macOS still ships bash 3.2
# as /bin/bash; fail with instructions instead of a cryptic syntax error.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "generate-secrets.sh needs bash 4 or newer (found ${BASH_VERSION:-unknown})." >&2
  echo "macOS: brew install bash, then run:  \"$(brew --prefix 2>/dev/null || echo /opt/homebrew)/bin/bash\" $0 ${*:-}" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
shopt -s nocasematch

TARGET="${1:-all}"
case "$TARGET" in compose | k8s | all) ;; *)
  echo "usage: $0 [compose|k8s|all]" >&2
  exit 2
  ;;
esac

rand_hex() { # $1 = number of random bytes → 2×$1 hex characters
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Satisfies the password policy (upper, lower, digit, >= 10 chars) and is
# URL/shell-safe: "Sc" + 24 random hex chars + "x9Q".
admin_password() { printf 'Sc%sx9Q' "$(rand_hex 12)"; }

is_placeholder() {
  case "$1" in
    "" | *change*me* | *placeholder* | *dev_only* | *dev-only* | *dev_password* | *_dev | *_dev_* | password | secret | admin | guest | test | sentinel | postgres) return 0 ;;
  esac
  return 1
}

# Minimum length per secret; 0 = not a secret (kept as-is).
min_length() {
  case "$1" in
    JWT_ACCESS_SECRET | JWT_REFRESH_SECRET | RESILIENCE_CHAOS_TOKEN) echo 32 ;;
    POSTGRES_PASSWORD | *_DB_PASSWORD | REDIS_PASSWORD | RABBITMQ_PASSWORD | RABBITMQ_DEFAULT_PASS | GRAFANA_ADMIN_PASSWORD) echo 16 ;;
    DEFAULT_ADMIN_PASSWORD | SIMULATOR_PASSWORD | INTAKE_PASSWORD) echo 10 ;;
    *) echo 0 ;;
  esac
}

new_value() {
  case "$1" in
    # Phase 16/19: the simulator and intake service accounts follow the same password policy.
    DEFAULT_ADMIN_PASSWORD | SIMULATOR_PASSWORD | INTAKE_PASSWORD) admin_password ;;
    JWT_ACCESS_SECRET | JWT_REFRESH_SECRET | RESILIENCE_CHAOS_TOKEN) rand_hex 32 ;;
    *) rand_hex 16 ;;
  esac
}

needs_new() { # $1 key, $2 current value
  local min
  min="$(min_length "$1")"
  [ "$min" -eq 0 ] && return 1
  is_placeholder "$2" && return 0
  [ "${#2}" -lt "$min" ] && return 0
  if [ "$1" = "DEFAULT_ADMIN_PASSWORD" ] || [ "$1" = "SIMULATOR_PASSWORD" ] || [ "$1" = "INTAKE_PASSWORD" ]; then
    shopt -u nocasematch
    local weak=1
    [[ "$2" =~ [a-z] && "$2" =~ [A-Z] && "$2" =~ [0-9] ]] && weak=0
    shopt -s nocasematch
    [ "$weak" -eq 1 ] && return 0
  fi
  return 1
}

# Keys from earlier phases that held credentials and are no longer used.
OBSOLETE_KEYS=" RABBITMQ_URL POSTGRES_MULTIPLE_DATABASES "

generate() { # $1 example file, $2 target file
  local example="$1" target="$2" tmp key value line generated=() kept_extra=()
  declare -A current=()
  if [ -f "$target" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [[ "$line" =~ ^[[:space:]]*# || "$line" != *=* ]] && continue
      current["${line%%=*}"]="${line#*=}"
    done <"$target"
  fi

  tmp="$(mktemp "${target}.XXXXXX")"
  chmod 600 "$tmp"
  declare -A seen=()
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^[[:space:]]*# || "$line" != *=* ]]; then
      printf '%s\n' "$line" >>"$tmp"
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    [ -n "${current[$key]+set}" ] && value="${current[$key]}"
    seen["$key"]=1
    if needs_new "$key" "$value"; then
      value="$(new_value "$key")"
      generated+=("$key")
      [ "$key" = "DEFAULT_ADMIN_PASSWORD" ] && NEW_ADMIN_PASSWORD="$value"
    fi
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  done <"$example"

  # Settings the user added that the example doesn't know about are kept.
  for key in "${!current[@]}"; do
    [ -n "${seen[$key]+set}" ] && continue
    [[ "$OBSOLETE_KEYS" == *" $key "* ]] && continue
    kept_extra+=("$key")
  done
  if [ "${#kept_extra[@]}" -gt 0 ]; then
    printf '\n# Kept from your previous file:\n' >>"$tmp"
    for key in "${kept_extra[@]}"; do printf '%s=%s\n' "$key" "${current[$key]}" >>"$tmp"; done
  fi

  mv "$tmp" "$target"
  chmod 600 "$target"
  if [ "${#generated[@]}" -gt 0 ]; then
    echo ">>> $target: generated ${#generated[@]} secret(s): ${generated[*]}"
  else
    echo ">>> $target: all secrets already set — nothing changed"
  fi
}

NEW_ADMIN_PASSWORD=""
if [ "$TARGET" = compose ] || [ "$TARGET" = all ]; then
  generate .env.example .env
fi
if [ "$TARGET" = k8s ] || [ "$TARGET" = all ]; then
  generate k8s/overlays/local/secrets.env.example k8s/overlays/local/secrets.env
fi

if [ -n "$NEW_ADMIN_PASSWORD" ]; then
  # Same password in both files only if both were generated in this run;
  # each file keeps its own value otherwise. Shown once — it's in the file(s).
  echo
  echo "Bootstrap admin login (also stored in the file(s) above):"
  echo "  email:    admin@sentinelcloud.local (DEFAULT_ADMIN_EMAIL)"
  echo "  password: see DEFAULT_ADMIN_PASSWORD in the generated file"
fi
echo
echo "These files are secrets: they are gitignored — never commit or share them."
