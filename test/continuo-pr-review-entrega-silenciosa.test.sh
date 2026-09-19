#!/usr/bin/env bash
# test/continuo-pr-review-entrega-silenciosa.test.sh (19/09/2026)
#
# Regressão: o job de cron do Hermes que roda este script é `no_agent=True`,
# o que significa que o `prompt` do job ("entregue um resumo de no máximo 2
# linhas") NUNCA é lido — o stdout do script é entregue verbatim no Telegram,
# e stdout vazio vira tick silencioso. Antes desta mudança o script despejava
# no stdout o progresso PR a PR, o output do `git pull` e o resumo final, de
# modo que TODA rodada — inclusive as completamente normais — virava uma
# mensagem longa. Pedido do editor: "só receber mensagem se algum problema
# estiver acontecendo".
#
# Mesmo padrão dos irmãos (#6910/#6891): extrai o BLOCO REAL de entrega do
# fim de hermes/scripts/continuo-pr-review.sh (do `NOTIFY=0` até o fim) e o
# executa com contadores forjados, provando o comportamento de verdade em vez
# de reimplementá-lo.
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

BLOCK="$TMPDIR/delivery.sh"
awk '/^NOTIFY=0$/,0' "$SCRIPT" > "$BLOCK"
if [ ! -s "$BLOCK" ]; then
  echo "FAIL: não conseguiu extrair o bloco de entrega de $SCRIPT (marcador NOTIFY=0 mudou?)"
  exit 1
fi
# Sanity check estrutural — prova que extraiu o bloco certo.
case "$(cat "$BLOCK")" in
  *'exit 0'*) ;;
  *) echo "FAIL: bloco extraído não termina com exit 0 — extração incompleta"; exit 1 ;;
esac

# Roda o bloco real num shell filho com `set -euo pipefail` (como no script)
# e os contadores que o cenário exige. Devolve stdout; stderr é descartado
# (é o log, que o Hermes só entrega quando o script sai não-zero).
run_block() {
  local reviewed="$1" merged="$2" escalated="$3" rejected="$4"
  local esc_new="$5" rej_new="$6" failed="$7" infra="$8" lock="$9"
  bash -c "
    set -euo pipefail
    REVIEWED=$reviewed MERGED=$merged ESCALATED=$escalated REJECTED=$rejected
    ESCALATED_NEW=$esc_new REJECTED_NEW=$rej_new
    FAILED=$failed INFRA_ERRORS=$infra LOCK_BLOCKED=$lock
    INFRA_ERROR_SUMMARY='PR #99 (merge_rc=1): motivo de exemplo
'
    INFRA_ERROR_LOG='$TMPDIR/infra.jsonl'
    source '$BLOCK'
  " 2>/dev/null
}

run_block_rc() {
  run_block "$@" >/dev/null 2>&1
}

# --- Cenário 1: rodada 100% normal (o caso do dia a dia) --------------------
OUT=$(run_block 3 2 0 0 0 0 0 0 0)
assert_true \
  "rodada normal (2 merges, 3 reviews, zero problema) não escreve NADA no stdout — tick silencioso no Hermes" \
  "$([ -z "$OUT" ] && echo 1 || echo 0)"
run_block_rc 3 2 0 0 0 0 0 0 0
assert_true \
  "rodada normal sai com exit 0 (saída não-zero viraria alerta de watchdog quebrado no Hermes)" \
  "$([ $? -eq 0 ] && echo 1 || echo 0)"

# --- Cenário 2: escalate/reject já sinalizados em rodadas anteriores --------
# ESCALATED/REJECTED > 0 mas *_NEW = 0: nada mudou de dono nesta rodada, o
# editor já foi avisado quando aconteceu. Continua silêncio (senão a mesma
# PR parada avisaria a cada tick, que é o ruído original).
OUT=$(run_block 0 0 2 1 0 0 0 0 0)
assert_true \
  "escalate/reject repetidos (já sinalizados antes) seguem silenciosos — não re-avisam a cada tick" \
  "$([ -z "$OUT" ] && echo 1 || echo 0)"

# --- Cenário 3: PR escalada AGORA -------------------------------------------
OUT=$(run_block 1 0 1 0 1 0 0 0 0)
assert_true \
  "escalate de 1ª vez avisa (PR acabou de virar responsabilidade humana)" \
  "$(echo "$OUT" | grep -q 'escalada(s) agora' && echo 1 || echo 0)"

# --- Cenário 4: PR rejeitada AGORA ------------------------------------------
OUT=$(run_block 1 0 0 1 0 1 0 0 0)
assert_true \
  "reject de 1ª vez avisa (consertar ou fechar)" \
  "$(echo "$OUT" | grep -q 'rejeitada(s) agora' && echo 1 || echo 0)"

# --- Cenário 5: erro de infra -----------------------------------------------
OUT=$(run_block 1 0 0 0 0 0 0 1 0)
assert_true \
  "erro de infra avisa" \
  "$(echo "$OUT" | grep -q 'falhas=1' && echo 1 || echo 0)"
assert_true \
  "erro de infra leva o MOTIVO junto, não só o contador (invariante do #6910 preservada)" \
  "$(echo "$OUT" | grep -q 'motivo de exemplo' && echo 1 || echo 0)"
assert_true \
  "erro de infra cita o caminho do log completo (#6910)" \
  "$(echo "$OUT" | grep -q 'log completo:' && echo 1 || echo 0)"

# --- Cenário 6: falha de sessão de review -----------------------------------
OUT=$(run_block 0 0 0 0 0 0 1 0 0)
assert_true \
  "falha de sessão de review avisa" \
  "$([ -n "$OUT" ] && echo 1 || echo 0)"

# --- Cenário 7: contenção de lock sozinha NÃO é problema --------------------
# LOCK_BLOCKED é sinal agregado ("aconteceu N vezes"), não falha: outra
# coordenadora estava mergeando, esta PR é retentada no próximo tick.
OUT=$(run_block 1 0 0 0 0 0 0 0 2)
assert_true \
  "contenção de merge-lock sozinha não dispara mensagem (é retentada no próximo tick, não é falha)" \
  "$([ -z "$OUT" ] && echo 1 || echo 0)"
# ...mas quando JÁ há problema, o contador aparece junto (#8212 review, P3).
OUT=$(run_block 1 0 0 0 0 0 1 0 2)
assert_true \
  "quando há problema, bloqueadas-por-lock aparece no resumo (#8212 review, P3)" \
  "$(echo "$OUT" | grep -q 'bloqueadas-por-lock=2' && echo 1 || echo 0)"

# --- Invariante estrutural: progresso PR a PR não pode voltar ao stdout -----
assert_true \
  "nenhum echo de progresso 'PR #...' do script escreve em stdout (tudo em stderr)" \
  "$(grep -nE '^\s*echo "\[continuo-pr-review\] PR #' "$SCRIPT" | grep -v '>&2' | grep -q . && echo 0 || echo 1)"
assert_true \
  "git pull do merge não vaza 'Fast-forward'/'files changed' pro stdout" \
  "$(grep -qE '^\s*git pull --ff-only >&2' "$SCRIPT" && echo 1 || echo 0)"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "$FAILED asserção(ões) falharam"
  exit 1
fi
echo ""
echo "TODOS OS TESTES PASSARAM"
