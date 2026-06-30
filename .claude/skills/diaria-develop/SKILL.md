---
name: diaria-develop
description: Sessão de desenvolvimento SUPERVISIONADA focada no backlog BLOQUEADO (#2636) — o complemento exato do /diaria-overnight. O editor está presente e desbloqueia em tempo real (cola token, confirma conta, decide trade-off, autoriza blast-radius); a skill valida o desbloqueio deterministicamente (#573) e leva a issue ao merge reusando a maquinaria do overnight, PARALELIZANDO tudo que for seguro. Uso — `/diaria-develop [AAMMDD] [--issues N,M] [--only A-E] [--dry-run] [--no-implement] [--serial]`.
disable-model-invocation: true
---

# /diaria-develop

Sessão de desenvolvimento **supervisionada/interativa** focada nas issues **COM BLOQUEIO** — exatamente as que o `/diaria-overnight` pula. Aqui o **bloqueio é o escopo de trabalho, não o filtro de rejeição**. Como o editor está presente, ele desbloqueia ao vivo (cola um token, confirma que criou uma conta de terceiro, decide um trade-off de produto/editorial, ou autoriza uma mudança de alto blast-radius); a skill **valida o desbloqueio deterministicamente (#573)** e leva a issue até o merge **reusando a maquinaria de implementação do overnight**, com uma diferença central: **paraleliza tudo que for seguro** (inverte o #636 — ver seção de Paralelização).

Espelho invertido do `/diaria-overnight` (#2021): onde o overnight é autônomo e recusa tudo que está bloqueado, o `/diaria-develop` é supervisionado e ataca justamente o bloqueado. Esta skill só roda por invocação explícita do editor (`disable-model-invocation: true`) — o blast radius (merges autônomos em master + aplicação de mudanças de alto impacto) exige que a invocação seja o consentimento, mesmo padrão de `/diaria-overnight` e `/diaria-remover-votos-pixel`.

**Premissa de transporte:** assume `gh` CLI presente, igual ao overnight — toda a maquinaria reusada (`gh issue list`, `gh pr create`, `gh pr checks --watch`, `gh pr merge --squash`, `gh api graphql --jq` para o gate de threads, `gh run view --log-failed`) é construída sobre `gh`. A Fase 0 roda `gh auth status`.

## Como difere de /diaria-overnight

| Eixo | /diaria-overnight | /diaria-develop |
|---|---|---|
| **Escopo** | fila DESBLOQUEADA | fila BLOQUEADA (complemento exato) |
| **Regra 1** | `AskUserQuestion` PROIBIDO pós-briefing (não pode depender de presença) | perguntar é **permitido e central** — o gate de desbloqueio por issue é o órgão da skill (pressupõe editor presente) |
| **Paralelização** | #636 estrito: 1 PR não-draft por vez | **paraleliza tudo que for seguro** (worktrees concorrentes sem colisão de arquivo; teto 4) |
| **Blast-radius** | recusa alto blast-radius não-supervisionado | **aceita**, atrás de um Gate B de pré-aplicação |

**Reuso verbatim do overnight (Fase 1 de implementação):** subagente `general-purpose` com `isolation: worktree` e `model: sonnet` explícito (#2019) → `npm ci` → `npm test` → branch → PR `Closes #NNNN` → self-review (#2038) → fixer 2-agentes → resolução de threads com carve-out FORBIDDEN → **gate determinístico de 2 condições (#2210/#2222)** → squash-merge → verify #573; #633 (bugfix exige teste de regressão); retry GitHub 401/429 com backoff; guard de publicação no prompt do subagente; #738 fail-fast de MCP; `plan.json` como fonte de verdade pós-compaction; timeline via `scripts/render-overnight-timeline.ts` (helper fluxo-neutro `renderTimeline`, #2637 — passar `--title "Timeline da sessão" --total-label "Total da sessão"`).

## Argumentos

- **`AAMMDD` (opcional)** — data-rótulo da sessão (nomeia `data/develop/{AAMMDD}/plan.json`). **Não é data de edição** (nenhum stage editorial destrutivo depende dela; a regra D+1 não se aplica). O default de hoje é seguro, mas a skill **confirma** ("sessão develop de hoje, {AAMMDD}? s/n") em vez de inferir em silêncio. Fixar no `plan.json` e reler dele (a sessão pode cruzar meia-noite).
- **`--issues N,M,…`** — restringe a issues específicas, pulando a varredura. Issue não bloqueada (trabalho de overnight) → permitir-com-aviso.
- **`--only A,B,C,D,E`** — restringe por categoria de bloqueio (minimiza a troca de contexto do editor).
- **`--dry-run`** — só Fase 0 (varredura + classificação + tabela), zero side-effect.
- **`--no-implement`** — modo "só destravar": gate de desbloqueio + validação + registro durável, **sem** implementar (deixa pro overnight posterior, que então vê as issues como `elegivel`).
- **`--serial`** — desliga a paralelização (volta ao 1-PR-por-vez do overnight). Default é **paralelo seguro**.

## Paralelização segura no desenvolvimento (inverte o #636)

Diferente do overnight (serial por #636 — sem supervisão, paralelo elevaria o blast-radius), aqui a supervisão humana torna o paralelo seguro. **"Seguro" = sem colisão de arquivo**, via análise de **cluster de conflito**:

1. Para cada issue **desbloqueada+validada**, mapear o conjunto de arquivos que toca (corpo da issue + grep dos paths/símbolos citados).
2. Issues cujos conjuntos de arquivos se **intersectam** formam um **cluster** → serializam entre si (rebase em master após o cluster-mate mergear).
3. **Onda paralela máxima = 1 unidade por cluster que se toca + todos os singletons independentes.** As demais ficam para a próxima onda.
4. Cada unidade da onda roda num **worktree isolado próprio** (`isolation: worktree`) com seu subagente implementador **concorrente**.
5. **Teto de concorrência = 4 worktrees simultâneos** (`--serial` desliga; ondas maiores rodam em sub-lotes).

**Substitui o #636, não o afrouxa:** o invariante "nunca 2 PRs que colidem abertos ao mesmo tempo" é preservado por construção (a onda é livre de colisão). Drafts de CI-vermelho não contam. Unidades cat. D (blast-radius) rodam **sempre solo** (nunca na onda). A **Fase 1.5** (review consolidado) é a rede que enxerga interações entre os PRs da mesma onda.

## Categorias de bloqueio + protocolo de desbloqueio (editor faz X → coordenador faz Y)

| Cat | Bloqueio | Editor faz X | Coordenador faz Y | Validação #573 |
|---|---|---|---|---|
| **A** | credencial-runtime (ex: token Instagram/Threads) | cola o token/chave | grava em `.env.local` (gitignored; **se não existe num clone fresco, criar de `.env.example`**; atualizar `.env.example` com novas vars); implementa→PR→merge; remove `bloqueio-externo` | `publish-*.ts --dry-run` exit 0 + resposta de API válida — **nunca** "válido" só por colar |
| **B** | conta-externa-de-terceiro (ex: Kit da Clarice) | confirma que a conta já existe; cola IDs/credenciais | se existe: probe real → implementa→PR→merge, remove `on-hold`; se não: máximo offline (config/stubs/doc) + comentário do estado parcial, mantém `on-hold` | probe real contra a conta antes de declarar pronto |
| **C** | decisão-produto/editorial (ex: design system; UX trade-off) | escolhe o trade-off (`AskUserQuestion`) | **posta a decisão como comentário durável** na issue, remove a ambiguidade (→ elegível), implementa a opção escolhida | a decisão postada como comentário **é** a evidência durável |
| **D** | supervisão-blast-radius (ex: refactor pervasivo / migração ~N sites; `not-this-week`) | autoriza no **Gate B** após ver o diff-walkthrough | implementa em branch, roda local primeiro, Gate B, só após "ok" aplica em escala; merge com confirmação humana | teste local + diff de amostra revisado antes da escala |
| **E** | plataforma-sem-fix (ex: CSP/plan-gated de plataforma) | decide workaround vs upgrade vs documentar | implementa workaround→PR→merge; OU "documentar" atualiza o doc e converte a issue p/ elegível-documentada; OU "upgrade" confirmado → vira cat. A/B | estado de plataforma via `scripts/lib/publish-state.ts` antes de afirmar que o workaround funciona |

Categoria inferida na Fase 0 por **labels reais** (`bloqueio-externo`→A/B/E conforme corpo; `on-hold`/`kit-migration`→B; `not-this-week`→D; `beehiiv`→E) + corpo (token/chave→A; "criar conta"/"aguardando terceiro"→B; "decidir entre"/"OU"→C; "blast radius"/"~N sites"/"migração"→D; "CSP"/"plan-gated"/"API limit"→E). **Antes de hardcodar qualquer label, rodar `gh label list`** e confirmar o conjunto real `{ bloqueio-externo, on-hold, kit-migration, not-this-week, beehiiv }` (usar `bloqueio-externo` — NÃO `external-blocker`, que é prosa; NÃO `bloqueada-externa`, que é status interno do overnight).

## Fase 0 — Montar e triar a fila BLOQUEADA (filtro invertido)

0. **Resume** via `plan.json` se existe.
1. **Sync:** `git checkout master && git pull`; capturar `base_sha = git rev-parse HEAD`; **`gh auth status`**.
2. **Herdar a triagem do overnight:** ler `data/overnight/{AAMMDD-recente}/plan.json` e extrair os `status: pulada` com motivo ∈ `{bloqueio-externo, not-this-week, ambigua}` — a triagem cara já foi feita (`source: inherited-overnight`).
3. **Varredura fresca de confirmação** por labels reais via `gh issue list --json labels` + reconciliar; **fresh-scan vence o plan.json herdado em divergência**.
4. **Classificar** cada bloqueio em A–E.
5. **Imprimir a tabela** do backlog bloqueado, agrupada por categoria, ordenada P0>P1>P2>P3: `#NNNN | P? | cat A-E | o-que-falta-destravar | título`.
6. Aplicar `--issues`/`--only`.
7. Gravar `plan.json`; com `--dry-run`, **parar aqui**.

## Fase 0.5 — Briefing de ordem de ataque (ponto de partida, não cerca)

Diferente do overnight, o briefing aqui **só define a ordem** — perguntas seguem liberadas a sessão inteira. Via `AskUserQuestion`: (a) por prioridade; (b) por categoria; (c) só as que o editor consegue destravar agora. **Default sugerido: C e A primeiro** (mais baratos), depois E, depois B (depende de terceiro), **D por último**.

## Fase 1 — Desbloquear → validar → implementar em ondas paralelas seguras

O **desbloqueio** (Gate 1, humano) é serial por natureza (um editor, uma decisão por vez), mas pode **agrupar desbloqueios da mesma categoria numa única `AskUserQuestion`** (até 4 perguntas). À medida que issues ficam **desbloqueadas+validadas**, entram numa fila de implementação trabalhada em **ondas paralelas seguras**. **No início de cada iteração, reler `plan.json`.**

1. **Diagnosticar** e formular o pedido de desbloqueio **exato e acionável** (ex: "cole o valor de `INSTAGRAM_ACCESS_TOKEN` gerado em Meta Business > Apps > diar.ia > Tokens").
2. **Gate 1 — desbloqueio** (`AskUserQuestion`, formato por categoria) — toda opção inclui sempre "não consigo destravar agora (documentar e pular)".
3. **Validar deterministicamente (#573)** — nunca pela palavra do editor (ver tabela A–E).
4. **Compor a onda:** quando há ≥1 issue validada pendente, rodar a análise de cluster de conflito → **Gate de Onda** (editor aprova a composição) → **fan-out de até 4 implementadores concorrentes** (um worktree por unidade; branch `develop/fix-NNNN` solo, ou `develop/blast-NNNN` p/ cat. D — sempre solo). Cada PR passa pelo **Gate 2 determinístico** (#2210/#2222) e mergeia independentemente.
5. Atualizar `plan.json` + `scripts/log-event.ts`; `git pull` após cada merge. Issue não destravável na sessão → comentário durável (com dedup) explicando o que falta, status `pulada` motivo `nao-destravavel-na-sessao` (degradação elegante para o skip do overnight, mas só após ter tentado destravar ao vivo).

## Gates

**Quatro gates** — a separação limpa é o que torna seguro inverter a Regra 1 e paralelizar: **humano no Gate 1 e no Gate de Onda; máquina sozinha no Gate 2.**

- **GATE 1 — DESBLOQUEIO** (humano, `AskUserQuestion`, permitido por design). Órgão central da skill. Decisões de produto/editorial (cat. C/E) **viram comentário durável na issue** — `plan.json` é só cache.
- **GATE DE ONDA — COMPOSIÇÃO PARALELA** (humano, antes do fan-out). Apresenta clusters + singletons + o que serializa; editor aprova a onda. Pulável com `--serial`.
- **GATE 2 — IMPLEMENTAÇÃO/MERGE** (determinístico, sem humano, por PR): gate de 2 condições do overnight (#2210/#2222 — `gh pr checks` bucket≠pass == 0 **E** threads não-resolvidas excluindo FORBIDDEN == 0, ambos via `gh api graphql --jq`), em chamada separada do `gh pr merge`, + verify #573.
- **GATE B — PRÉ-APLICAÇÃO** (só cat. D, **obrigatório e não-opt-out**): entre validar e aplicar em escala. Mostra diff-walkthrough (contagem por tipo de mudança + 1 site exemplo antes/depois + resultado do teste local) e pede confirmação explícita ("vai tocar ~N sites; testei local: {resultado}. Aplico no conjunto inteiro? s/n/subconjunto").

**Fallback de ausência:** `AskUserQuestion` é bloqueante; se o editor sair no meio, a issue corrente vira `pulada` motivo `decisao-adiada`, `resume_state` é gravado e a sessão **para limpa — nunca continua autônoma**. Todo gate de desbloqueio inclui "decido depois / pular".

## Fase 1.5 — Code-review consolidado (opcional, mais leve)

Roda só se houve ≥1 merge e o diff `{base_sha}..HEAD` > ~50 linhas. Um `/code-review` sem `--comment`; crítico-em-produção confirmado deterministicamente (`gh run list --branch master --limit 1`, #573) → hotfix imediato; demais → issues via `scripts/lib/auto-reporter-dedup.ts` (dedup, labels tipo + prioridade obrigatória) com label extra **`session-finding`** (label compartilhada entre overnight e develop, #2636) e corpo citando o PR de origem. **Sem a cadeia depth-2 do overnight** — se o editor quer atacar um finding na hora, ele vira a próxima issue da Fase 1. Fail-soft #738.

> **Label `session-finding`:** label compartilhada entre `/diaria-overnight` e `/diaria-develop` (renomeada de `overnight-finding`, #2636). Ambas as skills filam os findings do code-review consolidado com ela.

## Fase 2 — Relatório + handoff para o overnight

Digest de `plan.json` + run-log (filtrado por `agent: "develop"` + AAMMDD) em 4 buckets: (a) destravadas e mergeadas (agrupadas por onda); (b) destravadas mas pendentes (`--no-implement` ou CI vermelho — **prontas p/ o próximo overnight pegar como `elegivel`**); (c) não-destraváveis na sessão; (d) findings/hotfixes. **Seção de HANDOFF:** quais issues saíram de bloqueada→elegível (label removido + decisão postada) e quais ações fora da sessão o editor ainda precisa agendar. Timeline via `npx tsx scripts/render-overnight-timeline.ts --plan data/develop/{AAMMDD}/plan.json --title "Timeline da sessão" --total-label "Total da sessão"`. Canal primário = terminal; rascunho no Gmail (`create_draft`, não envia, fail-soft #738).

## Guard de colisão editorial — aviso interativo, sem auto-preempt

Ao detectar edição em curso (`scripts/lib/find-current-edition.ts` retorna candidato ou `data/editions/` de hoje/amanhã ganhou arquivos novos), a skill **avisa o editor e pergunta** ("uma edição de hoje/amanhã está em curso — encerrar a sessão develop para liberar a pipeline editorial? s/n"). **Diferente do overnight, develop NÃO grava `preempted_*` nem auto-encerra** — como é supervisionado e nunca continua sem editor, a decisão é humana ao vivo. Se o editor não responde, o `AskUserQuestion` fica bloqueante, `resume_state` é gravado e a sessão para limpa.

## `plan.json` (`data/develop/{AAMMDD}/`, gitignored)

Reusa o schema do overnight + campos próprios de desbloqueio: `block_category` (A–E), `block_label` (literal real), `what_unblocks`, `unblock_status` (`pendente`|`desbloqueada-validada`|`nao-destravavel-na-sessao`), `unblock_evidence` (dry-run exit 0 / comentário #link / probe API ok — **NUNCA o valor do secret**), `editor_input_received` (bool/hash, nunca o secret), `source` (`inherited-overnight`|`fresh-scan`|`manual-issues-arg`), `wave` (id da onda paralela). **Regra crítica de resume:** nunca re-perguntar um desbloqueio já validado (`unblock_status: desbloqueada-validada` + `status: pendente` → retomar direto na implementação). **Segurança:** o plan.json nunca armazena o valor de um token. Develop **não** grava `preempted_*`.

## Fronteira com o overnight nas ambíguas (cat C)

`/diaria-develop` **trabalha** as issues ambíguas de trade-off-real (cat. C — decisão de produto/editorial). **Fronteira resolvida (#2640):** o `/diaria-overnight` marca issues de trade-off-real como `pulada` motivo `ambígua/trade-off-real`, posta comentário na issue direcionando ao `/diaria-develop`, e **nunca** as inclui no seu briefing. Ambiguidade trivial-mas-não-documentada (escolha técnica sem impacto diferencial em usuário) continua no briefing do overnight; trade-off-real é escopo exclusivo do develop.

## Label `local` — issues que só fecham em sessão local (#2643)

Issues com label **`local`** requerem recursos machine-local: junction `data/` (OneDrive), ComfyUI, credenciais persistidas, etc. O `/diaria-overnight` detecta o modo de execução via `npx tsx scripts/lib/exec-mode.ts` (`local` | `cloud`) e pula issues `local` em sessão cloud com motivo `requer-sessao-local`.

O `/diaria-develop` **roda por natureza em sessão local** (o editor está presente na máquina). Por isso, issues `local` são **elegíveis normalmente** no develop — a label é apenas informacional aqui. Se por algum motivo a sessão develop rodar em cloud (improvável), aplicar a mesma detecção do overnight e avisar o editor antes de pular.

**Quando aplicar a label `local` a uma nova issue:** quando a implementação ou o teste requer qualquer recurso ausente num clone fresco de cloud — junction `data/`, ComfyUI local, OneDrive sincronizado, credenciais locais não-gitadas, `scripts/overnight-watchdog.ts` via Task Scheduler, ou qualquer dependência de path local do editor.

## Regras

- **Perguntar ao editor é permitido e central** (inverte a Regra 1 do overnight) — mas via os gates definidos; a sessão pressupõe editor presente e **nunca continua autônoma sem ele**.
- **Nunca** disparar a pipeline editorial ao vivo (mesmo guard do overnight) — **única exceção controlada:** `publish-*.ts --dry-run` p/ validar token recém-colado (cat. A), rodado pelo coordenador top-level, **nunca** pelo subagente implementador.
- **Nunca persistir segredo no repo:** credencial só em `.env.local`; o subagente recebe referência ao env var, **nunca o valor**.
- #633 (teste de regressão em bugfix) e validação determinística de estado externo (#573) valem a sessão inteira.
- Paralelização preserva o invariante de não-colisão do #636; cat. D sempre solo + Gate B.
- Toda issue **trabalhada ou bloqueada** recebe comentário com o que foi feito / o que falta (com dedup).
- `data/develop/` segue o blanket gitignore de `data/`.
- Stall passivo é inaceitável (#738): toda espera de CI usa `gh pr checks --watch` em background; timeout de CI = 30 min → tratar como CI vermelho.
