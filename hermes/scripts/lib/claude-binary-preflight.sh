#!/usr/bin/env bash
# claude-binary-preflight.sh (#6875, #6879) — checagem compartilhada: o
# binário Claude Code precisa existir e responder a `--version` antes de
# qualquer script de cron tentar usá-lo (claude-openrouter.sh,
# continuo-pr-review.sh, opus-daily-diff-review.sh). Sem isso, a falha real
# (binário ausente/quebrado, postinstall não rodou) vira sintoma enigmático
# no meio do script chamador em vez de erro nomeado logo no início.
#
# Uso: sourced pelos 3 scripts, chamado logo após `set -euo pipefail`:
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/claude-binary-preflight.sh"
#   claude_binary_preflight
#
# Sai com exit 5 (mesmo código que os 3 scripts já usavam antes da extração)
# se o binário estiver ausente ou quebrado.
#
# Testável isoladamente via CLAUDE_BINARY_PREFLIGHT_CMD (override do nome do
# binário verificado) — ver claude-binary-preflight.test.sh, que stuba um
# binário fake via PATH em vez de depender do `claude` real instalado.

claude_binary_preflight() {
  local cmd="${CLAUDE_BINARY_PREFLIGHT_CMD:-claude}"
  if ! "$cmd" --version >/dev/null 2>&1; then
    echo "ERRO: binário Claude Code quebrado — rodar node ~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/install.cjs" >&2
    exit 5
  fi
}
