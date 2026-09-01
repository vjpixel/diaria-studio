#!/usr/bin/env bash
# scripts/dispatch-glm-lane-unit.sh (#6930)
#
# Despacha UMA unidade do piloto `z-ai/glm-5.3-flash` — ver `docs/lane-
# glm.md` (normativo) antes de mexer aqui. Este script implementa as
# condições (b) e (c) mecanicamente:
#
#   (b) Produtor apenas — imposto pelo --allowedTools abaixo, que OMITE
#       `gh pr merge`, `gh pr review` e `gh issue close|edit`. Instrução
#       de prompt não conta (#6864/#6849): quem impede é a ausência da
#       ferramenta, não o texto do prompt.
#   (c) --model z-ai/glm-5.3-flash SEMPRE explícito — sem ele o wrapper
#       roda a cadeia MODELS_DEFAULT inteira e o piloto mede 3 modelos.
#
# A condição (a) — "issue de aceite mecânico" — é seleção HUMANA do
# coordenador (docs/lane-glm.md: "não existe label nem script que
# classifique isso"). Este script recebe o número da issue já escolhida;
# não tenta decidir se ela é elegível.
#
# Invocação por UNIDADE, não sessão de vida longa (docs/lane-glm.md,
# mitigação ao vazamento do #6716 — sessão longa compacta mais, e é a
# compactação que dispara as chamadas Sonnet auxiliares faturadas em
# cheio). Este script roda `claude -p` (via claude-openrouter.sh) UMA VEZ
# e sai — nunca um loop, nunca reusa a mesma sessão pra 2 issues.
#
# Antes de cada despacho, o gate de critérios de morte
# (scripts/lib/glm-lane-gate.ts, via scripts/check-glm-lane-gate.ts) é
# consultado — teto de 10 unidades, zero PRs nos 3 primeiros despachos,
# média de rodadas de review, $/issue vs. lane Sonnet. `exit != 0` = NÃO
# despachar, mesmo que o operador peça — o script recusa a 11ª unidade
# (e qualquer unidade além de um critério de morte disparado) por
# construção, não por lembrete em prosa.
#
# Uso:
#   scripts/dispatch-glm-lane-unit.sh <ISSUE>
#
# Variáveis de ambiente:
#   GLM_LANE_UNITS_CAP (default 10)
#   GLM_LANE_SONNET_COST_PER_ISSUE_USD (default vazio — sem baseline,
#     ver docstring de sonnetLaneCostPerIssueUsd em glm-lane-gate.ts)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ISSUE="${1:?uso: dispatch-glm-lane-unit.sh <ISSUE>}"
UNITS_LOG="$REPO/data/glm-lane/units.jsonl"
CAP="${GLM_LANE_UNITS_CAP:-10}"
SONNET_BASELINE="${GLM_LANE_SONNET_COST_PER_ISSUE_USD:-}"

mkdir -p "$(dirname "$UNITS_LOG")"

echo "[glm-lane] portão de critérios de morte (issue #$ISSUE)..."
set +e
GATE_OUT=$(npx tsx scripts/check-glm-lane-gate.ts --units-log "$UNITS_LOG" --units-cap "$CAP" ${SONNET_BASELINE:+--sonnet-cost-per-issue "$SONNET_BASELINE"} 2>&1)
GATE_RC=$?
set -e
echo "$GATE_OUT"
if [ "$GATE_RC" -ne 0 ]; then
  echo "[glm-lane] RECUSADO — gate não autorizou despacho da unidade (rc=$GATE_RC). Ver motivo acima." >&2
  exit 1
fi

# #6930: reivindicação ANTES do worktree, comando STANDALONE (nunca
# encadeado com && — o hook de injeção de --session-id só injeta em
# comando não-composto, ver CLAUDE.md/inject-session-id.mjs).
echo "[glm-lane] reivindicando issue #$ISSUE (--kind continuo — branch continuo/*, mesmo merger do #6926)..."
npx tsx scripts/lib/session-registry.ts claim-issue --issue "$ISSUE" --kind continuo

BRANCH="continuo/glm-${ISSUE}-$(date -u +%Y%m%d%H%M%S)"
WORKTREE_DIR="$REPO/.claude/worktrees/glm-${ISSUE}"
echo "[glm-lane] criando worktree $WORKTREE_DIR em $BRANCH..."
git fetch origin -q
git worktree add -b "$BRANCH" "$WORKTREE_DIR" origin/master

ISSUE_TITLE=$(gh issue view "$ISSUE" --json title -q .title)
ISSUE_BODY=$(gh issue view "$ISSUE" --json body -q .body)

CREDITS_BEFORE_JSON=$(npx tsx scripts/glm-lane-credits.ts 2>&1)
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_EPOCH=$(date +%s)

PROMPT="Implemente a issue #$ISSUE do repo diaria-studio (título: \"$ISSUE_TITLE\").

$ISSUE_BODY

Siga o CLAUDE.md. Você está num WORKTREE isolado, branch $BRANCH — trabalhe só aqui. Edite com edições cirúrgicas, adicione teste de regressão se for bugfix (#633), rode os testes afetados. Quando terminar, rode 'git add' + 'git commit' + 'git push -u origin $BRANCH' + 'gh pr create' referenciando a issue (Closes #$ISSUE no corpo).

VOCÊ NUNCA MERGEIA, NUNCA REVISA PR, NUNCA FECHA NEM EDITA ISSUE — não tente, essas ferramentas não estão disponíveis pra você nesta sessão de propósito (piloto #6930, condição (b) do docs/lane-glm.md: quem julga é o revisor externo e os portões do #6926, não você). Se a issue for inviável/ambígua além do trivial, comente nela via 'gh issue comment' explicando o bloqueio e pare — não force uma solução errada."

echo "[glm-lane] despachando claude-openrouter.sh --model z-ai/glm-5.3-flash (issue #$ISSUE)..."
set +e
printf '%s' "$PROMPT" | "$REPO/hermes/scripts/claude-openrouter.sh" \
  --model z-ai/glm-5.3-flash \
  --cwd "$WORKTREE_DIR" \
  --tools "Read,Grep,Glob,Edit,Write,Bash(git:*),Bash(npm:*),Bash(npx:*),Bash(gh pr create:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh issue view:*),Bash(gh issue comment:*)" \
  --timeout 2400
CLAUDE_RC=$?
set -e

ENDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DURATION_SEC=$(( $(date +%s) - START_EPOCH ))

CREDITS_AFTER_JSON=$(npx tsx scripts/glm-lane-credits.ts 2>&1)

set +e
PR_NUMBER=$(gh pr list --head "$BRANCH" --json number -q '.[0].number' 2>/dev/null)
set -e

echo "[glm-lane] fim da unidade (rc=$CLAUDE_RC, ${DURATION_SEC}s, PR=${PR_NUMBER:-nenhuma})"

npx tsx scripts/record-glm-lane-unit.ts \
  --units-log "$UNITS_LOG" \
  --issue "$ISSUE" \
  --started-at "$STARTED_AT" \
  --ended-at "$ENDED_AT" \
  --duration-sec "$DURATION_SEC" \
  --credits-before "$CREDITS_BEFORE_JSON" \
  --credits-after "$CREDITS_AFTER_JSON" \
  --pr-number "${PR_NUMBER:-}"

echo "[glm-lane] registrado em $UNITS_LOG"
