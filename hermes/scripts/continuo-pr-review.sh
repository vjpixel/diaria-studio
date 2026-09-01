#!/usr/bin/env bash
# continuo-pr-review.sh (#6865, autoridade de merge desde #6926)
#
# Review Sonnet (assinatura claude.ai) de UMA PR `continuo/*` aberta por vez
# — não o diff acumulado do dia (esse é `opus-daily-diff-review.sh`, irmão
# deste script). Roda a cada 120min (job `3330b108a5b2`).
#
# ## Por que existe
#
# O `opus-daily-diff-review.sh` roda 1x/dia; o contínuo (`hermes-diaria-
# continuo/SKILL.md`) roda com cadência bem mais curta — não citar o
# número exato aqui (já divergiu no passado, ver CLAUDE.md; fonte canônica
# é `hermes cron list --all`, nunca esta prosa). Descompasso de ordem de
# grandeza (#6849/#6864/#6865): com o contínuo impedido de mergear a
# própria PR (#6864), uma PR podia esperar horas pelo único revisor
# externo que existia. Este
# script fecha esse gap SEM trocar o modelo do review profundo diário por
# um mais barato — dois papéis distintos (decisão do editor): revisão
# rápida e superficial de UMA PR (Sonnet, a cada 120min) vs. varredura
# funda do dia inteiro com visão de interação-entre-PRs (Opus, 1x/dia).
#
# ## Ação manual (fora do repo, feita em 31/08/2026)
#
# Job `3330b108a5b2`, `every 120m` (docstring corrigida no #6926 — dizia
# `every 240m`/"~4h" desde a criação; `hermes cron list --all` é a fonte
# canônica, nunca esta prosa, ver CLAUDE.md), aponta pro STUB
# `~/.hermes/scripts/continuo-pr-review.sh` — NÃO symlink (o guard de
# traversal do cron do Hermes rejeita symlink resolvendo fora de
# `~/.hermes/scripts/`; o stub só faz `exec` pra este arquivo). Ver
# `hermes/README.md`.
#
# ## Autoridade de merge (#6926) — do SCRIPT BASH, nunca do modelo
#
# Motivo da mudança: com o pickup do `/diaria-overnight` (#6823) como
# ÚNICO merger, e o overnight sem agendador (roda só quando o editor
# inicia uma rodada), uma PR pronta (review independente + CI verde) podia
# ficar parada indefinidamente — medido ao vivo na PR #6901, 10h29 parada,
# mergeada à mão pelo editor.
#
# `--allowedTools` abaixo CONTINUA sem `gh pr merge` — propriedade mecânica
# travada por `test/continuo-pr-review-never-merges.test.ts`, intocado por
# este PR. O que muda: a sessão do modelo agora grava um veredito
# ESTRUTURADO (`verdict=approve|reject`) no próprio marcador de identidade
# de execução (ver `scripts/lib/pr-review-authenticity.ts`,
# `extractIndependentReviewVerdict`), e É O BASH, DEPOIS que a sessão do
# modelo já saiu, que decide mergear — nunca uma ferramenta que o modelo
# invoca. Um modelo persuadido a aprovar uma PR ruim não mergeia nada
# sozinho: o veredito passa por MAIS 8 portões determinísticos e
# fail-closed em `scripts/check-continuo-merge-gate.ts` (superseded, SHA
# revisado conhecido, HEAD não mudou desde a revisão — corrida do #5716 —
# caminho não-sensível, CI verde + mergeable, diff dentro do limiar de
# `pr-create-review.mjs` #4813/#6393) antes de qualquer `gh pr merge`
# rodar — ver a lista completa e ordenada no docblock de
# `scripts/lib/continuo-merge-gate.ts`. Isto NÃO contradiz o #6864:
# avaliador (este script) e avaliado (a PR aberta pelo tick, processo/cron
# diferente) continuam sendo dois processos distintos — a mesma separação
# que já autorizava o pickup do overnight a mergear.
#
# Lacuna conhecida, registrada e não bloqueante (#6934): este script NÃO
# adquire o merge-lock cross-sessão (`session-registry.ts merge-lock-
# acquire`, usado por overnight/develop) antes de `gh pr merge` — integrar
# exige desenhar que `kind`/`session-id` este cron deveria reivindicar, o
# que não foi decidido ainda. Blast radius aceito por ora: PRs pequenas,
# CI obrigatória, revert de 1 comando.
#
# Dois portões que ESTE script NUNCA decide sozinho — sempre `escalate`,
# nunca `merge` nem `reject`: caminho sensível de publicação/render, e
# diff ≥ limiar de effort (a revisão desta sessão é rasa por design,
# Sonnet `--effort low`; só decide sobre o que consegue julgar). Nesses
# casos a PR fica pro pickup do `/diaria-overnight` — que continua
# existindo, agora como FALLBACK, não mais o único caminho.
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
source "$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/lib/claude-binary-preflight.sh"
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
MERGED=0
ESCALATED=0
REJECTED=0

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

# #6926: portão de merge — chama scripts/check-continuo-merge-gate.ts
# (lógica pura em scripts/lib/continuo-merge-gate.ts) e age no veredito.
# NUNCA invocado de dentro do `--allowedTools` da sessão do modelo (essa
# sessão só REVISA, ver docblock do topo do arquivo) — só daqui, depois que
# a sessão já saiu (caminho `claude -p`) ou nem chegou a rodar (caminho
# `AUTH_RC=0`). `check-continuo-merge-gate.ts` AUTO-DERIVA o SHA revisado
# do marcador de review (#6932, P0/P1 — nunca mais recebido como argumento
# aqui, pra fechar a corrida do #5716 por construção; ver docstring do
# script TS).
#
# stdout e stderr de `check-continuo-merge-gate.ts` são capturados
# SEPARADOS (arquivo temporário pro stderr) — não `2>&1` misturado — porque
# este bash faz `jq` sobre a linha JSON do stdout pra extrair `reason`/
# `action`, e stdout/stderr intercalados não têm ordem garantida entre si
# (#6932, P3: a versão anterior fazia `tail -1` sobre os dois juntos,
# arriscando pegar a linha errada).
try_merge_gate() {
  local pr="$1"
  local stderr_tmp
  stderr_tmp="$(mktemp)"
  set +e
  GATE_JSON=$(npx tsx scripts/check-continuo-merge-gate.ts --pr "$pr" 2>"$stderr_tmp")
  GATE_RC=$?
  set -e
  GATE_STDERR=$(cat "$stderr_tmp" 2>/dev/null || true)
  rm -f "$stderr_tmp"

  case "$GATE_RC" in
    0)
      REVIEWED_HEAD_SHA=$(printf '%s' "$GATE_JSON" | jq -r '.details.reviewedHeadSha // empty')
      echo "[continuo-pr-review] PR #$pr: gate=merge (head=$REVIEWED_HEAD_SHA)"
      echo "$GATE_JSON"
      set +e
      # `--match-head-commit`: o GitHub recusa o merge se o HEAD real da PR
      # divergir do SHA que o gate acabou de confirmar — fecha o intervalo
      # entre "gate leu o HEAD" e "gh pr merge de fato roda" (#6932, P2;
      # TOCTOU que existiria mesmo com o gate correto, se algo empurrasse
      # um commit nesse meio-tempo).
      if [ -n "$REVIEWED_HEAD_SHA" ]; then
        gh pr merge "$pr" --squash --match-head-commit "$REVIEWED_HEAD_SHA"
      else
        gh pr merge "$pr" --squash
      fi
      MERGE_RC=$?
      set -e
      if [ "$MERGE_RC" -ne 0 ]; then
        # #573: confirmar estado real em vez de confiar só no exit code do
        # `gh pr merge` — mesmo princípio já aplicado ao merge do overnight.
        set +e
        MERGED_STATE=$(gh pr view "$pr" --json state,mergedAt --jq '[.state, .mergedAt] | @tsv' 2>&1)
        set -e
        if echo "$MERGED_STATE" | grep -q "^MERGED"; then
          echo "[continuo-pr-review] PR #$pr: gh pr merge saiu com erro (rc=$MERGE_RC) mas o estado remoto confirma MERGED — contando como mergeada"
          MERGED=$((MERGED + 1))
        else
          echo "[continuo-pr-review] PR #$pr: gh pr merge falhou (rc=$MERGE_RC) e estado remoto não confirma merge — não conta como mergeada, tenta de novo no próximo tick" >&2
          INFRA_ERRORS=$((INFRA_ERRORS + 1))
          log_infra_error "$pr" "merge_rc=$MERGE_RC" "gate autorizou merge mas gh pr merge falhou: $MERGED_STATE"
        fi
      else
        MERGED=$((MERGED + 1))
        echo "[continuo-pr-review] PR #$pr: mergeada"
      fi
      ;;
    1)
      echo "[continuo-pr-review] PR #$pr: gate=escalate — deixando pro pickup do /diaria-overnight (fallback, #6823)"
      echo "$GATE_JSON"
      ESCALATED=$((ESCALATED + 1))
      ;;
    2)
      echo "[continuo-pr-review] PR #$pr: gate=reject — NÃO mergear"
      echo "$GATE_JSON"
      REJECTED=$((REJECTED + 1))
      # #6926: só comenta o motivo — nunca fecha/reabre a PR sozinho aqui
      # (fora de escopo; fechamento de PR superseded continua trabalho do
      # tick, hermes-diaria-continuo/SKILL.md §3 passo 1).
      GATE_REASON=$(printf '%s' "$GATE_JSON" | jq -r '.reason // "motivo não disponível"')
      set +e
      gh pr comment "$pr" --body "Gate de merge automático (#6926): rejeitado — $GATE_REASON"
      COMMENT_RC=$?
      set -e
      if [ "$COMMENT_RC" -ne 0 ]; then
        # #6932 (P3): rejeição em si continua correta (merge bloqueado) —
        # só a comunicação na PR falhou. Registrar pra não perder o rastro
        # (mesma disciplina do #6910), nunca deixar isso silencioso.
        echo "[continuo-pr-review] PR #$pr: gate=reject, mas gh pr comment falhou (rc=$COMMENT_RC) — motivo só nos logs desta rodada" >&2
        INFRA_ERRORS=$((INFRA_ERRORS + 1))
        log_infra_error "$pr" "reject_comment_rc=$COMMENT_RC" "rejeição correta ($GATE_REASON), falha ao postar o motivo na PR"
      fi
      ;;
    *)
      echo "[continuo-pr-review] PR #$pr: check-continuo-merge-gate.ts falhou (infra, rc=$GATE_RC) — pulando merge nesta rodada: $GATE_STDERR" >&2
      INFRA_ERRORS=$((INFRA_ERRORS + 1))
      log_infra_error "$pr" "merge_gate_rc=$GATE_RC" "$GATE_STDERR"
      ;;
  esac
}

for PR in $PR_NUMBERS; do
  set +e
  AUTH_OUT=$(npx tsx scripts/check-pr-review-authenticity.ts --pr "$PR" 2>&1)
  AUTH_RC=$?
  set -e

  if [ "$AUTH_RC" -eq 0 ]; then
    # #6926: deixou de ser skip incondicional. Já existe review independente
    # — pular a REVISÃO (não revisar de novo à toa), mas ir direto ao
    # portão de merge. `check-continuo-merge-gate.ts` auto-deriva o SHA
    # revisado do PRÓPRIO marcador (campo `head=`, #6932 P0/P1) — nada pra
    # buscar/fabricar aqui. Marcador legado sem `head=` (pré-#6926) resolve
    # sozinho pra `reviewedHeadSha=null` → o gate escala, nunca assume que
    # o HEAD atual é o que foi revisado.
    echo "[continuo-pr-review] PR #$PR já tem review independente (verdict=pass) — pulando revisão, indo direto ao portão de merge (#6926)"
    SKIPPED=$((SKIPPED + 1))
    try_merge_gate "$PR"
    continue
  fi
  if [ "$AUTH_RC" -eq 3 ]; then
    # #738/CLAUDE.md: falha de infra (gh indisponível, PR sumiu) não é
    # motivo pra tentar revisar às cegas — pula esta PR nesta rodada,
    # tenta de novo no próximo tick (~2h).
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

  # #6923: os dois campos JSON antigos (base/head ref oid) que este bloco
  # pedia via `gh pr view` não existem no `gh` 2.46 (pacote ESM do Ubuntu
  # do helios) — "Unknown JSON field", TODA PR pulada em TODA rodada,
  # silenciosamente até o #6910 revelar o motivo.
  # Fix: REST v3 via `gh api`, onde `.base.sha`/`.head.sha` são estáveis há
  # anos independente da versão do `gh` — 1 chamada em vez de 3, e nunca
  # depende do que a distro decidir empacotar no próximo `apt upgrade`
  # (não subir o `gh`: ver docstring da issue #6923). `set +e` preservado
  # do #6871 (P3) — falha transitória de rede/gh numa PR não pode abortar
  # o script inteiro (set -euo pipefail), só pular essa PR.
  set +e
  API_OUT=$(gh api "repos/{owner}/{repo}/pulls/$PR" --jq '[.base.sha, .head.sha, .title] | @tsv' 2>&1)
  API_RC=$?
  set -e

  if [ "$API_RC" -ne 0 ]; then
    echo "[continuo-pr-review] PR #$PR: gh api pulls falhou ao buscar base/head/title — pulando esta rodada" >&2
    INFRA_ERRORS=$((INFRA_ERRORS + 1))
    log_infra_error "$PR" "gh_api_pulls_rc=$API_RC" "$API_OUT"
    continue
  fi

  IFS=$'\t' read -r BASE_SHA HEAD_SHA PR_TITLE <<< "$API_OUT"

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
  # #6926: o marcador ganha o campo `verdict=` — a sessão substitui
  # `{VEREDITO}` por `approve` ou `reject` (nunca deixa o placeholder
  # literal). `scripts/lib/pr-review-authenticity.ts`
  # (`extractIndependentReviewVerdict`) exige exatamente `approve` ou
  # `reject`; qualquer outro valor faz o marcador inteiro não casar o
  # formato COM campo — cai no formato antigo sem campo, que o gate de
  # merge trata como "sem veredito", nunca "approve" por omissão.
  # #6926/#6932 (P0/P1): `head=${HEAD_SHA}` é o SHA REAL, já conhecido por
  # ESTE script (bloco `gh api pulls` acima) — embutido diretamente, nunca
  # pedido ao modelo pra preencher. O modelo só decide `{VEREDITO}`; o SHA
  # não depende de o modelo copiar/adivinhar corretamente, e é o que
  # `check-continuo-merge-gate.ts` compara contra o HEAD atual da PR pra
  # fechar a corrida do #5716.
  MARKER_PREFIX="<!-- continuo-review: run=${RUN_ID} at=${AT} verdict="
  MARKER_SUFFIX=" head=${HEAD_SHA} -->"

  PROMPT="Você é o review externo do contínuo do diaria-studio — uma sessão SEPARADA da que abriu esta PR (a delegação do contínuo não tem ferramenta Agent, #6712; você tem assinatura claude.ai e está revisando de verdade). Revise a PR #$PR (\`$PR_TITLE\`), diff \`git diff $BASE_SHA..$HEAD_SHA\`, commits \`git log --oneline $BASE_SHA..$HEAD_SHA\`.

Procure, nesta ordem de prioridade:
1. Bugs de correção (lógica errada, edge case quebrado, regressão de comportamento).
2. Violações das regras do CLAUDE.md (ex: bugfix sem teste de regressão #633, edição não-cirúrgica #495).
3. Falhas silenciosas (catch vazio, fallback que mascara erro).
4. Simplificação/eficiência óbvia que não muda comportamento.

Reporte TODOS os achados, incluindo baixa confiança — a filtragem por confiança/severidade é um passo separado, não seu trabalho aqui (mesma regra do #5304 já aplicada ao review automatizado deste repo). Tag cada achado com confiança (alta/média/baixa) e severidade (P0-P3).

VEREDITO (#6926, novo): decida \`approve\` ou \`reject\`. \`reject\` = há pelo menos 1 achado de confiança alta OU média com severidade P0/P1 — algo que você não deixaria passar num PR seu. \`approve\` = nenhum achado nesse patamar (achados de baixa confiança ou P2/P3 não impedem approve; reporte-os mesmo assim, só não bloqueiam).

OBRIGATÓRIO: poste seu review como comentário via \`gh pr comment $PR --body \"...\"\`. A primeira linha pode ser prosa legível pra humano, no formato \`Review automatizado (1 agente, effort low): <resumo de 1 frase>\` — mas isso NÃO é mais o que o gate reconhece (#6849: esse formato de prosa é público e qualquer sessão pode reproduzi-lo, review real ou fabricado). O que o gate de autenticidade (\`scripts/lib/pr-review-authenticity.ts\`) exige, em UMA LINHA PRÓPRIA em qualquer lugar do comentário, é este marcador EXATO — copie literalmente, trocando SÓ \`{VEREDITO}\` por \`approve\` ou \`reject\` (nunca deixe as chaves, nunca invente outro valor):
${MARKER_PREFIX}{VEREDITO}${MARKER_SUFFIX}

Sem essa linha exata (com \`{VEREDITO}\` substituído), seu review não conta pro gate de merge automático — o PR fica escalado pro pickup manual do overnight em vez de mergear, mesmo genuinamente aprovado.

Se não encontrar NENHUM achado de confiança alta ou média (P0/P1): poste mesmo assim, com \`Review automatizado (1 agente, effort low): sem findings de confiança alta/média — approve.\` seguido da linha do marcador (com \`verdict=approve\`) — comentário vazio não satisfaz o gate.

VOCÊ NUNCA MERGEIA NADA. Não tente \`gh pr merge\` — não está nas ferramentas permitidas. Decidir e mergear é responsabilidade do SCRIPT BASH que te invocou, depois que você sair — não sua. Seu único trabalho é revisar e postar o comentário com o veredito."

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

  # #6926: portão de merge — SÓ depois da sessão de review já ter saído
  # (CLAUDE_RC=0 confirmado acima). `check-continuo-merge-gate.ts` auto-
  # deriva o SHA revisado do marcador que acabou de ser postado (`head=`,
  # embutido acima com o valor REAL de $HEAD_SHA capturado ANTES da sessão
  # rodar) — se algo empurrou um commit novo enquanto a sessão revisava, o
  # gate compara esse SHA contra o HEAD atual da PR e detecta a divergência
  # (corrida do #5716).
  try_merge_gate "$PR"
done

echo "[continuo-pr-review] concluído — revisadas=$REVIEWED já-tinham-review=$SKIPPED falharam=$FAILED erros-de-infra=$INFRA_ERRORS mergeadas=$MERGED escaladas=$ESCALATED rejeitadas=$REJECTED"
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
