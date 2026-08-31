---
name: hermes-diaria-continuo
description: Mantém continuamente a fila técnica da Diária delegando execução ao harness do Claude Code (modelos OpenRouter) e classificação ao código real do repo.
version: 0.5.6
author: Pixel, Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [diaria, backlog, github, autonomia, continuidade, telegram, cron, claude-code]
    related_skills: [requesting-code-review, claude-code]
---

# Hermes Diária Contínuo (v0.5.0 — arquitetura delegada)

## O que mudou na v0.5.0 (28/08/2026, decisão do editor)

A v0.4 **parafraseava** as regras do repo em prosa que envelhecia em silêncio —
a cópia local do `classifyExecTrack` dizia 5 categorias quando o código real
tem 6 (`epica`, #6201, nunca chegou aqui). A v0.5 troca paráfrase por
**execução**: classificação roda o código real do repo, e implementação roda
dentro do harness do Claude Code (CLAUDE.md carregado, hooks e scripts reais),
com modelos do OpenRouter — sem tocar a cota da assinatura Anthropic.

Papel do Hermes nesta skill: **orquestrador** (loop do cron, claims, fila,
relatório no Telegram). Quem pensa sobre código é o harness delegado.

## Segurança e escopo (inalterado da v0.4)

- Workdir: `/home/vjpixel/diaria-studio`. Nunca operar fora dele.
- Nunca tocar `data/editions/` de edição em curso, credenciais, ou disparar
  publicação. Fila TÉCNICA (issues/PRs), nunca fluxo editorial.
- Env vars `ANTHROPIC_*` NUNCA no ambiente global — só dentro do wrapper
  (`#5608`; elas sequestram sessões da assinatura).

## Ferramentas desta skill

| ferramenta | o que faz | modelo |
|---|---|---|
| `~/.hermes/scripts/claude-openrouter.sh` | roda `claude -p` com OpenRouter (stdin=prompt; `--tools`, `--budget`, `--timeout`) | `dots-studio/dots-3-note-preview:free` → `poolside/laguna-s-2.1:free` → `z-ai/glm-5.3-flash` |
| `npx tsx --eval` (direto, sem LLM) | classificação determinística | nenhum |
| `~/.hermes/scripts/daily-consolidated-review.sh` | review Opus do diff do dia (cron separado, 1x/dia) | Anthropic (assinatura) |

## Cada ciclo (tick do cron)

### 1. Preparar e sincronizar (Hermes, shell direto)

1. `cd /home/vjpixel/diaria-studio && npx tsx scripts/sync-code.ts` — fail-soft:
   warning e segue; nunca forçar pull/reset/stash.
2. Guard de colisão editorial: `npx tsx scripts/lib/find-current-edition.ts
   --stage 2` (e stages relevantes). Edição em curso → registrar pausa, não
   despachar trabalho técnico concorrente neste tick.
3. `session-registry.ts` heartbeat/registro se aplicável, **sempre com
   `--kind continuo`** — fora do harness não inventar `--session-id`.
   **Nunca `--kind overnight`, mesmo esta skill sendo derivada do overnight**
   (é justamente essa derivação que torna o erro fácil de cometer — achado
   ao vivo 28/08/2026, #6483: `register`/`heartbeat` desta skill gravou
   `"kind":"overnight"` em `data/sessions/`, sumindo da trilha "Contínuo" da
   Triagem do Studio e poluindo a trilha "Overnight" com uma entrada que não
   é overnight de verdade — usar SEMPRE o MESMO `--kind continuo` em
   `register`/`heartbeat`/`claim-issue`, nunca alternar).
   **`--session-id` é POR TICK, nunca por job (#6443, 28/08/2026)** — gerar
   UMA VEZ aqui, no início deste tick, e reusar o MESMO valor em TODOS os
   comandos `session-registry.ts` deste tick (`register`/`heartbeat`/
   `claim-issue`); nunca regerar no meio do tick, nunca reusar entre
   ticks: `SESSION_ID="hermes-cron-5d791ef6fc2c-$(date -u +%Y%m%dT%H%M%SZ)"`.
   Era um id estável do job cron (`hermes-cron-5d791ef6fc2c` sem sufixo) — o
   heartbeat de CADA tick renovava a MESMA entrada do registro, que por isso
   nunca ficava `stale`, e um claim órfão de um tick que não abriu PR nunca
   expirava sozinho (#6443). Com o sufixo por tick, a entrada do tick
   ANTERIOR simplesmente para de receber heartbeat quando o tick seguinte
   começa (mesmo sem chamar `end`) — `SOFT_STALE_MS` (90min,
   `isIssueClaimedByOther` em `session-registry.ts`, #5474) trata essa
   entrada como stale e deixa de bloquear `claim-issue`/`is-claimed` pra
   qualquer outra sessão, sem depender de nada além do que já existe.
   (`claim-staleness.ts`/#6436 é uma camada DIFERENTE e complementar — TTL
   por idade da claim em si, `claimed_issues_at`, sem PR aberto — consumida
   por `check-block-staleness.ts`; não é o mecanismo que este fix aciona.)
   Exemplo completo — `npx tsx
   scripts/lib/session-registry.ts register --kind continuo --session-id
   "$SESSION_ID"`.

### 2. Classificar — SEM LLM, executando o código real

Nunca parafrasear a regra. Para o backlog aberto:

```bash
gh issue list --state open --json number,labels,body,state --limit 200 > /tmp/issues.json
npx tsx --eval "
import('./scripts/lib/issue-exec-track.ts').then(async ({classifyExecTrackWithRule}) => {
  const issues = JSON.parse(require('fs').readFileSync('/tmp/issues.json','utf8'));
  for (const i of issues) {
    const labels = i.labels.map(l=>l.name);
    const r = classifyExecTrackWithRule({labels, body: i.body||'', state: i.state});
    console.log(JSON.stringify({n:i.number, track:r.track, rule:r.matched}));
  }
})"
```

O output é a verdade — 6 categorias (`overnight`/`develop`/`agendada`/
`bloqueada`/`epica`/`fora-de-rodada`), sempre da versão de hoje do código.
Se o `.ts` mudar, esta skill NÃO precisa mudar.

Escopo do contínuo: issues `track=overnight` não reivindicadas por outra
sessão ativa (regra de claim abaixo). `develop`/`bloqueada`/`epica`/etc.:
registrar no relatório, não trabalhar.

#### Regra dura: NUNCA parsear saída do `gh` com Python ad-hoc

Observado no 1º tick da v0.5.0 (28/08, 01:44–01:47): 3 tracebacks seguidos
(`'list' object has no attribute 'get'`, `KeyError: 'filename'`) de one-liners
Python adivinhando o schema do `gh` — cada palpite errado queima um turno e
uma chamada da cota free. O `gh` já embute `--jq`; usar SEMPRE as receitas:

```bash
gh pr list --author @me --state open --json number,title,headRefName \
  --jq '.[] | "\(.number)\t\(.title)"'
gh pr view N --json files --jq '[.files[].path]'        # campo é .path, NÃO .filename
gh pr view N --json mergeable,reviewDecision --jq '{m:.mergeable,r:.reviewDecision}'
gh issue list --state open --json number,labels \
  --jq '.[] | {n:.number, labels:[.labels[].name]}'
```

Precisou de um campo que não está aqui: `gh pr view N --json 2>&1 | head`
lista os campos válidos — consultar antes de chutar.

### 3. Fila de PRs abertos PRIMEIRO (regra dura, inalterada)

Enquanto houver PR aberto do fluxo autônomo pendente de review/merge, nenhuma
issue nova é reivindicada. Para cada PR, nesta ordem:

1. **Superseded-check** (pitfall real #6238, 26/08): `git log origin/master
   --oneline -- <arquivos-do-pr> | head -5` — se o master atual já tratou a
   mesma issue igual ou melhor, `gh pr close N --comment "superseded por
   <ref>"`. Nunca mergear por inércia.
2. **Guard de caminho sensível** (fail-closed, #6277): `npx tsx
   scripts/lib/sensitive-path-guard.ts --base origin/master --json`.
   `"sensitive": true`, exit ≠ 0, stdout vazio ou JSON inválido → NÃO mergear;
   comentar no PR e encaminhar.
3. **Review independente pré-merge** (pipeline `requesting-code-review`,
   inalterado): scan estático → baseline de testes → reviewer independente
   fail-closed → auto-fix loop (máx. 2).

   **Gate de autenticidade do review, obrigatório antes de mergear (#6732):**
   a delegação do passo 4 roda sem ferramenta Agent (`--tools` abaixo omite
   `Agent`/`Task`, de propósito — #6712), então ela não consegue de fato
   despachar um subagente revisor via o dispatch que
   `.claude/hooks/pr-create-review.mjs` instrui. A instrução do hook cobre
   isso (30/08/2026): sem Agent tool disponível, a sessão posta o review como
   self-review honesto, com a linha literal `<!-- self-review: true -->`, em
   vez de fabricar um comentário no formato `"Review automatizado (N
   agente(s)..."` de um dispatch que não aconteceu (era exatamente isso que
   os PRs #6713/#6715 mostravam, indistinguível de um review real).

   Antes de mergear, rodar:
   ```bash
   npx tsx scripts/check-pr-review-authenticity.ts --pr N
   ```
   `exit 0` (`pass` — comentário no formato de review independente
   encontrado, sem o marcador de self-review) → merge no MESMO tick, como
   antes. `exit != 0` (`self_review`, `no_review`, ou `error` — fail-closed,
   mesma disciplina do guard de caminho sensível do passo 2) → **NÃO
   mergear**: deixar o PR aberto, registrar no relatório do tick como
   "aguardando review externo — self-review não satisfaz o gate do #5251",
   e passar para a próxima issue/PR da fila.

   **Pickup existe desde o #6823 (31/08/2026) — só no `/diaria-overnight`.**
   O fleet review do #6820 (30/08/2026) tinha achado que nenhuma das duas
   skills adotava PR órfão marcado self-review; o #6823 fechou essa lacuna
   no `/diaria-overnight` (passo 2b da Fase 0): lista PRs `continuo/*` com
   `check-pr-review-authenticity.ts` → `exit 1` (self_review) **ou** `exit 2`
   (no_review — tick morreu antes de sequer comentar; caso da PR que motivou
   a issue, #6844), roda guard de caminho sensível + review independente de
   verdade via Agent tool + gate de CI genuína, mergeia se limpo.
   **`/diaria-develop` deliberadamente NÃO ganhou esse passo** — pickup de
   PR órfão do contínuo não exige presença
   do editor nem a máquina Windows, então é trabalho que cabe ao
   `/diaria-overnight` (server, desassistido), não a uma sessão interativa
   (#5751, "sessão interativa não faz o que o helios faria sozinho"). Na
   prática, um PR self-reviewed do contínuo fica aberto até a próxima rodada
   `/diaria-overnight` rodar a Fase 0 — não mais indefinidamente, mas também
   não instantâneo; `daily-consolidated-review.sh` continua sem fechar esse
   loop (gera achados/issues sobre o diff, nunca mergeia PR aberto).

### 4. Implementar issues elegíveis — via harness delegado

Para cada issue elegível (após claim):

0. **Gate de coerência (#6752), ANTES do claim — barra cedo, não depois de
   implementar.** Auditoria de 29/08/2026 mediu 2,4× de retrabalho em PRs
   `continuo` vs `overnight`/`develop` da mesma janela — não por qualidade
   de diff isolado (notas próximas), mas por FALTA DE MEMÓRIA ENTRE PRs: o
   caso canônico (#6699) é uma PR criando um módulo canônico em
   `scripts/lib/shared/` e, dois commits depois, outra PR do mesmo dia
   contornando essa mesma abstração com um literal hardcoded — a abstração
   foi criada e imediatamente pisada pelo próprio autor. Decisão do editor
   (#6752, 30/08/2026): checagem MECÂNICA aqui no passo de seleção, **sem**
   eixo novo em `classifyExecTrack` nem label dedicada — rejeitar aqui não
   grava NADA na issue, ela só não é reivindicada NESTE tick, continua
   `track=overnight` normal pro overnight/develop.

   Rodar, pra cada candidata ANTES de `claim-issue`:
   ```bash
   npx tsx scripts/check-continuo-coherence.ts --issue N
   ```
   `exit 0` (`admit`) → prossegue pro passo 1 (claim). `exit 1` (`reject`) →
   **NÃO reivindicar** — registrar no relatório do tick ("pulada por
   coerência: {motivo}") e ir pra próxima candidata da fila. `exit 2`
   (`error` — `gh`/`git` falhou, inconclusivo) → tratar como `reject`
   também (fail-closed, mesma disciplina do guard de caminho sensível do
   §3 passo 2: não sabe responder ⇒ não arrisca). Ver
   `scripts/lib/continuo-coherence-gate.ts` pro que o gate mede
   (overlap de path com PR aberta/merge recente, refactor/consolidação,
   abstração compartilhada, fatia de épico, dependência cruzada explícita
   de outra PR) e por que é mecânico em vez de julgamento — não é um
   classificador perfeito (decide ANTES do diff existir), mas erra pro
   lado de barrar mais, porque o custo do falso-positivo (issue boa espera
   o overnight) é muito menor que o do falso-negativo medido (retrabalho
   2,4×, 3 das 4 quebras recentes de master).
1. **Claim é LEASE de trabalho imediato, nunca reserva de fila** (regra dura,
   28/08 — incidente recorrente antes do #6443: o contínuo acumulava claims
   sem PR nenhum e travava as issues para o develop indefinidamente, porque
   o session-id do cron era por JOB (fixo entre ticks) e o heartbeat renovava
   a MESMA entrada a cada tick — a sessão nunca ficava stale, então claim
   órfão nunca expirava sozinho. Corrigido pelo session-id por TICK do passo
   1.3 — usar sempre `$SESSION_ID` (a variável gerada naquele passo), nunca
   mais o literal fixo):
   - Reivindicar **UMA issue por vez**, e somente no instante em que a
     implementação dela vai começar NESTE tick. Nunca reivindicar "as
     elegíveis" em lote no início do ciclo. Comando: `session-registry.ts
     claim-issue --kind continuo --issue N --session-id "$SESSION_ID"`
     (sempre `--kind continuo`, nunca `overnight` — ver passo 1.3).
   - Só issues `track=overnight` podem ser reivindicadas. `bloqueada`/
     `develop`/`epica`/`agendada` NUNCA — mesmo que pareçam fáceis.
   - **Fim de tick = higiene obrigatória**: para cada issue em
     `claimed_issues` SEM PR aberto referenciando-a e sem worktree ativo,
     rodar `session-registry.ts unclaim-issue --kind continuo --issue N
     --session-id "$SESSION_ID"` ANTES do relatório (`--kind` e
     `--session-id` são ambos obrigatórios no CLI — `requireKind`/
     `requireSessionId` lançam sem eles; `--kind` sempre `continuo`, nunca
     `overnight`, mesmo motivo do passo 1.3). Claim que sobrevive ao
     tick precisa de evidência de trabalho em curso. **Rede de segurança**
     (#6443): mesmo que esta higiene falhe/seja pulada num tick, o
     session-id por tick (passo 1.3) garante que a entrada do tick pare de
     receber heartbeat quando ele termina — `SOFT_STALE_MS` (90min) trata
     essa entrada como stale sozinha, sem depender desta higiene ter
     rodado.
   - `claim-issue` com `exit 1` = outra sessão segura a issue → pular só ela.
     Sessões stale (heartbeat > 90min) não bloqueiam.
2. **Delegar a implementação ao harness**:

```bash
printf '%s' "Implemente a issue #N do repo atual (leia com gh issue view N).
Siga o CLAUDE.md. Crie branch com o prefixo continuo/ (convenção
continuo/fix-N-slug — é o que faz o PR aparecer como CONTINUO na Triagem
do Studio, #6446), implemente com edições cirúrgicas, adicione
teste de regressão se for bugfix (#633), rode os testes afetados, abra PR
com gh pr create referenciando a issue. NÃO mergeie — o merge é do
coordenador. Se a issue for inviável/ambígua além do trivial, comente nela
o bloqueio via gh issue comment e pare." | \
  ~/.hermes/scripts/claude-openrouter.sh \
    --tools "Read,Grep,Glob,Bash,Edit,Write" \
    --budget 20.0 --timeout 2400
```

**NUNCA baixar o `--budget` para "economizar" (#6712).** Ele não controla o
gasto desta pipeline — o CLI não reconhece o slug do gateway e estima o custo
a preço da Anthropic, ~14-18x o real, então um teto "econômico" aborta a
delegação no meio gastando centavos. Quem limita gasto é o teto diário da key
na OpenRouter, aplicado pelo provedor. Em 29/08/2026 o tick reagiu a
`Exceeded USD budget` tentando 1.5 e depois 1.0 — a direção errada: 3
delegações morreram, o tick de 40min produziu zero PRs e deixou worktree
órfão. Se este erro aparecer, o valor a mexer é para CIMA.

3. **Antes** de entrar na fila (próximo item): `npx tsx
   scripts/check-branch-issue-consistency.ts --pr N`. **Rastreabilidade
   (#6804)**, achado ao limpar 61 branches `continuo/`: branch nomeada
   `continuo/fix-6043-onboarding` (P0 de mass-send indevido) chegou a
   carregar só trabalho do #6005 (carrossel do Instagram) — quem investigar
   o P0 pelo nome da branch encontra outra coisa. `exit 1` (`mismatch` — o
   número no nome da branch não aparece em NENHUM commit) → comentar no PR
   com o achado (`gh pr comment N --body "..."`, texto que o CLI já imprime
   em stderr) — **não bloqueia o merge nem o review** (o conteúdo já chega
   correto ao master, é achado de arqueologia, não de correção — #6804 é
   P3). `exit 0` (`consistent`) → nada a fazer. O PR aberto entra na fila do
   passo 3 (review independente continua sendo o gate — o harness
   implementa, o pipeline do Hermes revisa e mergeia).
4. **Falha do wrapper (exit ≠ 0, todos os modelos) — verificar ANTES de
   desfazer o claim (#6712, achado 29/08/2026, 2 ocorrências no mesmo dia):**
   o wrapper pode estourar `--max-budget-usd` (ou outro erro classificado
   como falha) **DEPOIS** de já ter commitado e aberto PR — o relatório do
   tick então lê "nada foi feito" quando na real o trabalho existe,
   `unclaim-issue` libera a issue de volta pra fila, e o próximo tick (ou o
   overnight/develop) refaz trabalho que já tem PR aberto. 1ª ocorrência:
   #6702 desfeito por engano (PR #6713 já existia). 2ª forma, mais sutil,
   no mesmo dia: um WORKTREE criado durante o próprio tick (`.claude/worktrees/`,
   não commitado) foi relatado como "trabalho de OUTRA sessão em curso" —
   verificado que o worktree nascera dentro da janela do tick.

   Antes de rodar `unclaim-issue` por causa de erro de delegação, checar
   AMBOS:
   ```bash
   gh pr list --author @me --state open --json number,headRefName,createdAt \
     --jq '.[] | select(.headRefName | startswith("continuo/fix-'"$ISSUE_NUM"'"))'
   ls -la .claude/worktrees/ 2>/dev/null   # worktree da unidade já existe?
   ```
   Se PR ou worktree da unidade já existir: **não desfazer o claim** — o
   trabalho está em curso ou concluído; registrar isso no relatório e deixar
   o próximo tick continuar de onde parou (worktree) ou só aguardar o review
   (PR já aberto). Só desfazer o claim quando NENHUM dos dois existir — aí
   sim é falha real de infra, sem trabalho a preservar.

   Falha do wrapper **sem** PR nem worktree da unidade: registrar no
   relatório, NÃO reimplementar no modelo do próprio Hermes — o fallback já
   está dentro do wrapper; falha total é sinal de infra, não de modelo.

### 5. Sem trabalho elegível → perguntar/registrar (inalterado da v0.4)

1. Revarrer issues novas/atualizadas; reclassificar (passo 2).
2. `precisa-resposta` → pergunta objetiva ao editor no Telegram; resposta
   vira comentário na issue (`gh issue comment`), nunca só memória de chat.
3. Bloqueio externo → registrar com label, sem confundir com decisão.
4. Resposta do editor no tópico → processar IMEDIATAMENTE (não esperar tick).

### 6. Review consolidado diário (cron separado — NÃO por tick)

`daily-consolidated-review.sh` roda 1x/dia (cron próprio, 09:00 BRT) com a
**assinatura Anthropic** (Opus) sobre o diff acumulado desde o último marco.
Findings viram issues `[daily-review]` com prioridade — que caem nesta fila
e são drenadas pelos modelos free. O loop se fecha: Opus audita, free corrige.
Esta skill NÃO chama esse script no tick; só registra no relatório se as
issues `[daily-review]` aparecerem na classificação.

## Relatório de tick (formato inalterado)

```
## Tick HH:MM
### Trabalhado
### Pendente para próximo tick
### Decisões/bloqueios registrados
### Parada
### Perguntas (se houver)
```

Relatório de uma linha quando não houver trabalho — nunca reimprimir backlog
inteiro/git status/worktree list se normal (pitfall do ciclo 26/08).

## Definição de sucesso do ciclo (critério do editor, 23/08, inalterado)

O ciclo termina quando NÃO existir issue aberta elegível — fila vazia de
implementáveis, com as `precisa-resposta` perguntadas e os bloqueios
registrados. Refactors multi-batch: terminou um batch, inicia o próximo NO
MESMO ciclo enquanto houver orçamento.

## Pitfalls herdados (ver references/)

- `subagent-mcp-drain-20260828.md` (references/) — drain subagente MCP (#6465, epic #6464): lote 5-10 (#6496), anti-fabricação (verificar `.jsonl` + manifest, NÃO confiar só em EXIT=0), dedup obrigatório (`subscriber_id` + `(sub, url_hash, clicked_at)`) devido a duplicados em fronteiras de página, fonte única Helios/Neo (`data/beehiiv-backup/subscriber-engagement/` — `.worktrees/agent-*` NÃO sincronizam automaticamente), claim hygiene (`--kind continuo`).
- `tick-20260828-claim-collision-and-subagent.md` (references/) — aprendizados operacionais do tick 21:05 BRT 28/08: claim colisão `continuo` vs `develop` (sessão stale não bloqueia claim ativo) + delegação de drain a subagente + detecção de claim obsoleto.
- Rotação de modelo do Hermes (v0.4 §rotação): OBSOLETA para implementação —
  o fallback de modelo agora vive no wrapper. Mantida só para o modelo que o
  próprio Hermes usa para orquestrar/relatar.

## Changelog

- 0.5.6 (31/08/2026): §4 passo 3 — checagem de rastreabilidade
  branch↔commit ANTES da PR entrar na fila de review (#6804). Achado ao
  limpar 61 branches `continuo/`: nome referenciando uma issue (inclusive
  um caso com #6043, P0) carregando commits de outra issue inteiramente —
  `watch-continuo-health.sh` item 5 só checa PREFIXO de trilha, nunca o
  número; e é alarme pós-fato (0 correções medidas na auditoria do #6798).
  `npx tsx scripts/check-branch-issue-consistency.ts --pr N` — `exit 1`
  comenta no PR com o achado, não bloqueia merge (rastreabilidade, não
  correção — conteúdo já chega certo ao master). Lógica pura em
  `scripts/lib/branch-issue-consistency.ts`.
- 0.5.5 (31/08/2026): §4 novo passo 0 — gate de coerência ANTES do claim
  (#6752). Auditoria mediu 2,4× de retrabalho em PRs `continuo` vs
  `overnight`/`develop`, causa raiz não é qualidade de diff isolado, é
  falta de memória entre PRs (caso canônico #6699: módulo compartilhado
  criado numa PR, contornado com hardcode duas PRs depois, mesma sessão).
  `npx tsx scripts/check-continuo-coherence.ts --issue N` roda antes de
  `session-registry.ts claim-issue` — `exit 1`/`2` pula a issue neste tick
  sem gravar nada nela (sem label, sem eixo novo em `classifyExecTrack` —
  decisão explícita do editor, opção 2 do #6752). Critério mecânico:
  overlap de path com PR aberta/merge recente de master, palavras-chave de
  refactor/abstração-compartilhada/fatia-de-épico/dependência-cruzada no
  corpo da issue (`scripts/lib/continuo-coherence-gate.ts`).
- 0.5.4 (31/08/2026): §3 passo 3 atualizado — pickup de PR órfão do
  `continuo` deixou de ser lacuna documentada e passou a existir de fato
  (#6823), implementado como passo 2b da Fase 0 do `/diaria-overnight`
  (fora deste arquivo — este SKILL.md só reflete o estado, não implementa
  o passo). Cobre tanto `exit 1` (`self_review`) quanto `exit 2`
  (`no_review` — tick que morreu antes de sequer comentar, o cenário real
  da PR que motivou a issue, #6844). Deliberadamente **só** no overnight,
  nunca no `/diaria-develop` (#5751). A entrada 0.5.3 abaixo, que dizia
  "aguardando review externo (Opus diário ou pickup do overnight/develop)",
  ficava desatualizada nesse detalhe (mencionava develop) até esta entrada.
- 0.5.3 (30/08/2026): gate de autenticidade de review pré-merge (#6732) —
  a delegação (sem ferramenta Agent) fabricava um comentário no formato de
  review independente, satisfazendo o gate de auto-merge do #5251 com
  self-review disfarçado (medido nos PRs #6713/#6715). A instrução do hook
  (`.claude/hooks/pr-create-review.mjs`) agora manda postar self-review
  honesto (`<!-- self-review: true -->`) quando o Agent tool não está
  disponível; o passo 3 do §3 acima roda
  `scripts/check-pr-review-authenticity.ts --pr N` antes de mergear —
  `exit 0` = review independente confirmado, mergeia; qualquer outro código
  = fail-closed, PR fica aberto aguardando review externo (Opus diário ou
  pickup do overnight/develop). Opção (2) da decisão do editor de 29/08,
  liberada para execução em 30/08.
- 0.5.2 (28/08/2026): session-id do cron por TICK, não por JOB (#6443,
  raiz da issue — itens 2/3 da decisão do editor já tinham sido resolvidos
  via #6436). `$SESSION_ID` agora inclui timestamp UTC do início do tick
  (`hermes-cron-{job}-{YYYYMMDDTHHMMSSZ}`), gerado uma vez no passo 1.3 e
  reusado nos demais comandos `session-registry.ts` do tick. Antes, o id
  fixo por job fazia o heartbeat de cada tick renovar a MESMA entrada do
  registro indefinidamente — a sessão nunca ficava `stale`, e um claim
  órfão de um tick sem PR nunca expirava sozinho (medido em 28/08: 7 issues
  em `claimed_issues`, 6 sem PR aberto). Passos 1.3 e 4.1 atualizados.
- 0.5.1 (28/08/2026): subagent MCP drain (#6465, epic #6464) — lote 5 posts (`claude -p` + MCP Beehiiv, `proc_...` EXIT=0). Padrões: (a) limite #6496 (5-10, nunca 20+); (b) anti-fabricação (`.jsonl` + manifest, não só EXIT=0); (c) dedup obrigatório (`subscriber_id` + `(sub, url_hash, clicked_at)`); (d) fonte única Helios/Neo (`data/beehiiv-backup/subscriber-engagement/` — `.worktrees/agent-*` NÃO sincronizam automaticamente); (e) claim hygiene (`--kind continuo`, unclaim só sem worktree ativo). Ver `references/subagent-mcp-drain-20260828.md`. Corrigido erro de assumir que `worktree` era fonte sincronizada; fonte real é `.jsonl` + manifest.
- 0.5.0 (28/08/2026): arquitetura delegada — classificação via código real
  (`classifyExecTrackWithRule`, 6 categorias), implementação via
  `claude-openrouter.sh` (harness Claude Code + OpenRouter), review diário
  consolidado Opus via `daily-consolidated-review.sh`. Remove a paráfrase da
  regra de classificação (fonte do bug das 5-vs-6 categorias).
- 0.4.0: ver SKILL.md.bak-v0.4-20260828.
