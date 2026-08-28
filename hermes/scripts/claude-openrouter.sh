#!/usr/bin/env bash
# claude-openrouter.sh — roda `claude -p` (harness do Claude Code) com modelo
# do OpenRouter, SEM tocar a cota da assinatura claude.ai.
#
# Por que existe (28/08/2026): o hermes-diaria-continuo parafraseava as regras
# do repo (classifyExecTrack etc.) em prosa que envelhecia em silêncio — 5
# categorias na cópia vs 6 no código real. Este wrapper troca paráfrase por
# execução: o modelo roda DENTRO do checkout, com CLAUDE.md carregado e os
# scripts reais.
#
# Mecanismo: o OpenRouter fala a Messages API da Anthropic nativamente
# (validado ao vivo em /api/v1/messages, 28/08). ANTHROPIC_BASE_URL +
# ANTHROPIC_AUTH_TOKEN apontam o CLI pra lá; --model aceita slug do OpenRouter
# (com aviso de "modelo desconhecido", inofensivo).
#
# REGRAS INEGOCIÁVEIS (#5608 do diaria-studio):
#   - As env vars ANTHROPIC_* vivem SÓ no processo filho (env ... claude).
#     NUNCA exportar no ambiente global — sequestram sessões da assinatura
#     e desligam os conectores claude.ai (Beehiiv/Gmail) do pipeline.
#   - Este wrapper é pra fila de issues/código. NÃO usar pra nada que precise
#     dos conectores claude.ai.
#
# Gotchas embutidos:
#   - Prompt via STDIN (--allowedTools é variádico e engole prompt posicional).
#   - Fallback de modelo: free primeiro; se free falhar (balde diário esgota —
#     compartilhado por CONTA entre todos os :free), cai pro glm-5.3-flash
#     pago (~USD 0,075/M in; teto diário da chave limita o estrago).
#
# Uso:
#   echo "<tarefa>" | claude-openrouter.sh [--tools "Read,Bash(npx tsx:*)"] \
#     [--cwd DIR] [--budget USD] [--timeout SECS] [--model SLUG]
set -euo pipefail

TOOLS="Read,Grep,Glob,Bash"
CWD="/home/vjpixel/diaria-studio"
BUDGET="0.25"
TIMEOUT="1800"
MODELS_DEFAULT=("z-ai/glm-5.2:free" "dots-studio/dots-3-note-preview:free" "z-ai/glm-5.3-flash")
MODEL_FORCED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tools)   TOOLS="$2"; shift 2 ;;
    --cwd)     CWD="$2"; shift 2 ;;
    --budget)  BUDGET="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --model)   MODEL_FORCED="$2"; shift 2 ;;
    *) echo "arg desconhecido: $1" >&2; exit 2 ;;
  esac
done

# Mesma fonte de chave que o próprio Hermes usa (credential_pool.openrouter).
KEY=$(python3 - <<'PY'
import json
a = json.load(open('/home/vjpixel/.hermes/auth.json'))
for c in a.get('credential_pool', {}).get('openrouter', []):
    t = c.get('access_token', '')
    if t.startswith('sk-or-'):
        print(t)
        break
PY
)
[ -n "$KEY" ] || { echo "ERRO: nenhuma chave OpenRouter no auth.json" >&2; exit 3; }

PROMPT=$(cat)
[ -n "$PROMPT" ] || { echo "ERRO: prompt vazio no stdin" >&2; exit 2; }

if [ -n "$MODEL_FORCED" ]; then
  MODELS=("$MODEL_FORCED")
else
  MODELS=("${MODELS_DEFAULT[@]}")
fi

# Sem --bare de propósito: --bare desliga o auto-discovery do CLAUDE.md, que é
# metade do valor deste wrapper. A troca de auth é garantida pelo env mesmo
# assim — ANTHROPIC_AUTH_TOKEN tem precedência sobre o OAuth da assinatura
# (o CLI avisa "connectors are disabled ... takes precedence", validado 28/08).
cd "$CWD"
for MODEL in "${MODELS[@]}"; do
  echo "[claude-openrouter] tentando model=$MODEL" >&2
  set +e
  OUT=$(printf '%s' "$PROMPT" | timeout "$TIMEOUT" env \
    ANTHROPIC_BASE_URL="https://openrouter.ai/api" \
    ANTHROPIC_AUTH_TOKEN="$KEY" \
    CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000 \
    claude -p \
      --model "$MODEL" \
      --allowedTools "$TOOLS" \
      --max-budget-usd "$BUDGET" 2> >(grep -vE "not a model this version|unrecognized_model|connectors are disabled" >&2) \
    )
  RC=$?
  set -e
  if [ $RC -eq 0 ] && [ -n "$OUT" ]; then
    printf '%s\n' "$OUT"
    echo "[claude-openrouter] ok model=$MODEL" >&2
    exit 0
  fi
  echo "[claude-openrouter] falhou model=$MODEL rc=$RC — próximo da cadeia" >&2
done

echo "ERRO: todos os modelos da cadeia falharam" >&2
exit 1
