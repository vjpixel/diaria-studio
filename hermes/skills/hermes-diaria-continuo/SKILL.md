---
name: hermes-diaria-continuo
description: Mantém continuamente a fila técnica da Diária delegando execução ao harness do Claude Code (modelos OpenRouter) e classificação ao código real do repo.
version: 0.5.1
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
| `~/.hermes/scripts/claude-openrouter.sh` | roda `claude -p` com OpenRouter (stdin=prompt; `--tools`, `--budget`, `--timeout`) | glm-5.2:free → dots-3:free → glm-5.3-flash |
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
   fail-closed → auto-fix loop (máx. 2). Passed → merge no MESMO tick.

### 4. Implementar issues elegíveis — via harness delegado

Para cada issue elegível (após claim):

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
    --budget 0.25 --timeout 2400
```

3. O PR aberto entra na fila do passo 3 (review independente continua sendo
   o gate — o harness implementa, o pipeline do Hermes revisa e mergeia).
4. Falha do wrapper (exit ≠ 0, todos os modelos): registrar no relatório,
   NÃO reimplementar no modelo do próprio Hermes — o fallback já está dentro
   do wrapper; falha total é sinal de infra, não de modelo.

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

- `pr-batch-review.md` — lote de PRs, superseded-check, conflito no worktree.
- `overnight-claim-collision.md` — colisão de claim ≠ exclusão total.
- `continuo-review-pipeline.md` — guard sensível fail-closed.
- `subagent-mcp-drain-20260828.md` (references/) — drain subagente MCP (#6465, epic #6464): lote 5-10 (#6496), anti-fabricação (verificar `.jsonl` + manifest, NÃO confiar só em EXIT=0), dedup obrigatório (`subscriber_id` + `(sub, url_hash, clicked_at)`) devido a duplicados em fronteiras de página, fonte única Helios/Neo (`data/beehiiv-backup/subscriber-engagement/` — `.worktrees/agent-*` NÃO sincronizam automaticamente), claim hygiene (`--kind continuo`).
- Rotação de modelo do Hermes (v0.4 §rotação): OBSOLETA para implementação —
  o fallback de modelo agora vive no wrapper. Mantida só para o modelo que o
  próprio Hermes usa para orquestrar/relatar.

## Changelog

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
