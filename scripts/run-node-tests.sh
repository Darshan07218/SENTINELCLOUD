#!/usr/bin/env bash
# =========================================================================
# Runs every Node.js test file in the repository with the built-in test
# runner (node --test), one file at a time from its own package directory,
# and prints a pass/fail line per file plus a total.
#
#   ./scripts/run-node-tests.sh              # unit tests
#   SC_DB_TEST=1 SC_DB_TEST_ALLOW_RESET=1 … ./scripts/run-node-tests.sh
#                                            # + tests/db (real PostgreSQL;
#                                            #   see tests/db/realPostgres.test.js)
#
# Install each service's dependencies first (npm ci in services/<name>),
# otherwise files that import express/zod/pg-mem are reported as
# "missing deps" instead of failing.
# Requires Node 20+. Exit code is non-zero if any file failed.
# =========================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

total_pass=0 total_fail=0 files_failed=0 files_skipped=0
results=()

run_file() {
  local dir=$1 file=$2
  local out pass fail
  # TAP reporter: Node 23+ defaults to "spec", whose summary lines this parser doesn't read.
  out=$(cd "$dir" && timeout 600 node --test --test-reporter=tap "$file" 2>&1)
  pass=$(printf '%s\n' "$out" | awk '/^# pass /{print $3}' | tail -1)
  fail=$(printf '%s\n' "$out" | awk '/^# fail /{print $3}' | tail -1)
  # A failing before() hook cancels every test in its suite: "# fail 0", "# cancelled N".
  local cancelled
  cancelled=$(printf '%s\n' "$out" | awk '/^# cancelled /{print $3}' | tail -1)
  fail=$(( ${fail:-0} + ${cancelled:-0} ))
  local missing
  missing=$(printf '%s\n' "$out" | grep -o "Cannot find package '[^']*'" | head -1 | sed "s/Cannot find package //")
  if [[ -n "$missing" ]]; then
    results+=("SKIP  $dir/$file (missing deps: $missing — run npm ci in $dir)")
    files_skipped=$((files_skipped + 1))
    return
  fi
  pass=${pass:-0} fail=${fail:-0}
  total_pass=$((total_pass + pass)) total_fail=$((total_fail + fail))
  if [[ "$fail" != "0" ]]; then
    files_failed=$((files_failed + 1))
    results+=("FAIL  $dir/$file ($pass passed, $fail failed)")
    printf '%s\n' "$out" | grep -E "^not ok|failureType|error:" | head -20 >&2
  else
    results+=("PASS  $dir/$file ($pass tests)")
  fi
}

for dir in services/*/ shared/node-security/ shared/node-broker/ tests/db/; do
  dir=${dir%/}
  [[ -d "$dir" ]] || continue
  if [[ -d "$dir/tests" ]]; then
    for f in "$dir"/tests/*.test.js; do [[ -e "$f" ]] && run_file "$dir" "tests/$(basename "$f")"; done
  else
    for f in "$dir"/*.test.js; do [[ -e "$f" ]] && run_file "$dir" "$(basename "$f")"; done
  fi
done

printf '%s\n' "${results[@]}"
echo "-------------------------------------------------------------"
echo "tests passed: $total_pass   failed: $total_fail   files failed: $files_failed   files skipped (missing deps): $files_skipped"
[[ $files_failed -eq 0 && $total_fail -eq 0 ]]
