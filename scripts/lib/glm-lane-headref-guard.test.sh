#!/usr/bin/env bash
# scripts/lib/glm-lane-headref-guard.test.sh (#6954)
#
# Testa `is_safe_glm_branch_ref` EXECUTANDO a validação e, no caso hostil,
# EXECUTANDO a substituição real dentro de uma string --tools de mentira
# e inspecionando o resultado — não regex estática sobre o código-fonte
# (era exatamente o gap que o achado de review de PR aponta: os testes
# antigos só verificavam a PRESENÇA da substring `${BRANCH}` no arquivo,
# nunca o que a substituição produz com um valor adversarial de verdade).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=glm-lane-headref-guard.sh
source "$SCRIPT_DIR/glm-lane-headref-guard.sh"

FAILURES=0
assert_true() {
  if ! "$@"; then
    echo "FALHOU (esperava sucesso): $*" >&2
    FAILURES=$((FAILURES + 1))
  fi
}
assert_false() {
  if "$@"; then
    echo "FALHOU (esperava falha): $*" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

# --- Casos benignos: branches reais que o próprio harness produz ou que
# um humano renomearia à mão ---
assert_true is_safe_glm_branch_ref "continuo/glm-6954-20260901120000"
assert_true is_safe_glm_branch_ref "fix-6953-glm-lane-pr-followup"
assert_true is_safe_glm_branch_ref "feature/abc.def_123"

# --- Casos hostis: nomes de branch VÁLIDOS pro git (confirmado com
# `git check-ref-format --branch`) que carregam sintaxe de --allowedTools ---
assert_false is_safe_glm_branch_ref "x),Bash(git"
assert_false is_safe_glm_branch_ref "a,Bash(gh pr merge"
assert_false is_safe_glm_branch_ref "branch with spaces"
assert_false is_safe_glm_branch_ref 'a"b'
assert_false is_safe_glm_branch_ref '$(whoami)'
assert_false is_safe_glm_branch_ref ""

# --- A prova real pedida pelo review: EXECUTA a substituição com o valor
# hostil dentro de uma string --tools igual à do script de verdade, e
# confirma que o padrão perigoso (Bash(git:*) irrestrito) só aparece
# quando a validação foi PULADA — e que o guard, quando aplicado antes,
# teria recusado esse valor (não deixando a substituição nem acontecer). ---
HOSTILE_REF="x),Bash(git"
UNGUARDED_TOOLS="Read,Grep,Glob,Edit,Write,Bash(git push origin ${HOSTILE_REF}:*),Bash(npm test:*)"
if [[ "$UNGUARDED_TOOLS" != *"Bash(git:*)"* ]]; then
  echo "FALHOU — o cenário de ataque não reproduziu: esperava que a substituição SEM guard produzisse 'Bash(git:*)' irrestrito na string --tools resultante, e não produziu. Isto invalidaria a premissa do teste (o bug pra que este guard existe)." >&2
  FAILURES=$((FAILURES + 1))
fi
if is_safe_glm_branch_ref "$HOSTILE_REF"; then
  echo "FALHOU — is_safe_glm_branch_ref aceitou o valor hostil que provou escapar --tools acima." >&2
  FAILURES=$((FAILURES + 1))
fi

if [ "$FAILURES" -eq 0 ]; then
  echo "ok — glm-lane-headref-guard.test.sh: todas as asserções passaram"
  exit 0
else
  echo "FALHOU — $FAILURES asserção(ões) de glm-lane-headref-guard.test.sh" >&2
  exit 1
fi
