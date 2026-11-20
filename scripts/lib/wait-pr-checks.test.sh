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

# ── 10. #10578/#13685: check RODANDO sem concluir estoura o teto de EXECUÇÃO -> exit 1 ──
# A fila (#10578) não estende o prazo de quem já tem runner; desde o #13685 o
# check rodando tem o teto próprio (`running_ceiling_secs`), e passado ele é
# o caso "sem progresso": TIMEOUT, nunca FILA.
check_pr_checks_once() {
  LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #10: verdict=pending — 1 check(s) ainda não concluído(s): a
[check-pr-checks-gate] queue: queued=0 pending=1"
  return 2
}
START10=$(date +%s)
OUT10=$(wait_pr_checks "10" 1 1 60 3 2>&1)
RC10=$?
ELAPSED10=$(( $(date +%s) - START10 ))
assert_eq "check em execução sem concluir (queued=0) -> exit 1 no teto de execução" "1" "$RC10"
if echo "$OUT10" | grep -q "TIMEOUT.*em execução.*#13685"; then
  echo "ok: TIMEOUT diz que o check seguia em execução (cita #13685)"
else
  echo "FAIL: mensagem de TIMEOUT com check em execução não encontrada — obtido: $OUT10"
  FAILED=1
fi
if [ "$ELAPSED10" -ge 3 ] && [ "$ELAPSED10" -le 10 ]; then
  echo "ok: esperou até o teto de execução de 3s, não o normal de 1s (${ELAPSED10}s)"
else
  echo "FAIL: teto de execução de 3s não respeitado — levou ${ELAPSED10}s"
  FAILED=1
fi

# ── 12. #13685: run in_progress além do teto normal NÃO dá TIMEOUT ──────────
# Cenário da PR #13678 (rodada 261119): o job `test` seguia `in_progress` no
# HEAD vigente depois dos 30 min e passou minutos depois; o helper saía
# "TIMEOUT após 1818s" e a regra mandava a PR pra draft + fixer. Fixture:
# 5 leituras com 1 check rodando (queued=0 pending=1), depois resolve; com
# timeout=2, antes do fix o laço saía rc=1 por volta da 3ª leitura.
CALL_COUNT_FILE12="$(mktemp)"
echo 0 > "$CALL_COUNT_FILE12"
check_pr_checks_once() {
  local n
  n=$(( $(cat "$CALL_COUNT_FILE12") + 1 ))
  echo "$n" > "$CALL_COUNT_FILE12"
  if [ "$n" -le 5 ]; then
    LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #12: verdict=pending — 1 check(s) ainda não concluído(s): test
[check-pr-checks-gate] queue: queued=0 pending=1"
    return 2
  fi
  return 0
}
OUT12=$(wait_pr_checks "12" 2 1 60 60 2>&1)
RC12=$?
rm -f "$CALL_COUNT_FILE12"
assert_eq "check em execução além do teto normal e o CI conclui -> exit 0, nunca TIMEOUT" "0" "$RC12"
if echo "$OUT12" | grep -q "TIMEOUT"; then
  echo "FAIL: run in_progress foi tratado como TIMEOUT — obtido: $OUT12"
  FAILED=1
else
  echo "ok: sem TIMEOUT enquanto o check estava em execução"
fi

# ── 13. #13685: pendente SEM run (rollup vazio, sem linha queue:) fica no teto normal ──
# A extensão é só pra check rodando: "nenhum check registrado" não ganha os
# 60 min, mesmo com o teto de execução folgado.
check_pr_checks_once() {
  LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #13: verdict=pending — nenhum check registrado ainda no PR (statusCheckRollup vazio)"
  return 2
}
START13=$(date +%s)
wait_pr_checks "13" 1 1 60 60 >/dev/null 2>&1
RC13=$?
ELAPSED13=$(( $(date +%s) - START13 ))
assert_eq "pendente sem run (sem linha queue:) -> exit 1 no teto normal" "1" "$RC13"
if [ "$ELAPSED13" -le 10 ]; then
  echo "ok: sem extensão de execução (${ELAPSED13}s)"
else
  echo "FAIL: pendente sem run ganhou extensão — levou ${ELAPSED13}s"
  FAILED=1
fi

# ── 11. #12733: virada de segundo antes da 1ª leitura nunca dá TIMEOUT ──────
# O vermelho intermitente do job Shell tests (PR #12717) era o caso 9 dando
# rc=1 "após 1s": `start=$(date +%s)` e o 1º `now=$(date +%s)` caíram em
# segundos diferentes, elapsed=1 >= teto=1, e o laço saiu sem consultar o
# gate. Aqui a virada é forçada: `date` falso avança 1s por chamada e `sleep`
# não espera, então o resultado não depende do relógio da máquina.
DATE_FILE11="$(mktemp)"
echo 1000 > "$DATE_FILE11"
date() {
  local t
  t=$(cat "$DATE_FILE11")
  echo $(( t + 1 )) > "$DATE_FILE11"
  echo "$t"
}
sleep() { :; }
GATE_CALLS11="$(mktemp)"
echo 0 > "$GATE_CALLS11"
check_pr_checks_once() {
  echo $(( $(cat "$GATE_CALLS11") + 1 )) > "$GATE_CALLS11"
  LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #11: verdict=pending — 2 check(s) ainda não concluído(s): a, b
[check-pr-checks-gate] queue: queued=2 pending=2"
  return 2
}
wait_pr_checks "11" 1 1 3 >/dev/null 2>&1
RC11=$?
CALLS11=$(cat "$GATE_CALLS11")
unset -f date sleep
rm -f "$DATE_FILE11" "$GATE_CALLS11"
assert_eq "virada de segundo antes da 1ª leitura -> fila (rc=7), nunca TIMEOUT sem consultar o gate" "7" "$RC11"
if [ "$CALLS11" -ge 1 ]; then
  echo "ok: gate consultado antes de avaliar o teto (${CALLS11} leitura(s))"
else
  echo "FAIL: o laço avaliou o teto sem nenhuma leitura do gate"
  FAILED=1
fi

# Mesma virada com o gate resolvendo na 1ª leitura: sai 0, nunca TIMEOUT.
DATE_FILE11="$(mktemp)"
echo 1000 > "$DATE_FILE11"
date() {
  local t
  t=$(cat "$DATE_FILE11")
  echo $(( t + 1 )) > "$DATE_FILE11"
  echo "$t"
}
sleep() { :; }
check_pr_checks_once() { return 0; }
wait_pr_checks "11" 1 1 >/dev/null 2>&1
RC11B=$?
unset -f date sleep
rm -f "$DATE_FILE11"
assert_eq "virada de segundo antes da 1ª leitura com CI já resolvido -> exit 0" "0" "$RC11B"

# ── 14-16. #13702: relógio falso (1s por `date`, `sleep` sem espera) ────────
# Os cenários abaixo precisam de dezenas de "segundos"; o relógio falso os
# torna determinísticos e instantâneos. Cada leitura do gate = 1 volta = 1s.
FAKE_CLOCK13702="$(mktemp)"
GATE_CALLS13702="$(mktemp)"
fake_clock_on() {
  echo 1000 > "$FAKE_CLOCK13702"
  echo 0 > "$GATE_CALLS13702"
  date() {
    local t
    t=$(cat "$FAKE_CLOCK13702")
    echo $(( t + 1 )) > "$FAKE_CLOCK13702"
    echo "$t"
  }
  sleep() { :; }
}
fake_clock_off() { unset -f date sleep; }
gate_call_n() {
  local n
  n=$(( $(cat "$GATE_CALLS13702") + 1 ))
  echo "$n" > "$GATE_CALLS13702"
  echo "$n"
}

# ── 14. fila seguida de execução: o teto de execução conta DEPOIS da fila ───
# Cenário do #13702: o job espera por runner e depois roda. Fixture: 8
# leituras na fila, 4 rodando, depois o CI conclui. timeout=2,
# running_ceiling=6: antes do fix o prazo com check rodando era
# max(2+fila, 6) = 10, contado do início da espera, e o laço saía TIMEOUT na
# 2ª leitura de execução; com o fix o prazo é 6 + 8 de fila = 14.
fake_clock_on
check_pr_checks_once() {
  local n
  n=$(gate_call_n)
  if [ "$n" -le 8 ]; then
    LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=1 pending=1 running=0"
    return 2
  fi
  if [ "$n" -le 12 ]; then
    LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=0 pending=1 running=1"
    return 2
  fi
  return 0
}
OUT14=$(wait_pr_checks "14" 2 1 60 6 2>&1)
RC14=$?
fake_clock_off
assert_eq "fila seguida de execução: teto de execução soma o tempo de fila -> exit 0, nunca TIMEOUT" "0" "$RC14"
if echo "$OUT14" | grep -q "TIMEOUT"; then
  echo "FAIL: execução depois da fila tratada como TIMEOUT — obtido: $OUT14"
  FAILED=1
else
  echo "ok: sem TIMEOUT na execução que começou depois da fila"
fi

# Mesmo cenário com execução que nunca conclui: o laço continua limitado
# (#6921) — TIMEOUT com a mensagem de execução, por volta de 6 + 8 leituras.
fake_clock_on
check_pr_checks_once() {
  local n
  n=$(gate_call_n)
  if [ "$n" -le 8 ]; then
    LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=1 pending=1 running=0"
    return 2
  fi
  LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=0 pending=1 running=1"
  return 2
}
OUT14B=$(wait_pr_checks "14" 2 1 60 6 2>&1)
RC14B=$?
CALLS14B=$(cat "$GATE_CALLS13702")
fake_clock_off
assert_eq "execução eterna depois da fila -> exit 1 (TIMEOUT de execução)" "1" "$RC14B"
if echo "$OUT14B" | grep -q "TIMEOUT.*em execução.*#13702"; then
  echo "ok: TIMEOUT de execução cita #13702"
else
  echo "FAIL: mensagem de TIMEOUT de execução não encontrada — obtido: $OUT14B"
  FAILED=1
fi
if [ "$CALLS14B" -ge 12 ] && [ "$CALLS14B" -le 20 ]; then
  echo "ok: teto de execução + tempo de fila respeitado (${CALLS14B} leituras)"
else
  echo "FAIL: esperado ~14 leituras (6 de execução + 8 de fila), obtido ${CALLS14B}"
  FAILED=1
fi

# ── 15. execução e fila juntas ao estourar o teto -> exit 7 (FILA), nunca 1 ──
# Antes do fix o ramo running vinha primeiro e saía TIMEOUT (ci_timeout,
# draft + fixer) onde o que segurava o CI era a fila de runner.
fake_clock_on
check_pr_checks_once() {
  gate_call_n >/dev/null
  LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=1 pending=2 running=1"
  return 2
}
OUT15=$(wait_pr_checks "15" 1 1 3 3 2>&1)
RC15=$?
CALLS15=$(cat "$GATE_CALLS13702")
fake_clock_off
assert_eq "check rodando + check na fila no teto -> exit 7 (FILA), nunca TIMEOUT" "7" "$RC15"
if echo "$OUT15" | grep -q "FILA.*#10578"; then
  echo "ok: mensagem de FILA presente"
else
  echo "FAIL: mensagem de FILA não encontrada — obtido: $OUT15"
  FAILED=1
fi
if [ "$CALLS15" -le 10 ]; then
  echo "ok: teto absoluto (fila + execução) respeitado (${CALLS15} leituras)"
else
  echo "FAIL: laço passou do teto absoluto — ${CALLS15} leituras"
  FAILED=1
fi

# ── 16. StatusContext legado pendente (running=0) não ganha a extensão ──────
# `pending - queued` contava o status legado PENDING/EXPECTED como execução
# e a espera dobrava pra 60 min. Com `running=0` o teto é o normal.
fake_clock_on
check_pr_checks_once() {
  gate_call_n >/dev/null
  LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #16: verdict=pending — 1 check(s) ainda não concluído(s): deploy/preview
[check-pr-checks-gate] queue: queued=0 pending=1 running=0"
  return 2
}
OUT16=$(wait_pr_checks "16" 2 1 60 60 2>&1)
RC16=$?
CALLS16=$(cat "$GATE_CALLS13702")
fake_clock_off
assert_eq "status legado pendente (running=0) -> exit 1 no teto normal" "1" "$RC16"
if [ "$CALLS16" -le 4 ]; then
  echo "ok: sem extensão de execução pro status legado (${CALLS16} leituras)"
else
  echo "FAIL: status legado ganhou a extensão de execução — ${CALLS16} leituras"
  FAILED=1
fi
if echo "$OUT16" | grep -q "em execução"; then
  echo "FAIL: TIMEOUT descreveu status legado como check em execução — obtido: $OUT16"
  FAILED=1
else
  echo "ok: TIMEOUT sem a mensagem de execução"
fi
# ── 17. heartbeat ci_wait_running (#13725) ─────────────────────────────────
# Espera estendida (check rodando) passa do limiar de stall do watchdog; o
# laço grava ci_wait_running sozinho a cada CI_WAIT_HEARTBEAT_SECS, sem
# depender do coordenador. Sem check rodando, nunca emite.
HB_LOG13725="$(mktemp)"
emit_ci_wait_running() { echo "$1 $2 $3" >> "$HB_LOG13725"; }
fake_clock_on
check_pr_checks_once() {
  gate_call_n >/dev/null
  LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=0 pending=1 running=1"
  return 2
}
CI_WAIT_HEARTBEAT_SECS=10 wait_pr_checks "17" 1 1 30 30 >/dev/null 2>&1
RC17=$?
fake_clock_off
assert_eq "espera estendida estoura -> exit 1" "1" "$RC17"
HB17=$(wc -l < "$HB_LOG13725" | tr -d ' ')
if [ "$HB17" -ge 2 ]; then
  echo "ok: heartbeat ci_wait_running emitido repetidamente (${HB17}x)"
else
  echo "FAIL: heartbeat ci_wait_running ausente/insuficiente — ${HB17} emissões"
  FAILED=1
fi
if head -n 1 "$HB_LOG13725" | grep -q "^17 .* 1$"; then
  echo "ok: heartbeat carrega PR e contagem de checks rodando"
else
  echo "FAIL: formato do heartbeat inesperado — $(head -n 1 "$HB_LOG13725")"
  FAILED=1
fi

: > "$HB_LOG13725"
fake_clock_on
check_pr_checks_once() {
  gate_call_n >/dev/null
  LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=1 pending=1 running=0"
  return 2
}
CI_WAIT_HEARTBEAT_SECS=2 wait_pr_checks "17" 1 1 30 30 >/dev/null 2>&1
fake_clock_off
assert_eq "sem check rodando (só fila) -> nenhum heartbeat" "0" "$(wc -l < "$HB_LOG13725" | tr -d ' ')"
rm -f "$HB_LOG13725"

# ── 18. #13726: StatusContext pendente JUNTO com CheckRun rodando ──────────
# `queued=0 pending=2 running=1`: o caso exato que o #13702 separa. A extensão
# de execução vale (há 1 CheckRun com runner), mas a contagem de execução é o
# `running=1` do gate, nunca `pending - queued` = 2 (que contaria o status
# legado). timeout=2, running_ceiling=6, sem fila: ~6 leituras, não 2.
HB_LOG13726="$(mktemp)"
emit_ci_wait_running() { echo "$1 $2 $3" >> "$HB_LOG13726"; }
fake_clock_on
check_pr_checks_once() {
  gate_call_n >/dev/null
  LAST_GATE_OUTPUT="[check-pr-checks-gate] PR #18: verdict=pending — 2 check(s) ainda não concluído(s): deploy/preview, test
[check-pr-checks-gate] queue: queued=0 pending=2 running=1"
  return 2
}
OUT18=$(CI_WAIT_HEARTBEAT_SECS=2 wait_pr_checks "18" 2 1 60 6 2>&1)
RC18=$?
CALLS18=$(cat "$GATE_CALLS13702")
fake_clock_off
assert_eq "status legado pendente + CheckRun rodando -> exit 1 (TIMEOUT de execução)" "1" "$RC18"
if [ "$CALLS18" -ge 5 ] && [ "$CALLS18" -le 10 ]; then
  echo "ok: CheckRun rodando ganha a extensão mesmo com status legado pendente (${CALLS18} leituras)"
else
  echo "FAIL: esperado ~6 leituras (teto de execução), obtido ${CALLS18}"
  FAILED=1
fi
if echo "$OUT18" | grep -q "PR #18 com 1 check(s) ainda em execução"; then
  echo "ok: TIMEOUT conta só o CheckRun (running=1), não o status legado"
else
  echo "FAIL: TIMEOUT deveria citar 1 check em execução — obtido: $OUT18"
  FAILED=1
fi
if [ -s "$HB_LOG13726" ] && ! grep -qv "^18 .* 1$" "$HB_LOG13726"; then
  echo "ok: heartbeat conta 1 check rodando, nunca 2"
else
  echo "FAIL: heartbeat com contagem errada ou ausente — $(cat "$HB_LOG13726")"
  FAILED=1
fi
rm -f "$HB_LOG13726"

# ── 19. #13744: emit_ci_wait_running só grava com agente E edição declarados ─
# Inferir (default overnight + plan.json mais recente) atribuía a espera de CI
# do develop/continuo à rodada overnight. Função REAL, `npx` falso (sem rede).
NPX_LOG13744="$(mktemp)"
emit_real_13744() {
  (
    # shellcheck source=./wait-pr-checks.sh
    source "$DIR/wait-pr-checks.sh"
    npx() { echo "$*" >> "$NPX_LOG13744"; }
    emit_ci_wait_running 19 1200 1
  )
}
: > "$NPX_LOG13744"
( unset WAIT_PR_CHECKS_AGENT WAIT_PR_CHECKS_EDITION; emit_real_13744 )
assert_eq "sem agente nem edição -> não grava" "0" "$(wc -l < "$NPX_LOG13744" | tr -d ' ')"
( unset WAIT_PR_CHECKS_AGENT; WAIT_PR_CHECKS_EDITION=261120 emit_real_13744 )
assert_eq "só edição (agente não declarado) -> não grava (nunca assume overnight)" "0" "$(wc -l < "$NPX_LOG13744" | tr -d ' ')"
( unset WAIT_PR_CHECKS_EDITION; WAIT_PR_CHECKS_AGENT=overnight emit_real_13744 )
assert_eq "só agente (edição não declarada) -> não grava (nunca infere do plan.json)" "0" "$(wc -l < "$NPX_LOG13744" | tr -d ' ')"
WAIT_PR_CHECKS_AGENT=develop WAIT_PR_CHECKS_EDITION=261120 emit_real_13744
if grep -q -- "--edition 261120 --agent develop" "$NPX_LOG13744" && grep -q '"source": "wait-pr-checks"' "$NPX_LOG13744"; then
  echo "ok: agente+edição declarados -> grava com eles e details.source=wait-pr-checks"
else
  echo "FAIL: chamada do log-event inesperada — $(cat "$NPX_LOG13744")"
  FAILED=1
fi
rm -f "$NPX_LOG13744"

# ── 20. #13744: sem rajada de heartbeat depois de fila longa ───────────────
# 30 leituras só com fila (running=0), depois check rodando. Com o marco
# somado ao antigo (900, 1800, ...), a 1ª volta rodando emitia várias vezes
# seguidas até alcançar o elapsed; o marco agora conta da última emissão.
HB_LOG13744="$(mktemp)"
emit_ci_wait_running() { echo "$2" >> "$HB_LOG13744"; }
fake_clock_on
check_pr_checks_once() {
  local n
  n=$(gate_call_n)
  if [ "$n" -le 30 ]; then
    LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=1 pending=1 running=0"
    return 2
  fi
  if [ "$n" -le 55 ]; then
    LAST_GATE_OUTPUT="[check-pr-checks-gate] queue: queued=0 pending=1 running=1"
    return 2
  fi
  return 0
}
CI_WAIT_HEARTBEAT_SECS=10 wait_pr_checks "20" 5 1 200 200 >/dev/null 2>&1
RC20=$?
fake_clock_off
assert_eq "fila longa seguida de execução -> exit 0" "0" "$RC20"
HB20=$(wc -l < "$HB_LOG13744" | tr -d ' ')
BURST20=0
PREV20=""
while read -r e; do
  if [ -n "$PREV20" ] && [ $(( e - PREV20 )) -lt 10 ]; then BURST20=1; fi
  PREV20="$e"
done < "$HB_LOG13744"
if [ "$HB20" -ge 2 ] && [ "$HB20" -le 3 ] && [ "$BURST20" -eq 0 ]; then
  echo "ok: heartbeat espaçado de CI_WAIT_HEARTBEAT_SECS mesmo após fila longa (${HB20}x)"
else
  echo "FAIL: rajada de heartbeat após fila — emissões em elapsed=[$(tr '\n' ' ' < "$HB_LOG13744")]"
  FAILED=1
fi
rm -f "$HB_LOG13744"

rm -f "$FAKE_CLOCK13702" "$GATE_CALLS13702"

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
