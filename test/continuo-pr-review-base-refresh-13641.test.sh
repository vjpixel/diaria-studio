#!/usr/bin/env bash
# test/continuo-pr-review-base-refresh-13641.test.sh (#13641)
#
# Regressão: PR aprovada e verde, recusada por `base_not_fresh` (#13470) porque
# outra PR entrou no master depois do CI dela, ficava recusada TODO tick sem
# que nada atualizasse a branch — a única atualização era o `refresh_branch`
# do resolvedor de travadas (6h parada, no máximo 2x por PR). Agora
# `try_merge_gate()` traz a base pra branch na hora (update-branch preso ao
# HEAD revisado), DEPOIS de soltar o lock, só quando o motivo é a base ter
# andado. Extrai a função REAL via awk e roda contra `gh`/`git`/`npx` fakes.
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
  scripts/gh-pr-update-branch.ts)
    echo "update-branch:$*" >> "$EVENTS_LOG"
    if [ -f "$WORKDIR_FAKE/update-conflict" ]; then
      echo '{"outcome":"conflict","detail":"merge conflict"}'; exit 1
    fi
    echo '{"outcome":"accepted"}'; exit 0 ;;
esac
exit 9
F
cat > "$WORKDIR/bin/gh" <<'F'
#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  case "$2" in
    */pulls/*) echo master ;;
    */compare/*)
      [ -f "$WORKDIR_FAKE/compare-fail" ] && exit 1
      printf 'ahead\t%s\n' "$(cat "$WORKDIR_FAKE/behind")" ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  echo "merge:$3" >> "$EVENTS_LOG"; exit 0
fi
exit 0
F
printf '#!/usr/bin/env bash\nexit 0\n' > "$WORKDIR/bin/git"
chmod +x "$WORKDIR/bin/"*

# $1 = PR, $2 = TARGET_REPO (vazio = studio). Grava RC e contadores.
run_pr() {
  (
    export EVENTS_LOG WORKDIR_FAKE="$WORKDIR" PATH="$WORKDIR/bin:$PATH"
    export INFRA_ERROR_LOG="$WORKDIR/infra.jsonl" SESSION_ID="t-$$"
    export MERGE_LOCK_MAX_RETRIES=1 MERGE_LOCK_RETRY_DELAY_S=0
    TARGET_REPO="${2:-}"
    INFRA_ERRORS=0; INFRA_ERROR_SUMMARY=""; MERGED=0; LOCK_BLOCKED=0; BASE_REFRESHED=0
    set -euo pipefail
    eval "$LOG_SRC"; eval "$ACQ_SRC"; eval "$REL_SRC"; eval "$TRY_SRC"
    register_pending_data_writes() { :; }
    set +e; try_merge_gate "$1"; rc=$?; set -e
    echo "RC=$rc MERGED=$MERGED BASE_REFRESHED=$BASE_REFRESHED" > "$WORKDIR/counters.txt"
  )
}
reset() { : > "$EVENTS_LOG"; : > "$WORKDIR/infra.jsonl"; rm -f "$WORKDIR/compare-fail" "$WORKDIR/update-conflict"; }
EVENTS_LOG="$WORKDIR/events.log"

# 1. Base andou: sem merge, update-branch na hora, preso ao HEAD revisado,
#    depois de soltar o lock (a ordem importa: a janela do lock é só do merge).
reset; echo 2 > "$WORKDIR/behind"
run_pr 7
assert_eq "base andou: sem merge" "$(grep -c '^merge:' "$EVENTS_LOG")" "0"
assert_eq "base andou: update-branch chamado 1x com --expected-head e --no-wait" \
  "$(grep -c '^update-branch:--pr 7 --expected-head head-of-7 --no-wait$' "$EVENTS_LOG")" "1"
assert_eq "base andou: release antes do update-branch" \
  "$(grep -v '^acquire$' "$EVENTS_LOG" | tr '\n' ' ')" "release update-branch:--pr 7 --expected-head head-of-7 --no-wait "
assert_eq "base andou: contador BASE_REFRESHED=1 e tick não aborta" \
  "$(cat "$WORKDIR/counters.txt")" "RC=0 MERGED=0 BASE_REFRESHED=1"

# 2. Base fresca: merge normal, nenhum update-branch.
reset; echo 0 > "$WORKDIR/behind"
run_pr 8
assert_eq "base fresca: mergeia" "$(grep -c '^merge:8$' "$EVENTS_LOG")" "1"
assert_eq "base fresca: sem update-branch" "$(grep -c '^update-branch:' "$EVENTS_LOG")" "0"

# 3. Compare ilegível: fail-closed sem update (sem leitura da base, nada a trazer).
reset; echo 2 > "$WORKDIR/behind"; touch "$WORKDIR/compare-fail"
run_pr 9
assert_eq "compare ilegível: sem merge" "$(grep -c '^merge:' "$EVENTS_LOG")" "0"
assert_eq "compare ilegível: sem update-branch" "$(grep -c '^update-branch:' "$EVENTS_LOG")" "0"

# 4. update-branch falha (conflito): não aborta, motivo no log append-only.
reset; echo 3 > "$WORKDIR/behind"; touch "$WORKDIR/update-conflict"
run_pr 10
assert_eq "conflito: tick segue (RC=0), sem merge, sem contar refresh" \
  "$(cat "$WORKDIR/counters.txt")" "RC=0 MERGED=0 BASE_REFRESHED=0"
assert_eq "conflito: base_refresh_rc=1 no log" "$(grep -c 'base_refresh_rc=1' "$WORKDIR/infra.jsonl")" "1"

# 5. PR do diaria-design: o update-branch mira o repo da PR.
reset; echo 1 > "$WORKDIR/behind"
run_pr 11 vjpixel/diaria-design
assert_eq "design: update-branch com --repo do design" \
  "$(grep -c '^update-branch:--pr 11 --expected-head head-of-11 --no-wait --repo vjpixel/diaria-design$' "$EVENTS_LOG")" "1"

[ "$FAILED" -eq 0 ] || { echo FALHOU; exit 1; }
echo "TODOS OS TESTES PASSARAM"
