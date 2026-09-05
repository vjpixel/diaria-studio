#!/usr/bin/env bash
# continuo-pr-review.sh (#6865, autoridade de merge desde #6926)
#
# Review Sonnet (assinatura claude.ai) de TODAS as PRs `continuo/*` abertas
# por execução, uma por iteração do loop (ver `for PR in $PR_NUMBERS`,
# ~linha 446) — não o diff acumulado do dia (esse é `opus-daily-diff-review.sh`,
# irmão deste script). Roda em cron próprio (job `3330b108a5b2`) — a cadência
# NÃO vive nesta prosa: derivar com `hermes cron list --all` (#6928;
# já registrou valor errado duas vezes).
#
# ## Por que existe
#
# O `opus-daily-diff-review.sh` roda 1x/dia; o contínuo (`hermes-diaria-
# continuo/SKILL.md`) roda com cadência bem mais curta — não citar o
# número exato aqui (já divergiu no passado, ver CLAUDE.md; fonte canônica
# é `hermes cron list --all`, nunca esta prosa). O comentário original
# justificava este script com um descompasso e uma espera máxima que eram
# derivados de cadências erradas — as duas muito maiores que a realidade
# medida (corrigido no #6928; para os valores de agora, derive com
# `hermes cron list --all`). O motivo do script não depende
# da razão: o contínuo é impedido de mergear a própria PR (#6864), e o
# revisor externo precisa existir separado do tick (#6865). Este
# script fecha esse gap SEM trocar o modelo do review profundo diário por
# um mais barato — dois papéis distintos (decisão do editor): revisão
# rápida e superficial, PR por PR (Sonnet) vs. varredura
# funda do dia inteiro com visão de interação-entre-PRs (Opus, 1x/dia).
# O contraste entre os dois scripts é ESCOPO (uma PR isolada por iteração,
# mas todas as PRs abertas por execução vs. diff acumulado do dia inteiro)
# e MODELO (Sonnet vs. Opus) — nunca quantidade de PRs revisadas por execução
# (#7242: a prosa já afirmou "UMA PR por execução" duas vezes, o que é falso
# desde sempre — o loop em `for PR in $PR_NUMBERS` sempre iterou todas).
#
# ## Ação manual (fora do repo, feita em 31/08/2026)
#
# Job `3330b108a5b2`, aponta pro STUB (docstring já havia registrado
# cadência errada desde a criação — corrigida no #6926/#6928;
# `hermes cron list --all` é a fonte canônica, nunca esta prosa, ver
# CLAUDE.md), aponta pro STUB
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
# Lacuna do #6934 FECHADA: este script agora adquire o merge-lock
# cross-sessão (`session-registry.ts merge-lock-acquire`/`-release`, o
# mesmo usado por overnight/develop) imediatamente antes do `gh pr merge` e
# libera logo após o `git pull` que o segue — ver `try_merge_gate()` mais
# abaixo e o comentário durável de decisão na issue #6934 (kind
# `continuo-review` dedicado, `--session-id` derivado do `RUN_ID`/`$$` do
# próprio tick, TTL inalterado). Lock negado retenta um número pequeno e
# fixo de vezes (`MERGE_LOCK_MAX_RETRIES`/`MERGE_LOCK_RETRY_DELAY_S`) antes
# de desistir desta PR nesta rodada — nunca segue pro `gh pr merge` sem o
# lock, e nunca vaza o lock em caminho de erro (`trap ... EXIT`).
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

# #6934: identidade de sessão pro merge-lock cross-sessão (`session-registry.ts
# merge-lock-acquire`/`-release`) — decisão (b) do comentário durável da
# issue. Gerada UMA VEZ aqui, no topo do tick (não dentro do laço por PR nem
# dentro de `try_merge_gate`), pela mesma razão que a issue documenta:
# estável DURANTE o tick inteiro (várias PRs do mesmo tick usam a mesma
# identidade — o lock protege o checkout compartilhado, não uma PR
# individual), distinta ENTRE ticks (cada execução do cron é um processo
# novo, `$$` muda). Mesmo padrão `date+PID` que `RUN_ID` (gerado mais abaixo,
# por PR, pro marcador de autenticidade do review) já usa — não um esquema
# novo, só o mesmo padrão numa escala diferente (por tick, não por PR).
# Prefixo `continuo-review-` deixa o `heldBy` do `.merge-lock.json`
# autodescritivo mesmo sem consultar `data/sessions/` (este script nunca
# chama `register` — ver docstring do kind `continuo-review` em
# `scripts/lib/session-registry.ts`).
SESSION_ID="continuo-review-$(date -u +%s)-$$"

# #6934 decisão (c): TTL do lock (`MERGE_LOCK_TTL_MS` em session-registry.ts)
# não muda — só o retry ao redor da AQUISIÇÃO é deste script. Pequeno e fixo
# (decisão item 4 da issue), mesmo valor já usado pelo overnight/develop pro
# MESMO lock (`MAX_LOCK_RETRIES`/`LOCK_RETRY_DELAY_MS` em
# `scripts/lib/merge-train-live.ts`) — lock negado é "outra coordenadora
# mergeando agora", não erro; poucas tentativas curtas cobrem contenção
# transitória sem prender o tick pela janela inteira do TTL (2min).
MERGE_LOCK_MAX_RETRIES=3
MERGE_LOCK_RETRY_DELAY_S=20

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
LOCK_BLOCKED=0

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

# #6934: adquire o merge-lock cross-sessão com um número pequeno e FIXO de
# retries (`MERGE_LOCK_MAX_RETRIES`/`MERGE_LOCK_RETRY_DELAY_S` acima) — lock
# negado significa "outra coordenadora (overnight/develop/continuo, ou este
# mesmo script noutro tick sobreposto) está no meio do PRÓPRIO merge agora",
# NUNCA um erro: nunca aborta o tick na primeira negativa, e nunca segue pro
# `gh pr merge` sem antes ter conseguido o lock (item 4 da decisão da issue).
# Retorna 0 quando adquiriu, 1 quando esgotou as tentativas — o chamador
# decide o que fazer (aqui: pular esta PR nesta rodada, tentar de novo no
# próximo tick).
#
# Review fleet PR #7051 (finding 1, P1): a versão original não capturava
# stdout/stderr do `session-registry.ts merge-lock-acquire` — qualquer saída
# não-zero (negação legítima, `--session-id` ausente, `npx`/`tsx` quebrado,
# `data/sessions/` ilegível, erro de I/O ao escrever `.merge-lock.json`) era
# tratada como a MESMA coisa: "outra coordenadora está mergeando". Se a causa
# real fosse sistêmica (não contenção), o diagnóstico errado se repetiria a
# cada tick, pra toda PR, indefinidamente — o #6934 pararia de funcionar em
# silêncio. Agora a saída real é capturada em `LOCK_ACQUIRE_LAST_OUTPUT`
# (global, lida pelo chamador) e ecoada em cada retry — não resolve a
# ambiguidade na origem (isso é da lib, `main()` de `session-registry.ts` já
# colapsa "denied" e "erro —" no mesmo exit 1; fora do escopo mínimo daqui),
# só para de descartar o sinal.
LOCK_ACQUIRE_LAST_OUTPUT=""
acquire_merge_lock_with_retry() {
  local attempt=0
  local out
  while :; do
    if out=$(npx tsx scripts/lib/session-registry.ts merge-lock-acquire \
      --kind continuo-review --session-id "$SESSION_ID" 2>&1); then
      return 0
    fi
    LOCK_ACQUIRE_LAST_OUTPUT="$out"
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$MERGE_LOCK_MAX_RETRIES" ]; then
      return 1
    fi
    echo "[continuo-pr-review] merge-lock negado (tentativa $attempt/$MERGE_LOCK_MAX_RETRIES) — outra coordenadora está mergeando agora, retry em ${MERGE_LOCK_RETRY_DELAY_S}s: $out" >&2
    sleep "$MERGE_LOCK_RETRY_DELAY_S"
  done
}

# Libera o lock que a PRÓPRIA sessão detém. Nunca derruba o script —
# best-effort, mesmo espírito de `log_infra_error`/outros pontos deste
# arquivo — mas a saída não-zero pode significar coisas bem diferentes:
# `merge-lock-release` legitimamente falha (exit 1) quando o lock pertence a
# OUTRA sessão (nunca deveria acontecer aqui — só chamamos depois de um
# `acquire_merge_lock_with_retry` bem-sucedido pela MESMA `$SESSION_ID`) ou
# quando já não havia lock nenhum (idempotente, tratado como sucesso pelo
# próprio `releaseMergeLock`) — mas TAMBÉM pode ser `npx tsx` quebrado ou
# outro erro de infra, caso em que o bash segue achando que liberou mas o
# `.merge-lock.json` continua detido pela `$SESSION_ID` já obsoleta (o TTL de
# 2min limita o dano, mas o estado diverge sem log nenhum — review fleet PR
# #7051, finding 2). A saída é capturada e ecoada em stderr em qualquer saída
# não-zero, pra causa real não ficar muda; não precisa virar `log_infra_error`
# (não é um erro NA ENTREGA, só um rastro pra quem investigar depois).
release_merge_lock() {
  local out
  if ! out=$(npx tsx scripts/lib/session-registry.ts merge-lock-release \
    --kind continuo-review --session-id "$SESSION_ID" 2>&1); then
    echo "[continuo-pr-review] release_merge_lock: saída não-zero (motivo pode ser lock alheio, idempotência, ou erro de infra) — $out" >&2
  fi
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

      # #6934: adquire o merge-lock cross-sessão IMEDIATAMENTE ANTES do
      # `gh pr merge` — nunca antes disso (o gate acima não toca o checkout
      # compartilhado), nunca depois do `gh pr merge` já ter rodado.
      if ! acquire_merge_lock_with_retry; then
        echo "[continuo-pr-review] PR #$pr: merge-lock negado após $MERGE_LOCK_MAX_RETRIES tentativas — outra coordenadora segue mergeando; pulando esta PR nesta rodada, tenta de novo no próximo tick" >&2
        LOCK_BLOCKED=$((LOCK_BLOCKED + 1))
        # Finding 1 (PR #7051): o motivo real (negação legítima OU erro de
        # infra indistinguível dela, ver comentário de
        # `acquire_merge_lock_with_retry` acima) é persistido no mesmo log
        # append-only que as outras 6 categorias de falha deste script usam
        # (#6910) — permite ver recorrência (a mesma PR bloqueada tick após
        # tick é o sinal de causa sistêmica, não contenção normal).
        # Deliberadamente NÃO incrementa `INFRA_ERRORS` (que controlaria o
        # bloco extra impresso NA ENTREGA no fim do script): o docblock de
        # `acquire_merge_lock_with_retry` é explícito — lock negado "NUNCA um
        # erro" — e a maioria das ocorrências É contenção legítima e
        # rotineira; tratar toda negativa como "erro de infra" no resumo
        # entregue (Telegram) seria alarme falso a cada tick concorrido. O
        # rastro fica no log append-only pra quem for investigar um padrão
        # suspeito; `LOCK_BLOCKED` no resumo final segue sendo o sinal
        # agregado de "isto aconteceu N vezes".
        log_infra_error "$pr" "lock_blocked" "${LOCK_ACQUIRE_LAST_OUTPUT:-motivo desconhecido — saída do merge-lock-acquire não capturada}"
        # `return`, não `break`: estamos dentro de `try_merge_gate()` (uma
        # função), não num loop — `break` aqui não teria o que interromper.
        # Retornar sai da função (equivalente a "acabou o `case`", já que a
        # ramificação `0)` é a última coisa que importa fazer neste caminho).
        return
      fi
      # A partir daqui o lock é NOSSO — release SEMPRE roda ao sair deste
      # branch, sucesso ou erro (item 5 da decisão: `gh pr merge` pode
      # falhar por SHA desatualizado, `--match-head-commit` acima, e mesmo
      # assim o lock não pode vazar). `trap ... EXIT` em vez de só uma
      # chamada no fim do bloco: sob `set -euo pipefail` (topo do script),
      # qualquer comando não protegido por `set +e`/`if`/`||` que falhar
      # aqui dentro sai do script INTEIRO, não só desta função — só um trap
      # de EXIT garante que `release_merge_lock` roda nesse caminho também.
      # Desarmado (`trap - EXIT`) assim que a janela fecha, pra não vazar
      # pro resto do tick (próxima PR do laço, ou o fim do script).
      trap release_merge_lock EXIT

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
      MERGE_CONFIRMED=0
      if [ "$MERGE_RC" -ne 0 ]; then
        # #573: confirmar estado real em vez de confiar só no exit code do
        # `gh pr merge` — mesmo princípio já aplicado ao merge do overnight.
        set +e
        MERGED_STATE=$(gh pr view "$pr" --json state,mergedAt --jq '[.state, .mergedAt] | @tsv' 2>&1)
        set -e
        # #6987/#6989 (01/09/2026): `command grep` — `grep` neste ambiente é
        # função de shell que shella pro binário `claude`; se ele quebrar,
        # `grep` falha junto, indistinguível de "não achou". Aqui a direção
        # de falha já é segura (cai no `else`, não conta como mergeada,
        # retenta no próximo tick) — `command grep` fecha o caso mesmo assim,
        # pra não depender de sorte de direção em toda chamada futura.
        if echo "$MERGED_STATE" | command grep -q "^MERGED"; then
          echo "[continuo-pr-review] PR #$pr: gh pr merge saiu com erro (rc=$MERGE_RC) mas o estado remoto confirma MERGED — contando como mergeada"
          MERGED=$((MERGED + 1))
          MERGE_CONFIRMED=1
        else
          echo "[continuo-pr-review] PR #$pr: gh pr merge falhou (rc=$MERGE_RC) e estado remoto não confirma merge — não conta como mergeada, tenta de novo no próximo tick" >&2
          INFRA_ERRORS=$((INFRA_ERRORS + 1))
          log_infra_error "$pr" "merge_rc=$MERGE_RC" "gate autorizou merge mas gh pr merge falhou: $MERGED_STATE"
        fi
      else
        MERGED=$((MERGED + 1))
        MERGE_CONFIRMED=1
        echo "[continuo-pr-review] PR #$pr: mergeada"
      fi

      # `git pull` só quando o merge foi de fato confirmado — mesmo critério
      # de `mergeSoloPr` (scripts/lib/merge-train-live.ts): sem merge
      # confirmado não há nada novo pra puxar, e a janela do lock existe
      # pra proteger exatamente "gh pr merge → git pull", não um pull solto.
      # Falha do `git pull` é NÃO-bloqueante (mesmo padrão de
      # `mergeSoloPr`) — o merge remoto já aconteceu; o checkout local
      # compartilhado só fica defasado até o próximo fetch/pull de alguém.
      # `--ff-only` (review fleet PR #7051, finding 3): `scripts/lib/
      # git-sync.ts` (usado por `sync-code.ts`, citado no CLAUDE.md) já
      # estabelece o padrão pra tocar este checkout compartilhado sem
      # interação — um `git pull` bare, com o checkout sujo, pode criar
      # merge commit e sair exit 0, escapando de $PULL_RC e do log
      # inteiramente (sucesso com efeito colateral, o único caminho que
      # escaparia da rede de logging desta PR).
      if [ "$MERGE_CONFIRMED" -eq 1 ]; then
        set +e
        git pull --ff-only
        PULL_RC=$?
        set -e
        if [ "$PULL_RC" -ne 0 ]; then
          echo "[continuo-pr-review] PR #$pr: merge confirmado, mas git pull local falhou (rc=$PULL_RC, não bloqueante) — checkout compartilhado fica defasado até o próximo fetch/pull" >&2
          INFRA_ERRORS=$((INFRA_ERRORS + 1))
          log_infra_error "$pr" "git_pull_rc=$PULL_RC" "merge confirmado, git pull local falhou"
        fi
      fi

      # Fecha a janela: libera o lock explicitamente e desarma o trap (que
      # senão rodaria de novo, inofensivo mas redundante, na saída do
      # script) — mesma ordem de `mergeSoloPr`.
      release_merge_lock
      trap - EXIT
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
      REJECT_BODY="Gate de merge automático (#6926): rejeitado — $GATE_REASON"

      # #7446 item 1: `reject` nunca era terminal — o mesmo motivo era
      # repostado a CADA tick enquanto a PR seguisse aberta e rejeitada
      # (medido ao vivo: 9 comentários idênticos em 18h na PR #7404). Pula o
      # `gh pr comment` só quando o ÚLTIMO comentário já é byte-a-byte igual
      # a este — qualquer motivo NOVO (CI mudou, veredito mudou) ainda posta
      # normalmente. `source=error` (gh falhou ao ler comentários) nunca
      # pula — fail-open em direção a comunicar, não a esconder.
      # #6932/#7446 (review da PR #7449, mesma classe reincidente num ramo
      # diferente): `2>&1` misturaria a linha `npm notice run ...` que `npx`
      # sempre emite em stderr dentro do JSON que o `jq` abaixo tenta
      # parsear — todo tick quebraria o parse e cairia sempre no fallback
      # `|| echo`. stdout/stderr SEPARADOS (arquivo temporário pro stderr,
      # mesmo padrão de `try_merge_gate()` acima) fecham isso.
      DEDUPE_STDERR_TMP="$(mktemp)"
      set +e
      DEDUPE_JSON=$(npx tsx scripts/check-continuo-reject-comment-dedupe.ts --pr "$pr" --candidate "$REJECT_BODY" 2>"$DEDUPE_STDERR_TMP")
      DEDUPE_RC=$?
      set -e
      DEDUPE_STDERR=$(cat "$DEDUPE_STDERR_TMP" 2>/dev/null || true)
      rm -f "$DEDUPE_STDERR_TMP"
      SKIP_COMMENT="false"
      if [ "$DEDUPE_RC" -eq 0 ]; then
        SKIP_COMMENT=$(printf '%s' "$DEDUPE_JSON" | jq -r '.skip // false' 2>/dev/null || echo "false")
      else
        echo "[continuo-pr-review] PR #$pr: check-continuo-reject-comment-dedupe.ts falhou (rc=$DEDUPE_RC) — postando mesmo assim (fail-open): $DEDUPE_STDERR" >&2
      fi

      if [ "$SKIP_COMMENT" = "true" ]; then
        echo "[continuo-pr-review] PR #$pr: motivo de rejeição idêntico ao último comentário — não duplicando (#7446 item 1)"
      else
        set +e
        gh pr comment "$pr" --body "$REJECT_BODY"
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
    # tenta de novo no próximo tick (intervalo: `hermes cron list --all`).
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

echo "[continuo-pr-review] concluído — revisadas=$REVIEWED já-tinham-review=$SKIPPED falharam=$FAILED erros-de-infra=$INFRA_ERRORS mergeadas=$MERGED escaladas=$ESCALATED rejeitadas=$REJECTED bloqueadas-por-lock=$LOCK_BLOCKED"
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
