#!/usr/bin/env bash
# daily-review-coverage.sh — cálculo PURO do campo de cobertura do
# opus-daily-diff-review.sh (#6757; script renomeado de
# daily-consolidated-review.sh no #6865).
#
# Extraído pra arquivo próprio, sem side effects (sem git/gh/claude), só pra
# ser `source`ável de um teste sem precisar de repo real ou rede. O script
# principal faz `source` deste arquivo e chama a função abaixo.
set -euo pipefail

# daily_review_coverage_field DIFF_LINES MAX_DIFF_LINES
#
# Imprime o campo `cobertura=...` que entra no marcador RESUMO-DAILY-REVIEW.
# - DIFF_LINES > MAX_DIFF_LINES  → "cobertura=parcial(DIFF_LINES/MAX_DIFF_LINES)"
#   (o teto degradou a instrução do prompt — RANGE_NOTE não vazio)
# - caso contrário               → "cobertura=total"
daily_review_coverage_field() {
  local diff_lines="$1"
  local max_diff_lines="$2"
  if [ "$diff_lines" -gt "$max_diff_lines" ]; then
    echo "cobertura=parcial($diff_lines/$max_diff_lines)"
  else
    echo "cobertura=total"
  fi
}
