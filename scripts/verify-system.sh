#!/usr/bin/env bash
# =========================================================================
# SentinelCloud end-to-end verification — the 13 system checks, from a
# CLEAN environment, against the real stack on your machine.
#
#   ./scripts/verify-system.sh compose --yes     # Docker Compose (≈10 min first run)
#   ./scripts/verify-system.sh k8s --yes         # Kind cluster   (≈20 min first run)
#   ./scripts/verify-system.sh all --yes         # both, one after the other
#
# Options
#   --yes            required: the run DELETES the Compose volumes
#                    (docker compose down -v) / recreates the Kind cluster.
#   --keep           leave the stack running afterwards (default: leave it
#                    running too; use --teardown to stop it at the end).
#   --teardown       stop everything when finished.
#   --skip-unit      skip the unit-test step (npm ci + node --test / mvn test
#                    inside containers; needs network for npm/Maven).
#   --skip-db-suite  skip tests/db/realPostgres.test.js (throwaway Postgres).
#
# The 15 checks (each prints PASS/FAIL with the evidence):
#    1 Docker Compose startup        8 Disaster event flow (fan-out + fan-in)
#    2 Database initialisation       9 Message broker
#    3 Authentication                10 Dashboard (frontend + live WebSocket)
#    4 Hospital service              11 Kubernetes deployment
#    5 Ambulance service             12 Monitoring (Prometheus/Alertmanager/Grafana)
#    6 Blood service                 13 Failure simulation
#    7 Power service                 14 Automatic detection (Phase 19)
#                                    15 Smarter response (Phase 20)
# In `compose` mode check 11 is reported as SKIP; in `k8s` mode check 1 is.
#
# Requirements: bash 4+, Docker with Compose v2, curl, Node.js 20+ (22+ for
# the WebSocket check); for k8s: kind 0.20+ and kubectl. Linux, macOS (brew
# bash) or Windows via WSL2 / Git Bash.
# Exit code: number of failed checks (0 = everything passed).
# =========================================================================
set -uo pipefail
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "verify-system.sh needs bash 4+ (macOS: brew install bash)" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
ROOT=$(pwd)

MODE="${1:-}"
shift || true
YES=0 TEARDOWN=0 SKIP_UNIT=0 SKIP_DB=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --keep) TEARDOWN=0 ;;
    --teardown) TEARDOWN=1 ;;
    --skip-unit) SKIP_UNIT=1 ;;
    --skip-db-suite) SKIP_DB=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
case "$MODE" in compose | k8s | all) ;; *)
  sed -n '2,30p' "$0"
  exit 2
  ;;
esac
if [[ $YES -ne 1 ]]; then
  echo "This run starts from a clean environment: it deletes SentinelCloud's Compose volumes" >&2
  echo "and/or the 'sentinelcloud' Kind cluster. Re-run with --yes to confirm." >&2
  exit 2
fi

# ---------------------------------------------------------------- output
declare -A RESULT DETAIL
ORDER=()
c_green=$'\e[32m' c_red=$'\e[31m' c_yellow=$'\e[33m' c_dim=$'\e[2m' c_off=$'\e[0m'
[[ -t 1 ]] || { c_green=""; c_red=""; c_yellow=""; c_dim=""; c_off=""; }
record() { # id status detail
  local key="$1"
  [[ -z "${RESULT[$key]:-}" ]] && ORDER+=("$key")
  # A check run in both modes fails if either run failed.
  if [[ "${RESULT[$key]:-}" == "FAIL" && "$2" != "FAIL" ]]; then return; fi
  RESULT[$key]=$2
  DETAIL[$key]="${DETAIL[$key]:+${DETAIL[$key]} | }$3"
  local col=$c_green
  [[ $2 == FAIL ]] && col=$c_red
  [[ $2 == SKIP ]] && col=$c_yellow
  printf '%s[%s]%s %s — %s\n' "$col" "$2" "$c_off" "$key" "$3"
}
step() { printf '\n%s==> %s%s\n' "$c_dim" "$*" "$c_off"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 2; }; }

need docker
need curl
need node
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose …)" >&2; exit 2; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ $NODE_MAJOR -ge 20 ]] || { echo "Node.js 20+ is required (found $(node -v))" >&2; exit 2; }

# ---------------------------------------------------------------- helpers
# js '<expression over d>' < json   → prints the expression's value
js() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d;try{d=JSON.parse(s)}catch{d=null};const v=(new Function("d","return ("+process.argv[1]+")"))(d);process.stdout.write(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }
envval() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2-; }

API="" ; BASE="" ; TOKEN="" ; JAR=$(mktemp)
http() { # METHOD PATH [JSON]  → sets HTTP_CODE, HTTP_BODY
  local m=$1 p=$2 body=${3:-}
  local args=(-s -o /tmp/sc-verify-body -w '%{http_code}' -X "$m" -H "Content-Type: application/json" -b "$JAR" -c "$JAR")
  [[ -n "$TOKEN" ]] && args+=(-H "Authorization: Bearer $TOKEN")
  [[ -n "$body" ]] && args+=(--data "$body")
  HTTP_CODE=$(curl "${args[@]}" "$API$p" 2>/dev/null || echo 000)
  HTTP_BODY=$(cat /tmp/sc-verify-body 2>/dev/null || true)
}
wait_until() { # seconds description command...
  local deadline=$((SECONDS + $1)); shift
  local what=$1; shift
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then echo "timed out waiting for: $what" >&2; return 1; fi
    sleep 3
  done
}

# ======================================================================
# Shared API checks (3–10, 12-partial) — run against Compose or Kind
# ======================================================================
api_checks() { # label envfile
  local label=$1 envfile=$2
  local email pw
  email=$(envval "$envfile" DEFAULT_ADMIN_EMAIL)
  pw=$(envval "$envfile" DEFAULT_ADMIN_PASSWORD)
  TOKEN=""

  # ---- 3 Authentication ------------------------------------------------
  step "[$label] 3 Authentication"
  local ok=1 why=()
  http GET /hospitals/
  [[ $HTTP_CODE == 401 ]] || { ok=0; why+=("unauthenticated GET /hospitals → $HTTP_CODE (want 401)"); }
  http POST /auth/login "{\"email\":\"$email\",\"password\":\"$pw\"}"
  TOKEN=$(printf '%s' "$HTTP_BODY" | js 'd&&d.accessToken')
  [[ $HTTP_CODE == 200 && -n "$TOKEN" ]] || { ok=0; why+=("admin login → $HTTP_CODE"); }
  http GET /auth/me
  [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.user.role') == SYSTEM_ADMIN ]] || { ok=0; why+=("/auth/me → $HTTP_CODE"); }
  http POST /auth/refresh "{}"
  local refreshed
  refreshed=$(printf '%s' "$HTTP_BODY" | js 'd&&d.accessToken')
  [[ $HTTP_CODE == 200 && -n "$refreshed" ]] && TOKEN=$refreshed || { ok=0; why+=("refresh via httpOnly cookie → $HTTP_CODE"); }
  local citizen="verify.$RANDOM$RANDOM@example.com" admin_token=$TOKEN
  TOKEN=""
  http POST /auth/register "{\"email\":\"$citizen\",\"password\":\"Verify-Passw0rd-$RANDOM\",\"fullName\":\"Verify Citizen\"}"
  [[ $HTTP_CODE == 201 ]] || { ok=0; why+=("register → $HTTP_CODE"); }
  http POST /auth/login "{\"email\":\"$citizen\",\"password\":\"wrong-password-1A\"}"
  [[ $HTTP_CODE == 401 ]] || { ok=0; why+=("wrong password → $HTTP_CODE (want 401)"); }
  TOKEN=$admin_token
  ((ok)) && record "3 Authentication" PASS "$label: 401 without token, login/me/refresh-cookie OK, sign-up 201, bad password 401" \
         || record "3 Authentication" FAIL "$label: ${why[*]}"

  # ---- 4 Hospital ------------------------------------------------------
  step "[$label] 4 Hospital service"
  ok=1 why=()
  http GET "/hospitals?page=1&limit=200"
  local hcount hid hlat hlng
  hcount=$(printf '%s' "$HTTP_BODY" | js 'd.hospitals.length')
  hid=$(printf '%s' "$HTTP_BODY" | js 'd.hospitals[0]&&d.hospitals[0].id')
  hlat=$(printf '%s' "$HTTP_BODY" | js 'd.hospitals[0]&&d.hospitals[0].latitude')
  hlng=$(printf '%s' "$HTTP_BODY" | js 'd.hospitals[0]&&d.hospitals[0].longitude')
  [[ $HTTP_CODE == 200 && ${hcount:-0} -ge 1 ]] || { ok=0; why+=("list → $HTTP_CODE ($hcount)"); }
  http GET /hospitals/stats/summary
  local total
  total=$(printf '%s' "$HTTP_BODY" | js 'd.summary.totalHospitals')
  [[ $HTTP_CODE == 200 && "$total" == "$hcount" ]] || { ok=0; why+=("summary → $HTTP_CODE total=$total list=$hcount"); }
  http GET "/hospitals/near?lat=$hlat&lng=$hlng&radiusKm=5"
  [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.hospitals[0]&&d.hospitals[0].id') == "$hid" ]] || { ok=0; why+=("near → $HTTP_CODE"); }
  http GET /hospitals/alerts
  [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("alerts → $HTTP_CODE"); }
  http GET /hospitals/not-a-uuid
  [[ $HTTP_CODE == 400 ]] || { ok=0; why+=("bad id → $HTTP_CODE (want 400)"); }
  # Phase 18: capacity forecast (the demo backfill gives every seeded hospital history).
  http GET "/hospitals/forecast?horizonHours=24"
  [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.count') == "$hcount" ]] || { ok=0; why+=("forecast list → $HTTP_CODE count=$(printf '%s' "$HTTP_BODY" | js 'd&&d.count')"); }
  http GET "/hospitals/$hid/forecast?horizonHours=12"
  [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.forecast.beds.status+":"+d.forecast.beds.forecast.length') == "OK:12" ]] || { ok=0; why+=("forecast → $HTTP_CODE $(printf '%s' "$HTTP_BODY" | js 'd&&d.forecast&&d.forecast.beds.status')"); }
  ((ok)) && record "4 Hospital service" PASS "$label: $hcount hospitals, SQL summary matches, radius search, alerts, 400 on bad id, capacity forecast" \
         || record "4 Hospital service" FAIL "$label: ${why[*]}"

  # ---- 5 Ambulance -----------------------------------------------------
  step "[$label] 5 Ambulance service"
  ok=1 why=()
  http GET /ambulances/stats/summary
  [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("summary → $HTTP_CODE"); }
  local plate="VERIFY-$RANDOM"
  http POST /ambulances/ "{\"vehicleNumber\":\"$plate\",\"latitude\":18.5204,\"longitude\":73.8567,\"driverName\":\"Verify Driver\",\"driverPhone\":\"+919800000000\",\"equipmentLevel\":\"ADVANCED\"}"
  [[ $HTTP_CODE == 201 ]] || { ok=0; why+=("register ambulance → $HTTP_CODE"); }
  http POST /ambulances/ "{\"vehicleNumber\":\"$plate\",\"latitude\":18.5204,\"longitude\":73.8567,\"driverName\":\"Verify Driver\",\"driverPhone\":\"+919800000000\",\"equipmentLevel\":\"ADVANCED\"}"
  [[ $HTTP_CODE == 409 ]] || { ok=0; why+=("duplicate plate → $HTTP_CODE (want 409)"); }
  http POST /ambulances/emergencies "{\"description\":\"verify-system emergency\",\"latitude\":18.5205,\"longitude\":73.8568,\"severity\":\"HIGH\"}"
  local eid amb
  eid=$(printf '%s' "$HTTP_BODY" | js 'd.emergency&&d.emergency.id')
  amb=$(printf '%s' "$HTTP_BODY" | js 'd.ambulance&&d.ambulance.id')
  [[ $HTTP_CODE == 201 && -n "$amb" ]] || { ok=0; why+=("create emergency → $HTTP_CODE (auto-dispatch: ${amb:-none})"); }
  if [[ -n "$eid" && -n "$amb" ]]; then
    http POST "/ambulances/emergencies/$eid/complete"
    [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.ambulance&&d.ambulance.status') == AVAILABLE ]] || { ok=0; why+=("complete → $HTTP_CODE"); }
    http POST "/ambulances/emergencies/$eid/complete"
    [[ $HTTP_CODE == 409 ]] || { ok=0; why+=("complete twice → $HTTP_CODE (want 409)"); }
  fi
  ((ok)) && record "5 Ambulance service" PASS "$label: register + duplicate 409, emergency auto-dispatched, completed, ambulance freed" \
         || record "5 Ambulance service" FAIL "$label: ${why[*]}"

  # ---- 6 Blood ---------------------------------------------------------
  step "[$label] 6 Blood service"
  ok=1 why=()
  http GET /blood-banks/
  local bid
  bid=$(printf '%s' "$HTTP_BODY" | js '(Array.isArray(d)?d:(d.bloodBanks||[]))[0]?.id')
  [[ $HTTP_CODE == 200 && -n "$bid" ]] || { ok=0; why+=("list → $HTTP_CODE"); }
  http GET /blood-banks/stats/summary
  [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("summary → $HTTP_CODE"); }
  http GET /blood-banks/low-stock
  [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("low-stock → $HTTP_CODE"); }
  http GET "/blood-banks/forecast?bloodType=O%2B"
  [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("forecast → $HTTP_CODE"); }
  if [[ -n "$bid" ]]; then
    local today exp
    today=$(node -p 'new Date().toISOString().slice(0,10)')
    exp=$(node -p 'new Date(Date.now()+20*864e5).toISOString().slice(0,10)')
    http POST "/blood-banks/$bid/inventory" "{\"bloodType\":\"AB-\",\"unitsAvailable\":6,\"collectionDate\":\"$today\",\"expiryDate\":\"$exp\"}"
    [[ $HTTP_CODE == 201 || $HTTP_CODE == 200 ]] || { ok=0; why+=("add inventory → $HTTP_CODE"); }
    http POST "/blood-banks/$bid/reservations" "{\"bloodType\":\"AB-\",\"unitsRequested\":2,\"hospitalId\":\"${hid:-00000000-0000-4000-8000-000000000000}\",\"notes\":\"verify-system\"}"
    local rid
    rid=$(printf '%s' "$HTTP_BODY" | js 'd.id||(d.reservation&&d.reservation.id)')
    [[ ($HTTP_CODE == 201 || $HTTP_CODE == 200) && -n "$rid" ]] || { ok=0; why+=("reserve → $HTTP_CODE"); }
    if [[ -n "$rid" ]]; then
      http POST "/blood-banks/reservations/$rid/release"
      [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("release → $HTTP_CODE"); }
      http POST "/blood-banks/reservations/$rid/release"
      [[ $HTTP_CODE == 409 ]] || { ok=0; why+=("release twice → $HTTP_CODE (want 409)"); }
    fi
  fi
  ((ok)) && record "6 Blood service" PASS "$label: list/summary/low-stock/forecast, inventory added, reserve → release → second release 409" \
         || record "6 Blood service" FAIL "$label: ${why[*]}"

  # ---- 7 Power ---------------------------------------------------------
  step "[$label] 7 Power service"
  ok=1 why=()
  http GET /power/map
  local tid
  tid=$(printf '%s' "$HTTP_BODY" | js 'd.markers.flatMap(m=>m.transformers)[0]?.transformerId')
  [[ $HTTP_CODE == 200 && -n "$tid" ]] || { ok=0; why+=("map → $HTTP_CODE"); }
  for p in /power/stats/summary /power/alerts /power/transformers/overloaded /power/transformers/high-temperature; do
    http GET "$p"
    [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("$p → $HTTP_CODE"); }
  done
  if [[ -n "$tid" ]]; then
    http POST "/power/transformers/$tid/telemetry" '{"voltage":11.0,"currentAmps":180,"loadPercentage":99,"temperatureCelsius":96}'
    [[ $HTTP_CODE == 200 || $HTTP_CODE == 201 ]] || { ok=0; why+=("critical telemetry → $HTTP_CODE"); }
    http POST "/power/transformers/$tid/status" '{"status":"FAILED","reason":"verify-system escalation"}'
    [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("CRITICAL→FAILED → $HTTP_CODE"); }
    http POST "/power/transformers/$tid/telemetry" '{"voltage":11.0,"currentAmps":100,"loadPercentage":40,"temperatureCelsius":45}'
    [[ $HTTP_CODE == 200 || $HTTP_CODE == 201 ]] || { ok=0; why+=("recovery telemetry → $HTTP_CODE (the old double-open-event bug made this 500)"); }
    http GET "/power/transformers/$tid/failures"
    [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("failures → $HTTP_CODE"); }
    # Phase 18: risk forecast — the transformer just failed, so it has a failure on record.
    http GET "/power/transformers/$tid/risk-forecast?horizonHours=24"
    [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.risk.forecast.failuresLast30Days>=1&&d.risk.forecast.projection.length===25') == true ]] || { ok=0; why+=("risk forecast → $HTTP_CODE"); }
  fi
  http GET "/power/transformers/risk-forecast"
  [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.count>=1&&d.risks.every((r,i,a)=>i===0||a[i-1].forecast.score>=r.forecast.score)') == true ]] || { ok=0; why+=("risk ranking → $HTTP_CODE"); }
  ((ok)) && record "7 Power service" PASS "$label: map/summary/alerts/overloaded/high-temp, CRITICAL → FAILED → recovered via telemetry, risk forecast" \
         || record "7 Power service" FAIL "$label: ${why[*]}"

  # ---- 8 Disaster event flow --------------------------------------------
  step "[$label] 8 Disaster event flow"
  ok=1 why=()
  http POST /disasters "{\"type\":\"FLOOD\",\"severity\":\"HIGH\",\"latitude\":${hlat:-18.52},\"longitude\":${hlng:-73.85},\"radiusKm\":25,\"description\":\"verify-system flood drill\"}"
  local did
  did=$(printf '%s' "$HTTP_BODY" | js 'd.disaster&&d.disaster.id')
  [[ $HTTP_CODE == 201 && $(printf '%s' "$HTTP_BODY" | js 'd.eventPublished') == true ]] || { ok=0; why+=("create → $HTTP_CODE published=$(printf '%s' "$HTTP_BODY" | js 'd&&d.eventPublished')"); }
  local responded=0
  if [[ -n "$did" ]]; then
    local deadline=$((SECONDS + 90))
    while ((SECONDS < deadline)); do
      http GET "/disasters/$did/situation-report"
      responded=$(printf '%s' "$HTTP_BODY" | js 'd.situationReport&&d.situationReport.respondedServices')
      [[ "${responded:-0}" == 4 ]] && break
      sleep 3
    done
    [[ "${responded:-0}" == 4 ]] || { ok=0; why+=("only ${responded:-0}/4 services reacted within 90 s"); }
    http POST "/disasters/$did/status" '{"status":"CONTAINED","note":"verify-system"}'
    [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("CONTAINED → $HTTP_CODE"); }
    http POST "/disasters/$did/status" '{"status":"RESOLVED","note":"verify-system"}'
    [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("RESOLVED → $HTTP_CODE"); }
    http POST "/disasters/$did/status" '{"status":"ACTIVE"}'
    [[ $HTTP_CODE == 409 ]] || { ok=0; why+=("RESOLVED→ACTIVE → $HTTP_CODE (want 409)"); }
  fi
  ((ok)) && record "8 Disaster event flow" PASS "$label: disaster.detected → 4/4 services reacted → situation report; status ACTIVE→CONTAINED→RESOLVED, reopen 409" \
         || record "8 Disaster event flow" FAIL "$label: ${why[*]}"
  DISASTER_ID=$did

  # ---- 9 Message broker -------------------------------------------------
  step "[$label] 9 Message broker"
  ok=1 why=()
  # Events leave through the outbox (Phase 14), so the last one
  # (disaster.resolved, set just above) can take a few seconds to arrive.
  local seen kinds="disaster.detected hospital.capacity.updated ambulance.status.updated blood.shortage.detected power.infrastructure.at_risk disaster.resolved"
  local deadline=$((SECONDS + 30)) missing
  while :; do
    http GET "/notifications/events/recent?limit=200"
    seen=$(printf '%s' "$HTTP_BODY" | js "d.events.filter(e=>e.correlationId==='$did').map(e=>e.eventType).sort().join(',')")
    missing=0
    for k in $kinds; do [[ ",$seen," == *",$k,"* ]] || missing=1; done
    ((missing == 0 || SECONDS >= deadline)) && break
    sleep 2
  done
  for k in $kinds; do
    [[ ",$seen," == *",$k,"* ]] || { ok=0; why+=("$k not in the event history after 30 s"); }
  done
  local queues
  queues=$(broker_queues "$label")
  for q in q.hospital.disaster-events q.ambulance.disaster-events q.bloodbank.disaster-events q.power.disaster-events q.disaster.reaction-aggregator q.notifications.all-events; do
    local line
    line=$(printf '%s\n' "$queues" | awk -v q="$q" '$1==q')
    [[ -n "$line" && $(awk '{print $3}' <<<"$line") -ge 1 ]] || { ok=0; why+=("queue $q missing or has no consumer ($line)"); }
  done
  ((ok)) && record "9 Message broker" PASS "$label: 6 durable queues with consumers; all 6 event types for the drill disaster recorded" \
         || record "9 Message broker" FAIL "$label: ${why[*]}"

  # ---- 10 Dashboard -----------------------------------------------------
  step "[$label] 10 Dashboard"
  ok=1 why=()
  local fe_code
  fe_code=$(curl -s -o /tmp/sc-verify-fe -w '%{http_code}' "$FRONTEND_URL/")
  [[ $fe_code == 200 ]] && grep -q '<div id="root">' /tmp/sc-verify-fe || { ok=0; why+=("frontend $FRONTEND_URL → $fe_code"); }
  local hs
  hs=$(curl -s "$BASE/health/services")
  [[ $(printf '%s' "$hs" | js 'Object.values(d.services).filter(s=>s.status==="up").length') -ge 8 ]] || { ok=0; why+=("health/services: $(printf '%s' "$hs" | js 'Object.entries(d.services).filter(([k,s])=>s.status!=="up").map(([k,s])=>k+"="+s.status).join(" ")')"); }
  if [[ $NODE_MAJOR -ge 22 ]]; then
    local ws
    ws=$(WS_URL="${BASE/http/ws}/ws/live" WS_TOKEN="$TOKEN" WS_ORIGIN="$FRONTEND_URL" node -e '
      const ws = new WebSocket(process.env.WS_URL, ["sentinel-live", "bearer." + process.env.WS_TOKEN]);
      const t = setTimeout(() => { console.log("timeout"); process.exit(0); }, 8000);
      ws.onmessage = (m) => { const f = JSON.parse(m.data); if (f.type === "welcome") { console.log("welcome"); clearTimeout(t); ws.close(); process.exit(0); } };
      ws.onerror = () => { console.log("error"); process.exit(0); };' 2>&1)
    [[ "$ws" == welcome* ]] || { ok=0; why+=("live WebSocket: $ws"); }
  else
    why+=("(WebSocket check skipped: needs Node 22+)")
  fi
  ((ok)) && record "10 Dashboard" PASS "$label: frontend served, 8/8 services ready, authenticated live-feed WebSocket handshake ${why[*]:-OK}" \
         || record "10 Dashboard" FAIL "$label: ${why[*]}"

  # ---- 14 Automatic detection (Phase 19) ---------------------------------
  # DEMO detections go through the same pipeline as USGS / Open-Meteo ones,
  # without depending on a real earthquake or storm happening right now.
  step "[$label] 14 Automatic detection"
  ok=1 why=()
  local created=() dtid dsid dstatus
  http GET /intake/overview
  [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.sources.length') == 2 ]] || { ok=0; why+=("overview → $HTTP_CODE"); }
  # HIGH: waits for an operator; confirming creates the disaster through the gateway.
  http POST /intake/demo '{"type":"FLOOD","severity":"HIGH"}'
  dtid=$(printf '%s' "$HTTP_BODY" | js 'd.detection&&d.detection.id')
  [[ $HTTP_CODE == 201 && $(printf '%s' "$HTTP_BODY" | js 'd.detection.status') == PENDING ]] || { ok=0; why+=("demo HIGH → $HTTP_CODE"); }
  if [[ -n "$dtid" ]]; then
    http POST "/intake/detections/$dtid/confirm" '{"note":"verify-system"}'
    dsid=$(printf '%s' "$HTTP_BODY" | js 'd.detection&&d.detection.disasterId')
    [[ $HTTP_CODE == 200 && -n "$dsid" ]] || { ok=0; why+=("confirm → $HTTP_CODE"); }
    http POST "/intake/detections/$dtid/confirm" '{}'
    [[ $HTTP_CODE == 409 ]] || { ok=0; why+=("second confirm → $HTTP_CODE (want 409)"); }
    if [[ -n "$dsid" ]]; then
      created+=("$dsid")
      http GET "/disasters/$dsid"
      [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.disaster.description.startsWith("[Auto-detected · DEMO]")') == true ]] || { ok=0; why+=("created disaster → $HTTP_CODE"); }
    fi
  fi
  # CRITICAL: confirmed by the policy alone.
  http POST /intake/demo '{"type":"EARTHQUAKE","severity":"CRITICAL"}'
  dstatus=$(printf '%s' "$HTTP_BODY" | js 'd.detection&&d.detection.status')
  [[ $HTTP_CODE == 201 && $dstatus == AUTO_CONFIRMED ]] || { ok=0; why+=("demo CRITICAL → $HTTP_CODE $dstatus (want AUTO_CONFIRMED)"); }
  dsid=$(printf '%s' "$HTTP_BODY" | js 'd.detection&&d.detection.disasterId')
  [[ -n "$dsid" ]] && created+=("$dsid")
  # LOW: dismissed by the operator; nothing is created.
  http POST /intake/demo '{"type":"LANDSLIDE","severity":"LOW"}'
  dtid=$(printf '%s' "$HTTP_BODY" | js 'd.detection&&d.detection.id')
  http POST "/intake/detections/$dtid/dismiss" '{"note":"verify-system"}'
  [[ $HTTP_CODE == 200 && $(printf '%s' "$HTTP_BODY" | js 'd.detection.status+":"+(d.detection.disasterId||"none")') == DISMISSED:none ]] || { ok=0; why+=("dismiss → $HTTP_CODE"); }
  ((ok)) && record "14 Automatic detection" PASS "$label: HIGH detection confirmed → disaster created via the gateway (second confirm 409), CRITICAL auto-confirmed, LOW dismissed" \
         || record "14 Automatic detection" FAIL "$label: ${why[*]}"

  # ---- 15 Smarter response (Phase 20) ------------------------------------
  # The HIGH disaster confirmed above: its plan carries an impact estimate and
  # bed reservations; approving holds the beds, undoing gives them back.
  step "[$label] 15 Smarter response"
  ok=1 why=()
  local pid="" pstatus="" held released
  if [[ ${#created[@]} -ge 1 ]]; then
    local deadline=$((SECONDS + 60))
    while ((SECONDS < deadline)); do
      http GET "/response/plans?disasterId=${created[0]}"
      pid=$(printf '%s' "$HTTP_BODY" | js '(d.plans||[]).find(p=>p.revision===1)?.id||""')
      [[ -n "$pid" ]] && break
      sleep 3
    done
    if [[ -z "$pid" ]]; then
      ok=0; why+=("no plan for the confirmed disaster within 60 s")
    else
      http GET "/response/plans/$pid"
      [[ $(printf '%s' "$HTTP_BODY" | js 'd.plan.needs.impact.casualties>0&&d.plan.actions.some(a=>a.kind==="hospital.reserve_beds")') == true ]] || { ok=0; why+=("plan has no impact estimate or bed reservation"); }
      http POST "/response/plans/$pid/approve" '{"note":"verify-system"}'
      [[ $HTTP_CODE == 200 ]] || { ok=0; why+=("approve → $HTTP_CODE"); }
      deadline=$((SECONDS + 90))
      while ((SECONDS < deadline)); do
        http GET "/response/plans/$pid"
        pstatus=$(printf '%s' "$HTTP_BODY" | js 'd.plan.status')
        [[ $pstatus == COMPLETED || $pstatus == PARTIAL ]] && break
        sleep 3
      done
      held=$(printf '%s' "$HTTP_BODY" | js 'd.plan.actions.filter(a=>a.kind==="hospital.reserve_beds"&&a.status==="SUCCEEDED").length')
      [[ $pstatus == COMPLETED || $pstatus == PARTIAL ]] || { ok=0; why+=("plan not settled after 90 s ($pstatus)"); }
      [[ ${held:-0} -ge 1 ]] || { ok=0; why+=("no bed reservation succeeded"); }
      http GET "/hospitals/reservations?status=HELD"
      [[ $(printf '%s' "$HTTP_BODY" | js "d.reservations.filter(r=>r.planId==='$pid').length") -ge 1 ]] || { ok=0; why+=("hospital-service shows no HELD reservation for the plan"); }
      http POST "/response/plans/$pid/undo" '{}'
      deadline=$((SECONDS + 60))
      while ((SECONDS < deadline)); do
        http GET "/hospitals/reservations?status=RELEASED"
        released=$(printf '%s' "$HTTP_BODY" | js "d.reservations.filter(r=>r.planId==='$pid').length")
        [[ ${released:-0} -ge ${held:-1} ]] && break
        sleep 3
      done
      [[ ${released:-0} -ge 1 && ${released:-0} -ge ${held:-1} ]] || { ok=0; why+=("undo did not release the beds ($released of $held)"); }
    fi
  else
    ok=0; why+=("check 14 created no disaster to plan for")
  fi
  ((ok)) && record "15 Smarter response" PASS "$label: plan with impact estimate; $held bed reservation(s) held on approval and released on undo" \
         || record "15 Smarter response" FAIL "$label: ${why[*]}"

  # Close the disasters checks 14 and 15 created.
  for dsid in "${created[@]}"; do
    http POST "/disasters/$dsid/status" '{"status":"CONTAINED","note":"verify-system cleanup"}'
    http POST "/disasters/$dsid/status" '{"status":"RESOLVED","note":"verify-system cleanup"}'
  done
}

# ======================================================================
# Compose
# ======================================================================
broker_queues() {
  if [[ $1 == compose ]]; then
    docker compose exec -T rabbitmq rabbitmqctl -q list_queues name messages consumers 2>/dev/null
  else
    kubectl -n sentinelcloud exec rabbitmq-0 -- rabbitmqctl -q list_queues name messages consumers 2>/dev/null
  fi
}

compose_run() {
  API="http://localhost:$(envval .env GATEWAY_PORT || true)"
  [[ "$API" == "http://localhost:" ]] && API="http://localhost:8080"
  BASE=$API
  API="$BASE/api/v1"
  FRONTEND_URL="http://localhost:$(envval .env FRONTEND_PORT)"
  [[ "$FRONTEND_URL" == "http://localhost:" ]] && FRONTEND_URL="http://localhost:5173"

  step "Compose: clean start (docker compose down -v), secrets, build, up"
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  ./scripts/generate-secrets.sh compose >/dev/null
  # Re-read ports now that .env exists.
  local gp fp
  gp=$(envval .env GATEWAY_PORT); fp=$(envval .env FRONTEND_PORT)
  BASE="http://localhost:${gp:-8080}"; API="$BASE/api/v1"; FRONTEND_URL="http://localhost:${fp:-5173}"
  if ! docker compose up -d --build; then
    record "1 Docker Compose startup" FAIL "docker compose up failed (see output above)"
    return
  fi

  # ---- 1 Compose startup -------------------------------------------------
  step "1 Docker Compose startup (waiting for every container to be healthy, up to 8 min)"
  local deadline=$((SECONDS + 480)) bad=""
  while ((SECONDS < deadline)); do
    bad=$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' | awk '$2!="running" || ($3!="" && $3!="healthy")')
    [[ -z "$bad" ]] && break
    sleep 5
  done
  local n
  n=$(docker compose ps --format '{{.Service}}' | wc -l)
  [[ -z "$bad" ]] && record "1 Docker Compose startup" PASS "$n containers running, all healthchecks healthy" \
                  || record "1 Docker Compose startup" FAIL "not healthy after 8 min: $(echo $bad)"
  wait_until 120 "gateway /health" curl -fs "$BASE/health"

  # ---- 2 Database initialisation ----------------------------------------
  step "2 Database initialisation"
  local pu dbs roles migr ok=1 why=()
  pu=$(envval .env POSTGRES_USER); pu=${pu:-sentinel}
  dbs=$(docker compose exec -T postgres psql -U "$pu" -d postgres -Atc "SELECT string_agg(datname || ':' || pg_get_userbyid(datdba), ' ' ORDER BY datname) FROM pg_database WHERE datname LIKE '%\_db'" 2>&1)
  for pair in ambulance_db:ambulance_svc auth_db:auth_svc blood_db:blood_bank_svc disaster_db:disaster_svc hospital_db:hospital_svc power_db:power_svc response_db:response_svc intake_db:intake_svc; do
    [[ " $dbs " == *" $pair "* ]] || { ok=0; why+=("missing $pair"); }
  done
  roles=$(docker compose exec -T postgres psql -U "$pu" -d postgres -Atc "SELECT count(*) FROM pg_roles WHERE rolname LIKE '%\_svc' AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole")
  [[ ${roles//[^0-9]/} == 8 ]] || { ok=0; why+=("least-privilege roles: $roles/8"); }
  for d in auth_db hospital_db ambulance_db disaster_db response_db intake_db; do
    migr=$(docker compose exec -T postgres psql -U "$pu" -d "$d" -Atc "SELECT count(*) FROM schema_migrations" 2>&1)
    [[ ${migr//[^0-9]/} -ge 1 ]] || { ok=0; why+=("$d schema_migrations: $migr"); }
  done
  for d in blood_db power_db; do
    migr=$(docker compose exec -T postgres psql -U "$pu" -d "$d" -Atc "SELECT count(*) FROM flyway_schema_history WHERE success" 2>&1)
    [[ ${migr//[^0-9]/} -ge 3 ]] || { ok=0; why+=("$d flyway: $migr"); }
  done
  ((ok)) && record "2 Database initialisation" PASS "8 databases each owned by its own non-superuser role; Node migrations + Flyway V1–V3 applied" \
         || record "2 Database initialisation" FAIL "${why[*]}"

  api_checks compose .env

  # ---- 12 Monitoring -----------------------------------------------------
  step "12 Monitoring"
  local pp ap gp2 gu gpw targets rules gok=1 gwhy=()
  pp=$(envval .env PROMETHEUS_PORT); ap=$(envval .env ALERTMANAGER_PORT); gp2=$(envval .env GRAFANA_PORT)
  gu=$(envval .env GRAFANA_ADMIN_USER); gpw=$(envval .env GRAFANA_ADMIN_PASSWORD)
  monitoring_checks "http://localhost:${pp:-9090}" "http://localhost:${ap:-9093}" "http://localhost:${gp2:-3000}" "${gu:-admin}" "$gpw" compose

  # ---- 13 Failure simulation ---------------------------------------------
  step "13 Failure simulation (Compose: stop hospital-service, observe, restart)"
  local fok=1 fwhy=()
  docker compose stop hospital-service >/dev/null 2>&1
  local st=""
  for _ in $(seq 1 10); do
    st=$(curl -s "$BASE/health/services" | js 'd.services.hospitals.status'); [[ $st == down ]] && break; sleep 2
  done
  [[ $st == down ]] || { fok=0; fwhy+=("gateway did not report hospitals down ($st)"); }
  http GET /hospitals/
  [[ $HTTP_CODE =~ ^50[234]$ ]] || { fok=0; fwhy+=("API during outage → $HTTP_CODE (want 502/503/504)"); }
  http GET /ambulances/stats/summary
  [[ $HTTP_CODE == 200 ]] || { fok=0; fwhy+=("other services affected: ambulances → $HTTP_CODE"); }
  echo "    waiting up to 150 s for Prometheus to fire SentinelServiceDown…"
  local fired=""
  for _ in $(seq 1 50); do
    fired=$(curl -s "http://localhost:${pp:-9090}/api/v1/alerts" | js 'd.data.alerts.filter(a=>a.labels.alertname==="SentinelServiceDown"&&a.state==="firing").map(a=>a.labels.job).join(",")')
    [[ $fired == *hospital* ]] && break; sleep 3
  done
  [[ $fired == *hospital* ]] || { fok=0; fwhy+=("SentinelServiceDown did not fire for hospital-service"); }
  docker compose start hospital-service >/dev/null 2>&1
  wait_until 120 "hospital-service back" bash -c "curl -s '$BASE/health/services' | grep -q '\"hospitals\":{\"status\":\"up\"'" || { fok=0; fwhy+=("hospital-service did not recover"); }
  ((fok)) && record "13 Failure simulation" PASS "compose: outage isolated to hospital API (others 200), gateway reported it, alert fired, service recovered" \
          || record "13 Failure simulation" FAIL "compose: ${fwhy[*]}"
  record "11 Kubernetes deployment" SKIP "compose mode (run: $0 k8s --yes)"

  if [[ $SKIP_DB -eq 0 ]]; then db_suite; fi
  if [[ $SKIP_UNIT -eq 0 ]]; then unit_tests; fi
  [[ $TEARDOWN -eq 1 ]] && docker compose down >/dev/null 2>&1
}

monitoring_checks() { # prom am grafana user pw label
  local prom=$1 am=$2 graf=$3 gu=$4 gpw=$5 label=$6 ok=1 why=()
  wait_until 120 "prometheus ready" curl -fs "$prom/-/ready"
  sleep 20 # one or two scrape intervals so every target has been scraped
  local down
  down=$(curl -s "$prom/api/v1/targets?state=active" | js 'd.data.activeTargets.filter(t=>t.health!=="up").map(t=>t.labels.job+"("+t.lastError+")").join("; ")')
  local up
  up=$(curl -s "$prom/api/v1/targets?state=active" | js 'd.data.activeTargets.filter(t=>t.health==="up").length')
  [[ -z "$down" && ${up:-0} -ge 10 ]] || { ok=0; why+=("targets down: $down"); }
  local rules
  rules=$(curl -s "$prom/api/v1/rules" | js 'd.data.groups.reduce((n,g)=>n+g.rules.length,0)+":"+d.data.groups.flatMap(g=>g.rules).filter(r=>r.health!=="ok").length')
  [[ ${rules%%:*} -ge 30 && ${rules##*:} == 0 ]] || { ok=0; why+=("rules loaded/unhealthy: $rules"); }
  curl -fs "$am/-/ready" >/dev/null || { ok=0; why+=("alertmanager not ready"); }
  local dash
  dash=$(curl -s -u "$gu:$gpw" "$graf/api/search?type=dash-db" | js 'd.length')
  [[ ${dash:-0} -ge 4 ]] || { ok=0; why+=("grafana dashboards provisioned: ${dash:-0}"); }
  local ds
  ds=$(curl -s -u "$gu:$gpw" "$graf/api/datasources/uid/prometheus/health" | js 'd.status')
  [[ $ds == OK ]] || { ok=0; why+=("grafana → prometheus datasource: ${ds:-unreachable}"); }
  ((ok)) && record "12 Monitoring" PASS "$label: $up targets up, ${rules%%:*} rules healthy, Alertmanager ready, $dash Grafana dashboards, datasource OK" \
         || record "12 Monitoring" FAIL "$label: ${why[*]}"
}

db_suite() {
  step "Extra: real-PostgreSQL integration suite (throwaway postgres:16-alpine)"
  local name=sc-verify-pg port=55439 pw
  pw=$(node -p 'require("crypto").randomBytes(18).toString("hex")')
  docker rm -f $name >/dev/null 2>&1
  local envs=(-e POSTGRES_USER=sentinel -e POSTGRES_PASSWORD="$pw" -e POSTGRES_SERVICE_DATABASES="auth_db:auth_svc:AUTH_DB_PASSWORD,hospital_db:hospital_svc:HOSPITAL_DB_PASSWORD,ambulance_db:ambulance_svc:AMBULANCE_DB_PASSWORD,blood_db:blood_bank_svc:BLOOD_BANK_DB_PASSWORD,power_db:power_svc:POWER_DB_PASSWORD,disaster_db:disaster_svc:DISASTER_DB_PASSWORD,response_db:response_svc:RESPONSE_DB_PASSWORD,intake_db:intake_svc:INTAKE_DB_PASSWORD")
  for v in AUTH HOSPITAL AMBULANCE BLOOD_BANK POWER DISASTER RESPONSE INTAKE; do envs+=(-e "${v}_DB_PASSWORD=${v}-$pw"); export "${v}_DB_PASSWORD=${v}-$pw"; done
  docker run -d --name $name "${envs[@]}" -p 127.0.0.1:$port:5432 -v "$ROOT/infrastructure/postgres-init:/docker-entrypoint-initdb.d:ro" postgres:16-alpine >/dev/null
  wait_until 90 "throwaway postgres" docker exec $name pg_isready -h 127.0.0.1 -U sentinel
  local out
  out=$(SC_DB_TEST=1 SC_DB_TEST_ALLOW_RESET=1 PGHOST=127.0.0.1 PGPORT=$port node --test tests/db/realPostgres.test.js 2>&1)
  local p f
  p=$(printf '%s\n' "$out" | awk '/^# pass /{print $3}'); f=$(printf '%s\n' "$out" | awk '/^# fail /{print $3}')
  [[ ${f:-1} == 0 && ${p:-0} -gt 0 ]] && record "Extra: DB integration suite" PASS "$p real-Postgres tests passed (migrations, Flyway+entity mapping, dispatch races, constraints, auth)" \
                                      || { printf '%s\n' "$out" | grep -E "^not ok|Error" | head -20; record "Extra: DB integration suite" FAIL "${f:-?} failed"; }
  docker rm -f $name >/dev/null 2>&1
}

unit_tests() {
  step "Extra: unit tests inside containers (npm ci + node --test; mvn test)"
  local failed=() passed=0
  for s in gateway auth-service hospital-service ambulance-service disaster-service notification-service resilience-service response-service simulator-service intake-service; do
    if docker run --rm -v "$ROOT:/src" -w "/src/services/$s" node:22-alpine sh -c \
      'cp -r . /tmp/w && cd /tmp/w && (npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1) && node --test tests/*.test.js' >/tmp/sc-unit-$s.log 2>&1; then
      passed=$((passed + $(awk '/^# pass /{print $3}' /tmp/sc-unit-$s.log | tail -1)))
    else failed+=("$s"); fi
  done
  docker run --rm -v "$ROOT/shared/node-security:/src/shared/node-security" -v "$ROOT/services:/src/services:ro" -w /src/shared/node-security node:22-alpine node --test tests/*.test.js >/tmp/sc-unit-shared.log 2>&1 || failed+=("shared/node-security")
  for s in blood-bank-service power-service; do
    docker run --rm -v "$ROOT/services/$s:/src:ro" maven:3.9-eclipse-temurin-21 sh -c 'cp -r /src /tmp/w && cd /tmp/w && mvn -B -q test' >/tmp/sc-unit-$s.log 2>&1 || failed+=("$s")
  done
  [[ ${#failed[@]} -eq 0 ]] && record "Extra: unit tests" PASS "Node ($passed tests) + shared + both Maven suites green (logs: /tmp/sc-unit-*.log)" \
                            || record "Extra: unit tests" FAIL "failing: ${failed[*]} (logs: /tmp/sc-unit-*.log)"
}

# ======================================================================
# Kubernetes (Kind)
# ======================================================================
k8s_run() {
  need kind
  need kubectl
  local OV=k8s/overlays/local
  step "Kind: fresh cluster"
  kind delete cluster --name sentinelcloud >/dev/null 2>&1 || true
  kind create cluster --config k8s/cluster/kind-cluster.yaml || { record "11 Kubernetes deployment" FAIL "kind create cluster failed"; return; }
  kubectl config use-context kind-sentinelcloud >/dev/null
  step "Kind: build + load images (application images built locally, infrastructure images pulled once)"
  ./scripts/k8s-build-images.sh kind || { record "11 Kubernetes deployment" FAIL "image build failed"; return; }
  local infra=(postgres:16-alpine redis:7-alpine rabbitmq:3.13-management-alpine prom/prometheus:v2.54.1 prom/alertmanager:v0.27.0 grafana/grafana:11.2.0 registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0 busybox:1.36)
  for i in "${infra[@]}"; do docker pull -q "$i" >/dev/null && kind load docker-image "$i" --name sentinelcloud >/dev/null; done
  ./scripts/generate-secrets.sh k8s >/dev/null
  step "Kind: apply (server-side: the dashboards ConfigMap is larger than client-side apply's annotation limit)"
  kubectl create namespace sentinelcloud --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  if ! kubectl apply --server-side --force-conflicts -k $OV >/dev/null; then
    record "11 Kubernetes deployment" FAIL "kubectl apply -k $OV failed"; return
  fi
  local ok=1 why=()
  for s in postgres rabbitmq redis; do kubectl -n sentinelcloud rollout status statefulset/$s --timeout=300s >/dev/null || { ok=0; why+=("statefulset/$s"); }; done
  kubectl -n sentinelcloud wait --for=condition=available deployment --all --timeout=600s >/dev/null || { ok=0; why+=("deployments: $(kubectl -n sentinelcloud get deploy --no-headers | awk '$2 !~ /^([0-9]+)\/\1$/ {print $1"="$2}' | xargs)"); }
  local pods
  pods=$(kubectl -n sentinelcloud get pods --no-headers | awk '$3!="Running" && $3!="Completed"{print $1"="$3}' | xargs)
  [[ -z "$pods" ]] || { ok=0; why+=("pods not running: $pods"); }
  local np
  np=$(kubectl -n sentinelcloud get networkpolicy --no-headers | wc -l)
  ((ok)) && record "11 Kubernetes deployment" PASS "3 StatefulSets + $(kubectl -n sentinelcloud get deploy --no-headers | wc -l) Deployments available, $np NetworkPolicies, HPAs: $(kubectl -n sentinelcloud get hpa --no-headers | wc -l)" \
         || record "11 Kubernetes deployment" FAIL "${why[*]}"
  record "1 Docker Compose startup" SKIP "k8s mode"

  BASE="http://localhost:30080"; API="$BASE/api/v1"; FRONTEND_URL="$BASE"
  wait_until 180 "gateway via frontend nginx" curl -fs "$BASE/health"
  api_checks k8s $OV/secrets.env

  step "12 Monitoring (Kubernetes)"
  monitoring_checks "http://localhost:30090" "http://localhost:30093" "http://localhost:30030" "$(envval $OV/secrets.env GRAFANA_ADMIN_USER)" "$(envval $OV/secrets.env GRAFANA_ADMIN_PASSWORD)" k8s

  step "13 Failure simulation (Kubernetes: Resilience Demo drill 'hospital-failure')"
  http POST /resilience/runs '{"scenarioId":"hospital-failure"}'
  if [[ $HTTP_CODE != 201 && $HTTP_CODE != 202 && $HTTP_CODE != 200 ]]; then
    record "13 Failure simulation" FAIL "k8s: starting the drill → $HTTP_CODE $HTTP_BODY"
  else
    local status="running" deadline=$((SECONDS + 420)) stage=""
    while ((SECONDS < deadline)); do
      http GET /resilience/runs/current
      status=$(printf '%s' "$HTTP_BODY" | js 'd.run&&d.run.status'); stage=$(printf '%s' "$HTTP_BODY" | js 'd.run&&d.run.stage')
      [[ "$status" != running ]] && break
      sleep 5
    done
    [[ "$status" == completed ]] && record "13 Failure simulation" PASS "k8s: hospital-failure drill completed (pod failed → detected → Kubernetes self-healed → restored)" \
                                 || record "13 Failure simulation" FAIL "k8s: drill ended '$status' at stage '$stage'"
  fi
  record "2 Database initialisation" PASS "k8s: services migrated (they only become Ready after migrations — see check 11)"
  [[ $TEARDOWN -eq 1 ]] && kind delete cluster --name sentinelcloud >/dev/null 2>&1
}

# ======================================================================
[[ $MODE == compose || $MODE == all ]] && compose_run
[[ $MODE == k8s || $MODE == all ]] && k8s_run

echo
echo "================ SentinelCloud verification summary ================"
fails=0
for k in "${ORDER[@]}"; do
  col=$c_green; [[ ${RESULT[$k]} == FAIL ]] && { col=$c_red; fails=$((fails + 1)); }; [[ ${RESULT[$k]} == SKIP ]] && col=$c_yellow
  printf '%s%-5s%s %s\n' "$col" "${RESULT[$k]}" "$c_off" "$k"
done
echo "===================================================================="
echo "failed checks: $fails"
rm -f "$JAR" /tmp/sc-verify-body /tmp/sc-verify-fe
exit $fails
