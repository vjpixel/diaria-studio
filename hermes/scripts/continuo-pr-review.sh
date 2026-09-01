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
# ## Ação manual (fora do repo, feita em 31/08/2026)
#
# Job `3330b108a5b2`, `every 240m`, aponta pro STUB
# `~/.hermes/scripts/continuo-pr-review.sh` — NÃO symlink (o guard de
# traversal do cron do Hermes rejeita symlink resolvendo fora de
# `~/.hermes/scripts/`; o stub só faz `exec` pra este arquivo). Ver
# `hermes/README.md`.
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
# `independent-review` por um MARCADOR com identidade de execução (#6849,
# 01/09/2026) — `<!-- continuo-review: run=<id> at=<iso> -->`, gerado
# ABAIXO (`RUN_ID`/`AT`) por ESTE script antes de invocar a sessão de
# review, nunca pela sessão que o comentário representa. Substitui o
# `INDEPENDENT_REVIEW_RE` original (regex sobre a prosa "Review
# automatizado (...)"): achado ao vivo que o revisor externo (este script)
# e uma sessão FABRICANDO review (a delegação do próprio PR, sem
# ferramenta Agent) produziam a MESMA prosa — nenhum regex textual
# distingue os dois quando o formato-alvo é público e citado neste
# arquivo versionado. O marcador não fecha essa lacuna por completo
# (honor-system nos dois lados continua — ver docstring de
# `pr-review-authenticity.ts`), mas fecha o caminho de fabricação POR
# ACIDENTE: `RUN_ID`/`AT` só existem porque ESTE processo os gerou agora,
# a sessão de review só os vê porque este script os passa no prompt — a
# delegação do PR (que roda ANTES/em paralelo, nunca dentro deste script)
# nunca tem acesso a esse valor específico. O comentário deixa de ser
# "texto que uma sessão sem Agent tool escreveu tentando cumprir a
# instrução" e passa a ser "texto que uma sessão com autoridade e
# capacidade de revisar de verdade escreveu depois de ler o diff, contendo
# um valor que só ESTE processo poderia ter fornecido" — mesma classe do
# review Opus diário, só que por PR.
#
# AUTH: assinatura claude.ai (OAuth), mesmo padrão do
# `opus-daily-diff-review.sh` — este script NÃO seta
# ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY nenhum (#5608).
set -euo pipefail

# #6891 (01/09/2026): desliga o auto-updater DENTRO deste processo — nunca
# export persistente de shell (mesma disciplina do #6714). Só vive neste
# script/filhos (processo próprio invocado pelo cron, nunca sourced numa
# sessão interativa) — sessões do editor continuam atualizando normalmente.
export DISABLE_AUTOUPDATER=1

# Preflight (#6875, extraído pro lib compartilhado no #6879): binário do
# Claude Code precisa existir e responder.
# shellcheck source=./lib/claude-binary-preflight.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/claude-binary-preflight.sh"
claude_binary_preflight

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
INFRA_ERRORS=0
INFRA_ERROR_SUMMARY=""

# #6910 (01/09/2026): o motivo de um erro de infra (exit 3 de
# check-pr-review-authenticity.ts, ou `gh pr view` falhando) só existia em
# $AUTH_OUT/stderr — a entrega do cron (Telegram) carrega só a linha de
# resumo final, então "erros-de-infra=1" chegava sem NENHUM rastro de qual
# das 3+ causas (gh indisponível, PR sumiu, JSON malformado, rede) foi. Esta
# função persiste cada ocorrência num log append-only (sobrevive à entrega,
# permite ver recorrência) E acumula um resumo truncado pra ir na linha
# final — as duas formas do #6910, não só uma.
INFRA_ERROR_LOG="$REPO/data/continuo-pr-review/infra-errors.jsonl"
log_infra_error() {
  local pr="$1" code="$2" reason="$3"
  mkdir -p "$(dirname "$INFRA_ERROR_LOG")"
  # jq -cn (compact, null-input) monta o JSON com escaping seguro — $reason
  # pode conter aspas, quebras de linha (stderr multi-linha do gh/tsx), etc.
  local jq_err
  jq_err=$(jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg pr "$pr" \
    --arg code "$code" --arg reason "$reason" \
    '{ts: $ts, pr: ($pr | tonumber), exit_code: $code, reason: $reason}' \
    2>&1 >> "$INFRA_ERROR_LOG")
  if [ -n "$jq_err" ]; then
    # Review do #6910 (P2): silenciar a falha do próprio logger de infra
    # reintroduziria exatamente a classe de falha silenciosa que esta PR
    # existe pra eliminar. Nunca aborta o script (best-effort, mesmo
    # espírito do `|| true` anterior) — só torna a falha VISÍVEL em stderr.
    echo "[continuo-pr-review] log_infra_error: falha ao escrever em $INFRA_ERROR_LOG: $jq_err" >&2
  fi
  local truncated="${reason:0:200}"
  INFRA_ERROR_SUMMARY="${INFRA_ERROR_SUMMARY}PR #$pr ($code): $truncated"$'\n'
}

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
    # Review #6871 (P3): contar no resumo final — sem isso o tick reporta
    # "revisadas=X já-tinham-review=Y falharam=Z" que não bate com o total
    # de PRs continuo/* abertas, escondendo que essa PR nem chegou a ser
    # avaliada de verdade.
    INFRA_ERRORS=$((INFRA_ERRORS + 1))
    log_infra_error "$PR" "auth_rc=3" "$AUTH_OUT"
    continue
  fi
  # AUTH_RC 1 (self_review) ou 2 (no_review): precisa de review real.

  # Review #6871 (P3): `gh pr view` também precisa de set +e — sem isso,
  # uma falha transitória de rede/gh numa PR aborta o script inteiro
  # (set -euo pipefail) em vez de só pular essa PR e seguir pras próximas,
  # inconsistente com o resto do loop (que já trata falha por-PR como
  # fail-soft, não fail-hard).
  set +e
  BASE_SHA=$(gh pr view "$PR" --json baseRefOid --jq .baseRefOid 2>&1)
  VIEW_RC=$?
  HEAD_SHA=$(gh pr view "$PR" --json headRefOid --jq .headRefOid 2>&1)
  VIEW_RC=$((VIEW_RC + $?))
  PR_TITLE=$(gh pr view "$PR" --json title --jq .title 2>&1)
  VIEW_RC=$((VIEW_RC + $?))
  set -e

  if [ "$VIEW_RC" -ne 0 ]; then
    echo "[continuo-pr-review] PR #$PR: gh pr view falhou ao buscar base/head/title — pulando esta rodada" >&2
    INFRA_ERRORS=$((INFRA_ERRORS + 1))
    log_infra_error "$PR" "gh_pr_view_rc=$VIEW_RC" "$BASE_SHA / $HEAD_SHA / $PR_TITLE"
    continue
  fi

  echo "[continuo-pr-review] revisando PR #$PR ($PR_TITLE, $BASE_SHA..$HEAD_SHA)..."

  # #6849: identidade de execução gerada AQUI, pelo processo externo — a
  # sessão de review abaixo só a conhece porque este script a passa no
  # prompt; a delegação do PR (que roda em processo separado, sem visão
  # deste script em execução) nunca a vê. Não é validada contra nada
  # depois (sem lookup, sem log paralelo) — só a FORMA do marcador conta
  # pro gate (`pr-review-authenticity.ts`); o valor em si só precisa ser
  # algo que a sessão fabricando o review não teria como adivinhar/copiar
  # de uma execução anterior.
  RUN_ID="$(date -u +%s)-$$-${RANDOM}"
  AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  MARKER="<!-- continuo-review: run=${RUN_ID} at=${AT} -->"

  PROMPT="Você é o review externo do contínuo do diaria-studio — uma sessão SEPARADA da que abriu esta PR (a delegação do contínuo não tem ferramenta Agent, #6712; você tem assinatura claude.ai e está revisando de verdade). Revise a PR #$PR (\`$PR_TITLE\`), diff \`git diff $BASE_SHA..$HEAD_SHA\`, commits \`git log --oneline $BASE_SHA..$HEAD_SHA\`.

Procure, nesta ordem de prioridade:
1. Bugs de correção (lógica errada, edge case quebrado, regressão de comportamento).
2. Violações das regras do CLAUDE.md (ex: bugfix sem teste de regressão #633, edição não-cirúrgica #495).
3. Falhas silenciosas (catch vazio, fallback que mascara erro).
4. Simplificação/eficiência óbvia que não muda comportamento.

Reporte TODOS os achados, incluindo baixa confiança — a filtragem por confiança/severidade é um passo separado, não seu trabalho aqui (mesma regra do #5304 já aplicada ao review automatizado deste repo). Tag cada achado com confiança (alta/média/baixa) e severidade (P0-P3).

OBRIGATÓRIO: poste seu review como comentário via \`gh pr comment $PR --body \"...\"\`. A primeira linha pode ser prosa legível pra humano, no formato \`Review automatizado (1 agente, effort low): <resumo de 1 frase>\` — mas isso NÃO é mais o que o gate reconhece (#6849: esse formato de prosa é público e qualquer sessão pode reproduzi-lo, review real ou fabricado). O que o gate de autenticidade (\`scripts/lib/pr-review-authenticity.ts\`) exige, em UMA LINHA PRÓPRIA em qualquer lugar do comentário, é este marcador EXATO, copiado literalmente, sem alterar um único caractere:
${MARKER}

Sem essa linha exata, seu review não conta pro gate, mesmo sendo genuíno.

Se não encontrar NENHUM achado de confiança alta ou média: poste mesmo assim, com \`Review automatizado (1 agente, effort low): sem findings de confiança alta/média.\` seguido da linha do marcador acima — comentário vazio não satisfaz o gate.

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

echo "[continuo-pr-review] concluído — revisadas=$REVIEWED já-tinham-review=$SKIPPED falharam=$FAILED erros-de-infra=$INFRA_ERRORS"
# #6910: motivo vai NA ENTREGA (não só no stderr) quando houve erro de
# infra — a linha de resumo é o que o Telegram carrega; sem isso
# "erros-de-infra=1" chegava sem nenhum rastro de causa. Log completo
# (não-truncado, todas as ocorrências, não só as desta rodada) sempre em
# $INFRA_ERROR_LOG.
if [ "$INFRA_ERRORS" -gt 0 ]; then
  echo "[continuo-pr-review] motivo(s) do(s) erro(s) de infra desta rodada:"
  printf '%s' "$INFRA_ERROR_SUMMARY"
  echo "[continuo-pr-review] log completo: $INFRA_ERROR_LOG"
fi
