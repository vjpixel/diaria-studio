#!/usr/bin/env bash
# test/continuo-pr-review-reject-label-npx-stderr-leak.test.sh (#7567)
#
# Regressão preventiva: a mesma classe de bug já reincidiu 2x neste arquivo
# (`try_merge_gate()`) — `npx tsx ... 2>&1` mistura a linha "npm notice run
# ..." que `npx` SEMPRE emite em stderr dentro do JSON que o `jq` seguinte
# tenta parsear, quebrando o parse e caindo sempre no fallback (#6932 no
# ramo merge, reincidido pela PR #7447/#7449 nos ramos escalate/reject-
# dedupe). O bloco de label/notificação do ramo `reject` (#7567,
# `check-continuo-reject-label.ts`) usa o mesmo padrão stdout/stderr
# separado desde a 1ª versão — este teste tranca esse padrão contra
# regressão futura, mesmo mecanismo dos irmãos
# `continuo-pr-review-escalate-label-npx-stderr-leak.test.sh` e
# `continuo-pr-review-reject-dedupe-npx-stderr-leak.test.sh`.
#
# Mecanismo (mesmo padrão do #6923/#6885/#6910 — extrai e roda o FRAGMENTO
# REAL, não uma reimplementação): isola via `sed` o bloco exato entre o
# comentário "# #7567: label + notificação de dono" e o `fi` que fecha o
# `if/else` de `REJECT_FIRST_TIME`, e roda esse bloco como processo bash de
# verdade contra um `npx` FAKE no PATH que imita o comportamento real —
# JSON limpo em stdout, "npm notice" em stderr.
#
# Uso: bash test/continuo-pr-review-reject-label-npx-stderr-leak.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hermes/scripts/continuo-pr-review.sh"

FAILED=0
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) echo "ok: $desc" ;;
    *) echo "FAIL: $desc — esperava conter [$needle], obtido [$haystack]"; FAILED=1 ;;
  esac
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

BLOCK=$(sed -n '/# #7567: label + notificação de dono/,/^      fi$/p' "$SCRIPT")
if [ -z "$BLOCK" ]; then
  echo "FAIL: não encontrei o bloco de label/notificação do ramo reject (marcador #7567 mudou?)"
  FAILED=1
fi

CALL_LINE=$(printf '%s\n' "$BLOCK" | command grep 'npx tsx scripts/check-continuo-reject-label.ts')
case "$CALL_LINE" in
  *'2>&1)') echo "FAIL: a chamada do npx voltou a misturar stdout/stderr com 2>&1 (regressão da classe #6932): $CALL_LINE"; FAILED=1 ;;
esac

if [ "$FAILED" -eq 0 ]; then
  mkdir -p "$WORKDIR/bin"
  # Fake `npx` — imita o `npx tsx check-continuo-reject-label.ts` real: JSON
  # limpo em stdout, "npm notice" em stderr (o poluidor real).
  cat > "$WORKDIR/bin/npx" <<'EOF'
#!/usr/bin/env bash
echo "npm notice run diaria-studio@0.1.0 npx" >&2
echo "npm notice run 'tsx' scripts/check-continuo-reject-label.ts" >&2
echo '{"firstTime":false,"labelApplied":true,"source":"ok"}'
exit 0
EOF
  chmod +x "$WORKDIR/bin/npx"

  {
    echo 'pr=7593'
    echo 'GATE_JSON="{}"'
    # #7704: o bloco passou a contabilizar erro de infra quando o label não
    # foi aplicado — stub o contador e a função pra rodar o fragmento real
    # isolado, e capturar se ele disparou.
    echo 'INFRA_ERRORS=0'
    echo 'log_infra_error() { echo "INFRA:$2" >> "'"$WORKDIR/infra.txt"'"; }'
    echo "$BLOCK"
    echo 'echo "REJECT_FIRST_TIME=$REJECT_FIRST_TIME" > "'"$WORKDIR/out.txt"'"'
    echo 'echo "INFRA_ERRORS=$INFRA_ERRORS" >> "'"$WORKDIR/out.txt"'"'
  } > "$WORKDIR/runnable.sh"

  PATH="$WORKDIR/bin:$PATH" bash "$WORKDIR/runnable.sh" >"$WORKDIR/stdout.txt" 2>"$WORKDIR/stderr.txt"

  if [ ! -f "$WORKDIR/out.txt" ]; then
    echo "FAIL: bloco extraído não chegou a resolver REJECT_FIRST_TIME"
    echo "  stdout: $(cat "$WORKDIR/stdout.txt")"
    echo "  stderr: $(cat "$WORKDIR/stderr.txt")"
    FAILED=1
  else
    RESULT="$(cat "$WORKDIR/out.txt")"
    # A asserção que importa: mesmo com "npm notice" em stderr durante a
    # chamada, REJECT_FIRST_TIME resolve o valor REAL do JSON (false — já
    # sinalizada), não o fallback "true" de um jq que falhou o parse.
    assert_contains "REJECT_FIRST_TIME reflete o JSON real (false), não o fallback do jq quebrado" "$RESULT" "REJECT_FIRST_TIME=false"
    # #7704: PR JÁ sinalizada é o estado estacionário esperado a partir do 2º
    # tick — nunca um erro de infra. A 1ª versão desta checagem lia
    # `labelApplied` sem distinguir "não precisei aplicar" de "tentei e
    # falhei", e teria acusado falha aqui a cada tick, para sempre, com
    # stderr vazio (achado do fleet review da PR #7706).
    assert_contains "PR já sinalizada não conta erro de infra" "$RESULT" "INFRA_ERRORS=0"
  fi
fi

# Cenário 2 (#7704): falha REAL de aplicação do label (`labelApplied:false`
# com rc=0 — o wrapper nunca aborta) precisa virar erro de infra visível. É
# o modo de falha que deixou `continuo-escalado`/`continuo-rejeitado` sem
# existir por meses sem nenhum sinal.
if [ "$FAILED" -eq 0 ]; then
  WORKDIR2="$(mktemp -d)"
  trap 'rm -rf "$WORKDIR" "$WORKDIR2"' EXIT
  mkdir -p "$WORKDIR2/bin"
  cat > "$WORKDIR2/bin/npx" <<'EOF'
#!/usr/bin/env bash
echo "npm notice run diaria-studio@0.1.0 npx" >&2
echo '{"firstTime":true,"labelApplied":false,"source":"ok"}'
exit 0
EOF
  chmod +x "$WORKDIR2/bin/npx"
  {
    echo 'pr=7593'
    echo 'GATE_JSON="{}"'
    echo 'INFRA_ERRORS=0'
    echo 'log_infra_error() { echo "INFRA:$2" >> "'"$WORKDIR2/infra.txt"'"; }'
    echo "$BLOCK"
    echo 'echo "INFRA_ERRORS=$INFRA_ERRORS" > "'"$WORKDIR2/out.txt"'"'
  } > "$WORKDIR2/runnable.sh"

  PATH="$WORKDIR2/bin:$PATH" bash "$WORKDIR2/runnable.sh" >/dev/null 2>&1
  RESULT2="$(cat "$WORKDIR2/out.txt" 2>/dev/null || echo "SEM SAIDA")"
  assert_contains "labelApplied=false real conta erro de infra" "$RESULT2" "INFRA_ERRORS=1"
  INFRA2="$(cat "$WORKDIR2/infra.txt" 2>/dev/null || echo "SEM LOG")"
  assert_contains "log_infra_error recebe o motivo tipado" "$INFRA2" "INFRA:reject_label_not_applied"
fi

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
