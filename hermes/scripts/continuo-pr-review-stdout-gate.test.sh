#!/usr/bin/env bash
# Teste de regressão #8532 — stdout de continuo-pr-review.sh é o payload do
# Telegram, e o #8454 comprou o invariante "só fala quando há problema".
#
# O furo que este teste tranca: `gh pr comment` e `gh pr merge` imprimem em
# STDOUT (a URL do comentário criado / "✓ Squashed and merged..."), e as
# chamadas rodavam no meio do laço de PRs, muito ANTES do guard
# `if [ "$NOTIFY" -eq 0 ]; then exit 0; fi` do fim do script. Um tick que o
# script decidiu manter silencioso entregava mesmo assim uma mensagem — no
# caso medido (20/09 05:07, PR #8510), uma URL nua e nada mais.
#
# Método: análise estática do fonte, não execução — rodar o script de
# verdade exigiria rede (gh, git fetch, `claude -p`) e uma PR real. O que
# se verifica é a propriedade que causou o bug: TODA invocação de `gh` que
# escreve em stdout, fora do bloco final de entrega, precisa redirecionar.
# Um `grep` por "existe >&2 no arquivo" não serviria (#6859: o teste
# passaria com o redirect numa linha morta) — aqui casa-se linha a linha.
#
# Uso: bash hermes/scripts/continuo-pr-review-stdout-gate.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$DIR/continuo-pr-review.sh"
FAILED=0

fail() { echo "FAIL: $1"; FAILED=1; }
ok()   { echo "ok: $1"; }

[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT não existe"; exit 1; }

# Linha do guard de entrega — tudo ACIMA dela é laço de trabalho e não pode
# escrever em stdout; o bloco abaixo é a entrega gated e pode.
GATE_LINE=$(grep -n 'if \[ "\$NOTIFY" -eq 0 \]' "$SCRIPT" | head -1 | cut -d: -f1)
if [ -z "$GATE_LINE" ]; then
  fail "guard NOTIFY sumiu do script — o invariante do #8454 não existe mais"
  exit 1
fi
ok "guard NOTIFY presente (linha $GATE_LINE)"

# Toda chamada de `gh` ACIMA do guard precisa: redirecionar pra stderr
# (>&2), ser capturada em variável ($(...)), ou ir pra /dev/null. O que não
# pode é escrever solto em stdout.
VAZAMENTOS=0
while IFS= read -r entry; do
  lineno=${entry%%:*}
  line=${entry#*:}
  [ "$lineno" -lt "$GATE_LINE" ] || continue
  case "$line" in
    *'>&2'*|*'$('*|*'/dev/null'*|*'|'*) continue ;;
  esac
  fail "linha $lineno escreve em stdout antes do guard NOTIFY (#8532):$line"
  VAZAMENTOS=$((VAZAMENTOS + 1))
done < <(grep -nE '^[[:space:]]*gh ' "$SCRIPT")

[ "$VAZAMENTOS" -eq 0 ] && ok "nenhuma chamada gh escreve em stdout antes do guard"

# As duas chamadas do incidente, nominalmente — se alguém reescrever o
# bloco e perder o redirect, o laço acima já pega; isto nomeia o caso.
if grep -qE '^[[:space:]]*gh pr comment "\$pr" --body "\$REJECT_BODY" >&2$' "$SCRIPT"; then
  ok "gh pr comment redireciona (a URL do comentário não vai pro Telegram)"
else
  fail "gh pr comment sem >&2 — URL nua volta a vazar no tick silencioso (#8532)"
fi

if [ "$(grep -cE '^[[:space:]]*gh pr merge .* >&2$' "$SCRIPT")" -eq 2 ]; then
  ok "ambos os ramos de gh pr merge redirecionam"
else
  fail "algum ramo de gh pr merge perdeu o >&2 — '✓ Squashed and merged' volta pro Telegram (#8532)"
fi

if [ "$FAILED" -eq 0 ]; then echo "PASS"; else echo "FALHOU"; fi
exit "$FAILED"
