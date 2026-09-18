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

# #6910 (review, P2): o próprio log_infra_error() não pode falhar em
# silêncio — se o jq/write falhar, tem que aparecer em stderr, não só
# `|| true` engolindo. Simula falha forçando INFRA_ERROR_LOG pra um
# diretório que não existe e não pode ser criado (permissão), provando que
# a função REAL escreve um aviso em stderr nesse caso.
READONLY_PARENT="$TMPDIR/readonly-parent"
mkdir -p "$READONLY_PARENT"
chmod 555 "$READONLY_PARENT"
INFRA_ERROR_LOG="$READONLY_PARENT/subdir/infra-errors.jsonl"
STDERR_OUT=$(log_infra_error "9999" "test_failure" "motivo qualquer" 2>&1 1>/dev/null || true)
chmod 755 "$READONLY_PARENT"
assert_true \
  "log_infra_error() avisa em stderr quando não consegue escrever o log (não engole em silêncio, P2 do review)" \
  "$(echo "$STDERR_OUT" | grep -q 'log_infra_error' && echo 1 || echo 0)"

# #8327 (review rejeitou): o rescue trocou a ordem — `exec 1>&3` (restaura
# stdout) vinha DEPOIS do bloco `if [ "$INFRA_ERRORS" -gt 0 ]`, então, com
# o `exec 1>&2` do topo redirecionando stdout→stderr por todo o corpo, o
# motivo de erro de infra ia parar em stderr e o Telegram (que carrega só
# o stdout) recebia `falhas=1` sem nenhuma causa — o mesmo sintoma que o
# #6910 corrigiu, reintroduzido pela própria PR. Testa o comportamento de
# verdade: executa o trecho final do script real com fd1 redirecionado
# (como o topo do script faz) e exige que o motive chegue no stdout.
DELIVER_SRC=$(awk '/^exec 1>&3$/{f=1} f{print}' "$SCRIPT")
if [ -z "$DELIVER_SRC" ]; then
  echo "FAIL: não conseguiu extrair o trecho de entrega (exec 1>&3) de $SCRIPT"
  exit 1
fi
# sanity estrutural: o trecho extraído contém a linha de resumo final
case "$DELIVER_SRC" in
  *'[continuo-pr-review] fim — revisadas='*) ;;
  *) echo "FAIL: trecho de entrega extraído está incompleto"; exit 1 ;;
esac

INFRA_ERRORS=1
INFRA_ERROR_SUMMARY="PR #1234 (auth_rc=3): gh: command not found"
INFRA_ERROR_LOG="$TMPDIR/infra-errors.jsonl"
LOCK_BLOCKED=0
LOCK_NOTE=""
REVIEWED=5 MERGED=3 ESCALATED=0 REJECTED=1 FAILED=0
# os captures vivem FORA do TMPDIR: o `trap 'rm -rf "$TMPDIR"' EXIT` herda
# pro subshell e apaga os arquivos de saída antes dos asserts de baixo
# (o subshell sai antes do bloco de checagens).
CAPTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR" "$CAPTURE_DIR"' EXIT
STDOUT_CAPTURE="$CAPTURE_DIR/delivery.stdout"
STDERR_CAPTURE="$CAPTURE_DIR/delivery.stderr"
# simula o estado do topo do script (fd3 = stdout original, fd1 = stderr)
SUB_RC=0
(
  exec 3>&1
  exec 1>&2
  eval "$DELIVER_SRC"
) 1>"$STDOUT_CAPTURE" 2>"$STDERR_CAPTURE" || SUB_RC=$?

assert_true \
  "entrega: motivo de erro de infra chega no STDOUT (Telegram), não só em stderr" \
  "$(grep -q 'motivo(s) do(s) erro(s) de infra' "$STDOUT_CAPTURE" && echo 1 || echo 0)"
assert_true \
  "entrega: motivo completo (PR #1234 + causa) vai no stdout" \
  "$(grep -q 'PR #1234.*gh: command not found' "$STDOUT_CAPTURE" && echo 1 || echo 0)"
assert_true \
  "entrega: caminho do log completo vai no stdout" \
  "$(grep -q 'log completo:' "$STDOUT_CAPTURE" && echo 1 || echo 0)"
assert_true \
  "entrega: linha de resumo final (falhas=1) vai no stdout" \
  "$(grep -qE 'fim — revisadas=5.*falhas=1' "$STDOUT_CAPTURE" && echo 1 || echo 0)"
assert_true \
  "entrega: com INFRA_ERRORS>0 o motivo NÃO é apenas um count sem causa (stdout tem rastro)" \
  "$(grep -q 'PR #1234' "$STDOUT_CAPTURE" && echo 1 || echo 0)"

# estrutura: o restauro de stdout (exec 1>&3) vem ANTES do bloco de motivo,
# não depois — é isso que o teste acima prova behaviorally, mas o assertion
# estrutural pega se alguém reverter a ordem de novo.
RESTORE_LINE=$(awk '/^exec 1>&3$/{print NR; exit}' "$SCRIPT")
MOTIVO_LINE=$(grep -n 'motivo(s) do(s) erro(s) de infra' "$SCRIPT" | head -1 | cut -d: -f1)
assert_true \
  "estrutura: exec 1>&3 (restaura stdout) aparece antes do bloco de motivo de infra" \
  "$([ -n "$RESTORE_LINE" ] && [ -n "$MOTIVO_LINE" ] && [ "$RESTORE_LINE" -lt "$MOTIVO_LINE" ] && echo 1 || echo 0)"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "$FAILED asserção(ões) falharam"
  exit 1
fi
echo ""
echo "TODOS OS TESTES PASSARAM"
