#!/usr/bin/env bash
# claude-openrouter.sh — SHIM DE COMPATIBILIDADE (#7649 Parte 2, mantido por
# 1 ciclo). O script foi renomeado para claude-delegate.sh: deixou de ser
# só "openrouter" desde a Parte 1 (#7649), que adicionou um elo final de
# assinatura claude.ai — sem gateway nenhum — à cadeia de fallback.
#
# Delega integralmente pro arquivo com o nome novo, no MESMO diretório
# (resolve via BASH_SOURCE + readlink -f, imune a symlink de deploy — é a
# mesma lição do #6943/#6922, replicada aqui de propósito porque este shim
# é justamente o alvo do symlink real em ~/.hermes/scripts/ no `helios`).
#
# Remover este shim (e recriar o symlink do helios apontando direto pro
# nome novo) é follow-up de 1 ciclo — ver comentário no PR #7649 Parte 2 e
# hermes/README.md.
set -euo pipefail
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
DIR="$(dirname "$SELF")"
exec "$DIR/claude-delegate.sh" "$@"
