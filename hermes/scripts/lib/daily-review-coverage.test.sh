#!/usr/bin/env bash
# Teste de regressão pro #6757 — cobertura degradada do daily-review precisa
# ficar visível no marcador de resumo, nas duas direções (parcial e total).
#
# Uso: bash hermes/scripts/lib/daily-review-coverage.test.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./daily-review-coverage.sh
source "$DIR/daily-review-coverage.sh"

FAILED=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $desc — esperado [$expected], obtido [$actual]"
    FAILED=1
  else
    echo "ok: $desc"
  fi
}

# Diff sintético ACIMA do teto (#6757, cenário "parcial") — RANGE_NOTE
# dispararia no script real, e o resumo precisa carregar isso, não silenciar.
assert_eq "diff acima do teto marca cobertura parcial com os dois números" \
  "cobertura=parcial(38412/20000)" \
  "$(daily_review_coverage_field 38412 20000)"

# Diff sintético ABAIXO do teto (#6757, cenário "total") — sem degradação,
# não pode virar "parcial" por engano (regressão inversa, tão real quanto a outra).
assert_eq "diff abaixo do teto marca cobertura total" \
  "cobertura=total" \
  "$(daily_review_coverage_field 4000 20000)"

# Borda exata (== teto) não é > teto, então não degrada — mesma semântica
# do `-gt` já usado pelo RANGE_NOTE no script principal.
assert_eq "diff igual ao teto (borda) marca cobertura total" \
  "cobertura=total" \
  "$(daily_review_coverage_field 20000 20000)"

if [ "$FAILED" -ne 0 ]; then
  echo "FALHOU"
  exit 1
fi
echo "OK — todos os asserts passaram"
