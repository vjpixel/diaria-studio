#!/usr/bin/env bash
# daily-consolidated-review.sh — review Opus (assinatura claude.ai) do diff
# ACUMULADO do dia no diaria-studio, 1x/dia.
#
# Racional (28/08/2026, decisão do editor): o hermes-diaria-continuo implementa
# e mergeia PRs com modelos free do OpenRouter (gate leve por PR). A qualidade
# Anthropic entra AQUI, no atacado: 1 sessão/dia sobre o diff consolidado
# (~25 PRs/dia) em vez de 25 sessões — o overhead fixo por sessão (CLAUDE.md,
# contexto) é pago 1x, e o review enxerga interações ENTRE PRs (ex: PR
# supersedido por outro do mesmo dia — caso real #6238, 26/08).
#
# AUTH: assinatura claude.ai (OAuth), DE PROPÓSITO — este script NÃO seta
# ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY nenhum (#5608: sessão de Claude Code
# autentica pela assinatura; e é o Opus que queremos aqui). Não confundir com
# claude-openrouter.sh, que faz o oposto.
#
# Estado: data/continuo/last-daily-review-sha (avança SÓ após review completo).
set -euo pipefail

REPO="/home/vjpixel/diaria-studio"
STATE_DIR="$REPO/data/continuo"
STATE_FILE="$STATE_DIR/last-daily-review-sha"
MAX_DIFF_LINES=20000

cd "$REPO"
git fetch origin -q
HEAD_SHA=$(git rev-parse origin/master)
mkdir -p "$STATE_DIR"

if [ -f "$STATE_FILE" ]; then
  BASE_SHA=$(cat "$STATE_FILE")
  git cat-file -e "$BASE_SHA" 2>/dev/null || BASE_SHA=$(git rev-parse "origin/master~20")
else
  # Primeira execução: só o último dia de commits, nunca o histórico inteiro.
  BASE_SHA=$(git log origin/master --since="24 hours ago" --format=%H | tail -1)
  [ -n "$BASE_SHA" ] && BASE_SHA=$(git rev-parse "$BASE_SHA~1" 2>/dev/null || echo "$BASE_SHA")
fi

if [ -z "${BASE_SHA:-}" ] || [ "$BASE_SHA" = "$HEAD_SHA" ]; then
  echo "[daily-review] nada novo desde o último review ($HEAD_SHA) — noop"
  exit 0
fi

NLINES=$(git diff --stat "$BASE_SHA..$HEAD_SHA" | tail -1)
echo "[daily-review] range $BASE_SHA..$HEAD_SHA ($NLINES)"

DIFF_LINES=$(git diff "$BASE_SHA..$HEAD_SHA" | wc -l)
RANGE_NOTE=""
if [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
  RANGE_NOTE="ATENÇÃO: diff tem $DIFF_LINES linhas (> $MAX_DIFF_LINES). Priorize arquivos de scripts/lib/, publishers e hooks; arquivos de teste e docs só se algo neles parecer errado."
fi

PROMPT="Você é o review consolidado diário do diaria-studio. Revise o diff acumulado \`git diff $BASE_SHA..$HEAD_SHA\` (commits: \`git log --oneline $BASE_SHA..$HEAD_SHA\`), mergeado em sua maior parte por modelos não-Anthropic via fila autônoma — seu papel é pegar o que o gate leve por PR deixou passar.

$RANGE_NOTE

Procure, nesta ordem de prioridade:
1. Bugs de correção (lógica errada, edge case quebrado, regressão de comportamento).
2. Interações ENTRE mudanças do range (dois PRs que se pisam; fix supersedido; mesma constante alterada 2x de formas incompatíveis).
3. Violações das regras do CLAUDE.md (ex: bugfix sem teste de regressão #633, edição não-cirúrgica #495, custo recorrente novo).
4. Falhas silenciosas (catch vazio, fallback que mascara erro).

Para CADA finding com confiança alta ou média: crie uma issue via \`gh issue create\` com label de tipo (bug/enhancement) + prioridade P0-P3 justificada no corpo (regra do CLAUDE.md: nunca perguntar, sempre criar com prioridade), corpo citando arquivo:linha e o commit do range. Prefixe o título com [daily-review]. Antes de criar, cheque \`gh issue list --search\` para não duplicar issue aberta equivalente.

Se nada de confiança alta/média: não crie issue nenhuma.

Ao final, imprima um resumo: N commits revisados, M findings, links das issues criadas."

echo "$PROMPT" | claude -p \
  --allowedTools "Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(gh issue create:*),Bash(gh issue list:*)" \
  --model opus --effort low

# Marco avança só depois do review completar sem erro (set -e garante).
echo "$HEAD_SHA" > "$STATE_FILE"
echo "[daily-review] concluído — marco avançado para $HEAD_SHA"
