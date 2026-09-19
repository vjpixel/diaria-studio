#!/usr/bin/env bash
# test/hermes-cron-entrega-so-com-problema.test.sh (19/09/2026)
#
# Regressão: os 3 jobs de cron do Hermes que servem este repo
# (`continuo-pr-review.sh`, `watch-continuo-health.sh`,
# `opus-daily-diff-review.sh`) rodam com `no_agent=True`. Nesse modo o
# `prompt` do job NÃO é lido por ninguém — o stdout do script é entregue
# verbatim no Telegram, e stdout VAZIO vira tick silencioso. Os três
# despejavam progresso/linhas "ok"/transcript no stdout, então a rodada
# saudável falava tanto quanto a quebrada. Pedido do editor: "só receber
# mensagem se algum problema estiver acontecendo".
#
# Mesmo padrão dos irmãos (#6910/#6891): extrai o BLOCO REAL de entrega e o
# executa com contadores forjados, em vez de reimplementar a lógica.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRREV="$HERE/../hermes/scripts/continuo-pr-review.sh"
WATCH="$HERE/../hermes/scripts/watch-continuo-health.sh"
DAILY="$HERE/../hermes/scripts/opus-daily-diff-review.sh"
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

# ── continuo-pr-review.sh: bloco de entrega executado de verdade ────────────
BLOCK="$TMPDIR/delivery.sh"
awk '/^NOTIFY=0$/,0' "$PRREV" > "$BLOCK"
if [ ! -s "$BLOCK" ]; then
  echo "FAIL: não extraiu o bloco de entrega de $PRREV (marcador NOTIFY=0 mudou?)"
  exit 1
fi
case "$(cat "$BLOCK")" in
  *'exit 0'*) ;;
  *) echo "FAIL: bloco extraído não termina com exit 0 — extração incompleta"; exit 1 ;;
esac

# Roda o bloco real num shell filho sob `set -euo pipefail` (como no script).
# stdout é o que o Telegram receberia; stderr é o log, descartado aqui.
run_block() {
  bash -c "
    set -euo pipefail
    REVIEWED=$1 MERGED=$2 ESCALATED=$3 REJECTED=$4
    ESCALATED_NEW=$5 REJECTED_NEW=$6
    ESCALATED_RECURRING=$7 ESCALATED_RECURRING_PRS=' #42'
    FAILED=$8 INFRA_ERRORS=$9 LOCK_BLOCKED=${10}
    INFRA_ERROR_SUMMARY='PR #99 (merge_rc=1): motivo de exemplo
'
    INFRA_ERROR_LOG='$TMPDIR/infra.jsonl'
    source '$BLOCK'
  " 2>/dev/null
}

#          reviewed merged esc rej escN rejN recorr failed infra lock
OUT=$(run_block 3 2 0 0 0 0 0 0 0 0)
assert_true \
  "pr-review: rodada normal (2 merges, 3 reviews, zero problema) não escreve NADA no stdout" \
  "$([ -z "$OUT" ] && echo 1 || echo 0)"

run_block 3 2 0 0 0 0 0 0 0 0 >/dev/null 2>&1
assert_true \
  "pr-review: rodada normal sai com exit 0 (não-zero viraria alerta de watchdog quebrado)" \
  "$([ $? -eq 0 ] && echo 1 || echo 0)"

OUT=$(run_block 0 0 2 1 0 0 0 0 0 0)
assert_true \
  "pr-review: escalate/reject já sinalizados antes seguem silenciosos — não re-avisam a cada tick" \
  "$([ -z "$OUT" ] && echo 1 || echo 0)"

OUT=$(run_block 1 0 1 0 1 0 0 0 0 0)
assert_true \
  "pr-review: escalate de 1ª vez avisa (PR acabou de virar responsabilidade humana)" \
  "$(echo "$OUT" | grep -q 'escalada(s) agora' && echo 1 || echo 0)"

OUT=$(run_block 1 0 0 1 0 1 0 0 0 0)
assert_true \
  "pr-review: reject de 1ª vez avisa (consertar ou fechar)" \
  "$(echo "$OUT" | grep -q 'rejeitada(s) agora' && echo 1 || echo 0)"

OUT=$(run_block 1 0 1 0 0 0 1 0 0 0)
assert_true \
  "pr-review: escalada REINCIDENTE segue avisando (#8446 preservado)" \
  "$(echo "$OUT" | grep -q 'REINCIDENTE' && echo 1 || echo 0)"

OUT=$(run_block 1 0 0 0 0 0 0 0 1 0)
assert_true "pr-review: erro de infra avisa" \
  "$(echo "$OUT" | grep -q 'falhas=1' && echo 1 || echo 0)"
assert_true \
  "pr-review: erro de infra leva o MOTIVO junto, não só o contador (#6910 preservado)" \
  "$(echo "$OUT" | grep -q 'motivo de exemplo' && echo 1 || echo 0)"
assert_true \
  "pr-review: erro de infra cita o caminho do log completo (#6910)" \
  "$(echo "$OUT" | grep -q 'log completo:' && echo 1 || echo 0)"

OUT=$(run_block 0 0 0 0 0 0 0 1 0 0)
assert_true "pr-review: falha de sessão de review avisa" \
  "$([ -n "$OUT" ] && echo 1 || echo 0)"

OUT=$(run_block 1 0 0 0 0 0 0 0 0 2)
assert_true \
  "pr-review: contenção de merge-lock sozinha não avisa (é retentada no próximo tick, não é falha)" \
  "$([ -z "$OUT" ] && echo 1 || echo 0)"
OUT=$(run_block 1 0 0 0 0 0 0 1 0 2)
assert_true \
  "pr-review: quando JÁ há problema, bloqueadas-por-lock aparece no resumo (#8212 review, P3)" \
  "$(echo "$OUT" | grep -q 'bloqueadas-por-lock=2' && echo 1 || echo 0)"

assert_true \
  "pr-review: nenhum progresso 'PR #...' volta pro stdout (tudo em stderr)" \
  "$(grep -nE '^[[:space:]]*echo "\[continuo-pr-review\] PR #' "$PRREV" | grep -v '>&2' | grep -q . && echo 0 || echo 1)"
assert_true \
  "pr-review: git pull do merge não vaza 'Fast-forward'/'files changed' pro stdout" \
  "$(grep -qE '^[[:space:]]*git pull --ff-only >&2' "$PRREV" && echo 1 || echo 0)"

# ── watch-continuo-health.sh ────────────────────────────────────────────────
assert_true \
  "watch: nenhuma linha de rotina '[watch] ...' volta pro stdout (vão pro \$WATCH_LOG)" \
  "$(grep -nE '^[[:space:]]*echo "\[watch\] [^\$]' "$WATCH" | grep -v '>&2' | grep -q . && echo 0 || echo 1)"
assert_true \
  "watch: stdout final é condicionado a ISSUES_CREATED>0 (varredura limpa = silêncio)" \
  "$(grep -q 'if \[ "\$ISSUES_CREATED" -gt 0 \]; then' "$WATCH" && echo 1 || echo 0)"
assert_true \
  "watch: as linhas que SOBRARAM em stderr são anomalias, nunca 'ok' — o alerta de FAILS>0 carrega o stderr inteiro" \
  "$(grep -E '^[[:space:]]*echo "\[watch\]' "$WATCH" | grep '>&2' | grep -qE ' ok[ )\"]' && echo 0 || echo 1)"
assert_true \
  "watch: file_issue conta a issue criada (senão o stdout final nunca dispara)" \
  "$(grep -q 'ISSUES_CREATED=\$((ISSUES_CREATED + 1))' "$WATCH" && echo 1 || echo 0)"
assert_true \
  "watch: exit honesto preservado — FAILS>0 ainda sai 1 (#6469, P2)" \
  "$(grep -q '\[ "\$FAILS" -eq 0 \] || exit 1' "$WATCH" && echo 1 || echo 0)"

# ── opus-daily-diff-review.sh ───────────────────────────────────────────────
assert_true \
  "daily-review: transcript do Opus vai pro log (tee ... >&2), não pro Telegram" \
  "$(grep -qE 'tee "\$OUT_FILE" >&2' "$DAILY" && echo 1 || echo 0)"
assert_true \
  "daily-review: entrega condicionada a findings>0 ou issues_falharam>0" \
  "$(grep -q 'if \[ "\$FINDINGS" -gt 0 \] || \[ "\$ISSUES_FALHARAM" -gt 0 \]; then' "$DAILY" && echo 1 || echo 0)"
assert_true \
  "daily-review: resumo ilegível avisa em vez de virar silêncio (não se afirma 'tudo bem' sem ler)" \
  "$(grep -q 'resumo do dia não pôde ser lido' "$DAILY" && echo 1 || echo 0)"
assert_true \
  "daily-review: gate do marcador RESUMO-DAILY-REVIEW preservado (exit 4, review incompleto)" \
  "$(grep -q 'exit 4' "$DAILY" && echo 1 || echo 0)"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "$FAILED asserção(ões) falharam"
  exit 1
fi
echo ""
echo "TODOS OS TESTES PASSARAM"
