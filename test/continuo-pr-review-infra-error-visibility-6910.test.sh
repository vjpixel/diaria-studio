#!/usr/bin/env bash
# test/continuo-pr-review-infra-error-visibility-6910.test.sh (#6910)
#
# Regressão: o motivo de um erro de infra (`check-pr-review-authenticity.ts`
# exit 3, ou `gh pr view` falhando) ia só pro stderr — a entrega do cron
# (Telegram) carrega apenas a linha de resumo final (stdout), então
# "erros-de-infra=1" chegava sem nenhum rastro de causa.
#
# Padrão de teste (mesmo do #6885/#6891): extrai a função REAL
# `log_infra_error` de hermes/scripts/continuo-pr-review.sh via marcadores
# awk e roda ela de verdade (não uma reimplementação) contra um
# INFRA_ERROR_LOG temporário — prova que (1) o log append-only recebe uma
# linha JSON válida com o motivo completo e (2) o resumo acumulado
# (INFRA_ERROR_SUMMARY) contém o motivo truncado, pronto pra ir na linha
# final de stdout que a entrega do cron carrega.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hermes/scripts/continuo-pr-review.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

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

# Extrai a função log_infra_error() { ... } inteira do script real.
FUNC_SRC=$(awk '/^log_infra_error\(\) \{/,/^\}/' "$SCRIPT")
if [ -z "$FUNC_SRC" ]; then
  echo "FAIL: não conseguiu extrair log_infra_error() de $SCRIPT (marcadores mudaram?)"
  exit 1
fi

# Sanity check estrutural — prova que extraiu o corpo certo, não um trecho
# vazio que passaria os testes por acidente.
case "$FUNC_SRC" in
  *"jq -cn"*) ;;
  *) echo "FAIL: corpo extraído não contém 'jq -cn' — extração incompleta"; exit 1 ;;
esac

INFRA_ERROR_LOG="$TMPDIR/infra-errors.jsonl"
INFRA_ERROR_SUMMARY=""

# Avalia a função extraída no shell atual (mesma técnica do #6891: roda o
# FRAGMENTO REAL, não uma reimplementação).
eval "$FUNC_SRC"

log_infra_error "1234" "auth_rc=3" "gh: command not found"
log_infra_error "5678" "gh_pr_view_rc=1" "linha 1
linha 2 com \"aspas\""

assert_true \
  "log JSONL tem 2 linhas (1 por chamada)" \
  "$([ "$(wc -l < "$INFRA_ERROR_LOG")" -eq 2 ] && echo 1 || echo 0)"

LINE1=$(sed -n '1p' "$INFRA_ERROR_LOG")
PR1=$(echo "$LINE1" | jq -r '.pr')
REASON1=$(echo "$LINE1" | jq -r '.reason')
assert_true "linha 1: pr=1234" "$([ "$PR1" = "1234" ] && echo 1 || echo 0)"
assert_true "linha 1: reason preservado" "$([ "$REASON1" = "gh: command not found" ] && echo 1 || echo 0)"

LINE2=$(sed -n '2p' "$INFRA_ERROR_LOG")
REASON2=$(echo "$LINE2" | jq -r '.reason')
assert_true \
  "linha 2: reason multi-linha com aspas sobrevive ao round-trip JSON (jq -cn escapa)" \
  "$(echo "$REASON2" | grep -q 'linha 2 com "aspas"' && echo 1 || echo 0)"

assert_true \
  "INFRA_ERROR_SUMMARY acumula as 2 ocorrências (não sobrescreve)" \
  "$(echo "$INFRA_ERROR_SUMMARY" | grep -c '^PR #' | grep -qx 2 && echo 1 || echo 0)"

assert_true \
  "INFRA_ERROR_SUMMARY contém o motivo da PR #1234 (não só o contador)" \
  "$(echo "$INFRA_ERROR_SUMMARY" | grep -q 'PR #1234.*gh: command not found' && echo 1 || echo 0)"

# O ponto central do #6910: a linha final de stdout (o que a entrega do cron
# carrega) tem que citar o motivo quando INFRA_ERRORS>0 — checa que o script
# real, não só a função isolada, imprime esse bloco condicional.
assert_true \
  "script real: bloco de resumo condicional (INFRA_ERRORS>0) imprime o motivo, não só o contador" \
  "$(grep -q 'motivo(s) do(s) erro(s) de infra' "$SCRIPT" && grep -q 'INFRA_ERROR_SUMMARY' "$SCRIPT" && echo 1 || echo 0)"

assert_true \
  "script real cita o caminho do log completo na saída (não só o resumo truncado desta rodada)" \
  "$(grep -q 'log completo: \$INFRA_ERROR_LOG' "$SCRIPT" && echo 1 || echo 0)"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "$FAILED asserção(ões) falharam"
  exit 1
fi
echo ""
echo "TODOS OS TESTES PASSARAM"
