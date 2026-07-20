---
name: diaria-develop
description: Sessão de desenvolvimento SUPERVISIONADA focada no backlog BLOQUEADO (#2636) — o complemento exato do /diaria-overnight. O editor está presente e desbloqueia em tempo real (cola token, confirma conta, decide trade-off, autoriza blast-radius); a skill valida o desbloqueio deterministicamente (#573) e leva a issue ao merge reusando a maquinaria do overnight, PARALELIZANDO tudo que for seguro. Uso — `/diaria-develop [AAMMDD] [--issues N,M] [--only A-E] [--bugs] [--priority P0,P1,P2,P3] [--dry-run] [--no-implement] [--serial]`.
disable-model-invocation: true
model: sonnet
effort: high
---

# /diaria-develop

Sessão de desenvolvimento **supervisionada/interativa** focada nas issues **COM BLOQUEIO** — exatamente as que o `/diaria-overnight` pula. Aqui o **bloqueio é o escopo de trabalho, não o filtro de rejeição**. Como o editor está presente, ele desbloqueia ao vivo (cola um token, confirma que criou uma conta de terceiro, decide um trade-off de produto/editorial, ou autoriza uma mudança de alto blast-radius); a skill **valida o desbloqueio deterministicamente (#573)** e leva a issue até o merge **reusando a maquinaria de implementação do overnight**, com uma diferença central: **paraleliza tudo que for seguro** (inverte o #636 — ver seção de Paralelização).

Espelho invertido do `/diaria-overnight` (#2021): onde o overnight é autônomo e recusa tudo que está bloqueado, o `/diaria-develop` é supervisionado e ataca justamente o bloqueado. Esta skill só roda por invocação explícita do editor (`disable-model-invocation: true`) — o blast radius (merges autônomos em master + aplicação de mudanças de alto impacto) exige que a invocação seja o consentimento, mesmo padrão de `/diaria-overnight` e `/diaria-remover-votos-pixel`.

**Modelo/effort do coordenador (#3454).** O frontmatter fixa `model: sonnet` + `effort: high` — mesmo pin do `/diaria-overnight` (#3453). Antes do #3454 o develop **não pinava nada** e o coordenador herdava o modelo/effort ambiente da sessão interativa do editor (potencialmente Opus/effort alto durante as fases mecânicas Fase 1/1.5, que não exigem isso), sem decisão registrada — a análise `docs/develop-token-analysis-3328.md` §3.2 identificou isso como a única lacuna estrutural real da skill. Decisão do editor (#3454): pinar `sonnet` + `high`, igual ao overnight — as decisões de julgamento ao vivo (cat. C/D/E) já passam por gates humanos explícitos (Gate 1, Gate de Onda, Gate B), então effort `high` basta pra mediação; previsibilidade de custo + consistência com o overnight valem mais que rodar mais forte nas fases mecânicas. Mesma limitação de escopo-de-turno do overnight (o override de frontmatter vale pelo turno atual; se o editor digitar uma mensagem livre mid-sessão, a sessão volta ao modelo/effort anteriores a partir daquele ponto — esperado, não bug). `--serial` e os gates humanos não mudam com o pin.

**Premissa de transporte:** assume `gh` CLI presente, igual ao overnight — toda a maquinaria reusada (`gh issue list`, `gh pr create`, `gh pr checks --watch`, `gh pr merge --squash`, `gh api graphql --jq` para o gate de threads, `gh run view --log-failed`) é construída sobre `gh`. A Fase 0 roda `gh auth status`.

## Como difere de /diaria-overnight

| Eixo | /diaria-overnight | /diaria-develop |
|---|---|---|
| **Escopo** | fila DESBLOQUEADA | fila BLOQUEADA (complemento exato) |
| **Regra 1** | `AskUserQuestion` PROIBIDO pós-briefing (não pode depender de presença) | perguntar é **permitido** — mas o briefing FRONT-LOADED (Fase 0.5, #2966) colhe o máximo no início pra **minimizar** interrupções; só o genuinamente-adiável fica mid-sessão |
| **Paralelização** | #636 estrito: 1 PR não-draft por vez | **paraleliza tudo que for seguro** (worktrees concorrentes sem colisão de arquivo; teto 6) |
| **Blast-radius** | recusa alto blast-radius não-supervisionado | **aceita**, atrás de um Gate B de pré-aplicação |

**Reuso verbatim do overnight (Fase 1 de implementação):** o prompt de cada subagente implementador **cita `context/overnight-dispatch-rules.md`** (checklist canônico compartilhado com o overnight, #3453 Rec 4 / #3454 Rec 2 — guard de publicação, convenção de branch, bootstrap, disciplina de testes #2959, #633, `no-regression-test`, self-review #2038) em vez de reproduzir o texto completo das regras, encurtando o prompt de dispatch do coordenador. Subagente `general-purpose` com `isolation: worktree` e `model: sonnet` explícito (#2019) → `npm ci` → **`npx tsc --noEmit` → testes afetados/novos** (`npx tsx --test test/<arquivo-tocado>.test.ts test/lib-boundary.test.ts` — **NUNCA a suíte completa `npm test` local, #2959**: o CI já roda a suíte inteira como gate autoritativo antes do merge, e repeti-la no worktree (~11k testes/~3min) é justamente o comando que dispara o auto-background do harness, travando o subagente num Monitor-loop sem retornar — padrão observado em 100% dos subagentes das rodadas 260703+260704) (#2754 — typecheck local explícito antes do push, não só os testes: o CI roda `npm run typecheck` como primeiro passo do job `test`, antes até de rodar os testes; pular isso local significa descobrir erro de tipo só depois de um round-trip inteiro de CI, o gargalo real de latência quando velocidade importa mais que tokens) → branch → PR `Closes #NNNN` → self-review (#2038) → fixer 2-agentes → resolução de threads com carve-out FORBIDDEN → **gate determinístico de 2 condições (#2210/#2222)** → squash-merge → verify #573; #633 (bugfix exige teste de regressão); retry GitHub 401/429 com backoff; guard de publicação no prompt do subagente; #738 fail-fast de MCP; `plan.json` como fonte de verdade pós-compaction; timeline via `scripts/render-overnight-timeline.ts` (helper fluxo-neutro `renderTimeline`, #2637 — passar `--title "Timeline da sessão" --total-label "Total da sessão"`).

## Argumentos

- **`AAMMDD` (opcional)** — data-rótulo da sessão (nomeia `data/develop/{AAMMDD}/plan.json`). **Não é data de edição** (nenhum stage editorial destrutivo depende dela; a regra D+1 não se aplica). O default de hoje é seguro, mas a skill **confirma** ("sessão develop de hoje, {AAMMDD}? s/n") em vez de inferir em silêncio. Fixar no `plan.json` e reler dele (a sessão pode cruzar meia-noite).
- **`--issues N,M,…`** — restringe a issues específicas, pulando a varredura. Issue não bloqueada (trabalho de overnight) → permitir-com-aviso.
- **`--only A,B,C,D,E`** — restringe por categoria de bloqueio (minimiza a troca de contexto do editor).
- **`--bugs`** (#3375) — restringe a sessão a issues bloqueadas com label `bug`; `enhancement`/`documentation`/cleanup/etc. ficam fora mesmo que desbloqueáveis por todos os outros critérios. Compõe com `--issues`/`--only` (ex: `--bugs --only A,B` = só bugs bloqueados por credencial ou conta externa). Aplica-se na varredura (Fase 0 passo 2/3) e na herança de triagem do overnight (passo 2) — issue herdada sem label `bug` não entra na tabela. Sem a flag, comportamento atual sem mudança.
- **`--priority [P0,P1,P2,P3]`** (#3499, aceita lista) — restringe a sessão a issues bloqueadas cujo label de prioridade ∈ conjunto passado (ex: `--priority P2` ou `--priority P0,P1`); as demais ficam fora de escopo mesmo que desbloqueáveis por todos os outros critérios — não são "puladas por bloqueio", simplesmente não entram, mesmo tratamento do `--bugs`. Compõe com `--issues`/`--only`/`--bugs` (ex: `--only A,B --priority P0,P1` = só cat. A/B com prioridade P0 ou P1; `--bugs --priority P2` = só bugs P2). Aplica-se na varredura (Fase 0 passo 2/3) e na herança de triagem do overnight (passo 2) — issue herdada cuja prioridade ∉ conjunto passado não entra na tabela. Sem a flag, comportamento atual sem mudança.
- **`--dry-run`** — só Fase 0 (varredura + classificação + tabela), zero side-effect.
- **`--no-implement`** — modo "só destravar": gate de desbloqueio + validação + registro durável, **sem** implementar (deixa pro overnight posterior, que então vê as issues como `elegivel`).
- **`--serial`** — desliga a paralelização (volta ao 1-PR-por-vez do overnight). Default é **paralelo seguro**.

## Paralelização segura no desenvolvimento (inverte o #636)

Diferente do overnight (serial por #636 — sem supervisão, paralelo elevaria o blast-radius), aqui a supervisão humana torna o paralelo seguro. **"Seguro" = sem colisão de arquivo**, via análise de **cluster de conflito**:

1. Para cada issue **desbloqueada+validada**, mapear o conjunto de arquivos que toca (corpo da issue + grep dos paths/símbolos citados).
2. Issues cujos conjuntos de arquivos se **intersectam** formam um **cluster** → serializam entre si (rebase em master após o cluster-mate mergear).
3. **Onda paralela máxima = 1 unidade por cluster que se toca + todos os singletons independentes.** As demais ficam para a próxima onda.
4. Cada unidade da onda roda num **worktree isolado próprio** (`isolation: worktree`) com seu subagente implementador **concorrente**.
5. **Teto de concorrência = 6 worktrees simultâneos** (revisado de 4 em #2754 — develop otimiza velocidade, não tokens; 6 ≈ `cores - 2` desta máquina, cada worktree é majoritariamente I/O-bound (chamadas de API, git, npm), então o teto real costuma ser rede/API antes de CPU. `--serial` desliga; ondas maiores rodam em sub-lotes; se a máquina engasgar em prática, baixar manualmente é seguro — não é um invariante de correção, só de throughput).

**Substitui o #636, não o afrouxa:** o invariante "nunca 2 PRs que colidem abertos ao mesmo tempo" é preservado por construção (a onda é livre de colisão). Drafts de CI-vermelho não contam. Unidades cat. D (blast-radius) rodam **sempre solo** (nunca na onda). A **Fase 1.5** (review consolidado) é a rede que enxerga interações entre os PRs da mesma onda.

## Categorias de bloqueio + protocolo de desbloqueio (editor faz X → coordenador faz Y)

| Cat | Bloqueio | Editor faz X | Coordenador faz Y | Validação #573 |
|---|---|---|---|---|
| **A** | credencial-runtime (ex: token Instagram/Threads) | cola o token/chave | grava em `.env.local` (gitignored; **se não existe num clone fresco, criar de `.env.example`**; atualizar `.env.example` com novas vars); implementa→PR→merge; remove `external-blocker` | `publish-*.ts --dry-run` exit 0 + resposta de API válida — **nunca** "válido" só por colar |
| **B** | conta-externa-de-terceiro (ex: Kit da Clarice) | confirma que a conta já existe; cola IDs/credenciais | se existe: probe real → implementa→PR→merge, remove `on-hold`; se não: máximo offline (config/stubs/doc) + comentário do estado parcial, mantém `on-hold` | probe real contra a conta antes de declarar pronto |
| **C** | decisão-produto/editorial (ex: design system; UX trade-off) | escolhe o trade-off (`AskUserQuestion`) | **posta a decisão como comentário durável** na issue, remove a ambiguidade (→ elegível), implementa a opção escolhida | a decisão postada como comentário **é** a evidência durável |
| **D** | supervisão-blast-radius (ex: refactor pervasivo / migração ~N sites; `not-this-week`) | autoriza no **Gate B** após ver o diff-walkthrough | implementa em branch, roda local primeiro, Gate B, só após "ok" aplica em escala; merge com confirmação humana | teste local + diff de amostra revisado antes da escala |
| **E** | plataforma-sem-fix (ex: CSP/plan-gated de plataforma) | decide workaround vs upgrade vs documentar | implementa workaround→PR→merge; OU "documentar" atualiza o doc e converte a issue p/ elegível-documentada; OU "upgrade" confirmado → vira cat. A/B | estado de plataforma via `scripts/lib/publish-state.ts` antes de afirmar que o workaround funciona |

Categoria inferida na Fase 0 por **labels reais** (`external-blocker`→A/B/E conforme corpo; `on-hold`/`kit-migration`→B; `not-this-week`→D; `beehiiv`→E) + corpo (token/chave→A; "criar conta"/"aguardando terceiro"→B; "decidir entre"/"OU"→C; "blast radius"/"~N sites"/"migração"→D; "CSP"/"plan-gated"/"API limit"→E). **Antes de hardcodar qualquer label, rodar `gh label list`** e confirmar o conjunto real `{ external-blocker, on-hold, kit-migration, not-this-week, beehiiv }` (usar `external-blocker` — NÃO `bloqueio-externo`, que não existe como label; `bloqueio-externo` só aparece como valor textual do campo `motivo`/`status` do `plan.json` do overnight, não como label do GitHub).

## Fase 0 — Montar e triar a fila BLOQUEADA (filtro invertido)

0. **Resume** via `plan.json` se existe.
1. **Sync:** `git checkout master && git pull`; capturar `base_sha = git rev-parse HEAD`; **`gh auth status`**. **Log de startup do modelo/effort do coordenador (#3454, espelha #2993 do overnight):** logar no run-log o modelo/effort **CONFIGURADO** pelo frontmatter desta skill (`sonnet` / `high`) — não o auto-relatado —, pra tornar o pin verificável via `/diaria-log {AAMMDD}`:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent develop --level info \
     --message "coordinator_model" \
     --details '{"model": "sonnet", "effort": "high", "source": "skill_frontmatter"}'
   ```
2. **Herdar a triagem do overnight:** ler `data/overnight/{AAMMDD-recente}/plan.json` e extrair os `status: pulada` com motivo ∈ `{bloqueio-externo, not-this-week, ambigua}` — a triagem cara já foi feita (`source: inherited-overnight`). **Com `--bugs` (#3375)**: descartar aqui as issues herdadas sem label `bug` — não entram na tabela nem na classificação seguinte. **Com `--priority` (#3499)**: descartar também as issues herdadas cuja prioridade ∉ conjunto passado.
3. **Varredura fresca de confirmação** por labels reais via `gh issue list --json labels` + reconciliar; **fresh-scan vence o plan.json herdado em divergência**. Mesmo filtro `--bugs` se aplica ao resultado fresco. Mesmo filtro `--priority` se aplica ao resultado fresco.
4. **Classificar** cada bloqueio em A–E.
5. **Imprimir a tabela** do backlog bloqueado, agrupada por categoria, ordenada P0>P1>P2>P3: `#NNNN | P? | cat A-E | o-que-falta-destravar | título`.
6. Aplicar `--issues`/`--only`/`--bugs`/`--priority`.
7. Gravar `plan.json`; com `--dry-run`, **parar aqui**.

## Fase 0.5 — Briefing FRONT-LOADED (colher o máximo de decisões no início, #2966)

O objetivo é **minimizar interrupções durante a sessão**: coletar na abertura TUDO que não depende de runtime, deixando só o genuinamente-adiável pra mid-sessão. Aproxima o "tudo no início" do overnight, mas SEM a Regra 1 — o develop ainda PODE perguntar depois, só que raramente PRECISA.

Montar o briefing em **múltiplas chamadas `AskUserQuestion` sequenciais** (o cap é 4 perguntas × 4 opções por chamada — front-loadar N decisões exige várias chamadas, agrupadas por categoria). Coletar, nesta ordem:

1. **Ordem de ataque** (`attack_order`) — (a) por prioridade; (b) por categoria; (c) só as destraváveis agora. **Default sugerido: C e A primeiro** (mais baratos), depois E, B (depende de terceiro), e **D por último**.
2. **Todas as decisões cat. C** (produto/editorial) — são decisões PURAS (não dependem de ver o código), então batchar TODAS agora, não uma a uma na Fase 1. Cada resposta → comentário durável na issue (a decisão postada É a evidência, #573) + `unblock_status: desbloqueada-validada` no `plan.json`.
3. **Todas as credenciais cat. A** — pedir o editor colar TODOS os tokens de uma vez (pro `.env.local`), validar cada um deterministicamente (#573: `publish-*.ts --dry-run`) ali mesmo. Token que o editor não tem pronto ("preciso gerar") → SÓ essa issue defere pro mid-sessão; as demais seguem validadas.
4. **Todas as confirmações cat. B** — estado das contas de terceiro de uma vez; probe real por conta confirmada.
5. **Política de onda** (`wave_policy`) — UMA pergunta: "auto-compor + mergear as ondas seguras SEM te perguntar cada composição, ou aprovar onda a onda?". **Default sugerido: `auto`** (a onda é livre-de-colisão por construção e o Gate 2 é determinístico). `auto` → pula o Gate de Onda a sessão inteira.
6. **Política de pré-autorização cat. D** (`catD_preauth`) — UMA pergunta: "pra blast-radius, pré-aprovo a abordagem se o teste local + diff de amostra passarem, ou quero ver CADA Gate B?". **Default = `show_each`** (ver cada Gate B) — a segurança do blast-radius NÃO se remove em silêncio; front-load aqui é OPÇÃO explícita, nunca o default.

Gravar tudo em `plan.json` (`attack_order`, `wave_policy`, `catD_preauth`, e por issue `unblock_status`/`unblock_evidence`). **Regra de resume:** nada coletado no briefing é re-perguntado.

**O que NÃO dá pra front-load** (fica mid-sessão, vira exceção — não o fluxo normal): Gate B cat. D quando `catD_preauth = show_each`; ambiguidade imprevista que só aparece implementando; falha de MCP (#738); input que o editor não tem pronto no briefing. Com o front-load, a maioria das sessões não para em nenhum desses.

## Fase 1 — Desbloquear → validar → implementar em ondas paralelas seguras

A maioria dos desbloqueios já foi **coletada no briefing FRONT-LOADED** (Fase 0.5, #2966): a Fase 1 processa as issues `desbloqueada-validada` direto na implementação, e só usa o **Gate 1 pro RESÍDUO** — o que não deu pra front-load (token que o editor foi gerar, ambiguidade imprevista). O Gate 1 remanescente é serial mas **agrupa desbloqueios da mesma categoria numa única `AskUserQuestion`** (até 4 perguntas). À medida que issues ficam **desbloqueadas+validadas**, entram numa fila de implementação trabalhada em **ondas paralelas seguras**. **No início de cada iteração, reler `plan.json`.**

1. **Diagnosticar** e formular o pedido de desbloqueio **exato e acionável** (ex: "cole o valor de `INSTAGRAM_ACCESS_TOKEN` gerado em Meta Business > Apps > diar.ia > Tokens").
2. **Gate 1 — desbloqueio** (`AskUserQuestion`, formato por categoria) — toda opção inclui sempre "não consigo destravar agora (documentar e pular)".
3. **Validar deterministicamente (#573)** — nunca pela palavra do editor (ver tabela A–E).
4. **Compor a onda:** quando há ≥1 issue validada pendente, rodar a análise de cluster de conflito (mapear arquivos por issue via grep no corpo + símbolos citados — puro lookup, sem escrita de código) → **Gate de Onda** (editor aprova a composição — **pulado se `wave_policy = auto`**, #2966; a onda é livre-de-colisão por construção) → **fan-out de até 6 implementadores concorrentes** (um worktree por unidade; branch `develop/fix-NNNN` solo, ou `develop/blast-NNNN` p/ cat. D — sempre solo). Cada PR passa pelo **Gate 2 determinístico** (#2210/#2222) e mergeia independentemente. **Fila grande (>8 issues validadas na onda, #2754):** a análise de cluster de conflito pode ser delegada a um subagente `general-purpose` com `model: haiku` explícito (não `sonnet` — aqui é puro grep/leitura, sem julgamento de implementação; latência menor sem perda de qualidade) em vez do coordenador rodar serialmente — só essa etapa de mapeamento, nunca a implementação em si (que continua sempre `sonnet`, #2019).
5. Atualizar `plan.json` + `scripts/log-event.ts`; `git pull` após cada merge. Issue não destravável na sessão → comentário durável (com dedup) explicando o que falta, status `pulada` motivo `nao-destravavel-na-sessao` (degradação elegante para o skip do overnight, mas só após ter tentado destravar ao vivo).

   **Instrumentação de token da rodada (#3454 Rec 1) — pré-requisito de qualquer corte futuro no develop:** não existe dataset real de develop com as 3 métricas que permitiram a análise do overnight (#3327). Ao **fim de cada unidade despachada** (issue solo ou onda), emitir um evento `subagent_metrics` no run-log com as mesmas 3 colunas — `duration_ms` sai de graça do `timeline` do `plan.json` (`merged`/`draft`/`pulada` menos `dispatch`); `subagent_tokens` e `tool_uses` vêm do retorno de cada `Agent` **se o harness os expuser por invocação** (caso não, gravar `null` com `source: "unavailable"`):
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent develop --level info \
     --message "subagent_metrics" \
     --details '{"unidade": "#NNNN | onda {id}", "issues": [123], "subagent_tokens": N, "tool_uses": N, "duration_ms": N, "source": "harness_usage | unavailable"}'
   ```
   Análogo ao `coordinator_tokens_estimate` do overnight (#3453 Rec 1), emitir também um `coordinator_tokens_estimate` ao fim de cada onda + no relatório (mesma forma: `{"phase": "onda {id} | fase_1_5 | fase_2", "tokens": N, "source": "harness_usage | context_size_proxy | unavailable"}`). Risco nenhum (só observabilidade); transforma a Seção 3 da análise #3328 de "leitura de código + analogia" em "medido".

## Gates

**Quatro gates** — a separação limpa é o que torna seguro inverter a Regra 1 e paralelizar: **humano no Gate 1 e no Gate de Onda; máquina sozinha no Gate 2.**

- **GATE 1 — DESBLOQUEIO** (humano, `AskUserQuestion`, permitido por design). Órgão central da skill. Decisões de produto/editorial (cat. C/E) **viram comentário durável na issue** — `plan.json` é só cache.
- **GATE DE ONDA — COMPOSIÇÃO PARALELA** (humano, antes do fan-out). Apresenta clusters + singletons + o que serializa; editor aprova a onda. **Pulável com `--serial` OU `wave_policy = auto`** (escolhido no briefing, #2966 — a onda é livre-de-colisão por construção, então auto-compor é seguro).
- **GATE 2 — IMPLEMENTAÇÃO/MERGE** (determinístico, sem humano, por PR): gate de 2 condições do overnight (#2210/#2222 — `gh pr checks` bucket≠pass == 0 **E** threads não-resolvidas excluindo FORBIDDEN == 0, ambos via `gh api graphql --jq`), em chamada separada do `gh pr merge`, + verify #573.
- **GATE B — PRÉ-APLICAÇÃO** (só cat. D): entre validar e aplicar em escala. Mostra diff-walkthrough (contagem por tipo de mudança + 1 site exemplo antes/depois + resultado do teste local) e pede confirmação explícita ("vai tocar ~N sites; testei local: {resultado}. Aplico no conjunto inteiro? s/n/subconjunto"). **Obrigatório por default (`catD_preauth = show_each`); opt-out por sessão via `catD_preauth = preapproved`** (escolhido no briefing, #2966) — aí o coordenador só aplica se o teste local + diff de amostra passarem, sem parar. O default NUNCA é pré-aprovado: a segurança do blast-radius não se remove em silêncio.

**Fallback de ausência:** `AskUserQuestion` é bloqueante; se o editor sair no meio, a issue corrente vira `pulada` motivo `decisao-adiada`, `resume_state` é gravado e a sessão **para limpa — nunca continua autônoma**. Todo gate de desbloqueio inclui "decido depois / pular".

## Fase 1.5 — Code-review consolidado (opcional, mais leve)

Roda só se houve ≥1 merge e o diff `{base_sha}..HEAD` > ~50 linhas. Um `/code-review` sem `--comment`; crítico-em-produção confirmado deterministicamente (`gh run list --branch master --limit 1`, #573) → hotfix imediato; demais → issues via `scripts/lib/auto-reporter-dedup.ts` (dedup, labels tipo + prioridade obrigatória) com label extra **`session-finding`** (label compartilhada entre overnight e develop, #2636) e corpo citando o PR de origem. **Sem a cadeia depth-2 do overnight** — se o editor quer atacar um finding na hora, ele vira a próxima issue da Fase 1. Fail-soft #738.

> **Label `session-finding`:** label compartilhada entre `/diaria-overnight` e `/diaria-develop` (renomeada de `overnight-finding`, #2636). Ambas as skills filam os findings do code-review consolidado com ela.

## Fase 2 — Relatório + handoff para o overnight

Com `--bugs` (#3375) ativo, abrir o digest com `Modo: --bugs (só issues com label bug)`. Com `--priority` (#3499) ativo, adicionar (ou combinar na mesma linha, se `--bugs` também ativo) `Modo: --priority {lista} (só issues com label de prioridade ∈ {lista})` — inclui a contagem de issues excluídas por não baterem a prioridade. Digest de `plan.json` + run-log (filtrado por `agent: "develop"` + AAMMDD) em 4 buckets: (a) destravadas e mergeadas (agrupadas por onda); (b) destravadas mas pendentes (`--no-implement` ou CI vermelho — **prontas p/ o próximo overnight pegar como `elegivel`**); (c) não-destraváveis na sessão; (d) findings/hotfixes. **Seção de HANDOFF:** quais issues saíram de bloqueada→elegível (label removido + decisão postada) e quais ações fora da sessão o editor ainda precisa agendar. **Linha de coordenador + custo (#3454):** `Coordenador: sonnet / high` (valores CONFIGURADOS no frontmatter, ver evento `coordinator_model` da Fase 0); se houver eventos `subagent_metrics`/`coordinator_tokens_estimate` no run-log, resumir numa tabela `unidade | subagent_tokens | tool_uses | duração` + total, com a ressalva `fonte: unavailable` quando o harness não expuser os tokens — é o primeiro dataset real de develop pra fechar a lacuna da análise #3328. Timeline via `npx tsx scripts/render-overnight-timeline.ts --plan data/develop/{AAMMDD}/plan.json --title "Timeline da sessão" --total-label "Total da sessão"`.

Salvar o digest completo em `data/develop/{AAMMDD}/report.md` (mesma convenção do overnight, `data/overnight/{AAMMDD}/report.md`). **Registrar na superfície de Relatórios do Studio (#3714, decisão do editor 260720 — substitui o antigo draft de Gmail, não soma a ele):**
```bash
npx tsx scripts/register-report.ts --kind develop --id {AAMMDD} \
  --title "Diar.ia develop {AAMMDD} — {N} destravadas/mergeadas" \
  --html-path data/develop/{AAMMDD}/report.md
```
File-based (só escreve `data/reports/index.jsonl`) — nunca depende do `npm run studio` estar no ar; o comando imprime a URL em stdout, capturar pro resumo do terminal. **Não criar mais draft via `create_draft` aqui.** Canal primário = terminal, incluindo a linha `Relatório: {URL do Studio}`; fail-soft #738 — falha do registro (raro, é só escrita local) nunca trava a sessão, só avisa que o relatório ficou local.

## Guard de colisão editorial — aviso interativo, sem auto-preempt

Ao detectar edição em curso (`scripts/lib/find-current-edition.ts` retorna candidato ou `data/editions/` de hoje/amanhã ganhou arquivos novos), a skill **avisa o editor e pergunta** ("uma edição de hoje/amanhã está em curso — encerrar a sessão develop para liberar a pipeline editorial? s/n"). **Diferente do overnight, develop NÃO grava `preempted_*` nem auto-encerra** — como é supervisionado e nunca continua sem editor, a decisão é humana ao vivo. Se o editor não responde, o `AskUserQuestion` fica bloqueante, `resume_state` é gravado e a sessão para limpa.

## `plan.json` (`data/develop/{AAMMDD}/`, gitignored)

Reusa o schema do overnight + campos próprios de desbloqueio: `block_category` (A–E), `block_label` (literal real), `what_unblocks`, `unblock_status` (`pendente`|`desbloqueada-validada`|`nao-destravavel-na-sessao`), `unblock_evidence` (dry-run exit 0 / comentário #link / probe API ok — **NUNCA o valor do secret**), `editor_input_received` (bool/hash, nunca o secret), `source` (`inherited-overnight`|`fresh-scan`|`manual-issues-arg`), `wave` (id da onda paralela). **Políticas de sessão do briefing front-loaded (#2966):** `attack_order` (ordem escolhida), `wave_policy` (`auto`|`per_wave`, default `auto`), `catD_preauth` (`show_each`|`preapproved`, default `show_each`) — gravadas na Fase 0.5 e relidas em todas as fases; nunca re-perguntadas em resume. **Regra crítica de resume:** nunca re-perguntar um desbloqueio já validado (`unblock_status: desbloqueada-validada` + `status: pendente` → retomar direto na implementação) nem uma política já escolhida. **Segurança:** o plan.json nunca armazena o valor de um token. Develop **não** grava `preempted_*`.

**`machine_id` (#3033).** `data/` é um junction do OneDrive sincronizado entre máquinas — o `plan.json` desta sessão fica visível pra QUALQUER outra máquina no mesmo OneDrive, e vice-versa. Ao criar/gravar `plan.json` (Fase 0, Passo 7, e todo re-write subsequente), incluir o campo `machine_id` no nível raiz com o output de `npx tsx scripts/lib/machine-id.ts` (hostname desta máquina). Sem esse campo, a statusLine de outra máquina no mesmo OneDrive pode confundir o progresso desta sessão com o dela (`isForeignDevelopPlan` em `scripts/overnight-statusline.ts` filtra por esse campo; ausente = tratado como legado, não filtrado). Gravar 1x por sessão é suficiente (hostname não muda no meio de uma sessão) — não precisa reconsultar a cada write, mas preservar o campo em todo re-write do arquivo.

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
