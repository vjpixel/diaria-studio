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
  "watch: INDETERMINADO/falha segue em stderr, não demovido pro log junto com as linhas 'ok' (P3 do review da #8454)" \
  "$(grep -c 'echo "\[watch\].*INDETERMINADO' "$WATCH" | grep -qvx 0 && echo 1 || echo 0)"
assert_true \
  "watch: \$WATCH_LOG tem teto de tamanho (P3 do review da #8454: note() escreve ~30 linhas/dia pra sempre)" \
  "$(grep -q 'WATCH_LOG_MAX_LINES' "$WATCH" && echo 1 || echo 0)"
assert_true \
  "watch: file_issue conta a issue criada (senão o stdout final nunca dispara)" \
  "$(grep -q 'ISSUES_CREATED=\$((ISSUES_CREATED + 1))' "$WATCH" && echo 1 || echo 0)"
assert_true \
  "watch: exit honesto preservado — FAILS>0 ainda sai 1 (#6469, P2)" \
  "$(grep -q '\[ "\$FAILS" -eq 0 \] || exit 1' "$WATCH" && echo 1 || echo 0)"

# ── opus-daily-diff-review.sh: bloco de entrega executado de verdade ────────
# Achado P1 do review da #8454: esta seção só fazia `grep` no texto do script,
# então passava mesmo que o caminho fosse inalcançável — e não pegou o P0
# (`set -e` + `pipefail` matando a atribuição de FINDINGS num resumo sem
# `findings=`, justo o cenário do ramo "não pôde ser lido"). Agora o bloco
# REAL roda contra um $OUT_FILE forjado, igual à seção do pr-review.
DBLOCK="$TMPDIR/daily-delivery.sh"
awk '/^RESUMO=\$\(command grep -m1 /,0' "$DAILY" > "$DBLOCK"
if [ ! -s "$DBLOCK" ]; then
  echo "FAIL: não extraiu o bloco de entrega de $DAILY (marcador RESUMO= mudou?)"
  exit 1
fi

# Roda o bloco real sob `set -euo pipefail` (como no script) com um
# transcript forjado. Devolve o stdout — o que o Telegram receberia.
run_daily() {
  printf '%s\n' "$1" > "$TMPDIR/out.txt"
  bash -c "
    set -euo pipefail
    OUT_FILE='$TMPDIR/out.txt'
    source '$DBLOCK'
  " 2>/dev/null || true
}
# rc do bloco, separado: sem o `|| true` acima, um bloco que ABORTA (o bug P0
# fazia exatamente isso) derrubaria este próprio teste via `set -e` em vez de
# produzir um FAIL legível — a asserção morreria antes de ser avaliada.
run_daily_rc() {
  local rc
  set +e
  bash -c "
    set -euo pipefail
    OUT_FILE='$TMPDIR/out.txt'
    source '$DBLOCK'
  " >/dev/null 2>&1
  rc=$?
  set -e
  return "$rc"
}

OUT=$(run_daily "blá blá
RESUMO-DAILY-REVIEW: commits=12 findings=0 issues_criadas=nenhuma issues_falharam=0")
assert_true \
  "daily-review: dia limpo (findings=0) não escreve NADA no stdout" \
  "$([ -z "$OUT" ] && echo 1 || echo 0)"

OUT=$(run_daily "RESUMO-DAILY-REVIEW: commits=12 findings=3 issues_criadas=x issues_falharam=0")
assert_true \
  "daily-review: findings>0 entrega a linha de resumo" \
  "$(echo "$OUT" | grep -q 'findings=3' && echo 1 || echo 0)"
assert_true \
  "daily-review: entrega SÓ a linha de resumo, nunca o transcript" \
  "$([ "$(printf '%s' "$OUT" | wc -l)" -le 1 ] && echo 1 || echo 0)"

OUT=$(run_daily "RESUMO-DAILY-REVIEW: commits=12 findings=0 issues_criadas=x issues_falharam=2")
assert_true \
  "daily-review: issues_falharam>0 avisa mesmo com findings=0 (achado que não foi registrado é o pior caso)" \
  "$(echo "$OUT" | grep -q 'issues_falharam=2' && echo 1 || echo 0)"

# O P0 do review: resumo presente mas SEM o campo findings= (desvio de
# formatação do Opus). Antes do `|| true`, `set -e`+`pipefail` abortavam a
# atribuição e o script morria com stdout vazio — silêncio no único cenário
# que a política manda sempre avisar.
OUT=$(run_daily "RESUMO-DAILY-REVIEW: commits=12 issues_criadas=nenhuma")
assert_true \
  "daily-review: resumo SEM campo findings= avisa em vez de morrer calado (P0 do review da #8454)" \
  "$(echo "$OUT" | grep -q 'não pôde ser lido' && echo 1 || echo 0)"
printf '%s\n' "RESUMO-DAILY-REVIEW: commits=12 issues_criadas=nenhuma" > "$TMPDIR/out.txt"
DAILY_RC=0
run_daily_rc || DAILY_RC=$?
assert_true \
  "daily-review: resumo malformado ainda sai com exit 0 (o aviso já é a mensagem; exit 1 duplicaria com alerta de crash)" \
  "$([ "$DAILY_RC" -eq 0 ] && echo 1 || echo 0)"

OUT=$(run_daily "transcript sem marcador nenhum")
assert_true \
  "daily-review: transcript sem marcador RESUMO avisa (não se afirma 'tudo bem' sem ler)" \
  "$(echo "$OUT" | grep -q 'não pôde ser lido' && echo 1 || echo 0)"

assert_true \
  "daily-review: transcript do Opus vai pro log (tee ... >&2), não pro Telegram" \
  "$(grep -qE 'tee "\$OUT_FILE" >&2' "$DAILY" && echo 1 || echo 0)"
assert_true \
  "daily-review: gate do marcador RESUMO-DAILY-REVIEW preservado (exit 4, review incompleto)" \
  "$(grep -q 'exit 4' "$DAILY" && echo 1 || echo 0)"

# ── watch-continuo-health.sh: portão de stdout executado de verdade ─────────
WBLOCK="$TMPDIR/watch-delivery.sh"
awk '/^if \[ "\$ISSUES_CREATED" -gt 0 \]; then$/,/^fi$/' "$WATCH" > "$WBLOCK"
if [ ! -s "$WBLOCK" ]; then
  echo "FAIL: não extraiu o portão de stdout de $WATCH"
  exit 1
fi
run_watch() {
  bash -c "
    set -uo pipefail
    ISSUES_CREATED=$1
    ISSUES_CREATED_TITLES='- [watch-continuo] exemplo
'
    source '$WBLOCK'
  " 2>/dev/null
}
OUT=$(run_watch 0)
assert_true \
  "watch: varredura sem issue aberta não escreve NADA no stdout" \
  "$([ -z "$OUT" ] && echo 1 || echo 0)"
OUT=$(run_watch 2)
assert_true \
  "watch: issue aberta entrega contagem + título (o diagnóstico fica na issue)" \
  "$(echo "$OUT" | grep -q '2 issue(s)' && echo "$OUT" | grep -q 'exemplo' && echo 1 || echo 0)"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "$FAILED asserção(ões) falharam"
  exit 1
fi
echo ""
echo "TODOS OS TESTES PASSARAM"
