#!/usr/bin/env bash
# Teste de regressão pro #6771 (absorve #6709) — o filtro jq compartilhado
# de `continuo-branch-prefix.sh` precisa continuar excluindo as 7 branches
# reais do falso-positivo original, ACEITAR os prefixos autônomos/manuais
# documentados, e ainda assim FLAGAR uma branch genuinamente sem prefixo
# reconhecido (o caso real que motivou #6461).
#
# Uso: bash hermes/scripts/lib/continuo-branch-prefix.test.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./continuo-branch-prefix.sh
source "$DIR/continuo-branch-prefix.sh"

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

# `now` do jq é o timestamp real da execução — build o JSON com createdAt
# alguns minutos atrás (bem dentro da janela de 24h) usando `date`, pra não
# hardcodar uma data que expira.
RECENT="$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"
STALE="$(date -u -d '-48 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-48H +%Y-%m-%dT%H:%M:%SZ)"

run_filter() {
  echo "$1" | jq "$CONTINUO_BRANCH_PREFIX_JQ_FILTER"
}

# As 7 branches reais do #6709 — nenhuma deve ser flagada.
PAYLOAD_6709=$(cat <<JSON
[
  {"headRefName":"fix/6691-gitignore-pii","createdAt":"$RECENT","author":{"login":"vjpixel"}},
  {"headRefName":"docs/6674-kit-creator-network","createdAt":"$RECENT","author":{"login":"vjpixel"}},
  {"headRefName":"worktree-fix-6664-desbloqueia-track-guard","createdAt":"$RECENT","author":{"login":"vjpixel"}},
  {"headRefName":"docs/6310-claude-config-zenbook-status","createdAt":"$RECENT","author":{"login":"vjpixel"}},
  {"headRefName":"fix/6643-continuo-job-pausado-doc","createdAt":"$RECENT","author":{"login":"vjpixel"}},
  {"headRefName":"fix/tokens-panel-day-aggregation","createdAt":"$RECENT","author":{"login":"vjpixel"}},
  {"headRefName":"feat/diaria-desbloqueia-skill","createdAt":"$RECENT","author":{"login":"vjpixel"}}
]
JSON
)
assert_eq "as 7 branches reais do #6709 nunca são flagadas" '""' "$(run_filter "$PAYLOAD_6709")"

# hotfix/ — achado do fleet review do #6821, faltava na 1ª versão.
assert_eq "hotfix/ (exceção documentada em CLAUDE.md) não é flagada" '""' \
  "$(run_filter "[{\"headRefName\":\"hotfix/6060-restaura-plumbing-continuo\",\"createdAt\":\"$RECENT\",\"author\":{\"login\":\"vjpixel\"}}]")"

# chore/, refactor/, test/ — confirmados por histórico real (PRs #2661/#2001/#1042/#947).
for prefix in chore refactor test; do
  assert_eq "prefixo $prefix/ (histórico real confirmado) não é flagado" '""' \
    "$(run_filter "[{\"headRefName\":\"${prefix}/algo-qualquer\",\"createdAt\":\"$RECENT\",\"author\":{\"login\":\"vjpixel\"}}]")"
done

# Os 4 prefixos autônomos continuam aceitos (comportamento pré-#6771, nunca deve regredir).
for prefix in continuo overnight develop dependabot; do
  assert_eq "prefixo autônomo $prefix/ não é flagado" '""' \
    "$(run_filter "[{\"headRefName\":\"${prefix}/fix-1234-x\",\"createdAt\":\"$RECENT\",\"author\":{\"login\":\"vjpixel\"}}]")"
done

# O caso real que o check existe pra pegar (#6461): branch SEM nenhum prefixo
# reconhecido — precisa continuar sendo flagada, senão o check virou no-op.
assert_eq "branch sem nenhum prefixo reconhecido AINDA é flagada (#6461)" '"random-no-prefix-branch"' \
  "$(run_filter "[{\"headRefName\":\"random-no-prefix-branch\",\"createdAt\":\"$RECENT\",\"author\":{\"login\":\"vjpixel\"}}]")"

# Branch >24h não entra na janela, mesmo sem prefixo.
assert_eq "branch sem prefixo mas fora da janela de 24h não é flagada" '""' \
  "$(run_filter "[{\"headRefName\":\"random-no-prefix-branch\",\"createdAt\":\"$STALE\",\"author\":{\"login\":\"vjpixel\"}}]")"

# Branch de outro autor não entra, mesmo sem prefixo e dentro da janela.
assert_eq "branch sem prefixo de outro autor não é flagada" '""' \
  "$(run_filter "[{\"headRefName\":\"random-no-prefix-branch\",\"createdAt\":\"$RECENT\",\"author\":{\"login\":\"dependabot\"}}]")"

# Múltiplas branches sem prefixo → join(", ") com as duas.
assert_eq "múltiplas branches sem prefixo aparecem juntas no join" '"a-sem-prefixo, b-sem-prefixo"' \
  "$(run_filter "[{\"headRefName\":\"a-sem-prefixo\",\"createdAt\":\"$RECENT\",\"author\":{\"login\":\"vjpixel\"}},{\"headRefName\":\"continuo/fix-1-x\",\"createdAt\":\"$RECENT\",\"author\":{\"login\":\"vjpixel\"}},{\"headRefName\":\"b-sem-prefixo\",\"createdAt\":\"$RECENT\",\"author\":{\"login\":\"vjpixel\"}}]")"

if [ "$FAILED" -ne 0 ]; then
  echo "FALHOU"
  exit 1
fi
echo "OK — todos os asserts passaram"
