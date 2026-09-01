#!/usr/bin/env bash
# scripts/dispatch-glm-lane-unit.sh (#6930, --pr N no #6953)
#
# Despacha UMA unidade do piloto `z-ai/glm-5.3-flash` — ver `docs/lane-
# glm.md` (normativo) antes de mexer aqui. Este script implementa as
# condições (b) e (c) mecanicamente:
#
#   (b) Produtor apenas — imposto pelo --tools abaixo, que OMITE
#       `gh pr merge`, `gh pr review` e `gh issue close|edit`. Instrução
#       de prompt não conta (#6864/#6849): quem impede é a ausência da
#       ferramenta, não o texto do prompt. `git` e `npm`/`npx` são
#       escopados a subcomandos específicos, NUNCA `Bash(git:*)`/
#       `Bash(npm:*)`/`Bash(npx:*)` genéricos (achado de review, PR #6941,
#       DEMONSTRADO ao vivo: `Bash(git:*)` permite `git push origin
#       HEAD:master` — o mesmo dano que `gh pr merge` causaria, por outra
#       porta; `Bash(npm:*)` permite `npm exec -- gh pr merge ...`,
#       executando o `gh` real por uma invocação que não começa com `gh`,
#       driblando o allowlist inteiro). `git push` é escopado à branch
#       EXATA desta unidade (`$BRANCH`, interpolada abaixo), nunca a
#       branch nenhuma. Em modo `--pr` (segunda rodada), `gh pr create`
#       é OMITIDO do `--tools` — mecanicamente impossível abrir uma PR
#       duplicada nesse modo, não só desaconselhado por texto.
#
#       **Risco residual, registrado em vez de fingido resolvido**: nada
#       aqui é uma sandbox real. `Bash(npx tsx:*)` continua podendo rodar
#       QUALQUER arquivo `.ts` que o modelo tenha acabado de escrever via
#       `Write` (ele tem essa ferramenta) — inclusive um arquivo cujo
#       único propósito é chamar `execSync("gh pr merge ...")`. Fechar
#       isso por completo exigiria tirar `Write`/`Edit` (inviável — o
#       produtor existe pra editar código) ou rodar em sandbox de
#       processo/container (fora de escopo desta PR, piloto de 10
#       unidades). O que este script FECHA são os desvios triviais e já
#       demonstrados (push direto, `npm exec`); o que fica em aberto é o
#       mesmo risco de "modelo adversarial com Write + interpretador" que
#       nenhum outro produtor autônomo deste repo resolve hoje (a própria
#       delegação padrão do contínuo usa `Bash` SEM NENHUM escopo — ver
#       `hermes-diaria-continuo/SKILL.md` §4 passo 2 — então este script já
#       é mais restrito que o piso já aceito no repo, não menos).
#   (c) --model z-ai/glm-5.3-flash SEMPRE explícito — sem ele o wrapper
#       roda a cadeia MODELS_DEFAULT inteira e o piloto mede 3 modelos.
#
# A condição (a) — "issue de aceite mecânico" — é seleção HUMANA do
# coordenador (docs/lane-glm.md: "não existe label nem script que
# classifique isso"). Este script recebe o número da issue já escolhida;
# não tenta decidir se ela é elegível.
#
# ## PRÉ-REQUISITO: a issue já precisa estar reivindicada — este script
# NUNCA chama claim-issue sozinho (achado de review, PR #6941, confirmado
# ao vivo nesta mesma sessão: `--session-id` só é injetado automaticamente
# quando `session-registry.ts` é o comando LITERAL de topo passado à
# ferramenta Bash — `.claude/hooks/inject-session-id.mjs` inspeciona a
# STRING do comando, e uma chamada enterrada dentro de um script `bash
# arquivo.sh` nunca aparece nessa string. Um `claim-issue` chamado DAQUI
# sempre falharia com "--session-id ausente", e não há como este script
# descobrir o session_id sozinho — só o hook sabe, e só injeta em chamada
# de topo). Por isso: o COORDENADOR reivindica ANTES, como comando
# standalone:
#
#   npx tsx scripts/lib/session-registry.ts claim-issue --issue N --kind continuo
#
# e libera DEPOIS (também standalone, mesmo motivo):
#
#   npx tsx scripts/lib/session-registry.ts unclaim-issue --issue N --kind continuo
#
# Este script SÓ CONFERE que a claim existe (`is-claimed`, leitura pura,
# sem session_id necessário) e recusa despachar se não encontrar — fail-
# closed, nunca assume "deve estar reivindicada" sem checar.
#
# Invocação por UNIDADE, não sessão de vida longa (docs/lane-glm.md,
# mitigação ao vazamento do #6716 — sessão longa compacta mais, e é a
# compactação que dispara as chamadas Sonnet auxiliares faturadas em
# cheio). Este script roda `claude -p` (via claude-openrouter.sh) UMA VEZ
# e sai — nunca um loop, nunca reusa a mesma sessão pra 2 issues.
#
# Antes de cada despacho, o gate de critérios de morte
# (scripts/lib/glm-lane-gate.ts, via scripts/check-glm-lane-gate.ts) é
# consultado — teto de 10 unidades, zero PRs MERGEADAS nos 3 primeiros
# despachos (#6922, corrigido de "abertas" pra "mergeadas" no #6953),
# média de rodadas de review > 2, $/issue vs. lane Sonnet (os 3 últimos
# ainda não normativos em docs/lane-glm.md § Teto e reversão —
# especificados pelo coordenador durante a construção deste harness;
# emendar aquela seção antes do 1º despacho real, não só este comentário).
# `exit != 0` = NÃO despachar — o script recusa a 11ª unidade (e qualquer
# unidade além de um critério de morte disparado) por construção.
#
# ## Modo `--pr N` (#6953) — SEGUNDA RODADA numa PR já aberta
#
# Sem `--pr`, este script SEMPRE cria branch/worktree novos a partir de
# `origin/master` — despachar de novo pra uma issue cuja unidade anterior
# já abriu PR abriria uma PR DUPLICADA (achado ao vivo, unidade 2 do
# piloto: a #6950 recebeu 3 findings de review e não tinha como o
# harness endereçá-los sem duplicar). `--pr N` resolve isso: em vez de
# `origin/master`, faz checkout da branch HEAD da PR N (`gh pr view N
# --json headRefName`) e injeta no prompt os comentários de review já
# postados nela (`gh pr view N --json comments`) — o modelo comita POR
# CIMA do que já existe, e `gh pr create` fica FORA do `--tools` nesse
# modo (mecanicamente impossível duplicar). `git push` continua escopado
# à branch exata (agora a da PR, não uma nova).
#
# Uso:
#   npx tsx scripts/lib/session-registry.ts claim-issue --issue N --kind continuo
#   scripts/dispatch-glm-lane-unit.sh N               # 1ª rodada — abre PR nova
#   scripts/dispatch-glm-lane-unit.sh N --pr M         # 2ª+ rodada — itera sobre a PR M já aberta
#   npx tsx scripts/lib/session-registry.ts unclaim-issue --issue N --kind continuo
#
# Variáveis de ambiente:
#   GLM_LANE_UNITS_CAP (default 10)
#   GLM_LANE_SONNET_COST_PER_ISSUE_USD (default vazio — sem baseline,
#     ver docstring de sonnetLaneCostPerIssueUsd em glm-lane-gate.ts)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ISSUE="${1:?uso: dispatch-glm-lane-unit.sh <ISSUE> [--pr N] (issue já precisa estar reivindicada — ver docstring)}"
shift || true
EXISTING_PR=""
if [ "${1:-}" = "--pr" ]; then
  EXISTING_PR="${2:?uso: --pr requer um número de PR}"
fi

UNITS_LOG="$REPO/data/glm-lane/units.jsonl"
CAP="${GLM_LANE_UNITS_CAP:-10}"
SONNET_BASELINE="${GLM_LANE_SONNET_COST_PER_ISSUE_USD:-}"
# #6941 (P2): timestamp no NOME do diretório, não só na branch — sem
# isso, um 2º despacho da MESMA issue (retry após falha) batia em
# "diretório já existe" no `git worktree add`, antes até de invocar o
# modelo, porque a 1ª tentativa nunca limpava o próprio diretório.
RUN_TAG="$(date -u +%Y%m%d%H%M%S)"
if [ -n "$EXISTING_PR" ]; then
  WORKTREE_DIR="$REPO/.claude/worktrees/glm-pr${EXISTING_PR}-${RUN_TAG}"
else
  WORKTREE_DIR="$REPO/.claude/worktrees/glm-${ISSUE}-${RUN_TAG}"
fi

mkdir -p "$(dirname "$UNITS_LOG")"

# Limpeza do worktree SEMPRE ao sair — sucesso, falha, ou timeout (#6941,
# achados de review): o trabalho de fato sobrevive na branch remota/PR, o
# checkout local não precisa persistir. Não tenta liberar a claim (o
# session_id não está disponível aqui — ver docstring da seção PRÉ-
# REQUISITO acima); só evita acumular diretórios órfãos entre unidades.
cleanup_worktree() {
  local rc=$?
  if [ -d "$WORKTREE_DIR" ]; then
    if [ "$rc" -ne 0 ]; then
      echo "[glm-lane] ABORTADO (rc=$rc) — removendo worktree $WORKTREE_DIR. A issue #$ISSUE pode continuar reivindicada: rode 'session-registry.ts unclaim-issue --issue $ISSUE --kind continuo' se não for retentar." >&2
    fi
    git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
  fi
}
trap cleanup_worktree EXIT

echo "[glm-lane] conferindo se a issue #$ISSUE está reivindicada (pré-requisito — este script nunca reivindica sozinho)..."
# `is-claimed` SEMPRE sai exit 0 (a resposta é o JSON `{claimed, by}`, não
# o exit code — mesmo padrão de `active-of-kind`, ver docblock do próprio
# subcomando em session-registry.ts). Um bash que checasse só o RC
# concluiria "reivindicada" pra QUALQUER issue, sempre — achado de review
# desta mesma revisão (#6941): tem que ler o campo `claimed` do JSON.
set +e
IS_CLAIMED_OUT=$(npx tsx scripts/lib/session-registry.ts is-claimed --issue "$ISSUE" 2>&1)
IS_CLAIMED_RC=$?
set -e
CLAIMED=$(printf '%s' "$IS_CLAIMED_OUT" | tail -1 | jq -r 'if has("claimed") then (.claimed|tostring) else "erro" end' 2>/dev/null)
if [ "$IS_CLAIMED_RC" -ne 0 ] || [ "$CLAIMED" != "true" ]; then
  echo "[glm-lane] RECUSADO — issue #$ISSUE não está reivindicada (rc=$IS_CLAIMED_RC, claimed=$CLAIMED): $IS_CLAIMED_OUT" >&2
  echo "[glm-lane] rode primeiro, como comando STANDALONE: npx tsx scripts/lib/session-registry.ts claim-issue --issue $ISSUE --kind continuo" >&2
  exit 1
fi

echo "[glm-lane] portão de critérios de morte (issue #$ISSUE)..."
GATE_STDERR_TMP="$(mktemp)"
set +e
GATE_JSON=$(npx tsx scripts/check-glm-lane-gate.ts --units-log "$UNITS_LOG" --units-cap "$CAP" ${SONNET_BASELINE:+--sonnet-cost-per-issue "$SONNET_BASELINE"} 2>"$GATE_STDERR_TMP")
GATE_RC=$?
set -e
GATE_STDERR=$(cat "$GATE_STDERR_TMP" 2>/dev/null || true)
rm -f "$GATE_STDERR_TMP"
echo "$GATE_JSON"
[ -n "$GATE_STDERR" ] && echo "$GATE_STDERR" >&2
if [ "$GATE_RC" -eq 1 ]; then
  echo "[glm-lane] RECUSADO — gate não autorizou despacho da unidade (critério de morte ou teto). Ver motivo acima." >&2
  exit 1
elif [ "$GATE_RC" -ne 0 ]; then
  # #6941 (P2): rc=2 (uso inválido/arquivo ilegível) é ERRO DE INVOCAÇÃO
  # do gate, não recusa de política — não pode ler a mesma mensagem de
  # "critério de morte disparou", senão mascara um bug de comando.
  echo "[glm-lane] ERRO DE INVOCAÇÃO DO GATE (rc=$GATE_RC) — isto não é uma recusa de política, corrija o comando antes de tentar de novo." >&2
  exit 2
fi

ISSUE_TITLE=$(gh issue view "$ISSUE" --json title -q .title)
ISSUE_BODY=$(gh issue view "$ISSUE" --json body -q .body)

# CI-wait guard (#6953, achado ao vivo): a unidade 2 do piloto abriu a PR
# e ficou girando DEPOIS disso, provavelmente num laço `gh pr view`
# esperando CI — custou US$ 0,2407 contra US$ 0,0108 de uma unidade que
# não esperou nada. Checar/esperar CI é trabalho do revisor externo
# (continuo-pr-review.sh, opus-daily-diff-review.sh, pickup do overnight),
# nunca desta unidade — ela tem que soltar a sessão assim que git push +
# (gh pr create, se for a 1ª vez) terminarem.
CI_WAIT_GUARD="NUNCA rode 'gh pr checks', 'gh run watch', nem qualquer laço esperando o CI terminar — não é seu trabalho e cada segundo de espera é faturado. Assim que você fizer 'git push' (e 'gh pr create' se for a 1ª vez nesta issue), a sessão está PRONTA e deve finalizar imediatamente."

if [ -n "$EXISTING_PR" ]; then
  echo "[glm-lane] modo --pr $EXISTING_PR — segunda rodada, checkout da branch já existente..."
  HEAD_REF=$(gh pr view "$EXISTING_PR" --json headRefName -q .headRefName)
  if [ -z "$HEAD_REF" ]; then
    echo "[glm-lane] ERRO — não deu pra resolver a branch HEAD da PR #$EXISTING_PR." >&2
    exit 2
  fi
  BRANCH="$HEAD_REF"
  git fetch origin "$BRANCH" -q
  echo "[glm-lane] criando worktree $WORKTREE_DIR em cima de origin/$BRANCH (existente)..."
  # -B (não -b): reseta/cria a branch local com o mesmo nome apontando
  # pro HEAD remoto atual da PR — idempotente entre retries desta mesma
  # PR, nunca colide com "branch já existe" de uma tentativa anterior
  # cujo worktree já foi limpo.
  git worktree add -B "$BRANCH" "$WORKTREE_DIR" "origin/$BRANCH"

  REVIEW_COMMENTS=$(gh pr view "$EXISTING_PR" --json comments -q '[.comments[] | "--- comentário de \(.author.login) em \(.createdAt) ---\n\(.body)"] | join("\n\n")')
  if [ -z "$REVIEW_COMMENTS" ]; then
    REVIEW_COMMENTS="(nenhum comentário encontrado via 'gh pr view --json comments' — confira você mesmo com 'gh pr view $EXISTING_PR' se isso for inesperado.)"
  fi

  PROMPT="Esta é uma ITERAÇÃO sobre a PR #$EXISTING_PR já aberta (branch $BRANCH) pro repo diaria-studio, referente à issue #$ISSUE (título: \"$ISSUE_TITLE\"). NÃO chame 'gh pr create' — a ferramenta nem está disponível nesta sessão, de propósito.

Comentários de review já postados na PR #$EXISTING_PR:

$REVIEW_COMMENTS

Enderece CADA achado acima. Você está num WORKTREE isolado, já no checkout da branch $BRANCH — trabalhe só aqui. Edite com edições cirúrgicas, rode os testes afetados. Quando terminar, rode 'git add' + 'git commit' + 'git push origin $BRANCH'.

$CI_WAIT_GUARD

VOCÊ NUNCA MERGEIA, NUNCA REVISA PR, NUNCA FECHA NEM EDITA ISSUE — não tente, essas ferramentas não estão disponíveis pra você nesta sessão de propósito (piloto #6930, condição (b) do docs/lane-glm.md: quem julga é o revisor externo e os portões do #6926, não você). Se algum comentário for inviável/ambíguo além do trivial, comente na PR via 'gh pr comment' explicando o bloqueio e pare — não force uma solução errada."

  TOOLS="Read,Grep,Glob,Edit,Write,Bash(git add:*),Bash(git commit:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git branch:*),Bash(git push origin ${BRANCH}:*),Bash(npm test:*),Bash(npx tsx:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr comment:*),Bash(gh issue view:*),Bash(gh issue comment:*)"
else
  echo "[glm-lane] criando worktree $WORKTREE_DIR em branch nova..."
  git fetch origin -q
  BRANCH="continuo/glm-${ISSUE}-${RUN_TAG}"
  git worktree add -b "$BRANCH" "$WORKTREE_DIR" origin/master

  PROMPT="Implemente a issue #$ISSUE do repo diaria-studio (título: \"$ISSUE_TITLE\").

$ISSUE_BODY

Siga o CLAUDE.md. Você está num WORKTREE isolado, branch $BRANCH — trabalhe só aqui. Edite com edições cirúrgicas, adicione teste de regressão se for bugfix (#633), rode os testes afetados. Quando terminar, rode 'git add' + 'git commit' + 'git push -u origin $BRANCH' + 'gh pr create' referenciando a issue (Closes #$ISSUE no corpo).

$CI_WAIT_GUARD

VOCÊ NUNCA MERGEIA, NUNCA REVISA PR, NUNCA FECHA NEM EDITA ISSUE — não tente, essas ferramentas não estão disponíveis pra você nesta sessão de propósito (piloto #6930, condição (b) do docs/lane-glm.md: quem julga é o revisor externo e os portões do #6926, não você). Se a issue for inviável/ambígua além do trivial, comente nela via 'gh issue comment' explicando o bloqueio e pare — não force uma solução errada."

  TOOLS="Read,Grep,Glob,Edit,Write,Bash(git add:*),Bash(git commit:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git branch:*),Bash(git push -u origin ${BRANCH}:*),Bash(npm test:*),Bash(npx tsx:*),Bash(gh pr create:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh issue view:*),Bash(gh issue comment:*)"
fi

# Snapshots de crédito: stdout e stderr SEPARADOS (arquivo temporário) —
# achado de review (#6941, P3): `2>&1` misturado arrisca stray stderr
# noise (deprecation warning etc.) corromper o JSON que
# `record-glm-lane-unit.ts` precisa fazer `JSON.parse` em cima.
CREDITS_STDERR_TMP="$(mktemp)"
CREDITS_BEFORE_JSON=$(npx tsx scripts/glm-lane-credits.ts 2>"$CREDITS_STDERR_TMP")
[ -s "$CREDITS_STDERR_TMP" ] && echo "[glm-lane] stderr do snapshot 'before': $(cat "$CREDITS_STDERR_TMP")" >&2
rm -f "$CREDITS_STDERR_TMP"
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_EPOCH=$(date +%s)

echo "[glm-lane] despachando claude-openrouter.sh --model z-ai/glm-5.3-flash (issue #$ISSUE${EXISTING_PR:+, PR #$EXISTING_PR})..."
set +e
printf '%s' "$PROMPT" | "$REPO/hermes/scripts/claude-openrouter.sh" \
  --model z-ai/glm-5.3-flash \
  --cwd "$WORKTREE_DIR" \
  --tools "$TOOLS" \
  --timeout 2400
CLAUDE_RC=$?
set -e

ENDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DURATION_SEC=$(( $(date +%s) - START_EPOCH ))

CREDITS_STDERR_TMP="$(mktemp)"
CREDITS_AFTER_JSON=$(npx tsx scripts/glm-lane-credits.ts 2>"$CREDITS_STDERR_TMP")
[ -s "$CREDITS_STDERR_TMP" ] && echo "[glm-lane] stderr do snapshot 'after': $(cat "$CREDITS_STDERR_TMP")" >&2
rm -f "$CREDITS_STDERR_TMP"

set +e
if [ -n "$EXISTING_PR" ]; then
  PR_NUMBER="$EXISTING_PR"
else
  PR_NUMBER=$(gh pr list --head "$BRANCH" --json number -q '.[0].number' 2>/dev/null)
fi
set -e

# #6941 (P0/P1, achado de review): CLAUDE_RC nunca pode virar só uma
# linha de log — o gate (#6922: zero PRs MERGEADAS nos 3 primeiros
# despachos, #6953) tem que distinguir "o modelo terminou e não abriu
# PR" (o sinal real) de "a invocação nem chegou a terminar direito"
# (infra, não é sinal sobre o modelo). `--status` carrega essa distinção
# pro registro.
STATUS="completed"
if [ "$CLAUDE_RC" -ne 0 ]; then
  STATUS="infra-error"
fi

echo "[glm-lane] fim da unidade (rc=$CLAUDE_RC status=$STATUS, ${DURATION_SEC}s, PR=${PR_NUMBER:-nenhuma})"

npx tsx scripts/record-glm-lane-unit.ts \
  --units-log "$UNITS_LOG" \
  --issue "$ISSUE" \
  --started-at "$STARTED_AT" \
  --ended-at "$ENDED_AT" \
  --duration-sec "$DURATION_SEC" \
  --credits-before "$CREDITS_BEFORE_JSON" \
  --credits-after "$CREDITS_AFTER_JSON" \
  --pr-number "${PR_NUMBER:-}" \
  --status "$STATUS"

echo "[glm-lane] registrado em $UNITS_LOG"

if [ "$CLAUDE_RC" -ne 0 ]; then
  # #6953 (achado ao vivo): o conselho aqui NUNCA pode ser "retente" quando
  # já existe uma PR pra esta issue — retentar sem --pr abriria uma
  # DUPLICATA, e um agente autônomo lendo esta linha obedeceria ao
  # conselho literalmente. Só "considere retentar" quando NENHUMA PR
  # existe ainda (nesse caso, sim, é seguro despachar de novo do zero).
  if [ -n "${PR_NUMBER:-}" ]; then
    echo "[glm-lane] a invocação do claude-openrouter.sh saiu com rc=$CLAUDE_RC — unidade registrada como infra-error, não conta pros critérios de morte que medem o MODELO. JÁ EXISTE a PR #$PR_NUMBER pra esta issue — revise-a, ou rode de novo com 'scripts/dispatch-glm-lane-unit.sh $ISSUE --pr $PR_NUMBER' pra iterar. NÃO despache sem --pr, isso abriria uma PR duplicada." >&2
  else
    echo "[glm-lane] a invocação do claude-openrouter.sh saiu com rc=$CLAUDE_RC — unidade registrada como infra-error, não conta pros critérios de morte que medem o MODELO. Nenhuma PR foi aberta ainda pra issue #$ISSUE; considere retentar do zero (sem --pr)." >&2
  fi
  exit 1
fi
