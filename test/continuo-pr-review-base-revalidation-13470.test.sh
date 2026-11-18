#!/usr/bin/env bash
# test/continuo-pr-review-base-revalidation-13470.test.sh (#13470)
#
# Regressão: duas PRs verdes isoladas que só quebram juntas. `try_merge_gate()`
# precisa reler a base sob o lock e recusar o merge da PR cujo HEAD não contém
# a base atual (outra PR entrou depois do CI dela). Extrai a função REAL via
# awk e roda contra `gh`/`git`/`npx` fakes; o fake mantém UM estado de base:
# mergear a PR A avança a base, e a PR B (revisada sobre a base antiga) passa
# a estar 1 commit atrás.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hermes/scripts/continuo-pr-review.sh"
FAILED=0
assert_eq() {
  if [ "$2" = "$3" ]; then echo "ok: $1"; else echo "FAIL: $1 — esperava [$3], obtido [$2]"; FAILED=$((FAILED + 1)); fi
}
extract_fn() { awk "/^$1\\(\\) \\{/,/^\\}/" "$SCRIPT"; }
LOG_SRC="$(extract_fn log_infra_error)"; ACQ_SRC="$(extract_fn acquire_merge_lock_with_retry)"
REL_SRC="$(extract_fn release_merge_lock)"; TRY_SRC="$(extract_fn try_merge_gate)"
for b in "$LOG_SRC" "$ACQ_SRC" "$REL_SRC" "$TRY_SRC"; do
  [ -n "$b" ] || { echo "FAIL: extração de função falhou"; exit 1; }
done

WORKDIR="$(mktemp -d)"; trap 'rm -rf "$WORKDIR"' EXIT
mkdir -p "$WORKDIR/bin"
cat > "$WORKDIR/bin/npx" <<'F'
#!/usr/bin/env bash
shift; script="$1"; shift
case "$script" in
  scripts/check-continuo-merge-gate.ts)
    pr="$2"; echo "{\"details\":{\"reviewedHeadSha\":\"head-of-$pr\"}}"; exit 0 ;;
  scripts/lib/session-registry.ts)
    case "$1" in
      merge-lock-acquire) echo acquire >> "$EVENTS_LOG" ;;
      merge-lock-release) echo release >> "$EVENTS_LOG" ;;
    esac; exit 0 ;;
esac
exit 9
F
cat > "$WORKDIR/bin/gh" <<'F'
#!/usr/bin/env bash
# Estado: BASE_STATE guarda quantos commits a base avançou; BASE_SEEN_<pr> é a
# posição da base quando o CI da PR rodou (PR A e B: 0).
if [ "$1" = "api" ]; then
  case "$2" in
    */pulls/*) echo master ;;
    */compare/*)
      sha="${2##*...}"; seen=0
      moved="$(cat "$BASE_STATE")"
      behind=$((moved - seen))
      [ "$sha" = "head-of-1" ] && behind=0   # A é a 1ª: base ainda no ponto do CI
      [ -f "$WORKDIR_FAKE/compare-fail" ] && exit 1
      printf 'ahead\t%s\n' "$behind" ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  echo "merge:$3:${6:-}" >> "$EVENTS_LOG"
  echo $(( $(cat "$BASE_STATE") + 1 )) > "$BASE_STATE"
  exit 0
fi
exit 0
F
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORKDIR/bin/git"
chmod +x "$WORKDIR/bin/"*

run_pr() {
  (
    export EVENTS_LOG BASE_STATE WORKDIR_FAKE="$WORKDIR" PATH="$WORKDIR/bin:$PATH"
    export INFRA_ERROR_LOG="$WORKDIR/infra.jsonl" SESSION_ID="t-$$"
    export MERGE_LOCK_MAX_RETRIES=1 MERGE_LOCK_RETRY_DELAY_S=0
    INFRA_ERRORS=0; INFRA_ERROR_SUMMARY=""; MERGED=0; LOCK_BLOCKED=0
    set -euo pipefail
    eval "$LOG_SRC"; eval "$ACQ_SRC"; eval "$REL_SRC"; eval "$TRY_SRC"
    register_pending_data_writes() { :; }
    set +e; try_merge_gate "$1"; set -e
    echo "MERGED=$MERGED" > "$WORKDIR/counters.txt"
  )
}

EVENTS_LOG="$WORKDIR/events.log"; BASE_STATE="$WORKDIR/base"; echo 0 > "$BASE_STATE"; : > "$EVENTS_LOG"
run_pr 1
assert_eq "PR A (base fresca) mergeia com --match-head-commit" \
  "$(grep -c '^merge:1:head-of-1$' "$EVENTS_LOG")" "1"
run_pr 2
assert_eq "PR B (base andou com A) NÃO mergeia" "$(grep -c '^merge:2' "$EVENTS_LOG")" "0"
assert_eq "PR B: lock liberado mesmo sem merge (acquire==release)" \
  "$(grep -c '^acquire$' "$EVENTS_LOG")" "$(grep -c '^release$' "$EVENTS_LOG")"
assert_eq "PR B: motivo gravado no log append-only" \
  "$(grep -c 'base_not_fresh' "$WORKDIR/infra.jsonl")" "1"

# fail-closed: compare falhando = sem merge
echo 0 > "$BASE_STATE"; : > "$EVENTS_LOG"; touch "$WORKDIR/compare-fail"
run_pr 3
assert_eq "compare ilegível: fail-closed, sem merge" "$(grep -c '^merge:' "$EVENTS_LOG")" "0"

[ "$FAILED" -eq 0 ] || { echo FALHOU; exit 1; }
echo "TODOS OS TESTES PASSARAM"
