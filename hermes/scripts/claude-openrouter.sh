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
#   - Exit codes na falha total da cadeia (#6617, 28/08/2026): 1 = falha
#     transitória (quota/rate-limit/timeout — "volta sozinho" é uma leitura
#     válida); 4 = pelo menos um modelo da cadeia falhou com sinal de CONFIG
#     INVÁLIDA (model id que o provedor não reconhece) e nenhum sinal de
#     quota apareceu — "volta sozinho" é falso aqui, precisa correção manual
#     do MODELS_DEFAULT/--model. Motivado por incidente real: o watchdog de
#     rate-limit do Hermes lia rc≠0 como sinônimo de quota-exhaustion e
#     pausava o job dizendo "reset natural resolve", mas `z-ai/glm-5.2:free`
#     tinha saído do catálogo do OpenRouter (confirmado via
#     /api/v1/models, 28/08) — a cadeia nunca ia se recuperar sozinha.
#
# Uso:
#   echo "<tarefa>" | claude-openrouter.sh [--tools "Read,Bash(npx tsx:*)"] \
#     [--cwd DIR] [--budget USD] [--timeout SECS] [--model SLUG]
set -euo pipefail

TOOLS="Read,Grep,Glob,Bash"
CWD="/home/vjpixel/diaria-studio"
BUDGET="0.25"
TIMEOUT="1800"
# z-ai/glm-5.2:free saiu do catálogo do OpenRouter (confirmado ao vivo em
# /api/v1/models, 28/08/2026 — #6617) e foi substituído por poolside/laguna-
# s-2.1:free, já validado em produção (job 5d791ef6fc2c do Hermes contínuo).
MODELS_DEFAULT=("poolside/laguna-s-2.1:free" "dots-studio/dots-3-note-preview:free" "z-ai/glm-5.3-flash")
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

# Validar numéricos ANTES do loop (finding do review #6446: valor malformado
# faria TODOS os modelos falharem identicamente, mascarado como "cadeia caiu").
case "$TIMEOUT" in (*[!0-9]*|'') echo "ERRO: --timeout deve ser inteiro em segundos, veio '$TIMEOUT'" >&2; exit 2 ;; esac
case "$BUDGET" in (*[!0-9.]*|''|.|*.*.*) echo "ERRO: --budget deve ser numérico em USD, veio '$BUDGET'" >&2; exit 2 ;; esac

# Mesma fonte de chave que o próprio Hermes usa (credential_pool.openrouter).
# try/except (finding do review #6446): auth.json ausente/corrompido imprimia
# traceback cru e matava o script via set -e ANTES do guard de mensagem abaixo.
KEY=$(python3 - <<'PY'
import json
try:
    a = json.load(open('/home/vjpixel/.hermes/auth.json'))
except Exception:
    raise SystemExit(0)  # stdout vazio -> guard do shell dá a mensagem
for c in a.get('credential_pool', {}).get('openrouter', []):
    t = c.get('access_token', '')
    if t.startswith('sk-or-'):
        print(t)
        break
PY
)
[ -n "$KEY" ] || { echo "ERRO: nenhuma chave OpenRouter legível em ~/.hermes/auth.json (arquivo ausente, JSON inválido, ou sem token sk-or-*)" >&2; exit 3; }

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
# stderr CRU sempre preservado em arquivo (finding do review #6446: o filtro
# de ruído era a ÚNICA cópia — linha real que contivesse um dos padrões era
# perdida pra sempre). O terminal segue filtrado; o arquivo tem tudo.
STDERR_LOG="${TMPDIR:-/tmp}/claude-openrouter-stderr.$$.log"
# Sinais agregados pra decidir o exit code final (#6617): "unrecognized_model"
# sozinho é ruído esperado de QUALQUER modelo de terceiro (o CLI não conhece
# nenhum slug do OpenRouter) — não distingue modelo válido de inválido. O que
# distingue é o PROVEDOR recusar o modelo (rc≠0 + saída vazia + nenhum sinal
# de quota/rate-limit no mesmo stderr) vs. a conta ficar sem cota (429/rate
# limit explícito, ou timeout — esses SIM se resolvem sozinhos no reset).
SAW_QUOTA_SIGNAL=0
SAW_CONFIG_ERROR_SIGNAL=0
for MODEL in "${MODELS[@]}"; do
  echo "[claude-openrouter] tentando model=$MODEL" >&2
  ATTEMPT_LOG="${TMPDIR:-/tmp}/claude-openrouter-attempt.$$.log"
  : > "$ATTEMPT_LOG"
  set +e
  OUT=$(printf '%s' "$PROMPT" | timeout "$TIMEOUT" env \
    ANTHROPIC_BASE_URL="https://openrouter.ai/api" \
    ANTHROPIC_AUTH_TOKEN="$KEY" \
    CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000 \
    claude -p \
      --model "$MODEL" \
      --allowedTools "$TOOLS" \
      --max-budget-usd "$BUDGET" 2> >(tee -a "$STDERR_LOG" "$ATTEMPT_LOG" | grep -vE "not a model this version|unrecognized_model|connectors are disabled" >&2) \
    )
  RC=$?
  set -e
  if [ $RC -eq 0 ] && [ -n "$OUT" ]; then
    printf '%s\n' "$OUT"
    echo "[claude-openrouter] ok model=$MODEL" >&2
    rm -f "$STDERR_LOG" "$ATTEMPT_LOG"
    exit 0
  fi
  # Classificar o motivo desta tentativa (finding do review #6446 cobria só
  # rc=0/saída-vazia vs timeout vs rc≠0 genérico; #6617 acrescenta a
  # distinção quota-transitória vs config-permanente dentro do rc≠0/vazio).
  if [ $RC -eq 124 ]; then
    SAW_QUOTA_SIGNAL=1
    echo "[claude-openrouter] falhou model=$MODEL: TIMEOUT (${TIMEOUT}s) — próximo da cadeia; stderr cru em $STDERR_LOG" >&2
  elif grep -qiE "rate.?limit|429|quota exceeded|too many requests" "$ATTEMPT_LOG"; then
    SAW_QUOTA_SIGNAL=1
    echo "[claude-openrouter] falhou model=$MODEL rc=$RC: RATE-LIMIT/QUOTA (sinal no stderr) — transitório, próximo da cadeia; stderr cru em $STDERR_LOG" >&2
  elif grep -qiE "model not found|invalid model|no endpoints found|no allowed providers" "$ATTEMPT_LOG"; then
    SAW_CONFIG_ERROR_SIGNAL=1
    echo "[claude-openrouter] falhou model=$MODEL rc=$RC: MODELO INEXISTENTE/INVÁLIDO no provedor — config permanente, NÃO é rate-limit; próximo da cadeia; stderr cru em $STDERR_LOG" >&2
  elif [ $RC -eq 0 ]; then
    echo "[claude-openrouter] falhou model=$MODEL: saída VAZIA com rc=0 (sessão terminou sem texto final) — próximo da cadeia; stderr cru em $STDERR_LOG" >&2
  else
    echo "[claude-openrouter] falhou model=$MODEL rc=$RC — sem sinal claro de quota nem de modelo inválido; próximo da cadeia; stderr cru em $STDERR_LOG" >&2
  fi
  rm -f "$ATTEMPT_LOG"
done

if [ "$SAW_CONFIG_ERROR_SIGNAL" -eq 1 ] && [ "$SAW_QUOTA_SIGNAL" -eq 0 ]; then
  echo "ERRO: todos os modelos da cadeia falharam — sinal de CONFIG INVÁLIDA (model id que o provedor não reconhece), NÃO de rate-limit. Não vai se resolver sozinho no reset de cota; corrigir MODELS_DEFAULT/--model." >&2
  exit 4
fi
echo "ERRO: todos os modelos da cadeia falharam" >&2
exit 1
