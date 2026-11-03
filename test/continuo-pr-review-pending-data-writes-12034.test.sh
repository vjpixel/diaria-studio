#!/usr/bin/env bash
# test/continuo-pr-review-pending-data-writes-12034.test.sh (#12034)
#
# Regressão: PR do contínuo mergeada por `hermes/scripts/continuo-pr-review.sh`
# com a seção `Escrita pendente em data/` (item 35, #11780) no corpo ficava
# sem ninguém aplicar a escrita. Agora `try_merge_gate()` chama
# `register_pending_data_writes` depois do merge confirmado (só no studio),
# que abre a issue de alarme via `register-pending-data-writes.ts`.
#
# Mesmo padrão do #6934/#6910: extrai as FUNÇÕES REAIS do script via `awk` e
# roda contra um `npx` FAKE no PATH. Nada toca `gh`, rede nem `data/` real
# (o log de infra vai para um diretório temporário).
#
# Uso: bash test/continuo-pr-review-pending-data-writes-12034.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hermes/scripts/continuo-pr-review.sh"

FAILED=0
assert_eq() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "ok: $desc"
  else
    echo "FAIL: $desc — esperava [$want], obtido [$got]"
    FAILED=$((FAILED + 1))
  fi
}
assert_contains() {
  local desc="$1" hay="$2" needle="$3"
  case "$hay" in
    *"$needle"*) echo "ok: $desc" ;;
    *) echo "FAIL: $desc — [$needle] ausente em [$hay]"; FAILED=$((FAILED + 1)) ;;
  esac
}

extract_fn() {
  awk "/^${1}\\(\\) \\{/,/^\\}/" "$SCRIPT"
}

REGISTER_SRC="$(extract_fn register_pending_data_writes)"
LOG_INFRA_ERROR_SRC="$(extract_fn log_infra_error)"
TRY_MERGE_GATE_SRC="$(extract_fn try_merge_gate)"
if [ -z "$REGISTER_SRC" ] || [ -z "$LOG_INFRA_ERROR_SRC" ] || [ -z "$TRY_MERGE_GATE_SRC" ]; then
  echo "FAIL: não conseguiu extrair as funções de $SCRIPT (marcadores mudaram?)"
  exit 1
fi

# 1. Ligação no fluxo de merge: chamada guardada por merge confirmado + studio.
assert_contains "try_merge_gate chama register_pending_data_writes guardado por MERGE_CONFIRMED e studio" \
  "$TRY_MERGE_GATE_SRC" 'if [ "$MERGE_CONFIRMED" -eq 1 ] && [ -z "${TARGET_REPO:-}" ]; then
        register_pending_data_writes "$pr"'
# A chamada vem depois de liberar o lock (fora da janela do merge).
RELEASE_LINE=$(printf '%s\n' "$TRY_MERGE_GATE_SRC" | grep -n '      release_merge_lock$' | head -1 | cut -d: -f1)
REGISTER_LINE=$(printf '%s\n' "$TRY_MERGE_GATE_SRC" | grep -n 'register_pending_data_writes "\$pr"' | head -1 | cut -d: -f1)
if [ -n "$RELEASE_LINE" ] && [ -n "$REGISTER_LINE" ] && [ "$REGISTER_LINE" -gt "$RELEASE_LINE" ]; then
  echo "ok: registro roda depois do release_merge_lock"
else
  echo "FAIL: registro deveria vir depois do release_merge_lock (release=$RELEASE_LINE register=$REGISTER_LINE)"
  FAILED=$((FAILED + 1))
fi
# Alarme no stdout do tick (entrega ao Telegram).
assert_contains "NOTIFY liga com escrita pendente" "$(cat "$SCRIPT")" '[ "${PENDING_DATA_WRITES:-0}" -gt 0 ] 2>/dev/null && NOTIFY=1'

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
mkdir -p "$WORKDIR/bin"

# npx fake: devolve o que FAKE_OUT/FAKE_RC mandarem, registra a chamada.
cat > "$WORKDIR/bin/npx" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$CALLS_LOG"
# FAKE_NOT_MERGED_TIMES=k: as k primeiras chamadas respondem not-merged
# (API ainda OPEN logo após o merge), as seguintes devolvem FAKE_OUT.
n=$(wc -l < "$CALLS_LOG")
if [ "$n" -le "${FAKE_NOT_MERGED_TIMES:-0}" ]; then
  printf '%s' '{"outcome":"not-merged","pr":42,"state":"OPEN"}'
  exit 0
fi
printf '%s' "${FAKE_OUT:-}"
[ -n "${FAKE_ERR:-}" ] && printf '%s' "$FAKE_ERR" >&2
exit "${FAKE_RC:-0}"
EOF
chmod +x "$WORKDIR/bin/npx"

run_case() {
  # $1 = FAKE_OUT, $2 = FAKE_RC, $3 = FAKE_NOT_MERGED_TIMES (default 0)
  : > "$WORKDIR/calls.log"
  (
    export PATH="$WORKDIR/bin:$PATH"
    export CALLS_LOG="$WORKDIR/calls.log"
    export FAKE_OUT="$1" FAKE_RC="$2" FAKE_NOT_MERGED_TIMES="${3:-0}"
    PENDING_DATA_WRITES_RETRY_SLEEP=0
    REPO="$WORKDIR/repo"
    INFRA_ERROR_LOG="$WORKDIR/infra-errors.jsonl"
    INFRA_ERRORS=0
    INFRA_ERROR_SUMMARY=""
    PENDING_DATA_WRITES=0
    PENDING_DATA_WRITES_SUMMARY=""
    TARGET_REPO=""
    eval "$LOG_INFRA_ERROR_SRC"
    eval "$REGISTER_SRC"
    set -e
    register_pending_data_writes 42 2>/dev/null
    echo "rc=$? pending=$PENDING_DATA_WRITES infra=$INFRA_ERRORS summary=$PENDING_DATA_WRITES_SUMMARY"
  )
}

# 2. Registrado: conta e guarda a issue no resumo.
: > "$WORKDIR/calls.log"
OUT=$(run_case '{"outcome":"registered","pr":42,"issue":777,"url":"u","action":"created","writes":[]}' 0)
assert_contains "registered conta 1 pendência" "$OUT" "pending=1 infra=0"
assert_contains "resumo cita a issue" "$OUT" "PR #42 -> issue #777;"
assert_contains "chama o CLI com --pr" "$(cat "$WORKDIR/calls.log")" "tsx scripts/register-pending-data-writes.ts --pr 42"

# 3. Sem seção: silêncio.
OUT=$(run_case '{"outcome":"none","pr":42}' 0)
assert_contains "none não conta nada" "$OUT" "rc=0 pending=0 infra=0"

# 4. Falha do CLI: não aborta (set -e ativo), vira erro de infra com log.
rm -f "$WORKDIR/infra-errors.jsonl"
OUT=$(run_case '{"outcome":"failed","pr":42,"error":"HTTP 502"}' 1)
assert_contains "falha vira erro de infra, sem abortar" "$OUT" "rc=0 pending=0 infra=1"
assert_contains "log de infra registra o código" "$(cat "$WORKDIR/infra-errors.jsonl" 2>/dev/null)" '"exit_code":"pending_data_writes_rc=1"'

# 5. Review PR #12043, finding 1: not-merged transitório (API ainda OPEN logo
# após o merge) é reconferido e, quando a API alcança, registra normalmente.
OUT=$(run_case '{"outcome":"registered","pr":42,"issue":778,"url":"u","action":"created","writes":[]}' 0 2)
assert_contains "not-merged transitório é reconferido e registra" "$OUT" "pending=1 infra=0"
assert_contains "resumo cita a issue após retentativa" "$OUT" "PR #42 -> issue #778;"
assert_eq "3 chamadas (2 not-merged + 1 registered)" "$(wc -l < "$WORKDIR/calls.log" | tr -d ' ')" "3"

# 6. not-merged persistente: teto de tentativas respeitado (sem laço infinito),
# vira erro de infra com aviso no log — nunca silêncio — sem abortar.
rm -f "$WORKDIR/infra-errors.jsonl"
OUT=$(run_case '{"outcome":"registered","pr":42,"issue":779}' 0 99)
assert_contains "not-merged persistente vira erro de infra, sem abortar" "$OUT" "rc=0 pending=0 infra=1"
assert_eq "teto de 3 tentativas" "$(wc -l < "$WORKDIR/calls.log" | tr -d ' ')" "3"
assert_contains "log de infra registra not-merged" "$(cat "$WORKDIR/infra-errors.jsonl" 2>/dev/null)" '"exit_code":"pending_data_writes_not_merged"'

if [ "$FAILED" -eq 0 ]; then
  echo "TODOS OS TESTES PASSARAM"
  exit 0
fi
echo "FALHOU ($FAILED)"
exit 1
