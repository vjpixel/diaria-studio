#!/usr/bin/env bash
# test/continuo-pr-review-reject-dedupe-npx-stderr-leak.test.sh (#7446 item 1,
# review da PR #7449)
#
# Regressão: a 1ª versão do bloco de dedupe do comentário de rejeição
# (#7446 item 1) capturava `npx tsx ... 2>&1` — misturando a linha `npm
# notice run ...` que `npx` SEMPRE emite em stderr dentro do que o `jq`
# abaixo tenta parsear como JSON. Todo tick quebraria o parse (`jq: parse
# error`) e caía sempre no fallback `|| echo "false"` — o item 1 inteiro
# ficava inoperante (SKIP_COMMENT nunca resolvia "true", o comentário de
# rejeição seria repostado a cada tick de qualquer forma, o mesmo sintoma
# que #7446 item 1 existe pra consertar). Achado por review externo na PR
# irmã #7449 (mesma classe de bug, ramo `escalate`) — #6932 já tinha
# corrigido essa exata classe uma vez em `try_merge_gate()`; este teste
# tranca o ramo `reject` contra a mesma reincidência.
#
# Mecanismo (mesmo padrão do #6923/#6885/#6910 — extrai e roda o FRAGMENTO
# REAL, não uma reimplementação): isola via `sed` o bloco exato de dedupe
# entre o comentário `# #6932/#7446` e o `fi` que fecha o `if/else`, e roda
# esse bloco como processo bash de verdade contra um `npx` FAKE no PATH que
# imita o comportamento real — imprime JSON limpo em stdout E uma linha
# `npm notice run ...` em stderr.
#
# Uso: bash test/continuo-pr-review-reject-dedupe-npx-stderr-leak.test.sh
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

BLOCK=$(sed -n '\|# #6932/#7446 (review da PR #7449|,/^      fi$/p' "$SCRIPT")
if [ -z "$BLOCK" ]; then
  echo "FAIL: não encontrei o bloco de dedupe do comentário de rejeição (marcador #6932/#7446 mudou?)"
  FAILED=1
fi

# Sanity estrutural: a linha que CHAMA o npx (não o texto explicativo do
# comentário, que cita "2>&1" em prosa) tem de capturar stdout/stderr
# SEPARADOS — se a chamada real voltou a terminar em `2>&1)`, o teste falha
# aqui em vez de silenciosamente testar o caminho errado.
CALL_LINE=$(printf '%s\n' "$BLOCK" | command grep 'npx tsx scripts/check-continuo-reject-comment-dedupe.ts')
case "$CALL_LINE" in
  *'2>&1)') echo "FAIL: a chamada do npx voltou a misturar stdout/stderr com 2>&1 (regressão da classe #6932): $CALL_LINE"; FAILED=1 ;;
esac

if [ "$FAILED" -eq 0 ]; then
  mkdir -p "$WORKDIR/bin"
  # Fake `npx` — imita o `npx tsx check-continuo-reject-comment-dedupe.ts`
  # real: JSON limpo em stdout, "npm notice" em stderr (o poluidor real).
  cat > "$WORKDIR/bin/npx" <<'EOF'
#!/usr/bin/env bash
echo "npm notice run diaria-studio@0.1.0 npx" >&2
echo "npm notice run 'tsx' scripts/check-continuo-reject-comment-dedupe.ts" >&2
echo '{"skip":true,"source":"compared"}'
exit 0
EOF
  chmod +x "$WORKDIR/bin/npx"

  {
    echo 'pr=7404'
    echo 'GATE_JSON="{}"'
    echo 'REJECT_BODY="qualquer motivo"'
    echo "$BLOCK"
    echo 'echo "SKIP_COMMENT=$SKIP_COMMENT" > "'"$WORKDIR/out.txt"'"'
  } > "$WORKDIR/runnable.sh"

  PATH="$WORKDIR/bin:$PATH" bash "$WORKDIR/runnable.sh" >"$WORKDIR/stdout.txt" 2>"$WORKDIR/stderr.txt"

  if [ ! -f "$WORKDIR/out.txt" ]; then
    echo "FAIL: bloco extraído não chegou a resolver SKIP_COMMENT"
    echo "  stdout: $(cat "$WORKDIR/stdout.txt")"
    echo "  stderr: $(cat "$WORKDIR/stderr.txt")"
    FAILED=1
  else
    RESULT="$(cat "$WORKDIR/out.txt")"
    # A asserção que importa: mesmo com "npm notice" em stderr durante a
    # chamada, SKIP_COMMENT resolve o valor REAL do JSON (true), não o
    # fallback "false" de um jq que falhou o parse.
    assert_contains "SKIP_COMMENT reflete o JSON real (true), não o fallback do jq quebrado" "$RESULT" "SKIP_COMMENT=true"
  fi
fi

if [ "$FAILED" -eq 1 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TODOS OS TESTES PASSARAM"
