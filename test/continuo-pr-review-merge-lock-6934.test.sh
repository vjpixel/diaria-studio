#!/usr/bin/env bash
# test/continuo-pr-review-merge-lock-6934.test.sh (#6934)
#
# Regressão do gap descrito na issue #6934: `try_merge_gate()` em
# `hermes/scripts/continuo-pr-review.sh` chamava `gh pr merge` direto, sem
# adquirir o merge-lock cross-sessão (`session-registry.ts merge-lock-
# acquire`/`-release`) que overnight/develop já usam pro MESMO checkout
# compartilhado. Decisão registrada no comentário durável da issue: kind
# dedicado `continuo-review`, `--session-id` derivado do RUN_ID/PID do
# próprio tick, TTL inalterado, retry pequeno-e-fixo em vez de abort na
# primeira negativa.
#
# Mecanismo (mesmo padrão do #6885/#6891/#6910/#6923 — extrai as FUNÇÕES
# REAIS do script via `awk`, nunca uma reimplementação, e roda contra `gh`/
# `git`/`npx` FAKES no PATH que só gravam um EVENTS_LOG de quem foi chamado
# e em que ORDEM). Cobre as 4 propriedades pedidas pela issue:
#   1. lock adquirido ANTES do `gh pr merge`
#   2. lock liberado DEPOIS do `git pull` que segue um merge bem-sucedido
#   3. lock liberado também quando o `gh pr merge` FALHA (não vaza)
#   4. lock negado retenta (número pequeno e fixo) em vez de abortar —
#      e SÓ desiste (sem nunca chamar `gh pr merge`) depois de esgotar as
#      tentativas.
#
# Uso: bash test/continuo-pr-review-merge-lock-6934.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hermes/scripts/continuo-pr-review.sh"

FAILED=0
assert_true() {
  local desc="$1" cond="$2"
  if [ "$cond" = "1" ]; then
    echo "ok: $desc"
  else
    echo "FAIL: $desc"
    FAILED=$((FAILED + 1))
  fi
}
assert_eq() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "ok: $desc"
  else
    echo "FAIL: $desc — esperava [$want], obtido [$got]"
    FAILED=$((FAILED + 1))
  fi
}

# Extrai as funções REAIS via awk (mesma técnica do #6910/#6923) — nunca uma
# reimplementação. Cada uma termina em `}` na coluna 0, mesmo padrão de
# `log_infra_error() { ... }` já extraído pelo #6910.
extract_fn() {
  local name="$1"
  awk "/^${name}\\(\\) \\{/,/^\\}/" "$SCRIPT"
}

LOG_INFRA_ERROR_SRC="$(extract_fn log_infra_error)"
ACQUIRE_SRC="$(extract_fn acquire_merge_lock_with_retry)"
RELEASE_SRC="$(extract_fn release_merge_lock)"
TRY_MERGE_GATE_SRC="$(extract_fn try_merge_gate)"

for pair in "log_infra_error:$LOG_INFRA_ERROR_SRC" "acquire_merge_lock_with_retry:$ACQUIRE_SRC" \
  "release_merge_lock:$RELEASE_SRC" "try_merge_gate:$TRY_MERGE_GATE_SRC"; do
  name="${pair%%:*}"
  body="${pair#*:}"
  if [ -z "$body" ]; then
    echo "FAIL: não conseguiu extrair $name() de $SCRIPT (marcadores mudaram?)"
    FAILED=1
  fi
done
if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU (extração)"
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
mkdir -p "$WORKDIR/bin"

# ─── fakes ──────────────────────────────────────────────────────────────
# Todos gravam em $EVENTS_LOG (um evento por linha, na ordem real de
# invocação) — é essa ordem que prova as propriedades 1/2/3 acima.

cat > "$WORKDIR/bin/npx" <<'FAKE_NPX'
#!/usr/bin/env bash
# args esperados: tsx <script.ts> [--pr N | merge-lock-acquire|release --kind K --session-id X]
shift # descarta "tsx"
script="$1"; shift
case "$script" in
  scripts/check-continuo-merge-gate.ts)
    echo "gate-called" >> "$EVENTS_LOG"
    cat "$GATE_JSON_FIXTURE"
    exit "$(cat "$GATE_RC_FIXTURE")"
    ;;
  scripts/lib/session-registry.ts)
    sub="$1"; shift
    case "$sub" in
      merge-lock-acquire)
        remaining=$(cat "$ACQUIRE_DENY_COUNT" 2>/dev/null || echo 0)
        if [ "$remaining" -gt 0 ]; then
          echo $((remaining - 1)) > "$ACQUIRE_DENY_COUNT"
          echo "acquire-denied" >> "$EVENTS_LOG"
          echo "session-registry: merge-lock-acquire denied (held by another session)"
          exit 1
        fi
        echo "acquire-ok" >> "$EVENTS_LOG"
        echo "session-registry: merge-lock-acquire ok"
        exit 0
        ;;
      merge-lock-release)
        echo "release" >> "$EVENTS_LOG"
        echo "session-registry: merge-lock-release ok"
        exit 0
        ;;
      *)
        echo "FAKE_NPX: subcomando session-registry desconhecido: $sub" >&2
        exit 9
        ;;
    esac
    ;;
  *)
    echo "FAKE_NPX: script desconhecido: $script" >&2
    exit 9
    ;;
esac
FAKE_NPX
chmod +x "$WORKDIR/bin/npx"

cat > "$WORKDIR/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  echo "merge-called" >> "$EVENTS_LOG"
  rc="$(cat "$GH_MERGE_RC_FIXTURE" 2>/dev/null || echo 0)"
  if [ "$rc" -eq 0 ]; then echo "merge-ok" >> "$EVENTS_LOG"; fi
  exit "$rc"
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat "$GH_VIEW_STATE_FIXTURE"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  exit 0
fi
echo "FAKE_GH: comando desconhecido: $*" >&2
exit 9
FAKE_GH
chmod +x "$WORKDIR/bin/gh"

cat > "$WORKDIR/bin/git" <<'FAKE_GIT'
#!/usr/bin/env bash
if [ "$1" = "pull" ]; then
  echo "pull-called" >> "$EVENTS_LOG"
  rc="$(cat "$GIT_PULL_RC_FIXTURE" 2>/dev/null || echo 0)"
  exit "$rc"
fi
exit 0
FAKE_GIT
chmod +x "$WORKDIR/bin/git"

# GATE_JSON fixo — gate=merge (rc 0) em todos os cenários: estes testes
# cobrem o LOCK, não o portão de merge em si (esse já tem cobertura própria
# em check-continuo-merge-gate.test.ts).
echo '{"details":{"reviewedHeadSha":"deadbeef1234"}}' > "$WORKDIR/gate.json"
echo 0 > "$WORKDIR/gate.rc"

run_scenario() {
  # Roda try_merge_gate() de verdade, num subshell isolado (variáveis de
  # cenário exportadas via env, contadores globais legíveis depois via
  # arquivo — subshell pra nunca deixar `set -e`/trap de uma rodada vazar
  # pra outra).
  (
    export EVENTS_LOG GATE_JSON_FIXTURE="$WORKDIR/gate.json" GATE_RC_FIXTURE="$WORKDIR/gate.rc"
    export ACQUIRE_DENY_COUNT GH_MERGE_RC_FIXTURE GH_VIEW_STATE_FIXTURE GIT_PULL_RC_FIXTURE
    export PATH="$WORKDIR/bin:$PATH"
    export INFRA_ERROR_LOG="$WORKDIR/infra-errors.jsonl"
    export SESSION_ID="continuo-review-test-$$"
    export MERGE_LOCK_MAX_RETRIES=3
    export MERGE_LOCK_RETRY_DELAY_S=0
    INFRA_ERRORS=0
    INFRA_ERROR_SUMMARY=""
    MERGED=0
    LOCK_BLOCKED=0
    set -euo pipefail
    eval "$LOG_INFRA_ERROR_SRC"
    eval "$ACQUIRE_SRC"
    eval "$RELEASE_SRC"
    eval "$TRY_MERGE_GATE_SRC"
    set +e
    try_merge_gate 4242
    set -e
    echo "MERGED=$MERGED LOCK_BLOCKED=$LOCK_BLOCKED" > "$WORKDIR/counters.txt"
  )
}

# ─── Cenário A: caminho feliz — acquire ok, merge ok, pull ok ────────────
EVENTS_LOG="$WORKDIR/events-a.log"
: > "$EVENTS_LOG"
echo 0 > "$WORKDIR/acquire-deny-a"
ACQUIRE_DENY_COUNT="$WORKDIR/acquire-deny-a"
echo 0 > "$WORKDIR/gh-merge-rc-a"
GH_MERGE_RC_FIXTURE="$WORKDIR/gh-merge-rc-a"
GH_VIEW_STATE_FIXTURE="$WORKDIR/gh-view-a" # não usado neste cenário (merge não falha)
echo 0 > "$WORKDIR/git-pull-rc-a"
GIT_PULL_RC_FIXTURE="$WORKDIR/git-pull-rc-a"
run_scenario
EVENTS_A="$(cat "$EVENTS_LOG" | tr '\n' ',')"
assert_eq "cenário A — ordem exata: gate, acquire, merge, pull, release" \
  "$EVENTS_A" "gate-called,acquire-ok,merge-called,merge-ok,pull-called,release,"
assert_true "cenário A — MERGED=1 ao final" \
  "$(command grep -q '^MERGED=1 ' "$WORKDIR/counters.txt" && echo 1 || echo 0)"

# ─── Cenário B: merge FALHA (e gh pr view confirma NÃO mergeada) — lock   ─
#     ainda assim é liberado, e NENHUM pull é tentado (nada novo pra puxar) ─
EVENTS_LOG="$WORKDIR/events-b.log"
: > "$EVENTS_LOG"
echo 0 > "$WORKDIR/acquire-deny-b"
ACQUIRE_DENY_COUNT="$WORKDIR/acquire-deny-b"
echo 1 > "$WORKDIR/gh-merge-rc-b" # gh pr merge falha (ex: SHA desatualizado)
GH_MERGE_RC_FIXTURE="$WORKDIR/gh-merge-rc-b"
printf 'OPEN\tnull\n' > "$WORKDIR/gh-view-b" # gh pr view: PR continua OPEN, não MERGED
GH_VIEW_STATE_FIXTURE="$WORKDIR/gh-view-b"
GIT_PULL_RC_FIXTURE="$WORKDIR/nao-deveria-ser-lido-b"
run_scenario
EVENTS_B="$(cat "$EVENTS_LOG" | tr '\n' ',')"
assert_eq "cenário B — merge falha: acquire, merge (sem merge-ok), SEM pull, release mesmo assim" \
  "$EVENTS_B" "gate-called,acquire-ok,merge-called,release,"
assert_true "cenário B — MERGED continua 0 (merge não confirmado)" \
  "$(command grep -q '^MERGED=0 ' "$WORKDIR/counters.txt" && echo 1 || echo 0)"

# ─── Cenário C: lock negado 2x, concedido na 3ª tentativa — RETRY, não    ─
#     abort; o merge acontece normalmente depois que o lock é conseguido  ─
EVENTS_LOG="$WORKDIR/events-c.log"
: > "$EVENTS_LOG"
echo 2 > "$WORKDIR/acquire-deny-c" # nega 2x, concede na 3ª (MERGE_LOCK_MAX_RETRIES=3)
ACQUIRE_DENY_COUNT="$WORKDIR/acquire-deny-c"
echo 0 > "$WORKDIR/gh-merge-rc-c"
GH_MERGE_RC_FIXTURE="$WORKDIR/gh-merge-rc-c"
GH_VIEW_STATE_FIXTURE="$WORKDIR/gh-view-c"
echo 0 > "$WORKDIR/git-pull-rc-c"
GIT_PULL_RC_FIXTURE="$WORKDIR/git-pull-rc-c"
run_scenario
EVENTS_C="$(cat "$EVENTS_LOG" | tr '\n' ',')"
assert_eq "cenário C — 2 negativas retentadas, 3ª concede, merge segue normalmente" \
  "$EVENTS_C" "gate-called,acquire-denied,acquire-denied,acquire-ok,merge-called,merge-ok,pull-called,release,"
assert_true "cenário C — MERGED=1 (o retry não impediu o merge de acontecer)" \
  "$(command grep -q '^MERGED=1 ' "$WORKDIR/counters.txt" && echo 1 || echo 0)"

# ─── Cenário D: lock NUNCA concedido — esgota as tentativas, desiste desta ─
#     PR nesta rodada, e (crítico) `gh pr merge` NUNCA roda                ─
EVENTS_LOG="$WORKDIR/events-d.log"
: > "$EVENTS_LOG"
echo 99 > "$WORKDIR/acquire-deny-d" # nega sempre
ACQUIRE_DENY_COUNT="$WORKDIR/acquire-deny-d"
GH_MERGE_RC_FIXTURE="$WORKDIR/nao-deveria-ser-lido-d"
GH_VIEW_STATE_FIXTURE="$WORKDIR/nao-deveria-ser-lido-d"
GIT_PULL_RC_FIXTURE="$WORKDIR/nao-deveria-ser-lido-d"
run_scenario
EVENTS_D="$(cat "$EVENTS_LOG" | tr '\n' ',')"
assert_eq "cenário D — 3 tentativas negadas (MERGE_LOCK_MAX_RETRIES=3), desiste — NUNCA chama merge" \
  "$EVENTS_D" "gate-called,acquire-denied,acquire-denied,acquire-denied,"
assert_true "cenário D — LOCK_BLOCKED=1 (contabilizado, não silencioso)" \
  "$(command grep -q 'LOCK_BLOCKED=1' "$WORKDIR/counters.txt" && echo 1 || echo 0)"
assert_true "cenário D — MERGED continua 0" \
  "$(command grep -q '^MERGED=0 ' "$WORKDIR/counters.txt" && echo 1 || echo 0)"
if command grep -q 'merge-called' "$WORKDIR/events-d.log"; then
  assert_true "cenário D — 'gh pr merge' realmente nunca rodou (nenhum evento merge-called)" "0"
else
  assert_true "cenário D — 'gh pr merge' realmente nunca rodou (nenhum evento merge-called)" "1"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
