#!/usr/bin/env bash
# test/continuo-pr-review-escalate-label-npx-stderr-leak.test.sh (#7446 item 2)
#
# Regressão achada por review externo na PR #7449: a 1ª versão do bloco de
# label/notificação do ramo `escalate` (#7446 item 2) capturava `npx tsx ...
# 2>&1` — misturando a linha "npm notice run ..." que `npx` SEMPRE emite em
# stderr dentro do JSON que o `jq` abaixo tenta parsear. Todo tick quebraria
# o parse (`jq: parse error`) e caía sempre no fallback `|| echo "true"` —
# `FIRST_TIME` nunca resolvia "false", então o item 2 inteiro (não repetir a
# notificação a cada tick) ficava inoperante mesmo com o label aplicado
# corretamente. Mesma classe que #6932 já corrigiu uma vez em
# `try_merge_gate()`, e que a PR irmã #7447 (item 1, ramo `reject`)
# reintroduziu em paralelo — este teste tranca o ramo `escalate` contra a
# mesma reincidência.
#
# Mecanismo (mesmo padrão do #6923/#6885/#6910 — extrai e roda o FRAGMENTO
# REAL): isola via `sed` o bloco exato entre o comentário "Review externo
# (PR #7449)" e o `fi` que fecha o `if/else`, e roda contra um `npx` FAKE no
# PATH que imita o comportamento real — JSON limpo em stdout, "npm notice"
# em stderr.
#
# Uso: bash test/continuo-pr-review-escalate-label-npx-stderr-leak.test.sh
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

BLOCK=$(sed -n '/# Review externo (PR #7449)/,/^      fi$/p' "$SCRIPT")
if [ -z "$BLOCK" ]; then
  echo "FAIL: não encontrei o bloco de label/notificação do ramo escalate (marcador mudou?)"
  FAILED=1
fi

CALL_LINE=$(printf '%s\n' "$BLOCK" | command grep 'npx tsx scripts/check-continuo-escalate-label.ts')
case "$CALL_LINE" in
  *'2>&1)') echo "FAIL: a chamada do npx voltou a misturar stdout/stderr com 2>&1 (regressão da classe #6932): $CALL_LINE"; FAILED=1 ;;
esac

if [ "$FAILED" -eq 0 ]; then
  mkdir -p "$WORKDIR/bin"
  # Fake `npx` — imita o `npx tsx check-continuo-escalate-label.ts` real:
  # JSON limpo em stdout, "npm notice" em stderr (o poluidor real).
  cat > "$WORKDIR/bin/npx" <<'EOF'
#!/usr/bin/env bash
echo "npm notice run diaria-studio@0.1.0 npx" >&2
echo "npm notice run 'tsx' scripts/check-continuo-escalate-label.ts" >&2
echo '{"firstTime":false,"labelApplied":false,"source":"ok"}'
exit 0
EOF
  chmod +x "$WORKDIR/bin/npx"

  {
    echo 'pr=7432'
    echo 'GATE_JSON="{}"'
    echo 'ESCALATED=0'
    echo "$BLOCK"
    echo 'echo "FIRST_TIME=$FIRST_TIME" > "'"$WORKDIR/out.txt"'"'
  } > "$WORKDIR/runnable.sh"

  PATH="$WORKDIR/bin:$PATH" bash "$WORKDIR/runnable.sh" >"$WORKDIR/stdout.txt" 2>"$WORKDIR/stderr.txt"

  if [ ! -f "$WORKDIR/out.txt" ]; then
    echo "FAIL: bloco extraído não chegou a resolver FIRST_TIME"
    echo "  stdout: $(cat "$WORKDIR/stdout.txt")"
    echo "  stderr: $(cat "$WORKDIR/stderr.txt")"
    FAILED=1
  else
    RESULT="$(cat "$WORKDIR/out.txt")"
    # A asserção que importa: mesmo com "npm notice" em stderr durante a
    # chamada, FIRST_TIME resolve o valor REAL do JSON (false — já
    # sinalizada), não o fallback "true" de um jq que falhou o parse.
    assert_contains "FIRST_TIME reflete o JSON real (false), não o fallback do jq quebrado" "$RESULT" "FIRST_TIME=false"
  fi
fi

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
