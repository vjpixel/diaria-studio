#!/usr/bin/env bash
# scripts/lib/wait-pr-checks.test.sh (#6921)
#
# Teste de regressão pro teto de vida de `wait-pr-checks.sh` — o achado do
# #6921 foi 5 laços de espera de CI escritos à mão sem timeout, órfãos por
# até 15h. Este teste NUNCA faz uma chamada de rede real: sourceia o
# script e sobrescreve `check_pr_checks_once` (função separada de
# propósito, ver docstring do arquivo) por uma fake determinística,
# exercitando só a lógica do laço (`wait_pr_checks`).
#
# Uso: bash scripts/lib/wait-pr-checks.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./wait-pr-checks.sh
source "$DIR/wait-pr-checks.sh"

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

# ── 1. laço cuja condição resolve ANTES do teto sai normalmente (rc=0) ──────
check_pr_checks_once() { return 0; } # "pass" na 1ª tentativa
OUT1=$(wait_pr_checks "1" 5 1 2>&1)
RC1=$?
assert_eq "resolve antes do teto -> exit 0" "0" "$RC1"
if echo "$OUT1" | grep -q "não-pendentes"; then
  echo "ok: mensagem de sucesso presente"
else
  echo "FAIL: mensagem de sucesso ausente — obtido: $OUT1"
  FAILED=1
fi

# ── 2. laço com teto que ESTOURA sai com mensagem nomeada e código próprio ──
check_pr_checks_once() { return 2; } # sempre "pending", nunca resolve
OUT2=$(wait_pr_checks "2" 1 1 2>&1)
RC2=$?
assert_eq "estoura o teto -> exit 1 (nunca 0)" "1" "$RC2"
if echo "$OUT2" | grep -q "TIMEOUT.*teto de vida.*#6921"; then
  echo "ok: mensagem de TIMEOUT nomeada presente (cita #6921)"
else
  echo "FAIL: mensagem de TIMEOUT esperada não encontrada — obtido: $OUT2"
  FAILED=1
fi

# ── 3. verdict não-pending diferente de 0 (fail/error) ainda conta como "parou de esperar" ──
# wait_pr_checks só responde "parou de estar pendente" — quem decide
# passou/falhou é o chamador rodando o gate de novo. rc=1 (fail) do gate
# ainda deve fazer o LAÇO sair com sucesso (0), não travar esperando um
# "pass" que pode nunca vir.
check_pr_checks_once() { return 1; } # CI vermelho, não mais pendente
wait_pr_checks "3" 5 1 >/dev/null 2>&1
RC3=$?
assert_eq "gate retorna fail (rc=1, não-pending) -> loop ainda sai com 0" "0" "$RC3"

# ── 4. uso inválido do entrypoint (PR ausente) -> exit 2 ────────────────────
OUT4=$(bash "$DIR/wait-pr-checks.sh" 2>&1)
RC4=$?
assert_eq "PR ausente -> exit 2" "2" "$RC4"
if echo "$OUT4" | grep -q "uso:"; then
  echo "ok: mensagem de uso presente"
else
  echo "FAIL: mensagem de uso ausente — obtido: $OUT4"
  FAILED=1
fi

exit $FAILED
