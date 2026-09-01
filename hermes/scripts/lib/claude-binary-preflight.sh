#!/usr/bin/env bash
# claude-binary-preflight.sh (#6875, #6879, #6891) — checagem compartilhada: o
# binário Claude Code precisa existir e responder a `--version` antes de
# qualquer script de cron tentar usá-lo (claude-openrouter.sh,
# continuo-pr-review.sh, opus-daily-diff-review.sh). Sem isso, a falha real
# (binário ausente/quebrado, postinstall não rodou) vira sintoma enigmático
# no meio do script chamador em vez de erro nomeado logo no início.
#
# #6891 (01/09/2026): auto-reparo UMA vez antes de abortar. Medido em 01/09
# (#6875/#6891): o auto-updater do Claude Code reinstala em ciclo, e cada
# reinstalação abre uma janela em que o shim do npm já aponta pro binário
# mas o `postinstall` ainda não terminou de criá-lo — 3 quebras em 5h. A
# Parte A do #6891 (DISABLE_AUTOUPDATER=1 nos 3 scripts) ataca a CAUSA;
# esta Parte B é a rede de segurança pra quem invocar de fora dos 3 scripts,
# ou pra qualquer outra causa de binário quebrado — reparar é uma linha
# idempotente (`node install.cjs`), caro demais abortar por isso na
# frequência medida.
#
# Sequência: 1) `claude --version` falhou? 2) roda `node <install.cjs>`
# (idempotente) 3) tenta `claude --version` de novo 4) ainda falhou? exit 5
# como antes 5) funcionou? AVISA no stderr (nunca silencioso — reparar sem
# avisar esconde a frequência real da quebra, o dado que gerou a issue) e
# segue.
#
# Uso: sourced pelos 3 scripts, chamado logo após `set -euo pipefail`:
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/claude-binary-preflight.sh"
#   claude_binary_preflight
#
# Sai com exit 5 (mesmo código de antes) se o binário estiver ausente/quebrado
# E o reparo não resolver.
#
# Testável isoladamente via 3 overrides (nenhum depende do `claude`/`npm`/
# `node` reais — ver claude-binary-preflight.test.sh):
#   CLAUDE_BINARY_PREFLIGHT_CMD          — binário verificado (default: claude)
#   CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD   — comando de reparo (default: deriva
#                                          `node <npm root -g>/@anthropic-ai/claude-code/install.cjs`)
#   CLAUDE_BINARY_PREFLIGHT_NPM_CMD      — binário `npm` usado pra resolver
#                                          o prefixo global (default: npm)

claude_binary_preflight() {
  local cmd="${CLAUDE_BINARY_PREFLIGHT_CMD:-claude}"
  if "$cmd" --version >/dev/null 2>&1; then
    return 0
  fi

  local repair_cmd="${CLAUDE_BINARY_PREFLIGHT_REPAIR_CMD:-}"
  local install_cjs=""
  if [ -z "$repair_cmd" ]; then
    # Deriva o caminho do install.cjs do prefixo REAL do npm nesta máquina
    # (`~/.npmrc`/config, não uma constante — #6891 nomeia isso
    # explicitamente: hardcodar `~/.npm-global/...` quebra em qualquer
    # máquina com prefixo diferente).
    local npm_cmd="${CLAUDE_BINARY_PREFLIGHT_NPM_CMD:-npm}"
    local npm_root
    npm_root="$("$npm_cmd" root -g 2>/dev/null)" || npm_root=""
    if [ -n "$npm_root" ]; then
      install_cjs="${npm_root}/@anthropic-ai/claude-code/install.cjs"
      repair_cmd="node \"$install_cjs\""
    fi
  fi

  if [ -n "$repair_cmd" ]; then
    eval "$repair_cmd" >/dev/null 2>&1 || true
    if "$cmd" --version >/dev/null 2>&1; then
      echo "AVISO: binário Claude Code estava quebrado — reparado automaticamente (#6891)${install_cjs:+" via $install_cjs"}. A frequência desta mensagem é o dado que abriu a issue — não ignorar se aparecer com frequência." >&2
      return 0
    fi
  fi

  echo "ERRO: binário Claude Code quebrado — reparo automático não resolveu${install_cjs:+" ($install_cjs)"} — rodar manualmente: node \$(npm root -g)/@anthropic-ai/claude-code/install.cjs" >&2
  exit 5
}
