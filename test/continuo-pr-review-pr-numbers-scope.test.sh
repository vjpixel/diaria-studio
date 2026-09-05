#!/usr/bin/env bash
# test/continuo-pr-review-pr-numbers-scope.test.sh (#7446 item 4)
#
# Regressão apontada por review externo na PR #7449: a mudança de escopo do
# filtro `PR_NUMBERS` (`continuo/*` → qualquer branch exceto `bot/*`) não
# tinha nenhum teste travando o `--jq` real. Extrai a expressão `--jq` EXATA
# do script (não uma reimplementação) e roda contra uma amostra de PRs com
# branches representativas (`continuo/*`, `develop/*`, `chore/*`, `bot/*`) —
# prova que `bot/*` é excluída e todo o resto passa.
#
# Uso: bash test/continuo-pr-review-pr-numbers-scope.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hermes/scripts/continuo-pr-review.sh"

FAILED=0
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "ok: $desc"
  else
    echo "FAIL: $desc — esperado [$expected], obtido [$actual]"
    FAILED=1
  fi
}

JQ_FILTER=$(sed -n "/^PR_NUMBERS=\$(gh pr list/,/) | .number')\$/p" "$SCRIPT" \
  | command grep -- '--jq' \
  | sed -E "s/^\s*--jq '(.*)'\)?\$/\1/")
if [ -z "$JQ_FILTER" ]; then
  echo "FAIL: não consegui extrair a expressão --jq de PR_NUMBERS (formato do script mudou?)"
  FAILED=1
fi

SAMPLE='[
  {"number": 7403, "headRefName": "chore/desliga-rampa-gmail-stage0"},
  {"number": 7404, "headRefName": "continuo/rescue-20260904T040307Z-2689057-34a8"},
  {"number": 7416, "headRefName": "develop/clarice-daily-cutover-7406"},
  {"number": 7434, "headRefName": "bot/heatmap-weekly-regen"}
]'

if [ "$FAILED" -eq 0 ]; then
  RESULT=$(printf '%s' "$SAMPLE" | jq -r "$JQ_FILTER" | sort -n | tr '\n' ',')
  assert_eq "bot/* excluída, continuo/*+develop/*+chore/* incluídas (#7446 item 4)" "7403,7404,7416," "$RESULT"
fi

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
