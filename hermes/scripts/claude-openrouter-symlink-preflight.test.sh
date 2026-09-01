#!/usr/bin/env bash
# hermes/scripts/claude-openrouter-symlink-preflight.test.sh (#6943)
#
# Regressão: `${BASH_SOURCE[0]}` sem `readlink -f` resolve pro caminho de
# INVOCAÇÃO quando o script é chamado através de um SYMLINK — o `source
# .../lib/claude-binary-preflight.sh` (e o de free-quota-exhaustion.sh)
# procurava `lib/` do lado do symlink, que não existe (deploy real do
# `helios`: `~/.hermes/scripts/claude-openrouter.sh` é symlink pro repo,
# sem `~/.hermes/scripts/lib/`). O contínuo ficou 8 de 11 ticks sem fazer
# NADA por isso — o wrapper morria antes de qualquer chamada, sempre no
# mesmo lugar (#6922/#6943).
#
# Testar o arquivo REAL direto (sem symlink) NUNCA reproduz — por isso
# este teste cria o symlink deliberadamente, sem `lib/` ao lado, exatamente
# como o deploy quebrado. Com o `source` sem `readlink -f`, este teste
# FALHA; com o fix, passa.
#
# Uso: bash hermes/scripts/claude-openrouter-symlink-preflight.test.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$REPO/hermes/scripts/claude-openrouter.sh"

TMPDIR_TEST="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

# Symlink SEM lib/ ao lado — reproduz o deploy real (não um stub com
# `exec`, que sobrevive ao bug por troca de processo; um SYMLINK de
# verdade, que é o caso que quebra).
SYMLINK="$TMPDIR_TEST/claude-openrouter.sh"
ln -s "$WRAPPER" "$SYMLINK"

# Fake `claude` — responde --version (preflight) e qualquer outra
# invocação com exit 0. Evita rede real via OpenRouter mesmo se
# `~/.hermes/auth.json` existir de verdade nesta máquina (o script segue
# até tentar invocar `claude` de verdade se o fake não estivesse na
# frente do PATH).
FAKE_BIN="$TMPDIR_TEST/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "1.0.0 (fake)"; exit 0; fi
echo "resposta fake (#6943, prova que chegou até aqui)"
exit 0
FAKE
chmod +x "$FAKE_BIN/claude"

set +e
OUT=$(PATH="$FAKE_BIN:$PATH" CLAUDE_BINARY_PREFLIGHT_CMD="claude" \
  "$SYMLINK" --model z-ai/glm-5.3-flash --timeout 5 <<< "prompt de teste" 2>&1)
RC=$?
set -e

# O bug do #6943 se manifesta como "arquivo/diretório não encontrado"
# apontando pra um dos 2 arquivos sourceados — nunca deveria aparecer,
# não importa como o resto da execução termina (auth.json ausente nesta
# máquina é um desfecho ESPERADO e válido, distinto do bug).
if printf '%s' "$OUT" | grep -qiE "(claude-binary-preflight\.sh|free-quota-exhaustion\.sh).*(No such file|not found)|(No such file|not found).*(claude-binary-preflight\.sh|free-quota-exhaustion\.sh)"; then
  echo "FAIL: source através do symlink NÃO resolveu (#6943 reaberto) — saída:"
  echo "$OUT"
  exit 1
fi

echo "ok: source através do symlink resolveu sem erro de arquivo não encontrado (rc=$RC)"

# Positivo, não só ausência de erro (achado de review, PR #6944): exige
# que a execução tenha chegado a um dos 2 desfechos ESPERADOS pós-source
# — sucesso de verdade (claude fake responde 0 o tempo todo) ou o erro
# nomeado de auth.json ausente (#6943 nomeia esse arquivo hardcoded,
# `/home/vjpixel/.hermes/auth.json` — pode existir de verdade nesta
# máquina ou não, os dois são desfechos válidos). Qualquer OUTRA coisa
# (crash inesperado, erro de sintaxe introduzido alhures) derruba o teste
# em vez de passar por omissão.
if [ "$RC" -eq 0 ] || printf '%s' "$OUT" | grep -q "nenhuma chave OpenRouter legível"; then
  echo "ok: desfecho pós-source é um dos esperados (rc=$RC)"
else
  echo "FAIL: desfecho inesperado pós-source (rc=$RC) — nem sucesso nem o erro nomeado de auth.json ausente:"
  echo "$OUT"
  exit 1
fi

exit 0
