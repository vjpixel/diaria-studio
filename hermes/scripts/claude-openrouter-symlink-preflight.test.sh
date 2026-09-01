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
echo "$OUT" | grep -q "preflight" && { echo "FAIL: menção residual a 'preflight' na saída sugere falha de resolução: $OUT"; exit 1; }
echo "ok: nenhuma menção a falha de preflight na saída"
exit 0
