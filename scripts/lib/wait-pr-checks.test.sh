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

# ── 5. rc=3 (erro do gate) ISOLADO se recupera — não conclui "resolveu" ────
# Achado do review da PR #6937 (P2, confiança alta): rc=3 é "não sei",
# nunca "parou de estar pendente". Uma falha TRANSITÓRIA (1 tentativa)
# tem que ser retentada, não promovida a sucesso.
GLM_CALL_COUNT=0
check_pr_checks_once() {
  GLM_CALL_COUNT=$((GLM_CALL_COUNT + 1))
  if [ "$GLM_CALL_COUNT" -eq 1 ]; then return 3; fi # 1 erro transitório
  return 0 # depois resolve normalmente
}
OUT5=$(wait_pr_checks "5" 30 1 2>&1)
RC5=$?
assert_eq "1 erro transitório (rc=3) seguido de sucesso -> ainda exit 0" "0" "$RC5"
if echo "$OUT5" | grep -q "não-pendentes"; then
  echo "ok: retentou depois do erro transitório e resolveu"
else
  echo "FAIL: não retentou/resolveu depois do erro transitório — obtido: $OUT5"
  FAILED=1
fi

# ── 6. rc=3 PERSISTENTE estoura o teto de tentativas -> exit 3 (nunca 0/1) ──
check_pr_checks_once() { return 3; } # erro do gate, sempre, nunca resolve
OUT6=$(wait_pr_checks "6" 60 1 2>&1)
RC6=$?
assert_eq "erro persistente (rc=3 sempre) -> exit 3, nunca confundido com sucesso ou timeout" "3" "$RC6"
if echo "$OUT6" | grep -q "ERRO PERSISTENTE"; then
  echo "ok: mensagem de erro persistente presente"
else
  echo "FAIL: mensagem de erro persistente ausente — obtido: $OUT6"
  FAILED=1
fi

# ── 7. rc=6 (gh_incompatible_flags) aborta NA 1ª OCORRÊNCIA, nunca retenta ──
# Regressão específica do #8425: uma incompatibilidade de versão do `gh`
# ("unknown flag: --json") é PERMANENTE, não transitória como o rc=3 acima —
# retentar (mesmo com teto) mascararia "nunca vai funcionar" como "espera
# mais um pouco". A contagem de chamadas prova que não houve NENHUM retry —
# gravada em arquivo (não variável) porque `$(wait_pr_checks ...)` roda a
# função inteira numa SUBSHELL de substituição de comando: uma variável
# setada dentro dela nunca é visível no shell de teste depois que a
# substituição termina.
CALL_COUNT_FILE7="$(mktemp)"
echo 0 > "$CALL_COUNT_FILE7"
check_pr_checks_once() {
  echo "$(( $(cat "$CALL_COUNT_FILE7") + 1 ))" > "$CALL_COUNT_FILE7"
  LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #7: verdict=gh_incompatible_flags — gh incompatível — assinatura de flag/campo \"--json\" não suportado detectada em stderr"
  return 6
}
OUT7=$(wait_pr_checks "7" 60 1 2>&1)
RC7=$?
assert_eq "gh_incompatible_flags (rc=6) -> exit 6, nunca 0/1/timeout" "6" "$RC7"
assert_eq "aborta na 1ª tentativa, sem nenhum retry" "1" "$(cat "$CALL_COUNT_FILE7")"
rm -f "$CALL_COUNT_FILE7"
if echo "$OUT7" | grep -q "INCOMPATIBILIDADE DE gh.*#8425"; then
  echo "ok: mensagem de incompatibilidade nomeada presente (cita #8425)"
else
  echo "FAIL: mensagem de incompatibilidade esperada não encontrada — obtido: $OUT7"
  FAILED=1
fi
if echo "$OUT7" | grep -q "gh_incompatible_flags"; then
  echo "ok: motivo do gate (LAST_GATE_OUTPUT) propagado na mensagem de abort"
else
  echo "FAIL: motivo do gate ausente na mensagem de abort — obtido: $OUT7"
  FAILED=1
fi

# ── 8. #10578: checks na FILA de runner estendem o teto ────────────────────
# Achado da rodada 261019d: runs enfileiradas ~35 min estouraram o teto de
# 30 min em 6 PRs que depois ficaram verdes. Fixture: 5 leituras pending com
# `queued=3` (nenhum runner pegou), depois o CI resolve. Com timeout=3, sem
# a extensão o laço sairia com rc=1 (TIMEOUT) por volta da 4ª leitura.
CALL_COUNT_FILE8="$(mktemp)"
echo 0 > "$CALL_COUNT_FILE8"
check_pr_checks_once() {
  local n
  n=$(( $(cat "$CALL_COUNT_FILE8") + 1 ))
  echo "$n" > "$CALL_COUNT_FILE8"
  if [ "$n" -le 5 ]; then
    LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #8: verdict=pending — 3 check(s) ainda não concluído(s): a, b, c
[check-pr-checks-gate] queue: queued=3 pending=3"
    return 2
  fi
  return 0
}
OUT8=$(wait_pr_checks "8" 3 1 60 2>&1)
RC8=$?
rm -f "$CALL_COUNT_FILE8"
assert_eq "fila de runner (queued>0) estende o teto e o CI resolve -> exit 0, nunca TIMEOUT" "0" "$RC8"
if echo "$OUT8" | grep -q "TIMEOUT"; then
  echo "FAIL: fila de runner foi tratada como TIMEOUT — obtido: $OUT8"
  FAILED=1
else
  echo "ok: sem TIMEOUT enquanto os checks estavam na fila"
fi

# ── 9. #10578: fila que nunca anda estoura o teto ABSOLUTO com exit 7 (FILA) ─
# A extensão nunca vira laço sem fim (#6921): `queue_ceiling_secs` limita, e
# o código de saída é próprio (7), distinto do TIMEOUT (1) de "rodando sem
# concluir" — o coordenador reaguarda em vez de logar ci_timeout.
check_pr_checks_once() {
  LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #9: verdict=pending — 2 check(s) ainda não concluído(s): a, b
[check-pr-checks-gate] queue: queued=2 pending=2"
  return 2
}
START9=$(date +%s)
OUT9=$(wait_pr_checks "9" 1 1 3 2>&1)
RC9=$?
ELAPSED9=$(( $(date +%s) - START9 ))
assert_eq "fila eterna estoura o teto absoluto -> exit 7 (FILA), nunca 1" "7" "$RC9"
if echo "$OUT9" | grep -q "FILA.*#10578"; then
  echo "ok: mensagem de FILA nomeada presente (cita #10578)"
else
  echo "FAIL: mensagem de FILA esperada não encontrada — obtido: $OUT9"
  FAILED=1
fi
if [ "$ELAPSED9" -le 10 ]; then
  echo "ok: teto absoluto respeitado (${ELAPSED9}s)"
else
  echo "FAIL: teto absoluto de 3s não respeitado — levou ${ELAPSED9}s"
  FAILED=1
fi

# ── 10. #10578: check RODANDO (queued=0) segue com o teto normal -> exit 1 ──
# Distinção pedida pela issue: "sem progresso" (job pegou runner e não
# termina) não ganha extensão, mesmo com teto absoluto folgado.
check_pr_checks_once() {
  LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #10: verdict=pending — 1 check(s) ainda não concluído(s): a
[check-pr-checks-gate] queue: queued=0 pending=1"
  return 2
}
wait_pr_checks "10" 1 1 60 >/dev/null 2>&1
RC10=$?
assert_eq "check em execução sem concluir (queued=0) -> exit 1 no teto normal" "1" "$RC10"

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
