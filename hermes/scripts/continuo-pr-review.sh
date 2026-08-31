#!/usr/bin/env bash
# continuo-pr-review.sh (#6865)
#
# Review Sonnet (assinatura claude.ai) de UMA PR `continuo/*` aberta por vez
# — não o diff acumulado do dia (esse é `opus-daily-diff-review.sh`, irmão
# deste script). Roda ~4h.
#
# ## Por que existe
#
# O `opus-daily-diff-review.sh` roda 1x/dia; o contínuo (`hermes-diaria-
# continuo/SKILL.md`) roda a cada 120min. Descompasso 12:1 (#6849/#6864/
# #6865): com o contínuo impedido de mergear a própria PR (#6864), uma PR
# podia esperar até ~24h pelo único revisor externo que existia. Este
# script fecha esse gap SEM trocar o modelo do review profundo diário por
# um mais barato — dois papéis distintos (decisão do editor): revisão
# rápida e superficial de UMA PR (Sonnet, ~4h) vs. varredura funda do dia
# inteiro com visão de interação-entre-PRs (Opus, 1x/dia).
#
# ## NUNCA mergeia (propriedade mecânica, não só de prosa)
#
# `--allowedTools` abaixo NÃO inclui `gh pr merge` — travado deliberadamente
# (ver test/continuo-pr-review-never-merges.test.ts). O merge continua
# EXCLUSIVO do pickup de PR órfã do contínuo
# (hermes-diaria-continuo/SKILL.md §3 passo 3, #6823) — dois processos
# mergeando a mesma PR é exatamente a corrida que o guard do #5716 existe
# pra evitar (#6849 item 4). Este script só REVISA: lê o diff, posta
# comentário. Nada mais.
#
# ## O comentário satisfaz o gate de autenticidade de verdade (#6849/#6732)
#
# `check-pr-review-authenticity.ts` classifica um comentário como
# `independent-review` por CASAR COM UM FORMATO DE TEXTO
# (`INDEPENDENT_REVIEW_RE`) — o #6849 documentou que isso é, por
# construção, honor-system: nenhum classificador textual distingue review
# feito de review declarado. Este script não fecha essa lacuna de desenho
# (nada fecha, ver #6849) — o que ele FAZ é garantir que, quando o formato
# aparece, ele veio de um dispatch real: uma sessão Sonnet SEPARADA da
# delegação que abriu a PR (delegação usa OpenRouter via
# `claude-openrouter.sh`, sem ferramenta Agent, #6712; este script usa a
# assinatura claude.ai, tem `--allowedTools` de leitura, e roda num cron
# distinto). O comentário deixa de ser "texto que uma sessão sem Agent tool
# escreveu tentando cumprir a instrução" e passa a ser "texto que uma
# sessão com autoridade e capacidade de revisar de verdade escreveu depois
# de ler o diff" — mesma classe do review Opus diário, só que por PR.
#
# AUTH: assinatura claude.ai (OAuth), mesmo padrão do
# `opus-daily-diff-review.sh` — este script NÃO seta
# ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY nenhum (#5608).
set -euo pipefail

REPO="/home/vjpixel/diaria-studio"
cd "$REPO"
git fetch origin -q

PR_NUMBERS=$(gh pr list --state open --json number,headRefName \
  --jq '.[] | select(.headRefName | startswith("continuo/")) | .number')

if [ -z "$PR_NUMBERS" ]; then
  echo "[continuo-pr-review] nenhuma PR continuo/* aberta — noop"
  exit 0
fi

REVIEWED=0
SKIPPED=0
FAILED=0

for PR in $PR_NUMBERS; do
  set +e
  AUTH_OUT=$(npx tsx scripts/check-pr-review-authenticity.ts --pr "$PR" 2>&1)
  AUTH_RC=$?
  set -e

  if [ "$AUTH_RC" -eq 0 ]; then
    echo "[continuo-pr-review] PR #$PR já tem review independente (verdict=pass) — skip"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if [ "$AUTH_RC" -eq 3 ]; then
    # #738/CLAUDE.md: falha de infra (gh indisponível, PR sumiu) não é
    # motivo pra tentar revisar às cegas — pula esta PR nesta rodada,
    # tenta de novo no próximo tick (~4h).
    echo "[continuo-pr-review] PR #$PR: check-pr-review-authenticity.ts falhou (infra) — pulando esta rodada: $AUTH_OUT" >&2
    continue
  fi
  # AUTH_RC 1 (self_review) ou 2 (no_review): precisa de review real.

  BASE_SHA=$(gh pr view "$PR" --json baseRefOid --jq .baseRefOid)
  HEAD_SHA=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
  PR_TITLE=$(gh pr view "$PR" --json title --jq .title)

  echo "[continuo-pr-review] revisando PR #$PR ($PR_TITLE, $BASE_SHA..$HEAD_SHA)..."

  PROMPT="Você é o review externo do contínuo do diaria-studio — uma sessão SEPARADA da que abriu esta PR (a delegação do contínuo não tem ferramenta Agent, #6712; você tem assinatura claude.ai e está revisando de verdade). Revise a PR #$PR (\`$PR_TITLE\`), diff \`git diff $BASE_SHA..$HEAD_SHA\`, commits \`git log --oneline $BASE_SHA..$HEAD_SHA\`.

Procure, nesta ordem de prioridade:
1. Bugs de correção (lógica errada, edge case quebrado, regressão de comportamento).
2. Violações das regras do CLAUDE.md (ex: bugfix sem teste de regressão #633, edição não-cirúrgica #495).
3. Falhas silenciosas (catch vazio, fallback que mascara erro).
4. Simplificação/eficiência óbvia que não muda comportamento.

Reporte TODOS os achados, incluindo baixa confiança — a filtragem por confiança/severidade é um passo separado, não seu trabalho aqui (mesma regra do #5304 já aplicada ao review automatizado deste repo). Tag cada achado com confiança (alta/média/baixa) e severidade (P0-P3).

OBRIGATÓRIO: poste seu review como comentário via \`gh pr comment $PR --body \"...\"\`. A PRIMEIRA LINHA do comentário tem que ser EXATAMENTE no formato \`Review automatizado (1 agente, effort low): <resumo de 1 frase>\` — é o formato que o gate de autenticidade (\`scripts/check-pr-review-authenticity.ts\`, #6732) reconhece como review independente de verdade. Sem essa linha exata no início, seu review não conta pro gate, mesmo sendo genuíno.

Se não encontrar NENHUM achado de confiança alta ou média: poste mesmo assim, com \`Review automatizado (1 agente, effort low): sem findings de confiança alta/média.\` — comentário vazio não satisfaz o gate.

VOCÊ NUNCA MERGEIA NADA. Não tente \`gh pr merge\` — não está nas ferramentas permitidas, e mesmo que estivesse, mergear PR do contínuo é decisão exclusiva do pickup (\`hermes-diaria-continuo/SKILL.md\` §3 passo 3, #6823), nunca deste review."

  set +e
  echo "$PROMPT" | timeout 1800 claude -p \
    --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr comment:*)" \
    --model sonnet --effort low
  CLAUDE_RC=$?
  set -e

  if [ "$CLAUDE_RC" -ne 0 ]; then
    echo "[continuo-pr-review] PR #$PR: sessão de review saiu com rc=$CLAUDE_RC — não conta como revisada, tenta de novo no próximo tick" >&2
    FAILED=$((FAILED + 1))
    continue
  fi
  REVIEWED=$((REVIEWED + 1))
done

echo "[continuo-pr-review] concluído — revisadas=$REVIEWED já-tinham-review=$SKIPPED falharam=$FAILED"
