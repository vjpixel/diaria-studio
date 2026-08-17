---
name: diaria-develop
description: Sessão de desenvolvimento SUPERVISIONADA. Por padrão (#4319) trabalha o backlog aberto INTEIRO em 4 ondas priorizadas (bugs → bloqueadas → P0/P1 → resto) até nenhuma issue estar aberta; `goal_policy=blocked_only` volta ao escopo original (#2636/#4297) de só o backlog BLOQUEADO. O editor está presente e desbloqueia em tempo real (cola token, confirma conta, decide trade-off, autoriza blast-radius); a skill valida o desbloqueio deterministicamente (#573) e leva a issue ao merge reusando a maquinaria do overnight, PARALELIZANDO tudo que for seguro (issues que colidem em arquivo viram 1 PR só). Uso — `/diaria-develop [AAMMDD] [--issues N,M] [--only A-E] [--bugs] [--priority P0,P1,P2,P3] [--dry-run] [--no-implement] [--serial]`.
disable-model-invocation: true
model: sonnet
effort: high
---

# /diaria-develop

Sessão de desenvolvimento **supervisionada/interativa**. Historicamente focada só nas issues **COM BLOQUEIO** — exatamente as que o `/diaria-overnight` pula — mas desde #4319 o escopo **default** é o backlog aberto inteiro, trabalhado em 4 ondas priorizadas (ver "Goal de esgotamento" abaixo). O que não muda: como o editor está presente, ele desbloqueia ao vivo (cola um token, confirma que criou uma conta de terceiro, decide um trade-off de produto/editorial, ou autoriza uma mudança de alto blast-radius); a skill **valida o desbloqueio deterministicamente (#573)** e leva a issue até o merge **reusando a maquinaria de implementação do overnight**, com uma diferença central: **paraleliza tudo que for seguro** (inverte o #636 — ver seção de Paralelização).

**Por padrão (#4319, `goal_policy=exhaust_all`), a sessão trabalha até nenhuma issue estar aberta** — todo o backlog, não só o bloqueado, em 4 ondas priorizadas: bugs (bloqueados ou não) → bloqueadas restantes → elegíveis P0/P1 → o resto. `goal_policy=blocked_only` volta ao alvo estreito de #2636/#4297 (só o backlog bloqueado). Não é uma garantia incondicional: o Fallback de ausência (editor sai no meio), uma **interrupção do editor no gate do grupo 3** (default auto-entra desde #5321 — deixou de ser obrigatório, mas o editor ainda pode intervir ali) e o guard de colisão editorial continuam podendo encerrar a sessão com o alvo não esgotado — nesse caso o Goal fica registrado como não atingido, não bloqueia o encerramento. **Os caps mecânicos de re-varredura e de profundidade de finding foram eliminados no develop (#4319)** — quem segura a sessão agora é só o editor, pelos gates bloqueantes (Gate 1, Gate de Onda) ou saindo; ver "Goal de esgotamento" pra definição exata do que conta como alvo, como terminal, e por que os caps saíram. `goal_policy = table_only` no briefing (ou `--no-implement`, que força o mesmo comportamento) volta ao comportamento pré-#4297 (fecha quando a tabela da Fase 0 acaba, sem re-varredura).

**Relação com o `/diaria-overnight` (#2021, reenquadrada em #4319):** com `exhaust_all`, o develop deixa de ser o *complemento* do overnight em escopo — vira um **superconjunto em escopo, mas não em modo**: ataca as mesmas issues que o overnight atacaria (e mais as bloqueadas que ele não pode), só que com o editor presente e com permissão de perguntar. O overnight continua sendo o único que roda desassistido; é essa diferença de modo, não de escopo, que faz cada skill existir. Esta skill só roda por invocação explícita do editor (`disable-model-invocation: true`) — o blast radius (merges autônomos em master + aplicação de mudanças de alto impacto) exige que a invocação seja o consentimento, mesmo padrão de `/diaria-overnight` e `/diaria-remover-votos-pixel`.

**Modelo/effort do coordenador (#3454).** O frontmatter fixa `model: sonnet` + `effort: high` — mesmo pin do `/diaria-overnight` (#3453). Antes do #3454 o develop **não pinava nada** e o coordenador herdava o modelo/effort ambiente da sessão interativa do editor (potencialmente Opus/effort alto durante as fases mecânicas Fase 1/1.5, que não exigem isso), sem decisão registrada — a análise `docs/develop-token-analysis-3328.md` §3.2 identificou isso como a única lacuna estrutural real da skill. Decisão do editor (#3454): pinar `sonnet` + `high`, igual ao overnight — as decisões de julgamento ao vivo (cat. C/D/E) já passam por gates humanos explícitos (Gate 1, Gate de Onda, Gate B), então effort `high` basta pra mediação; previsibilidade de custo + consistência com o overnight valem mais que rodar mais forte nas fases mecânicas. Mesma limitação de escopo-de-turno do overnight (o override de frontmatter vale pelo turno atual; se o editor digitar uma mensagem livre mid-sessão, a sessão volta ao modelo/effort anteriores a partir daquele ponto — esperado, não bug). `--serial` e os gates humanos não mudam com o pin.

**Premissa de transporte:** assume `gh` CLI presente, igual ao overnight — toda a maquinaria reusada (`gh issue list`, `gh pr create`, `gh pr checks --watch`, `gh pr merge --squash`, `gh api graphql --jq` para o gate de threads, `gh run view --log-failed`) é construída sobre `gh`. A Fase 0 roda `gh auth status`.

## Como difere de /diaria-overnight

| Eixo | /diaria-overnight | /diaria-develop |
|---|---|---|
| **Escopo (default #4319)** | fila DESBLOQUEADA | backlog aberto **inteiro**, em 4 ondas priorizadas (`exhaust_all`); `blocked_only` restringe à fila bloqueada (#2636/#4297) |
| **Regra 1** | `AskUserQuestion` PROIBIDO pós-briefing (não pode depender de presença) | perguntar é **permitido** — mas o briefing FRONT-LOADED (Fase 0.5, #2966) colhe o máximo no início pra **minimizar** interrupções; só o genuinamente-adiável fica mid-sessão |
| **Paralelização** | #636 estrito: 1 PR não-draft por vez | **paraleliza tudo que for seguro**; issues que colidem em arquivo **fundem numa unidade só** (1 PR, `Closes` múltiplo) em vez de serializar em ondas (#4319) — teto de 6 worktrees |
| **Blast-radius** | recusa alto blast-radius não-supervisionado | **aceita**, atrás de um Gate B de pré-aplicação |
| **Caps de terminação (#4319, #5272)** | só `findings_depth` 2 — o cap de re-varredura (`rescans_done` K=2) saiu também do overnight em #5272; lá a parada agora vem do anti-livelock + guard de colisão editorial, sem nenhum teto de relógio (decisão do editor, 260814) | **eliminados os dois** — o editor (Gate 1, Gate de Onda, interrupção no gate do grupo 3, ou Fallback de ausência) é quem segura a sessão |

**Viés de autoria própria e PR alheio (#5484) valem aqui também, não só no overnight.** `context/overnight-dispatch-rules.md` item 16 é critério do coordenador, não do subagente — o próprio coordenador desta skill lê e aplica: issue escrita pela própria sessão overnight/develop/continuo (inclusive herdada do `plan.json` do overnight, passo 2 da Fase 0) nunca vira cat. C "precisa mais contexto" sem bater literalmente um dos 4 critérios de "Perguntar é exceção"; e um PR alheio já aberto pra uma issue da fila só é razão pra não implementar de forma independente se passar as 3 perguntas do checklist (autor conhecido? CI rodando/verde? atualizado nas últimas ~24-48h?) — falhando qualquer uma, tratar como se o PR não existisse.

**Reuso verbatim do overnight (Fase 1 de implementação):** o prompt de cada subagente implementador **cita `context/overnight-dispatch-rules.md`** (checklist canônico compartilhado com o overnight, #3453 Rec 4 / #3454 Rec 2 — guard de publicação, convenção de branch, bootstrap, disciplina de testes #2959, #633, `no-regression-test`, self-review #2038) em vez de reproduzir o texto completo das regras, encurtando o prompt de dispatch do coordenador. Subagente `general-purpose` com `isolation: worktree` e `model: sonnet` explícito (#2019) → `npm ci` → **`npx tsc --noEmit` → testes afetados/novos** (`npx tsx --test test/<arquivo-tocado>.test.ts test/lib-boundary.test.ts` — **NUNCA a suíte completa `npm test` local, #2959**: o CI já roda a suíte inteira como gate autoritativo antes do merge, e repeti-la no worktree (~11k testes/~3min) é justamente o comando que dispara o auto-background do harness, travando o subagente num Monitor-loop sem retornar — padrão observado em 100% dos subagentes das rodadas 260703+260704) (#2754 — typecheck local explícito antes do push, não só os testes: o CI roda `npm run typecheck` como primeiro passo do job `test`, antes até de rodar os testes; pular isso local significa descobrir erro de tipo só depois de um round-trip inteiro de CI, o gargalo real de latência quando velocidade importa mais que tokens) → branch → PR `Closes #NNNN` → self-review (#2038) → fixer 2-agentes → resolução de threads com carve-out FORBIDDEN → **fleet review pré-merge explícito pelo coordenador (#4383, ver Gates — NÃO é reuso verbatim, ver nota abaixo)** → **gate determinístico de 2 condições (#2210/#2222)** → squash-merge → verify #573; #633 (bugfix exige teste de regressão); retry GitHub 401/429 com backoff; guard de publicação no prompt do subagente; #738 fail-fast de MCP; `plan.json` como fonte de verdade pós-compaction; timeline via `scripts/render-overnight-timeline.ts` (helper fluxo-neutro `renderTimeline`, #2637 — passar `--title "Timeline da sessão" --total-label "Total da sessão"`).

**Exceção ao "verbatim" — fleet review pré-merge (#4383):** todo o resto deste parágrafo É reuso verbatim do overnight, mas o passo de fleet review não pode ser, e a razão é mecânica, não estilística. `.claude/hooks/pr-create-review.mjs` (`resolveEffort`) só concede o desconto `low` (1 agente) a duas condições: prefixo de branch `overnight/*`, ou marker de sessão overnight ativa nesta máquina (`isOvernightRoundActive`) — nenhuma das duas nunca é verdadeira aqui, porque toda unidade do develop nasce em `develop/fix-*`/`develop/blast-*` (nunca `overnight/*`) e o develop não grava esse marker (só o overnight grava/remove o seu). Logo, todo PR desta skill resolve `max` (fleet de 5 agentes) no hook — nunca `low`. O overnight resolve `low` (1 agente) por construção, e sua Fase 1.5 (revisão consolidada, 1 agente, ao fim da rodada inteira) entrega exatamente esse 1 agente por PR em média — **paridade exata** com o que o hook teria dado se tivesse disparado. Copiar esse mesmo desenho pro develop (que foi o que aconteceu até aqui) quebra essa paridade: a Fase 1.5 do develop também é 1 agente só, mas cada PR individual tinha direito a 5. Como o subagente implementador não pode dispatchar Agent (#207 — mesma razão da regra 8 do checklist), ninguém nunca executava o fleet de verdade por PR — só o self-review + fixer (que endereça os achados do PRÓPRIO subagente, não de um revisor externo) e, no fim da sessão inteira, 1 agente consolidado. Achado #4383: de 17 PRs que resolveram `max` no hook num período analisado, só 9 (~53%) receberam de fato o fleet de 5 agentes — o resto (majoritariamente PRs de subagente do develop) parou no self-review. O passo explícito abaixo (ver Gates, "REVIEW DE FLEET PRÉ-MERGE") fecha essa lacuna determinísticamente, sem depender do hook disparar nem de iniciativa ad-hoc do coordenador.

## Argumentos

- **`AAMMDD` (opcional)** — data-rótulo da sessão (nomeia `data/develop/{AAMMDD}/plan.json`). **Não é data de edição** (nenhum stage editorial destrutivo depende dela; a regra D+1 não se aplica). O default de hoje é seguro, mas a skill **confirma** ("sessão develop de hoje, {AAMMDD}? s/n") em vez de inferir em silêncio. Fixar no `plan.json` e reler dele (a sessão pode cruzar meia-noite).
- **`--issues N,M,…`** — restringe a issues específicas, pulando a varredura. Issue não bloqueada (trabalho de overnight) → permitir-com-aviso.
- **`--only A,B,C,D,E`** — restringe por categoria de bloqueio (minimiza a troca de contexto do editor).
- **`--bugs`** (#3375) — restringe a sessão a issues bloqueadas com label `bug`; `enhancement`/`documentation`/cleanup/etc. ficam fora mesmo que desbloqueáveis por todos os outros critérios. Compõe com `--issues`/`--only` (ex: `--bugs --only A,B` = só bugs bloqueados por credencial ou conta externa). Aplica-se na varredura (Fase 0 passo 2/3) e na herança de triagem do overnight (passo 2) — issue herdada sem label `bug` não entra na tabela. Sem a flag, comportamento atual sem mudança.
- **`--priority [P0,P1,P2,P3]`** (#3499, aceita lista) — restringe a sessão a issues bloqueadas cujo label de prioridade ∈ conjunto passado (ex: `--priority P2` ou `--priority P0,P1`); as demais ficam fora de escopo mesmo que desbloqueáveis por todos os outros critérios — não são "puladas por bloqueio", simplesmente não entram, mesmo tratamento do `--bugs`. Compõe com `--issues`/`--only`/`--bugs` (ex: `--only A,B --priority P0,P1` = só cat. A/B com prioridade P0 ou P1; `--bugs --priority P2` = só bugs P2). Aplica-se na varredura (Fase 0 passo 2/3) e na herança de triagem do overnight (passo 2) — issue herdada cuja prioridade ∉ conjunto passado não entra na tabela. Sem a flag, comportamento atual sem mudança.
- **`--dry-run`** — só Fase 0 (varredura + classificação + tabela), zero side-effect.
- **`--no-implement`** — modo "só destravar": gate de desbloqueio + validação + registro durável, **sem** implementar (deixa pro overnight posterior, que então vê as issues como `elegivel`). Goal (#4297) não é avaliável neste modo — ver "Incompatibilidade estrutural com `--no-implement`" na seção "Goal de esgotamento".
- **`--serial`** — desliga a paralelização (volta ao 1-PR-por-vez do overnight). Default é **paralelo seguro**.
- **`--attack-order {a|b|c}`** (#4498) — sobrescreve o default `so_destravaveis_agora` (c) sem passar pelo briefing (a = por prioridade; b = por categoria; c = só as destraváveis agora). Só necessário quando o editor quer uma ordem diferente do default nesta sessão especificamente — a Fase 0.5 não pergunta mais isso por padrão (ver item 1).

## Paralelização segura no desenvolvimento (inverte o #636)

Diferente do overnight (serial por #636 — sem supervisão, paralelo elevaria o blast-radius), aqui a supervisão humana torna o paralelo seguro. **"Seguro" = sem colisão de arquivo entre PRs diferentes**, via análise de **cluster de conflito**:

1. Para cada issue **desbloqueada+validada** (dentro do tier corrente, ver "Goal de esgotamento"), mapear o conjunto de arquivos que toca (corpo da issue + grep dos paths/símbolos citados).
2. Issues cujos conjuntos de arquivos se **intersectam** formam um **cluster** → **fundem numa única unidade** (#4319 — decisão do editor, inverte o comportamento pré-#4319 de serializar em ondas separadas): um worktree, um branch, um subagente implementador, **um PR só**, com `Closes #N` explícito pra CADA issue do cluster no corpo do PR. Issues cujo conjunto de arquivos não intersecta ninguém são **singletons** — cada uma vira sua própria unidade.
3. **Onda paralela = 1 unidade por cluster fundido + todos os singletons**, todas simultâneas (não há mais "próxima onda" por causa de colisão — colisão deixou de ser motivo pra adiar).
4. Cada unidade roda num **worktree isolado próprio** (`isolation: worktree`) com seu subagente implementador **concorrente**.
5. **Teto de concorrência = 6 worktrees simultâneos** (revisado de 4 em #2754 — develop otimiza velocidade, não tokens; 6 ≈ `cores - 2` desta máquina, cada worktree é majoritariamente I/O-bound (chamadas de API, git, npm), então o teto real costuma ser rede/API antes de CPU. `--serial` desliga; a fusão de clusters **reduz o número de unidades a rodar**, então o teto aperta menos do que antes; se a máquina engasgar em prática, baixar manualmente é seguro — não é um invariante de correção, só de throughput). **Teto é POR SESSÃO, não da máquina inteira (#5156 item 6)** — com uma sessão overnight (ou outra develop) rodando em paralelo na mesma máquina, a soma real de worktrees concorrentes pode passar de 6; `session-registry.ts list-active` expõe `active_worktrees` de cada sessão ativa pra essa decisão informar quantos abrir nesta onda (ver Fase 1 passo 4).

**Substitui o #636, não o afrouxa:** o invariante real é "nunca 2 PRs que colidem abertos ao mesmo tempo" — a fusão de clusters (#4319) satisfaz isso **por construção, eliminando o caso** em vez de resolvê-lo por serialização (o #636 fica mais satisfeito, não menos). Drafts de CI-vermelho não contam. Unidades cat. D (blast-radius) rodam **sempre solo** — nunca fundem com ninguém, mesmo colidindo em arquivo. A **Fase 1.5** (review consolidado) é a rede que enxerga interações entre unidades da mesma onda que não colidiram em arquivo mas colidem semanticamente.

**Efeitos práticos da fusão (#4319):**
- `Closes #N` por issue do cluster — nunca um `Closes` só cobrindo a issue "principal" e as demais como `Refs`; cada issue precisa fechar por si (checar `gh issue view --json state` pós-merge pra cada uma, não confiar no corpo da PR — padrão já registrado no #4203, `feedback-overnight-verify-issue-closed-after-merge`).
- **Revert é tudo-ou-nada** pras issues fundidas — reverter uma isoladamente do PR fundido já seria conflituoso de qualquer forma (elas tocam o mesmo arquivo por definição do cluster). Se uma decisão de reverter só uma parte aparecer, o PR fundido inteiro volta, e as demais issues do cluster reabrem pra próxima sessão.
- O editor **não** pediu agrupamento por tema/área sem colisão real de arquivo — só issues que genuinamente tocam o mesmo arquivo fundem. Não generalizar pra "issues parecidas".

## Categorias de bloqueio + protocolo de desbloqueio (editor faz X → coordenador faz Y)

| Cat | Bloqueio | Editor faz X | Coordenador faz Y | Validação #573 |
|---|---|---|---|---|
| **A** | credencial-runtime (ex: token Instagram/Threads) | cola o token/chave | grava em `.env` (gitignored; **se não existe num clone fresco, criar de `.env.example`**; atualizar `.env.example` com novas vars); implementa→PR→merge; remove `external-blocker` | `publish-*.ts --dry-run` exit 0 + resposta de API válida — **nunca** "válido" só por colar |
| **B** | conta-externa-de-terceiro (ex: Kit da Clarice) | confirma que a conta já existe; cola IDs/credenciais | se existe: probe real → implementa→PR→merge; se não: máximo offline (config/stubs/doc) + **aplica a label `external-blocker`** (`gh issue edit N --add-label external-blocker`, se ainda ausente — #5462/#5533: sem ela a Triagem do Studio não enxerga a issue como Bloqueada, mesmo racional do `trade-off-real` da cat. C abaixo) + comentário do estado parcial **e grava `plan.json` status `pulada` motivo `nao-destravavel-na-sessao`** (#4297 — conta ainda não existe é o exemplo canônico de "intrinsecamente irresolvível na sessão", ver "Goal de esgotamento"). **`on-hold` deixou de ser aplicado/removido automaticamente por este fluxo (#4498)** — issue com esse label é excluída do alvo inteiro no passo 5 da Fase 0 (nunca chega no Gate 1); se o editor quiser pausar indefinidamente uma issue cat. B sem conta ainda, aplica `on-hold` manualmente no GitHub, e remove quando quiser reativar | probe real contra a conta antes de declarar pronto |
| **C** | decisão-produto/editorial (ex: design system; UX trade-off) | escolhe o trade-off (`AskUserQuestion`) | **posta a decisão como comentário durável** na issue, remove a ambiguidade (→ elegível) — inclusive **removendo a label `trade-off-real`** se presente (`gh issue edit N --remove-label trade-off-real`, #5462: sem isso a issue fica presa em Develop na Triagem para sempre depois de já decidida) —, implementa a opção escolhida | a decisão postada como comentário **é** a evidência durável |
| **D** | supervisão-blast-radius (ex: refactor pervasivo / migração ~N sites; `not-this-week`) | autoriza no **Gate B** após ver o diff-walkthrough | implementa em branch, roda local primeiro, Gate B, só após "ok" aplica em escala; merge com confirmação humana | teste local + diff de amostra revisado antes da escala |
| **E** | plataforma-sem-fix (ex: CSP/plan-gated de plataforma) | decide workaround vs upgrade vs documentar | implementa workaround→PR→merge; OU "documentar" atualiza o doc, converte a issue p/ `elegível-documentada` (label removida — próximo overnight pega) **e grava `plan.json` status `pulada` motivo `nao-destravavel-na-sessao`** (#4297 — handoff pro overnight conta como terminal aqui, mesmo sem merge nesta sessão); OU "upgrade" confirmado → vira cat. A/B | estado de plataforma via `scripts/lib/publish-state.ts` antes de afirmar que o workaround funciona |

Categoria inferida na Fase 0 por **labels reais** (`external-blocker`→A/B/E conforme corpo; `kit-migration`→B; `not-this-week`→D; `beehiiv`→E) + corpo (token/chave→A; "criar conta"/"aguardando terceiro"→B; "decidir entre"/"OU"→C; "blast radius"/"~N sites"/"migração"→D; "CSP"/"plan-gated"/"API limit"→E). **`on-hold` não infere categoria nenhuma** (#4498) — issue com esse label é excluída do alvo inteiro no passo 5 da Fase 0, ANTES de chegar nesta classificação (ver "Excluir do alvo, em qualquer política"). **Antes de hardcodar qualquer label, rodar `gh label list`** e confirmar o conjunto real `{ external-blocker, on-hold, kit-migration, not-this-week, beehiiv }` (usar `external-blocker` — NÃO `bloqueio-externo`, que não existe como label; `bloqueio-externo` só aparece como valor textual do campo `motivo`/`status` do `plan.json` do overnight, não como label do GitHub).

**Antes de classificar como cat. C — decisão-produto (#5373):** se a issue tem a label `decisao-registrada` (ou mesmo sem ela, como rede de segurança), rodar `npx tsx scripts/lib/issue-decisions.ts --issue N` (`scripts/lib/issue-decisions.ts`). **Comparação concreta:** "última mudança observável" = o campo `updatedAt` já buscado na varredura do passo 3. Decisão encontrada com `decided_at` **posterior** a `updatedAt` → a issue **não** é cat. C — a decisão já existe, usar como contexto e classificar pela EXECUÇÃO restante (elegível se nada mais falta; cat. A/B/E se a execução esbarra em bloqueio novo distinto da decisão em si). Corpo/labels mudaram genuinamente depois de `decided_at` → decisão pode estar desatualizada, reavaliar como cat. C normalmente.

**Bloqueio de execução já registrado (#5373 item 5) — não reabrir cat. C nem reclassificar como o mesmo bloqueio de sempre.** O mesmo comando acima também devolve `execution_block` (via `latestExecutionBlockFor`). Issue com label `bloqueio-execucao` (ou sem ela, rede de segurança) cujo `execution_block.recorded_at` é **posterior ou igual** a `updatedAt` → a decisão já existe E o bloqueio de execução restante já está documentado: classificar direto na categoria A/B/E correspondente ao `motivo` registrado (sem nova pergunta, sem nova checagem de cat. C), usando `execution_block.motivo` como o "o-que-falta-destravar" da tabela do passo 7. Corpo/labels mudaram genuinamente depois de `recorded_at` → o bloqueio pode ter sido resolvido nesse meio-tempo, reavaliar normalmente (probe real antes de assumir que segue bloqueado).

**Registro do bloqueio de execução, quando distinto da decisão em si.** Ao tentar destravar uma issue no Gate 1 e a execução esbarrar num impedimento novo (acesso que esta sessão não tem, guard de publicação, feature gated por plano) — mesmo já com a decisão cat. C resolvida — gravar como comentário começando com o marcador de `formatExecutionBlockMarker` (`scripts/lib/issue-decisions.ts`, `{recorded_at, motivo, sessao: "develop"}`) seguido de prosa; `gh issue edit N --add-label bloqueio-execucao`; manter/gravar `unblock_status` refletindo o bloqueio real (não "decisão pendente"). Nunca re-perguntar a decisão já tomada.

**Nenhuma issue remanescente sem cat. A-E explícita (#5376, 15/08/2026 —
mesma classe de bug do `/diaria-continuo` e do overnight abaixo).** Toda
issue que a Fase 0 encontra no backlog bloqueado precisa sair com exatamente
UMA das 5 letras — nunca um rótulo genérico ("bloqueada"/"decisão pendente")
cobrindo issue que na verdade cabia em cat. A/B/E (bloqueio de credencial/
conta/plataforma) ou, pior, que já tinha caminho de execução claro no corpo
e devia ter sido tratada como elegível em vez de bloqueada. Reler o corpo
inteiro antes de rotular — o atalho de classificar pelo título/label sem
checar o corpo foi a causa raiz observada ao vivo no #5376. A tabela do
`plan.json` e a Fase 2 (buckets a-d) já preservam essa distinção por design;
o risco aqui é só a classificação inicial na Fase 0 ser feita por atalho.

**Issue com checklist/múltiplos itens: classificar item por item, não a
issue inteira (#5379, 15/08/2026)** — o mesmo atalho do parágrafo acima
reaparece um nível abaixo, *dentro* de uma issue com corpo em lista/
checklist: jogar a issue inteira numa única letra A-E quando só 1 item
depende do bloqueio e os demais já têm caminho de execução claro (achado
ao vivo: #4555 tinha decisão editorial — cat. C — embutida junto de uma
tarefa de prospecção fora do repo; #5237 tinha 4 dos 5 itens de checklist
codáveis já, com só o developer token — cat. A — bloqueando o 5º). Antes de
rotular como A-E uma issue com múltiplos itens: percorrer cada item
separadamente. Itens sem decisão/credencial pendente ficam **elegíveis**
(voltam pro dispatch normal, cat. A-E vira irrelevante pra eles) mesmo que
outro item da mesma issue permaneça bloqueado — dispatch parcial (unidade
cobrindo só os itens elegíveis + comentário registrando o(s) item(ns)
bloqueado(s) e sua letra) é o resultado esperado, não uma exceção. Antes de
fechar qualquer item como A-E, buscar no corpo por "a escolha é editorial",
"decidir", "qual"/"quanto"/"quando" em frase interrogativa, "trade-off" —
sinal de que aquele item é cat. C disfarçada de outra letra (heurística de
atenção, não substitui reler o corpo inteiro).

**Verificação de estado antes de classificar qualquer issue como bloqueada —
categoria A-E ou `local` (#5383, generalizado em #5392).** "Escopo grande,
scoping futuro" **não é uma 6ª categoria** — é sempre uma leitura que se
resolve na categoria A-E aplicável (tipicamente C, decisão-produto), nunca
um status paralelo. Nenhuma dessas classificações é automática a partir da
leitura fácil da issue — o #5383 original restringia a verificação só ao
caso "escopo grande, scoping futuro"; o #5392 achou o mesmo atalho em
qualquer classificação de bloqueio (achado concreto: #5255 classificada
`local` sem checar `docs/audience-source-notes.md`, que já tinha a decisão
completa registrada 2 dias antes da issue existir). Antes de aceitar
qualquer classificação de bloqueio pra uma issue — categoria A-E ou `local`
(inclusive quando a leitura inicial for "escopo grande demais") — rodar as
4 checagens abaixo:
1. `gh issue view N --json comments` — ler os comentários mais recentes
   **por inteiro**, não só o `body`. Procurar menção a PR já mergeado,
   unidade já dispatchada, ou progresso parcial registrado.
2. `git log --oneline --all --grep "#N"` — trabalho já mergeado costuma
   citar o número da issue no commit message mesmo quando o comentário na
   issue não foi lido a tempo.
3. Se algum comentário citar um doc de acompanhamento (`docs/*.md`), ler
   esse doc **inteiro** — a convenção deste repo é fechar cada rodada de
   trabalho com uma seção "estado após esta rodada"/"candidatas pra próxima
   rodada" já pronta (ex real: `docs/entity-page-candidates.md`).
4. **`grep -il {palavra-chave do título/tema} docs/*.md`** — buscar um doc
   relacionado ao ASSUNTO da issue, mesmo sem link em nenhum comentário (o
   #5255 nunca citou `docs/audience-source-notes.md`). CLAUDE.md já
   documenta esse padrão de doc como "registro de decisão que evita reabrir
   investigação já concluída" (`docs/seo-notes.md`, `docs/audience-source-
   notes.md`). Achou um doc relacionado → ler **por inteiro** antes de
   aceitar a classificação de bloqueio — ele pode conter a decisão que
   torna a issue não-bloqueada.

**Quando pular a checagem 4.** É barata o bastante pra rodar em toda
classificação de bloqueio (um `grep`, não um fleet de agentes) — o skip por
label é estreito, não vale a issue inteira: só pula quando o
`npx tsx scripts/lib/issue-decisions.ts --issue N` (parágrafo acima) confirma
que a decisão/bloqueio JÁ REGISTRADO cobre exatamente o motivo de bloqueio
sendo avaliado agora, não qualquer outro item/sub-pergunta da mesma issue.
Item isolado sem marker correspondente → roda a checagem 4 mesmo com a
issue tendo `decisao-registrada`/`bloqueio-execucao` de outro item.

Só se as 4 checagens não acharem nada (nenhum PR, nenhum comentário de
progresso, nenhum doc de acompanhamento, nenhum doc relacionado por assunto)
é legítimo classificar a issue na categoria de bloqueio aplicável (A-E,
tipicamente C decisão-produto; ou `local` — inclusive quando o motivo for
escopo grande demais pra esta rodada; postar a leitura como comentário
durável na issue). Caso contrário, o próximo passo
já está documentado — dispatchar essa fatia pequena nesta mesma onda (issue
vira elegível), ou, no mínimo, reportar o próximo passo concreto na tabela
do `plan.json` em vez de aceitar a leitura de bloqueio.

**Herdar classificação de rodada anterior do MESMO DIA não dispensa esta
verificação (#5586) — vale tanto pra classificação herdada do overnight
(Fase 0 passo 2 abaixo, "Herdar a triagem do overnight") quanto pra uma
classificação herdada de uma rodada `/diaria-develop` anterior do mesmo dia.** Chegar com o
status já decidido por outra sessão de horas antes não é uma via paralela que
escapa das 4 checagens — é o mesmo atalho ("a issue parece bloqueada") que
este bloco existe pra vetar, só que disfarçado de reaproveitamento. Antes de
aceitar qualquer classificação de bloqueio herdada (categoria A-E ou `local`),
rodar uma checagem ainda mais barata que as 4 acima (não é a 5ª delas, é um
pré-filtro específico pra herança): `gh issue view N --json labels` e
conferir se a **label** citada como motivo da classificação herdada **ainda
existe** na issue (comparação de 1 campo, não uma investigação completa —
cobre o caso de motivo por label; motivo registrado só em marcador de
comentário exige reler o comentário, checagem 1 acima). Motivo batendo →
aceitar a herança sem reabrir as 4 checagens. Motivo NÃO batendo (label
removida, nunca existiu de fato, ou o
corpo mudou desde a classificação original) → tratar a issue como se
estivesse sendo classificada agora pela primeira vez e rodar a verificação
completa das 4 checagens acima — nunca propagar a classificação stale pra
mais uma onda/rodada. Achado concreto (#5586, `/diaria-overnight` 260817c):
#5237 chegou marcada `bloqueada-externa: label external-blocker` por uma
rodada anterior do mesmo dia; a label não existia mais na issue (a checagem
de 1 campo já teria pego isso) e o corpo tinha 4 de 5 itens de checklist já
codáveis, só 1 preso a um developer token — mesmo padrão do #5379 acima, item
por item.

**Bloqueio descoberto MID-EXECUÇÃO (não na varredura da Fase 0): estrutural vs
ação-física-rápida-do-editor (#5440, 16/08/2026).** As categorias A-E acima
cobrem o bloqueio identificado na classificação inicial. Um segundo tipo
aparece só depois, no meio da tentativa de execução em si (ex: cat. B
"confirma que a conta existe" vira, na hora de mexer de fato na conta, um
2FA/CAPTCHA que a sessão não consegue passar sozinha) — e os dois exigem
tratamento diferente:

1. **Estrutural** (comportamento atual, mantido sem mudança) — o novo
   impedimento precisa de algo que a sessão genuinamente não tem e o editor
   presente também não resolve na hora: aguardar terceiro, feature gated por
   plano, acesso/conta que não existe. Sinal: resolver exigiria dias, uma
   ação de outra pessoa, ou uma decisão que nem o editor tem pronta agora.
   → documentar (marcador `formatExecutionBlockMarker`, `bloqueio-execucao`)
   e `pulada` motivo `nao-destravavel-na-sessao`, sem perguntar — pular
   direto é correto aqui, perguntar seria a mesma fricção que o #5321 já
   eliminou.
2. **Ação física de segundos que só o editor presente executa** (2FA,
   clique de confirmação numa tela que só ele vê, identificar qual das N
   contas/opções é a certa, resolver um CAPTCHA) — sinal: resolve em
   segundos com **1 ação física** do editor, sem precisar decidir nada nem
   esperar terceiro. A sessão develop pressupõe editor presente (diferente
   do overnight) — pular esse tipo sem perguntar mina a proposta de valor
   central da skill. **`AskUserQuestion` AO VIVO**, com a opção padrão
   "não consigo agora / documentar e pular" sempre disponível (mesmo padrão
   de toda opção de Gate 1) — só cai no caminho `pulada` acima se o editor
   escolher essa opção ou estiver ausente (Fallback de ausência).

Exemplos concretos do achado que motivou isto (sessão 260816b): remoção de
2º admin numa conta de Ads travada em reverificação 2FA (tipo 2 — o editor
confirma no próprio dispositivo em segundos); conta entre N opções que só o
editor reconhece pelo nome (tipo 2 — identificação, não decisão); CAPTCHA no
live chat de um fornecedor (tipo 2). Contraste: cat. B esperando o editor
**criar** uma conta nova em outro serviço é tipo 1 — não é uma ação de
segundos, é abrir/configurar algo que não existe ainda.

## Goal de esgotamento (#4297, expandido em #4319)

Por padrão, **a sessão só encerra quando nenhuma issue do conjunto-alvo está sem status terminal.** Duas metades precisam de definição precisa, senão a propriedade vira livelock — e desde #4319 o alvo default é o backlog aberto **inteiro**, não só o bloqueado.

### `goal_policy`: três valores, `exhaust_all` é o default (#4319)

Coletado na Fase 0.5 junto de `wave_policy`/`catD_preauth`.

| Valor | Alvo | Nota |
|---|---|---|
| **`exhaust_all`** | Backlog aberto inteiro, nas 4 ondas abaixo | **default desde #4319** |
| `blocked_only` | Só o backlog bloqueado (cat. A–E) | comportamento original de #2636/#4297, era chamado `exhaust` |
| `table_only` | Fecha quando a tabela da Fase 0 acaba, sem re-varredura | inalterado desde #4297 — pra janela de tempo curta |

Nunca re-perguntado em resume. **Migração de `plan.json` legado:** uma sessão retomada cujo `plan.json` foi gravado por uma sessão anterior a #4319 tem `goal.policy: "exhaust"` — ler esse valor como **`blocked_only`**, nunca como `exhaust_all`. Promover silenciosamente o escopo de uma sessão em resume mudaria o mandato dela no meio do caminho, exatamente o que o Fallback de ausência existe pra impedir. Uma sessão só ganha `exhaust_all` respondendo o briefing de novo (nova invocação) — nunca por herança de um `plan.json` antigo.

**Incompatibilidade estrutural com `--no-implement`:** nesse modo, TODA issue do escopo termina em `unblock_status: desbloqueada-validada` + `status: pendente` por desenho (implementação fica pro overnight seguinte) — nenhum terminal da subseção "'Nenhuma issue aberta' = estado terminal" é alcançável, porque implementar é justamente o passo que produz `mergeada`/`draft-ci-vermelho`. Por isso, **`--no-implement` força `goal_policy = table_only`** direto, sem perguntar — a Fase 2 reporta `Goal: não avaliado (--no-implement ativo)`, não "não atingido". A pergunta de `goal_policy` no briefing (item 7 da Fase 0.5, agora com 3 opções) é pulada quando `--no-implement` está ativo.

### Conjunto-alvo com `exhaust_all`: 4 ondas em ordem fixa

Ordem fixa — **um grupo só é montado depois que o anterior está esgotado**. Precedência: **`bug` ganha de tudo** (decisão do editor) — mantém cada issue numa onda só, nunca duas.

| Onda | Entra | Esgota antes de |
|---|---|---|
| **1a** | Toda issue com label `bug` — **bloqueada ou não, qualquer prioridade** | 1b ser montada |
| **1b** | Issues bloqueadas (cat. A–E, mesmo alvo de `blocked_only`) que **não** têm label `bug` | 2 ser montada |
| **2** | Elegíveis ao overnight (não-bloqueadas) com label `P0` ou `P1` | 3 ser montada |
| **3** | Demais issues abertas (P2, P3, sem label de prioridade) | — (grupo final, atrás do gate próprio) |

Um bug bloqueado vai pra **1a**, não pra 1b. Um bug P0 elegível vai pra **1a**, não pra 2. 1b fica só com bloqueado que não é bug.

**Com `goal_policy = blocked_only`:** só as ondas 1a (fatia bloqueada) e 1b existem — é literalmente o mesmo conjunto-alvo de #2636/#4297 (o complemento exato do overnight), montado como se fosse uma única onda sem a partição por tier. A tabela de origem do alvo bloqueado é a mesma de sempre:

| Entra no alvo bloqueado | Origem |
|---|---|
| `bloqueio-externo` (cat. A/B/E) | motivo do overnight + labels `external-blocker`/`kit-migration`/`beehiiv` |
| `ambigua` **quando trade-off-real** (cat. C) | escopo exclusivo do develop por decisão do #2640 |
| `not-this-week` (cat. D) | label homônima |
| `requer-sessao-local` | motivo herdado do overnight no passo 2 da Fase 0 (junto dos demais, #4297); sem categoria A–E — develop roda local, então é elegível aqui |

**Não entra no alvo em NENHUMA política** — não são bloqueio nem trabalho pendente, são outra coisa, e incluí-las faria o Goal nunca fechar:

- `fora-do-escopo` — motivo herdado do overnight pra o que não é trabalho de pipeline;
- `on-hold` (#4498) — "Pausada indefinidamente pelo editor — fora dos briefings até reativar" (semântica do próprio label no GitHub). Excluída do `target_set`/`tiers` inteiramente, em qualquer política — nunca entra no briefing, nunca gera pergunta de Gate 1 cat. B. Reativação é o editor remover a label no GitHub (fora da sessão); a próxima varredura já a vê elegível de novo;
- `not-this-week` como issue-inteira-excluída (distinto da linha da tabela acima, que é sobre o MOTIVO de bloqueio cat. D) — o label existe justamente pra dizer "não agora";
- `elegivel_especial` (EPIC deliberadamente deferido, #3072) — por desenho só fecha quando a issue-filha mergeia; nunca é despachado.

`sem-resposta` deixou de ser um motivo do develop (era artefato do CAP de re-scan, eliminado — ver "Re-varredura sem cap" abaixo).

### "Nenhuma issue aberta" = estado terminal, não "mergeada"

Parte do backlog é **intrinsecamente irresolvível na sessão** (cat. B esperando terceiro criar conta, cat. A com token que o editor ainda vai gerar). Um Goal literal de "todas mergeadas" nunca fecharia. Terminal aceitável (todos já existem nesta skill):

- `mergeada`
- `draft-ci-vermelho`
- `pulada` motivo `nao-destravavel-na-sessao` (Fase 1 passo 5 — exige comentário durável explicando o que falta, com dedup; cobre tanto bloqueio cat. A/B/E não resolvido quanto **implementação de issue elegível que falha sem nunca abrir PR/chegar ao CI** — subagente trava, `npm ci`/worktree falha, exceção não tratada. Uma issue elegível pula Gate 1 direto pra composição da onda, então esse é o ÚNICO caminho terminal disponível pra ela quando a implementação não converge; sem esse caminho o tier correspondente nunca esgotaria)
- `pulada` motivo `decisao-adiada` (editor saiu no meio)
- `entregue-fora-de-codigo` (#5441, 16/08/2026 — ver subseção própria abaixo)

O Goal força **encarar cada issue do alvo e classificá-la** — o que ele elimina é "a issue nem foi olhada porque não estava na tabela da Fase 0", não a exigência de resolver o irresolvível.

### Unidade concluída sem gerar PR (#5441, 16/08/2026)

As categorias A-E e os terminais acima assumem que "resolver a issue" termina
em código: PR mergeado, ou pulada por bloqueio real. Existe um terceiro
caminho que a skill não modelava — a unidade conclui integralmente por uma
ação puramente OPERACIONAL, fora do repositório (deploy manual de um Worker
já defasado, export de dado de um painel de terceiro, ajuste direto numa
configuração externa) e não gera diff nenhum pra revisar/mergear. Sem um
status pra isso, a issue ficava boiando aberta indefinidamente — o trabalho
já tinha sido feito e documentado no `plan.json`/relatório, mas nada no
fluxo a levava até `gh issue close`.

**Quando se aplica:** a unidade terminou (o efeito pretendido pela issue já
existe no mundo — Worker redeployado, CSV exportado, campo atualizado no
painel) e não existe/não faz sentido existir um PR pra fechar (não houve
mudança de código versionada neste repo, ou a mudança de código que houve já
foi mergeada antes e o que faltava era só a ação operacional em si).
**Não** se aplica quando ainda falta implementar algo codável — nesse caso a
issue continua em `pendente`/segue pro Gate 1 normalmente.

**Protocolo:** ao concluir uma unidade assim, o coordenador NÃO fecha a
issue sozinho — pergunta ao editor, **batchado** com as demais decisões da
mesma onda (mesmo padrão de agrupamento das perguntas cat. C na Fase 0.5:
uma única `AskUserQuestion` cobrindo todas as unidades `entregue-fora-de-
codigo` da onda corrente), se fecha agora ou mantém aberta por algum motivo
(ex: aguardando validação de resultado pelo editor). Opções: "fechar agora"
(`gh issue close` + comentário durável com a evidência da entrega — link do
deploy, nome do arquivo exportado, timestamp) ou "manter aberta" (fica
`entregue-fora-de-codigo` mesmo assim — é terminal PARA O GOAL da sessão,
independente da decisão de fechar; a sessão não trava esperando o editor
decidir sobre fechamento, só sobre o Gate 1 residual normal). Registrar no
`plan.json` por issue: `status: "entregue-fora-de-codigo"`,
`fora_de_codigo_evidencia` (o que foi feito, nunca um secret),
`fora_de_codigo_fechamento` (`"fechada"` | `"mantida-aberta: {motivo}"`).

### O Goal é relativo ao escopo da sessão

`--issues`, `--only`, `--bugs` (#3375) e `--priority` (#3499) restringem o conjunto-alvo — **as ondas são montadas depois desse filtro, não antes**. Uma sessão `--bugs` tem 1a populada e 1b/2/3 nascem vazias, e o Goal é atingido quando 1a esgota; uma sessão `--priority P2,P3` tem 1a/1b/2 vazias e o grupo 3 é a sessão inteira (ver o caso redundante do gate do grupo 3, abaixo). O Goal é avaliado **contra o alvo já filtrado**, nunca contra o backlog total do repositório — senão qualquer sessão `--bugs` ou `--priority P0` ficaria com Goal permanentemente inatingível. O relatório da Fase 2 sempre diz qual escopo está sendo avaliado: `Goal (escopo: --bugs --priority P0,P1): atingido`.

### Re-varredura sem cap (decisão do editor, #4319)

**O cap de 2 re-scans, que existia em #4297, foi eliminado no develop.** Ele contradiz "continue até nenhuma issue estar aberta": com o backlog inteiro como alvo, o cap estouraria já na onda 3, e toda sessão fecharia em `rescan-limit` sem nunca chegar ao grupo 3. O status `pulada` motivo `rescan-limit` **deixou de existir no develop**.

Dois momentos de re-varredura, ambos **sem cap**:

- **Re-checagem entre ondas** — roda **antes de montar cada onda**, sempre. Barata (`gh issue list`, sem `body`), reclassifica a fila: uma issue `bug` nova criada durante a sessão entra em 1a mesmo que a sessão já esteja na onda 3 — `current_tier` **volta** pra 1a nesse caso (não gera livelock porque status terminal nunca é re-escolhido).
- **Re-varredura de convergência** — roda quando **as 4 ondas** estão esgotadas, procurando novatas antes de declarar `reached`. Repete enquanto encontrar issue nova sem status terminal; para sozinha na primeira iteração sem novidade (caso comum).

`rescans_done` deixa de ser um cap e vira **contador puro de observabilidade** no develop (quantas re-varreduras a sessão fez, reportado na Fase 2) — nenhuma lógica ramifica nele. **O `/diaria-overnight` seguiu o mesmo caminho em #5272** — o cap K=2 saiu de lá também, e `rescans_done` é contador puro nas duas skills. Este parágrafo já afirmou o contrário ("a eliminação vale só pro develop; unificar quebraria o overnight"), e a premissa é que estava errada: o cap nunca foi a única garantia de terminação daquela skill — o anti-livelock é que faz a re-varredura convergir, e o guard de colisão editorial já preemptava a rodada. A rodada desassistida **não** ganhou nada no lugar do contador: um teto de relógio (09:00 BRT) chegou a entrar e foi retirado no mesmo dia por decisão do editor — lá o freio é a fila secar, e em dia sem edição não há limite de horário nenhum. A divergência que resta entre as duas skills é só a de `findings_depth` — ver o parágrafo seguinte.

### Findings deixam de ser uma classe especial (decisão do editor, #4319)

`findings_depth`, a cadeia de mini-rodadas numeradas e o tratamento diferenciado de issues `session-finding` **saem do develop** (ver Fase 1.5). Um finding gerado pela própria sessão vira issue como qualquer outra, classificado no tier dele pelas mesmas regras (label `bug` → 1a; `enhancement` P2/P3 → 3) — disputa a fila com o resto, sem porta de reentrada própria. `findings_depth` **permanece no `plan.json` como contador puro** (mesmo destino de `rescans_done`), sem ramificar lógica; a Fase 2 reporta a cadeia (gerados / consumidos pela própria sessão / profundidade alcançada) como substituto do cap.

**Consequência aceita:** ~80% dos findings já filados por sessões passadas têm label `bug` — com `bug` ganhando de tudo, a maioria cai direto em 1a, que não tem gate. Uma sessão pode ciclar em 1a (trabalha bug → Fase 1.5 revisa → gera bug-finding → volta pra 1a) sem passar por nenhum gate automático — **é o comportamento pedido**: bug encontrado em código recém-escrito é trabalho real, adiá-lo só transfere o custo. O que seguraria essa sessão não é mais um contador — é o editor, presente o tempo todo, podendo encerrar quando quiser. `/diaria-overnight` mantém `findings_depth` (cap 2) e o tratamento especial de `session-finding` inalterados: lá não tem editor, e é a cadeia de findings — não a re-varredura da fila — que se auto-alimenta, porque o review do código recém-escrito gera trabalho sobre esse mesmo código. **Este é o único cap que ainda diverge**; o de `rescans_done`, que dividia este parágrafo até #5272, saiu do overnight também.

### O que garante terminação sem os dois caps

1. **Anti-livelock, intacto**: issue com status terminal **nunca** é re-escolhida na mesma sessão — uma re-varredura só devolve trabalho se houver issue genuinamente nova.
2. **Gate 1 e Gate de Onda** — gates humanos bloqueantes intactos, Fallback de ausência intacto. **Gate do grupo 3** (ver seção própria abaixo) não entra mais nesta lista de bloqueio garantido desde #5321 — auto-entra por default; segura a sessão só se o editor intervier ali por iniciativa própria.
3. **O editor** — sessão supervisionada; pode encerrar a qualquer momento, com ou sem um gate no caminho.

Nenhum dos três é um contador — foi a escolha do editor.

### O limite que NÃO pode ser cruzado

O develop é supervisionado **por natureza** — com os dois caps fora, essa distinção deixa de ser retórica: **não existe mais nenhum contador que encerra a sessão sozinho.** Quem encerra é o editor, pelos gates que seguem bloqueantes (Gate 1, Gate de Onda) ou simplesmente saindo, e nos dois casos a sessão para limpa com o resíduo registrado. **O gate do grupo 3 deixou de ser um desses pontos de parada garantidos (#5321)** — desde então ele auto-entra por default; ainda serve de checkpoint (o editor PODE interromper ali), mas não é mais onde a sessão necessariamente espera. Uma sessão iniciada e abandonada não roda pra sempre — ela para no primeiro gate BLOQUEANTE sem resposta; mas isso agora é propriedade do *gate*, não da contagem, e é por isso que Gate 1/Gate de Onda/Gate B não podem ser afrouxados nesta issue nem em nenhuma outra sem revisitar esta decisão.

- O **Fallback de ausência** segue intacto: `AskUserQuestion` é bloqueante; se o editor sai, a issue corrente vira `pulada` motivo `decisao-adiada`, e **antes** de gravar `resume_state` e parar, recalcular `goal.remaining`/`goal.reached` com esse status já aplicado (mesmo recompute do passo 5 da Fase 1) — **a sessão para limpa — nunca continua autônoma**. Essa atualização acontece independente de a Fase 2 rodar ou não nesta invocação (o `plan.json` gravado é que precisa estar correto pro resume, não uma promessa de que o relatório sai agora).
- Gate 1, Gate de Onda e Gate B **não** viram automáticos. **O gate do grupo 3 já é automático por padrão desde o #5321** — não é uma regressão desta seção, é a mudança que a issue #5321 pediu explicitamente; o que esta seção protege é que Gate 1/Onda/B não sofram o mesmo afrouxamento sem decisão própria.
- Goal não atingido é registrado com o resíduo por tier no handoff da Fase 2, pra a próxima sessão retomar. Nunca é motivo pra insistir.

## Gate do grupo 3 (revisado #5321, "Perguntar é exceção" — era `AskUserQuestion` obrigatório, #4319)

**Default: entrar no grupo 3 automaticamente**, com banner (não `AskUserQuestion`) — o critério de parada que já existe (goal de esgotamento, re-scans, guard de colisão editorial) segue valendo como sempre; o editor interrompe a sessão a qualquer momento se quiser redirecionar. Antes do #5321 isto era um `AskUserQuestion` obrigatório; o feedback do editor que motivou o #5321 ("faça menos perguntas — confio em você") se aplica igualmente aqui — grupo 3 é trabalho de menor valor por definição, não trabalho arriscado, então o mesmo raciocínio do #4498 (`attack_order`) se aplica: parar pra perguntar sem sinal de que a resposta varia é fricção sem ganho.

Ao entrar, imprimir banner:
```
Entrando no grupo 3 (cauda longa: P2, P3, sem prioridade) — {N} issues: {lista}.
Custo por issue tende a ser mais alto aqui. Pra pular ou escolher um
subconjunto, interrompa a sessão agora — ela segue direto se não houver
resposta.
```

Detalhes que decidem se isto funciona:

- **Registro por disparo, não só o primeiro**: se uma re-checagem entre ondas trouxer um bug novo e a sessão voltar pro grupo 1a, ao retornar ao grupo 3 o banner é impresso **de novo** — o backlog é outro. Cada disparo é um registro **novo** em `goal.tier3_gate` (array de disparos — `decision: "auto_entered"` por padrão, `"editor_interrupted"` se o editor intervier antes do próximo tier abrir).
- **Intervenção do editor não é "fazer pergunta"** (mesma exceção do overnight/Regra 1): se o editor disser "pula o grupo 3" ou "só entra nas P2" a qualquer momento antes/durante, a sessão respeita — vira `decision: "editor_interrupted"` no registro, com o pedido como `note`, `goal.reached: false`, e as issues não-entradas vão pro resíduo do handoff **sem** marcar as issues como `pulada` (elas não foram recusadas, só não entraram nesta sessão).
- **`editor_interrupted` exige ação real do editor — nunca é o rótulo pra uma decisão do coordenador (#5439).** `decision: "editor_interrupted"` só é correto quando o editor, por iniciativa própria, pediu explicitamente pra pular/pausar/redirecionar — o pedido literal vira `note`. **Em `goal_policy=exhaust_all`, "escopo já muito extenso" (contagem de PRs mergeadas, tempo decorrido, tamanho de refactor) NÃO é motivo válido de parada** — só 3 mecanismos podem encerrar a sessão antes do goal: o Fallback de ausência, este gate do grupo 3 com resposta real do editor, e o guard de colisão editorial. Se o coordenador se pegar querendo parar por "já fiz bastante", a ação correta é **continuar trabalhando**, não encerrar a sessão e rotular o próprio encerramento como se o editor tivesse pedido. Se o coordenador genuinamente precisa parar por um limite técnico real (token budget esgotado, tempo de execução do harness), esse é um evento distinto — registrar `decision: "coordinator_self_limited"` (ver enum completo no schema `tier3_gate` mais abaixo), nunca `editor_interrupted`. Incidente de referência: sessão `260816b`, o coordenador encerrou sozinho na onda 3 citando "escopo já muito extenso (3 PRs mergeadas, P0 fechado, refactor grande)" e registrou `editor_interrupted` sem nenhuma intervenção real do editor.
- **Este comportamento não é afetado por `wave_policy: auto`** — `wave_policy` decide se o editor aprova a *composição* de cada onda; isto aqui decidia se uma *classe inteira de trabalho* entra, e agora entra por padrão como qualquer outro tier.
- **Caso antes redundante, agora resolvido**: numa sessão `--priority P2,P3`, os grupos 1a/1b/2 nascem vazios e o grupo 3 é a sessão inteira — antes do #5321 o gate perguntava se o editor queria fazer o que ele acabou de pedir na linha de comando; com o default de entrada, esse caso simplesmente segue direto, sem a redundância.

## Fase 0 — Montar e triar a fila (#4319: bugs, bloqueadas, elegíveis P0/P1, resto)

0. **Resume** via `plan.json` se existe.
1. **Sync:** `git checkout master && git pull`; capturar `base_sha = git rev-parse HEAD`; **registrar esta sessão no registro compartilhado (#5156):** `npx tsx scripts/lib/session-registry.ts register --kind develop` (`--session-id` sempre auto-injetado por `.claude/hooks/inject-session-id.mjs` — nunca passado manualmente, a skill não sabe o próprio `session_id`) — é o que permite ao overnight (item 3) checar claim de issue antes de dispatchar, ao merge lock (item 4) serializar merges cross-sessão, e ao guard de cleanup de worktree (item 9) detectar esta sessão como ativa. Ver seção "Paralelismo entre sessões (#5156)" no fim deste arquivo. **capturar `started_at` = timestamp ISO 8601 REAL desta sessão AGORA** (`date -u +%Y-%m-%dT%H:%M:%SZ`, ou equivalente) — gravado em `started_at` no `plan.json` do passo 9 abaixo. **Nunca gravar a string `{AAMMDD}` nesse campo** (#3841 — mesmo bug de raiz do overnight: `{AAMMDD}` nomeia só o diretório da sessão, não é uma data parseável; `started_at` precisa ser um ISO real pro painel `/rodada` do Studio conseguir ordenar TODAS as rodadas — overnight e develop — numa sequência cronológica única). `gh auth status`. **Log de startup do modelo/effort do coordenador (#3454, espelha #2993 do overnight):** logar no run-log o modelo/effort **CONFIGURADO** pelo frontmatter desta skill (`sonnet` / `high`) — não o auto-relatado —, pra tornar o pin verificável via `/diaria-log {AAMMDD}`:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent develop --level info \
     --message "coordinator_model" \
     --details '{"model": "sonnet", "effort": "high", "source": "skill_frontmatter"}'
   ```
2. **Herdar a triagem do overnight:** ler `data/overnight/{AAMMDD-recente}/plan.json` e extrair os `status: pulada` com motivo ∈ `{bloqueio-externo, not-this-week, ambigua, requer-sessao-local}` (#4297 — a última só aparece se aquela rodada do overnight rodou em cloud; herdar mesmo assim, porque develop roda local por natureza e a torna elegível, ver seção "Label `local`") — a triagem cara já foi feita (`source: inherited-overnight`). **Herdar não é aceitar cegamente (#5586):** antes de tratar cada motivo herdado como fato assentado, rodar a checagem barata de "Herdar classificação de rodada anterior do MESMO DIA não dispensa esta verificação" (seção "Categorias de bloqueio + protocolo de desbloqueio" acima) — `gh issue view N --json labels` pra confirmar que a label citada como motivo ainda existe. **Checar se aquela rodada ainda está EM VOO antes de herdar (#5156 item 7):** `npx tsx scripts/lib/session-registry.ts list-active` — se houver uma entrada `kind: "overnight"` ainda ativa (não stale), o `plan.json` que acabou de ser lido é um documento de PROGRESSO, não o resultado final da rodada — os `status: pulada` de agora podem virar `elegivel`/`mergeada` minutos depois, ou novas issues `pulada` podem ainda ser adicionadas. Herdar mesmo assim (não vale a pena esperar), mas gravar `source: "inherited-overnight-in-flight"` em vez de `source: "inherited-overnight"` nessas issues — sinal explícito pro editor/relatório de que a herança é parcial/não-determinística, não uma leitura de rodada já encerrada. Registro vazio ou entrada `overnight` stale → herança normal, `source: "inherited-overnight"` como sempre. **Com `--bugs` (#3375)**: descartar aqui as issues herdadas sem label `bug` — não entram na tabela nem na classificação seguinte. **Com `--priority` (#3499)**: descartar também as issues herdadas cuja prioridade ∉ conjunto passado.
3. **Varredura completa dos issues abertos** (#4319 — antes era só uma varredura de confirmação por label de bloqueio; agora precisa do backlog inteiro pra montar as 4 ondas): `gh issue list --state open --limit 200 --json number,title,labels,body,updatedAt` (`updatedAt` — #5373, usado adiante pra comparar contra `decided_at` do helper de decisão); reconciliar contra o herdado do passo 2 — **fresh-scan vence o plan.json herdado em divergência**. Mesmo filtro `--bugs` se aplica ao resultado fresco. Mesmo filtro `--priority` se aplica ao resultado fresco.
4. **Classificar cada bloqueio em A–E** (só pras issues com sinal de bloqueio real — herdadas do passo 2 ou labels `external-blocker`/`kit-migration`/`not-this-week`/`beehiiv` do passo 3, cruzado com o corpo; `on-hold` NÃO entra aqui, #4498 — ver passo 5). Issue herdada só por `requer-sessao-local` (sem nenhuma label de categoria A–E aplicável) não força uma categoria — categoria `local` em vez de A-E (mesmo tratamento informacional da seção "Label `local`").
5. **Excluir do alvo, em qualquer política**: `fora-do-escopo`, `not-this-week` (issue inteira excluída da rodada — distinto do motivo cat. D da tabela de bloqueio), `elegivel_especial` (#3072), `on-hold` (#4498 — "Pausada indefinidamente pelo editor — fora dos briefings até reativar", semântica do próprio label; nunca entra no briefing/Gate 1, mesmo que carregue também `external-blocker`/`kit-migration`; reativação é o editor remover a label no GitHub).
6. **Montar as 4 ondas** (tabela "Conjunto-alvo com `exhaust_all`" da seção Goal de esgotamento) sobre o que sobrou do passo 5 — **bug ganha de tudo**: label `bug` (bloqueada ou não, qualquer prioridade) → 1a; bloqueada sem `bug` → 1b; elegível com `P0`/`P1` → 2; resto → 3. Essa classificação é feita **sempre**, independente de qual `goal_policy` a Fase 0.5 vai escolher — é dado barato, a decisão de qual tier a sessão de fato ataca vem depois.
7. **Imprimir a tabela**, agrupada por onda (1a/1b/2/3), ordenada P0>P1>P2>P3 dentro de cada uma: `#NNNN | P? | onda | cat A-E ou — | o-que-falta-destravar ou — | título`.
8. Aplicar `--issues`/`--only`/`--bugs`/`--priority` (filtra ANTES da onda ser fixada em `plan.json` — Goal avaliado contra o que sobrar).
9. Gravar `plan.json`, incluindo o campo `goal` inicial — `tiers` = `{ "1a": [...], "1b": [...], "2": [...], "3": [...] }` (números das issues em cada onda, já filtrados por `--issues`/`--only`/`--bugs`/`--priority` — calculado sempre, é dado barato, mesmo que a política acabe sendo `table_only` e `tiers` fique sem uso nesse caso), `current_tier` ainda **ausente** (só é gravado como `"1a"` na Fase 0.5, junto de `policy`, e só se a política escolhida for `exhaust_all`/`blocked_only` — `table_only` nunca grava esse campo), `policy` ainda `null` (coletada na Fase 0.5 — exceto com `--no-implement`, que grava `table_only` direto), `target_set`/`remaining` **ainda vazios** (só populados quando a Fase 0.5 souber a política — `blocked_only` usa só 1a-bloqueada+1b, `exhaust_all` usa as 4 ondas inteiras, `table_only` fica vazio pra sempre), `reached: false`, `rescans_done: 0`, `tier3_gate: []` (array de disparos do gate, vazio até o primeiro — ver schema). Com `--dry-run`, **parar aqui**.

## Fase 0.5 — Briefing FRONT-LOADED (colher o máximo de decisões no início, #2966)

O objetivo é **minimizar interrupções durante a sessão**: coletar na abertura TUDO que não depende de runtime, deixando só o genuinamente-adiável pra mid-sessão. Aproxima o "tudo no início" do overnight, mas SEM a Regra 1 — o develop ainda PODE perguntar depois, só que raramente PRECISA.

Montar o briefing em **múltiplas chamadas `AskUserQuestion` sequenciais** (o cap é 4 perguntas × 4 opções por chamada — front-loadar N decisões exige várias chamadas, agrupadas por categoria). Coletar, nesta ordem:

1. **Ordem de ataque** (`attack_order`) — **não é mais perguntada por padrão (#4498)**. Feedback direto do editor (sessão 260802b): a pergunta saía com o mesmo default escolhido praticamente toda sessão ("só as destraváveis agora"), sem sinal de que a resposta varia — fricção repetida sem ganho de informação. A skill aplica `so_destravaveis_agora` (opção c) automaticamente, sem `AskUserQuestion`, e grava no `plan.json` na Fase 0.5 como se tivesse sido respondida. Editor muda via `--attack-order {a|b|c}` na invocação (a = por prioridade; b = por categoria; c = só as destraváveis agora, o default) ou pedindo explicitamente mid-sessão ("muda a ordem de ataque pra X") — só nesses 2 casos a ordem é resolvida por decisão explícita em vez do default automático. **Escopo desde #4319:** a ordem ENTRE tiers é sempre fixa (1a → 1b → 2 → 3, ver "Goal de esgotamento") — `attack_order` não afeta isso, nunca afetou. O que `attack_order` decide é a ordem de resolução do Gate 1 (desbloqueio) **dentro** do tier corrente, quando há mais de uma categoria de bloqueio pra destravar ao mesmo tempo (relevante sobretudo em 1b, onde só issues bloqueadas entram).
2. **Todas as decisões cat. C** (produto/editorial) — são decisões PURAS (não dependem de ver o código), então batchar TODAS agora, não uma a uma na Fase 1. Cada resposta → comentário durável na issue (a decisão postada É a evidência, #573) + `unblock_status: desbloqueada-validada` no `plan.json`. **Registro machine-readable (#5373):** o comentário começa com o marcador de `formatDecisionMarker` (`scripts/lib/issue-decisions.ts`, `{decided_at, pergunta, resposta, sessao: "develop"}`) antes da prosa de sempre; junto, `gh issue edit N --add-label decisao-registrada` e apender no CORPO da issue `> Decidido em {data}: {resposta breve}` logo após o trecho da pergunta (ou no fim, se não localizável) — fecha o loop no que a próxima varredura lê primeiro.
3. **Todas as credenciais cat. A** — pedir o editor colar TODOS os tokens de uma vez (pro `.env`), validar cada um deterministicamente (#573: `publish-*.ts --dry-run`) ali mesmo. Token que o editor não tem pronto ("preciso gerar") → SÓ essa issue defere pro mid-sessão; as demais seguem validadas.
4. **Todas as confirmações cat. B** — estado das contas de terceiro de uma vez; probe real por conta confirmada.
5. **Política de onda** (`wave_policy`) — UMA pergunta: "auto-compor + mergear as ondas seguras SEM te perguntar cada composição, ou aprovar onda a onda?". **Default sugerido: `auto`** (a onda é livre-de-colisão por construção e o Gate 2 é determinístico). `auto` → pula o Gate de Onda a sessão inteira.
6. **Política de pré-autorização cat. D** (`catD_preauth`) — UMA pergunta: "pra blast-radius, pré-aprovo a abordagem se o teste local + diff de amostra passarem, ou quero ver CADA Gate B?". **Default = `show_each`** (ver cada Gate B) — a segurança do blast-radius NÃO se remove em silêncio; front-load aqui é OPÇÃO explícita, nunca o default.
7. **Política de esgotamento** (`goal_policy`, #4297/#4319) — UMA pergunta, agora com 3 opções: "(a) trabalhar o backlog aberto inteiro em 4 ondas priorizadas até não sobrar nenhuma issue aberta; (b) só o backlog bloqueado, como antes da #4319; (c) fechar quando a lista de hoje acabar, sem re-varredura?". **Default sugerido: `exhaust_all`** (a). `blocked_only` (b) = escopo original de #2636/#4297. `table_only` (c) = comportamento pré-#4297, pra janela de tempo curta. **Pulada se `--no-implement` está ativo** — nesse modo o Goal nunca é alcançável por desenho (ver "Incompatibilidade estrutural com `--no-implement`"), `goal.policy` grava `table_only` direto, sem perguntar.

Assim que `goal_policy` é respondida, popular `goal.target_set`/`goal.remaining` no `plan.json`: com `exhaust_all`, é a união das 4 ondas (`tiers["1a"] + tiers["1b"] + tiers["2"] + tiers["3"]`), e `goal.current_tier` é gravado como `"1a"`; com `blocked_only`, é só `tiers["1a"]` filtrada pra bloqueadas + `tiers["1b"]` (o mesmo conjunto de sempre, só que lido a partir da partição por onda em vez de recalculado), e `goal.current_tier` também é gravado como `"1a"`; com `table_only`, `target_set`/`remaining` ficam vazios (não avaliados) e `goal.current_tier` **não é gravado** (fica ausente pela sessão inteira — não existe conceito de tier nessa política). `reached` recalcula pra `target_set.length === 0` no mesmo passo.

Gravar tudo em `plan.json` (`attack_order`, `wave_policy`, `catD_preauth`, `goal.policy`, `goal.target_set`, `goal.remaining`, `goal.reached`, e por issue `unblock_status`/`unblock_evidence`). **Regra de resume:** nada coletado no briefing é re-perguntado.

**O que NÃO dá pra front-load** (fica mid-sessão, vira exceção — não o fluxo normal): Gate B cat. D quando `catD_preauth = show_each`; ambiguidade imprevista que só aparece implementando; falha de MCP (#738); input que o editor não tem pronto no briefing. Com o front-load, a maioria das sessões não para em nenhum desses.

## Fase 1 — Desbloquear → validar → implementar em ondas paralelas por tier

A maioria dos desbloqueios já foi **coletada no briefing FRONT-LOADED** (Fase 0.5, #2966): a Fase 1 processa as issues `desbloqueada-validada` direto na implementação, e só usa o **Gate 1 pro RESÍDUO** — o que não deu pra front-load (token que o editor foi gerar, ambiguidade imprevista). O Gate 1 remanescente é serial mas **agrupa desbloqueios da mesma categoria numa única `AskUserQuestion`** (até 4 perguntas). **Com `goal_policy ∈ {exhaust_all, blocked_only}`:** trabalho acontece **um tier por vez** (`goal.current_tier`, começa em `1a`) — só issues do tier corrente entram na fila de implementação; um tier só é aberto pra trabalho depois que o anterior está esgotado (todo status terminal). **Com `goal_policy = table_only`:** não existe conceito de tier — `current_tier` não é gravado (schema, seção `plan.json`), todas as issues da tabela impressa na Fase 0 formam uma fila única, sem partição nem avanço por onda; o passo 6 abaixo é pulado inteiro nesse caso. **No início de cada iteração, reler `plan.json`.**

1. **Diagnosticar** e formular o pedido de desbloqueio **exato e acionável** (ex: "cole o valor de `INSTAGRAM_ACCESS_TOKEN` gerado em Meta Business > Apps > diar.ia > Tokens") — só se relevante pra issue do tier corrente (issues de 1a/2/3 sem sinal de bloqueio pulam direto pro passo 3).
2. **Gate 1 — desbloqueio** (`AskUserQuestion`, formato por categoria, só pras issues bloqueadas do tier corrente) — toda opção inclui sempre "não consigo destravar agora (documentar e pular)".
3. **Validar deterministicamente (#573)** — nunca pela palavra do editor (ver tabela A–E). Issue elegível (sem bloqueio, tiers 1a/2/3) não passa por Gate 1/validação — vai direto pra composição da onda.
4. **Compor a onda:** quando há ≥1 issue pronta (validada, ou elegível sem bloqueio) no tier corrente, rodar a análise de cluster de conflito (mapear arquivos por issue via grep no corpo + símbolos citados — puro lookup, sem escrita de código) → issues que colidem em arquivo **fundem numa unidade só** (ver "Paralelização segura", #4319). **Checar claim de outra sessão antes do fan-out (#5156 item 3):** pra CADA issue da onda, `npx tsx scripts/lib/session-registry.ts is-claimed --issue {N}` — `claimed: true` (outra sessão overnight/develop ativa já está trabalhando essa issue) remove a unidade da onda (status `pulada`, motivo `claimed-por-outra-sessao`, sem comentário — corrida evitada, não bloqueio); registro vazio nunca bloqueia. **Checar o teto de concorrência somando TODAS as sessões ativas (#5156 item 6):** `npx tsx scripts/lib/session-registry.ts list-active` — o teto de 6 worktrees abaixo é POR SESSÃO; se outras sessões ativas nesta máquina já somam `active_worktrees` significativos, considerar abrir menos que 6 nesta onda (heurística, não trava — throughput, não correção, mesmo espírito do "se a máquina engasgar, baixar manualmente é seguro" já documentado abaixo). Depois de passar pelos dois checks: → **Gate de Onda** (editor aprova a composição — **pulado se `wave_policy = auto`**, #2966) → reivindicar cada issue aprovada (`npx tsx scripts/lib/session-registry.ts claim-issue --kind develop --issue {N}`, uma chamada por issue) — **o `claim-issue` vale pra toda unidade que o coordenador decide trabalhar, via subagente OU DIRETAMENTE (sem fan-out — comum em unidades pequenas, Chrome-assisted, ou investigativas que não justificam worktree isolado): reivindicar antes de começar a mexer na issue em qualquer um dos dois caminhos, não só no de fan-out (#5407)** → **fan-out de até 6 implementadores concorrentes** (um worktree por unidade; branch `develop/fix-NNNN` — ou `develop/fix-NNNN-MMMM` pra unidade fundida — solo, ou `develop/blast-NNNN` p/ cat. D, sempre solo e nunca fundida). Cada PR passa pelo **review de fleet pré-merge** (#4383 — ver "Gates", "REVIEW DE FLEET PRÉ-MERGE"; o coordenador dispatcha os 5 agentes explicitamente, nunca o subagente implementador) e só então pelo **Gate 2 determinístico** (#2210/#2222), mergeando independentemente; unidade fundida fecha **todas** as issues do cluster no mesmo merge (`Closes` por issue, verificar `gh issue view --json state` pós-merge pra cada uma). **Fila grande (>8 issues prontas no tier, #2754):** a análise de cluster de conflito pode ser delegada a um subagente `general-purpose` com `model: haiku` explícito (não `sonnet` — aqui é puro grep/leitura, sem julgamento de implementação; latência menor sem perda de qualidade) em vez do coordenador rodar serialmente — só essa etapa de mapeamento, nunca a implementação em si (que continua sempre `sonnet`, #2019).
5. Atualizar `plan.json` + `scripts/log-event.ts`; `git pull` após cada merge. Issue não destravável na sessão → comentário durável (com dedup) explicando o que falta, status `pulada` motivo `nao-destravavel-na-sessao` (degradação elegante para o skip do overnight, mas só após ter tentado destravar ao vivo). **Mesmo tratamento pra issue elegível cuja implementação falha sem nunca abrir PR/chegar ao CI** (#4319 — subagente travou, `npm ci`/worktree falhou, exceção não tratada durante a implementação): renderizar halt banner (`scripts/render-halt-banner.ts`, mesmo padrão do #738 pra outras paradas inesperadas), diagnosticar, e gravar `pulada` motivo `nao-destravavel-na-sessao` com o erro no comentário — nunca deixar a issue presa em `pendente` sem tentar de novo indefinidamente nem sem marcar terminal (é o único caminho terminal disponível pra uma issue que pulou Gate 1, e sem ele o tier correspondente nunca esgotaria).

   **Instrumentação de token da rodada (#3454 Rec 1) — pré-requisito de qualquer corte futuro no develop:** não existe dataset real de develop com as 3 métricas que permitiram a análise do overnight (#3327). Ao **fim de cada unidade despachada** (issue solo ou onda), emitir um evento `subagent_metrics` no run-log com as mesmas 3 colunas — `duration_ms` sai de graça do `timeline` do `plan.json` (`merged`/`draft`/`pulada` menos `dispatch`); `subagent_tokens` e `tool_uses` vêm do retorno de cada `Agent` **se o harness os expuser por invocação** (caso não, gravar `null` com `source: "unavailable"`):
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent develop --level info \
     --message "subagent_metrics" \
     --details '{"unidade": "#NNNN | onda {id}", "issues": [123], "subagent_tokens": N, "tool_uses": N, "duration_ms": N, "source": "harness_usage | unavailable"}'
   ```
   Análogo ao `coordinator_tokens_estimate` do overnight (#3453 Rec 1), emitir também um `coordinator_tokens_estimate` ao fim de cada onda + no relatório (mesma forma: `{"phase": "onda {id} | fase_1_5 | fase_2", "tokens": N, "source": "harness_usage | context_size_proxy | unavailable"}`). Risco nenhum (só observabilidade); transforma a Seção 3 da análise #3328 de "leitura de código + analogia" em "medido".

6. **Esgotar o tier corrente → avançar (`goal_policy ∈ {exhaust_all, blocked_only}`):** quando todas as issues do `current_tier` atingem status terminal:
   - **Re-checagem entre ondas** (#4319, sempre, sem cap): antes de montar a próxima onda, re-varrer TODAS as issues abertas via `gh issue list` (sem `body` — barata) e reclassificar em tiers (mesma regra da Fase 0 passo 6). Issue nova que cai num tier **já esgotado** entra na fila mesmo assim — `goal.current_tier` **volta** pra esse tier (não gera livelock: status terminal nunca é re-escolhido, só issue genuinamente nova reabre um tier). Atualizar `goal.tiers`/`goal.target_set`/`goal.remaining` no `plan.json` a cada ciclo.
   - Repetir o tier corrente (ou o tier reaberto) até esgotar de novo, então avançar: `1a → 1b → 2 → 3` (com `blocked_only`, só `1a`-bloqueada `→ 1b`, e o Goal fecha ali — nunca entra em 2/3).
   - **Antes de montar o grupo 3**, imprimir o banner do **Gate do grupo 3** (seção própria, revisado #5321) — sempre, mesmo em reentradas. Default `auto_entered` → monta normalmente; só vira `editor_interrupted` (`goal.reached: false`, grupo 3 vai pro resíduo sem virar `pulada`, ou só o subconjunto pedido entra) se o editor intervier por iniciativa própria antes do tier abrir. "Escopo já extenso" não é intervenção do editor — não interrompe nada; se o coordenador precisa mesmo parar por limite técnico real, é `coordinator_self_limited` (#5439, ver "Gate do grupo 3" acima e schema `tier3_gate`), nunca `editor_interrupted`.
   - Quando o **tier** 3 (ou 1b, em `blocked_only`) esgota **sem** issue nova na re-checagem seguinte (não confundir "tier" — grupo de prioridade 1a/1b/2/3 — com "onda" — o lote de unidades despachadas em paralelo dentro de um tier, que pode se repetir várias vezes até o tier esgotar): rodar a **re-varredura de convergência** (mesma varredura completa, agora perguntando "achou algo novo em qualquer tier?") — repete **sem cap** enquanto achar issue nova sem status terminal; sem novidade, `goal.reached: true` (ou `false` se o gate do grupo 3 registrou `editor_interrupted` com resíduo).
   - `rescans_done` incrementa a cada ciclo de re-checagem/convergência, **como contador puro** (#4319 — sem cap, nenhuma lógica lê o valor pra decidir parar; só a Fase 2 reporta). Issue novata entra no Gate 1 normalmente (não pula direto pra implementação). **Anti-livelock idêntico ao overnight:** issue com status terminal na sessão **nunca** é re-escolhida.

   Com `goal_policy = table_only`, pular esta etapa inteira — a Fase 1 encerra assim que a tabela original acaba, `goal` fica com `policy: "table_only"` e sem avaliação de `reached`.

## Gates

**Cinco gates** (#4319 acrescenta o do grupo 3 aos quatro de #4297) — a separação limpa é o que torna seguro inverter a Regra 1 e paralelizar: **humano bloqueante no Gate 1 e no Gate de Onda; humano-interruptível (default automático, #5321) no Gate do grupo 3; máquina sozinha no Gate 2.** **REVIEW DE FLEET PRÉ-MERGE (#4383, abaixo) não é um dos cinco** — é um passo de máquina inserido na esteira entre o self-review/fixer da unidade e o Gate 2, não um ponto de decisão/ramificação como os cinco; a contagem "cinco gates" permanece correta.

- **GATE 1 — DESBLOQUEIO** (humano, `AskUserQuestion`, permitido por design). Órgão central da skill. Decisões de produto/editorial (cat. C/E) **viram comentário durável na issue** — `plan.json` é só cache.
- **GATE DE ONDA — COMPOSIÇÃO PARALELA** (humano, antes do fan-out). Apresenta as unidades da onda — clusters fundidos e singletons (#4319, ver "Paralelização segura" — colisão já não serializa mais, funde) — editor aprova a onda. **Pulável com `--serial` OU `wave_policy = auto`** (escolhido no briefing, #2966 — a onda é livre-de-colisão por construção, então auto-compor é seguro).
- **REVIEW DE FLEET PRÉ-MERGE** (máquina, sem humano, por PR — #4383, roda entre o self-review/fixer da unidade e o Gate 2). O subagente implementador não pode dispatchar a ferramenta Agent (#207) — por isso, quando ele recebe do hook `.claude/hooks/pr-create-review.mjs` a instrução de rodar o review multi-agente, a regra 8 do checklist manda ele SÓ fazer self-review e retornar. Mas nenhuma branch desta skill (`develop/fix-*`/`develop/blast-*`) nunca bate o prefixo `overnight/*` nem o marker de sessão overnight ativa que o hook checa pro desconto `low` — então todo PR do develop resolve `max` (fleet de 5 agentes) no hook, nunca `low`. Diferente do overnight (cuja Fase 1.5, 1 agente, tem paridade exata com o `low` que os PRs dele resolvem), a Fase 1.5 do develop (também 1 agente, ao fim da sessão inteira) NÃO cobre o `max` a que cada PR individual tem direito — sem este passo, nenhuma unidade jamais recebe o fleet de verdade (achado #4383: só ~53% de compliance no período medido). Por isso, **antes do Gate 2**, o COORDENADOR (nunca o subagente) dispatcha explicitamente, em paralelo, os 5 agentes do fleet `max` — `pr-review-toolkit:code-reviewer`, `pr-review-toolkit:silent-failure-hunter`, `pr-review-toolkit:pr-test-analyzer`, `pr-review-toolkit:comment-analyzer`, `pr-review-toolkit:type-design-analyzer` (nomes PREFIXADOS pelo plugin) — cada um com `model: sonnet` explícito (#2019), escopo **explícito** `git diff {merge_base}...{branch}` desta unidade (nunca o diff unstaged default do agente) e restrição **somente leitura** (sem edição de arquivo, `checkout`/`switch`/`stash`/`reset`, ou commit — o checkout pode ser compartilhado com outra sessão). **Fallback obrigatório** se `Agent type ... not found` (plugin `pr-review-toolkit` ausente — sessão cloud, clone fresco): `general-purpose` com o mesmo rubrico inline usado no fallback da Fase 1.5 (correctness, simplification/efficiency, test-coverage, security) — degradar é aceitável, pular o review em silêncio não. Achados agregados vão pro mesmo agente fixer (2-agentes) já usado pro self-review, na mesma branch, antes de prosseguir pro Gate 2. Registrar no `plan.json` da unidade (`fleet_review: "done"` / `"skipped: {motivo}"`) para auditoria — mesmo padrão do campo `review` do overnight. **Instrumentação de token do fleet review (#4815):** ao receber o retorno dos 5 agentes (ou do fallback `general-purpose`), somar `harness_usage` de cada um **se o harness os expuser por invocação** (caso não, gravar `null` com `source: "unavailable"`) e emitir no run-log:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --agent develop --level info \
    --message "fleet_review_metrics" \
    --details '{"unidade": "#NNNN | onda {id}", "fleet_tokens": N, "tool_uses": N, "source": "harness_usage | unavailable"}'
  ```
  É a fonte da categoria **Fleet review pré-merge** da seção "Custo em tokens" (Fase 2, mandatória desde #4815) — separada da Implementação de propósito: foi essa separação, numa sessão real (260808), que tornou visível o rateio 66/34 entre as duas categorias (#4815 item 2).
- **GATE 2 — IMPLEMENTAÇÃO/MERGE** (determinístico, sem humano, por PR): gate de 2 condições do overnight (#2210/#2222 — `gh pr checks` bucket≠pass == 0 **E** threads não-resolvidas excluindo FORBIDDEN == 0, ambos via `gh api graphql --jq`), em chamada separada do `gh pr merge`, + verify #573. **Merge lock cross-sessão antes do `gh pr merge` (#5156 item 4):** `npx tsx scripts/lib/session-registry.ts merge-lock-acquire` (`--session-id` auto-injetado); `denied` → outra sessão (overnight ou develop concorrente) está no meio do próprio merge+pull (TTL 2 min) — esperar ~15s e tentar de novo, poucas tentativas, escalando pra halt banner se persistir. Liberar com `merge-lock-release` logo após o `git pull` que segue o merge — a janela protegida é só `gh pr merge` até esse `git pull`, nunca mais que isso.
- **GATE B — PRÉ-APLICAÇÃO** (só cat. D): entre validar e aplicar em escala. Mostra diff-walkthrough (contagem por tipo de mudança + 1 site exemplo antes/depois + resultado do teste local) e pede confirmação explícita ("vai tocar ~N sites; testei local: {resultado}. Aplico no conjunto inteiro? s/n/subconjunto"). **Obrigatório por default (`catD_preauth = show_each`); opt-out por sessão via `catD_preauth = preapproved`** (escolhido no briefing, #2966) — aí o coordenador só aplica se o teste local + diff de amostra passarem, sem parar. O default NUNCA é pré-aprovado: a segurança do blast-radius não se remove em silêncio.
- **GATE DO GRUPO 3 — ENTRADA NA CAUDA LONGA** (checkpoint humano-interruptível, default automático desde #5321 — não é mais `AskUserQuestion`; ver seção própria "Gate do grupo 3"). Único gate desta lista que não trava uma unidade de trabalho, e sim uma **classe inteira** de trabalho (o tier 3). Sem opt-out por `wave_policy = auto` porque não há mais o que pular — o default já é entrar.

**Fallback de ausência:** `AskUserQuestion` é bloqueante; se o editor sair no meio, a issue corrente vira `pulada` motivo `decisao-adiada`, `resume_state` é gravado e a sessão **para limpa — nunca continua autônoma**. Todo gate de desbloqueio inclui "decido depois / pular".

## Fase 1.5 — Code-review consolidado (opcional, mais leve)

**Rede complementar, não o review primário de cada PR (#4383).** Desde o fix do #4383, o review de fleet completo (5 agentes) já roda POR UNIDADE, explicitamente, no passo "REVIEW DE FLEET PRÉ-MERGE" da seção Gates — esta Fase 1.5 continua existindo por cima disso, com o mesmo papel que sempre teve no overnight: 1 agente só, sobre o diff ACUMULADO da sessão inteira, pra pegar interações entre PRs que não colidiram em arquivo (então nunca passaram pelo mesmo fleet) mas colidem semanticamente. Não é mais a única rede de segurança pós-merge do develop, e nunca foi dimensionada pra ser (1 agente não substitui o fleet de 5 que cada PR individual tem direito, ver a nota "#4383" no início da seção Gates).

Roda só se houve ≥1 merge e o diff `{base_sha}..HEAD` > ~50 linhas. Forma executável (#4034 — `/code-review` deixou de ser invocável via Skill tool desde 260724, gate de plataforma `disable-model-invocation`; #4234 — dispatch via agentes do plugin `pr-review-toolkit`): dispatchar um Agent com `subagent_type: "pr-review-toolkit:code-reviewer"` (nome PREFIXADO — sem o prefixo dá `Agent type not found`) e `model: sonnet` explícito (#2019), passando `git diff {base_sha}..HEAD` como escopo **explícito** no prompt (o agente revisa `git diff` unstaged por default) + restrição **somente leitura** (sem edição de arquivo, sem `git checkout`/`switch`/`stash`/`reset`, sem commit — o checkout é compartilhado, incidentes 260703/260708), sem `--comment` (mesmo racional do overnight — findings retornam ao coordenador). **Fallback obrigatório** se resolver `Agent type ... not found` (plugin ausente): `general-purpose` + rubrico inline (correctness, simplification/efficiency, test-coverage, security), o comportamento pré-#4234. Crítico-em-produção confirmado deterministicamente (`gh run list --branch master --limit 1`, #573) → hotfix imediato; demais → issues via `scripts/lib/auto-reporter-dedup.ts` (dedup, labels tipo + prioridade obrigatória). Review falhou (Agent indisponível, timeout) → fail-soft #738: `review: "skipped: {erro}"`, segue pro relatório.

**Findings não são mais classe especial no develop (#4319).** Até #4297, um finding filado aqui ganhava label `session-finding` e entrava por uma porta própria — mini-rodada numerada, cap de profundidade 2, excluído da re-checagem normal por `created_at >= started_at`. Isso **saiu**: o finding vira uma issue igual a qualquer outra, entra na próxima re-checagem entre ondas (Fase 1 passo 6) e é classificado no tier dele pelas mesmas regras da Fase 0 passo 6 (`bug` → 1a; `enhancement` → 2 ou 3, conforme prioridade) — disputa a fila com o resto, sem mini-rodada nem cap. `findings_depth` **permanece no `plan.json` como contador puro de observabilidade** (mesmo destino de `rescans_done`, ver "Goal de esgotamento") — incrementa a cada finding que a própria sessão consome, mas nenhuma lógica ramifica nele. A label `session-finding` continua existindo e sendo aplicada (útil pra origem/auditoria), só não tem mais tratamento estrutural diferenciado.

> **`/diaria-overnight` não muda:** lá o cap de profundidade 2 e o tratamento especial de `session-finding` (mini-rodadas, exclusão por `created_at`) continuam intactos — sem editor presente, é a única garantia de terminação daquele fluxo. A label `session-finding` segue compartilhada entre as duas skills (renomeada de `overnight-finding`, #2636); o que diverge é só o que cada skill FAZ com uma issue que carrega essa label.

## Fase 2 — Relatório + handoff para o overnight

**Gate de re-triagem pendente (#5476), primeiro passo antes de qualquer outra coisa nesta fase:** rodar `npx tsx scripts/check-state-changed-pending.ts --plan data/develop/{AAMMDD}/plan.json`. `exit 1` → voltar pra Fase 1, reavaliar dispatch pra cada issue listada (ver regra em "Regras" acima), só então continuar. `exit 0` → seguir normalmente.

**Abrir sempre com o status do Goal (#4297/#4319)**, antes de qualquer outra linha: `Goal (escopo: {descrição do escopo efetivo}, política: {exhaust_all|blocked_only}): atingido` ou `não atingido`. Escopo efetivo = `--issues`/`--only`/`--bugs`/`--priority` da invocação, resumidos (ex: `--bugs --priority P0,P1`; `nenhum filtro` se a sessão rodou sem flags de escopo). Com `goal.policy: "table_only"`, a linha vira `Goal: não avaliado (goal_policy=table_only)` — não é "não atingido", é fora de escopo por opção do editor no briefing. Com `--no-implement` ativo, a linha vira `Goal: não avaliado (--no-implement ativo)` pelo mesmo motivo (ver "Incompatibilidade estrutural com `--no-implement`").

Quando não atingido, listar o resíduo **por tier**: `1a: N issues` / `1b: N` / `2: N` / `3: N (gate: auto_entered|editor_interrupted|coordinator_self_limited — ver goal.tier3_gate)`, e dentro de cada tier o motivo POR ISSUE de não ter chegado a terminal (bloqueio cat. B ainda sem conta de terceiro, token cat. A não colado, "grupo 3 não entrou nesta sessão" quando o editor interrompeu com `editor_interrupted`, ou a sessão parou por limite técnico próprio com `coordinator_self_limited` — consultado no registro por-issue do `plan.json`, `goal.remaining` guarda só os números). É o resíduo que a Seção de HANDOFF abaixo também referencia.

**Cadeia de findings (#4319, substitui o cap de profundidade como sinal):** reportar quantos findings a sessão gerou na Fase 1.5, quantos ela mesma consumiu (voltaram pra fila via re-checagem entre ondas e foram trabalhados na mesma sessão), e `goal.findings_depth` final — é o que permite ao editor perceber "esta sessão passou N ciclos se auto-alimentando" sem que nada a tenha interrompido mecanicamente. Junto, reportar `goal.rescans_done` (quantas re-checagens/re-varreduras a sessão fez) — ambos são contadores de observabilidade agora, não motivo de a sessão ter parado.

Com `--bugs` (#3375) ativo, abrir o digest com `Modo: --bugs (só issues com label bug)`. Com `--priority` (#3499) ativo, adicionar (ou combinar na mesma linha, se `--bugs` também ativo) `Modo: --priority {lista} (só issues com label de prioridade ∈ {lista})` — inclui a contagem de issues excluídas por não baterem a prioridade. Digest de `plan.json` + run-log (filtrado por `agent: "develop"` + AAMMDD) em 4 buckets: (a) destravadas e mergeadas (agrupadas por onda); (b) destravadas mas pendentes (`--no-implement` ou CI vermelho — **prontas p/ o próximo overnight pegar como `elegivel`**); (c) não-destraváveis na sessão; (d) findings/hotfixes. **Seção de HANDOFF:** quais issues saíram de bloqueada→elegível (label removido + decisão postada) e quais ações fora da sessão o editor ainda precisa agendar. **Linha de coordenador (#3454):** `Coordenador: sonnet / high` (valores CONFIGURADOS no frontmatter, ver evento `coordinator_model` da Fase 0); se algum `stall`/intervenção do editor mid-sessão sugerir reversão, anotar a ressalva na mesma linha.

**Seção "Custo em tokens" (#4815) — MANDATÓRIA, nunca omitida.** A #3453 Rec 1/#3454 Rec 1 (instrumentar custo por rodada) vinha sendo adotada de forma inconsistente entre sessões — tabela de `subagent_tokens` presente em só 3 das 17 sessões de agosto medidas no #4815 (`develop/260804`, `260806b`, `260808`), best-effort ("se houver eventos, resumir"), e isso quase impediu a auditoria de custo de 260809. A partir de agora esta seção **sempre** entra no relatório da sessão, com as 3 categorias sempre presentes — cada uma escreve `unavailable` explicitamente quando o dado não existe, nunca omite a linha/tabela (ausência silenciosa é indistinguível de "esqueci"):
1. **Implementação** — tabela `unidade | subagent_tokens | tool_uses | duração` a partir dos eventos `subagent_metrics` (um por unidade despachada, ver Fase 1 passo 5) + total da sessão. Sessão sem nenhuma unidade despachada (ex: `--dry-run`, `--no-implement`) → tabela com a nota "nenhuma unidade".
2. **Fleet review pré-merge** — tabela SEPARADA da anterior (`unidade | fleet_tokens | tool_uses`, a partir dos eventos `fleet_review_metrics`, ver Gates "REVIEW DE FLEET PRÉ-MERGE") + total. A separação em relação à Implementação é o que torna visível o rateio entre as duas categorias (#4815 item 2, foi essa separação em 260808 que revelou o rateio 66/34) — nunca agregar as duas na mesma linha/tabela.
3. **Coordenador** — linha `Coordenador (tokens estimados): ~N (fonte: {harness_usage | context_size_proxy})` a partir de `coordinator_tokens_estimate`; se todos os eventos dessa categoria vierem `unavailable` (ou não existirem na sessão — histórico até aqui: `coordinator_tokens_estimate` nunca foi medido em nenhuma sessão real, #4815), a linha vira `Coordenador (tokens): unavailable` — nunca omitida.

Timeline via `npx tsx scripts/render-overnight-timeline.ts --plan data/develop/{AAMMDD}/plan.json --title "Timeline da sessão" --total-label "Total da sessão"`.

Salvar o digest completo em `data/develop/{AAMMDD}/report.md` (mesma convenção do overnight, `data/overnight/{AAMMDD}/report.md`). **Registrar na superfície de Relatórios do Studio (#3714, decisão do editor 260720 — substitui o antigo draft de Gmail, não soma a ele):**
```bash
npx tsx scripts/register-report.ts --kind develop --id {AAMMDD} \
  --title "diar.ia.br develop {AAMMDD} — {U} unidades, {N} issues destravadas/mergeadas" \
  --html-path data/develop/{AAMMDD}/report.md
```
File-based (só escreve `data/reports/index.jsonl`) — nunca depende do `npm run studio` estar no ar; o comando imprime a URL em stdout, capturar pro resumo do terminal. **Não criar mais draft via `create_draft` aqui.** **Preceda a tabela de unidades do relatório com o marcador literal `<!-- unidades-mergeadas -->` (#5521)** — com ele, o número de unidades no título (`"N unidades"`/`"N PRs"`) tem que bater com as linhas da tabela e o de issues (`"N issues"`) com as issues distintas que elas cobrem; divergência sai `exit 1` sem registrar nada, e o comando imprime o sufixo correto. Sem o marcador o comando avisa em stderr que a conferência não rodou. Único ponto não fail-soft do comando, de propósito (o título vira assunto de e-mail, que não tem desfazer); rationale completo no passo equivalente de `.claude/skills/diaria-overnight/SKILL.md`. Canal primário = terminal, incluindo a linha `Relatório: {URL do Studio}`; fail-soft #738 — falha do registro (raro, é só escrita local) nunca trava a sessão, só avisa que o relatório ficou local.

**Limpeza de worktrees mergeados (#4335, follow-up do #4326):** por último, depois do relatório salvo/registrado, **encerrar o registro desta sessão primeiro** (`npx tsx scripts/lib/session-registry.ts end --kind develop`, `--session-id` auto-injetado — #5156, senão esta própria sessão aparece como "outra sessão ativa" pro guard abaixo) e só então rodar `npx tsx scripts/cleanup-merged-worktrees.ts` — varre `.claude/worktrees/` (worktrees concorrentes desta sessão + sobras de rodadas anteriores), confirma via `gh pr list --head {branch} --state merged` quais branches já foram mergeadas e remove (`git worktree remove --force`) só essas. **FAIL-SOFT**: o script já nunca lança nem sai não-zero por falha de `gh`/permissão; mesmo assim, tratar qualquer stderr como warning — nunca travar o encerramento da sessão por causa desta limpeza. **Guard de sessão compartilhada embutido no próprio script (#5156 item 9):** ele consulta `session-registry.ts` e PULA a varredura inteira, sozinho, se detectar qualquer outra sessão ainda ativa nesta máquina (ex: um overnight que começou depois desta sessão develop) — não insistir com `--confirm-shared` sem certeza de que não há colisão.

## Guard de colisão editorial — aviso interativo, sem auto-preempt

Ao detectar edição em curso (`scripts/lib/find-current-edition.ts` retorna candidato ou `data/editions/` de hoje/amanhã ganhou arquivos novos), a skill **avisa o editor e pergunta** ("uma edição de hoje/amanhã está em curso — encerrar a sessão develop para liberar a pipeline editorial? s/n"). **Diferente do overnight, develop NÃO grava `preempted_*` nem auto-encerra** — como é supervisionado e nunca continua sem editor, a decisão é humana ao vivo. Se o editor não responde, o `AskUserQuestion` fica bloqueante, `resume_state` é gravado e a sessão para limpa.

## `plan.json` (`data/develop/{AAMMDD}/`, gitignored)

Reusa o schema do overnight (**inclusive `started_at` — ISO 8601 real capturado no passo 1, nunca a string `{AAMMDD}`, #3841**) + campos próprios de desbloqueio: `block_category` (A–E), `block_label` (literal real), `what_unblocks`, `unblock_status` (`pendente`|`desbloqueada-validada`|`nao-destravavel-na-sessao`), `unblock_evidence` (dry-run exit 0 / comentário #link / probe API ok — **NUNCA o valor do secret**), `editor_input_received` (bool/hash, nunca o secret), `source` (`inherited-overnight`|`fresh-scan`|`manual-issues-arg`), `wave` (id da onda paralela), `fora_de_codigo_evidencia`/`fora_de_codigo_fechamento` (#5441 — só presentes quando `status: "entregue-fora-de-codigo"`, ver subseção "Unidade concluída sem gerar PR"), `fleet_review` (#4383 — `"done"` | `"skipped: {motivo}"`, gravado pelo coordenador ao concluir o passo "REVIEW DE FLEET PRÉ-MERGE" da seção Gates, por unidade; ausente em `plan.json` de sessão anterior a #4383). **Políticas de sessão do briefing front-loaded (#2966):** `attack_order` (resolvida — default `so_destravaveis_agora` sem pergunta, ou override via `--attack-order`/pedido mid-sessão, #4498), `wave_policy` (`auto`|`per_wave`, default `auto`), `catD_preauth` (`show_each`|`preapproved`, default `show_each`) — gravadas na Fase 0.5 e relidas em todas as fases; nunca re-perguntadas em resume. **Regra crítica de resume:** nunca re-perguntar um desbloqueio já validado (`unblock_status: desbloqueada-validada` + `status: pendente` → retomar direto na implementação) nem uma política já escolhida. **Segurança:** o plan.json nunca armazena o valor de um token. Develop **não** grava `preempted_*`.

**`goal` (#4297, expandido em #4319), objeto no nível raiz:**
```json
"goal": {
  "policy": "exhaust_all",
  "tiers": { "1a": [4309, 4310], "1b": [], "2": [4295], "3": [4252, 4275] },
  "current_tier": "1a",
  "target_set": [4309, 4310, 4295, 4252, 4275],
  "remaining": [4310, 4295, 4252, 4275],
  "reached": false,
  "rescans_done": 3,
  "findings_depth": 1,
  "tier3_gate": [
    { "asked_at": "2026-07-29T20:10:03Z", "decision": "auto_entered", "selected": null }
  ]
}
```
Exemplo: sessão já esgotou o grupo 3 uma vez (o único disparo registrado em `tier3_gate`, decisão `auto_entered` — default desde #5321); um bug novo apareceu depois numa re-checagem e reabriu o tier `1a` — por isso `current_tier` voltou pra `"1a"` mesmo já tendo passado pelo grupo 3 (regra de reabertura da seção "Re-varredura sem cap"). Se a sessão retornar ao grupo 3 depois de esgotar esse `1a` reaberto, é um disparo **novo**, que vira um segundo item no array `tier3_gate`.

`policy` ∈ `exhaust_all` (default, #4319) | `blocked_only` (escopo original #2636/#4297) | `table_only` = `goal_policy` do briefing, copiado aqui pra não precisar re-ler a Fase 0.5 — **transiente `null`** entre a escrita inicial da Fase 0 passo 9 e o preenchimento da Fase 0.5 (ou direto `table_only` se `--no-implement`); nenhuma fase entre esses dois pontos lê `goal.policy`, então o `null` nunca é observado por lógica que dependa dele.

**Migração de legado (#4319):** `plan.json` gravado por sessão anterior a #4319 tem `policy: "exhaust"` — ler como **`blocked_only`**, nunca como `exhaust_all` (promover o escopo silenciosamente em resume mudaria o mandato da sessão no meio, o que o Fallback de ausência existe pra impedir). Um `plan.json` legado também não tem `tiers`/`current_tier`/`tier3_gate` — tratar como ausentes, sem tentar reconstruir retroativamente. Em particular, **`current_tier` ausente num resume não vira `"1a"` por default** — a sessão trata `target_set`/`remaining` já gravados por ela mesma (pré-#4319) como uma fila única sem partição por tier, exatamente como funcionava antes desta issue existir; a Fase 1 passo 6 (avanço entre tiers) não roda pra essa sessão porque não há tier nenhum pra avançar.

`tiers` = a partição do backlog aberto em 4 ondas (Fase 0 passo 6), recalculada a cada re-checagem entre ondas (Fase 1 passo 6) — issue nova pode entrar num tier já esgotado, e nesse caso `current_tier` **volta** pra ele (não gera livelock: status terminal nunca é re-escolhido). `current_tier` = onda que a Fase 1 está trabalhando agora (`1a`|`1b`|`2`|`3`) — só existe (é gravado) com `policy: "exhaust_all"` ou `"blocked_only"` (nesta, só assume `1a`/`1b`); com `policy: "table_only"` o campo **nunca é gravado**, fica ausente a sessão inteira (mesmo tratamento explícito-vazio que `target_set`/`remaining` já recebem nessa política — ver Fase 1). `target_set` = união das issues nos tiers relevantes pra política escolhida (as 4 ondas com `exhaust_all`; só a fatia bloqueada de `1a` + `1b` com `blocked_only`), populado assim que a Fase 0.5 souber a política — **imutável durante a sessão exceto por re-scan** (novatas aceitas numa re-checagem são adicionadas tanto a `target_set` quanto a `remaining`, e ao `tiers` correspondente; issue que sai de aberto — fechada fora da sessão, manualmente ou por outra sessão concorrente, ver risco de sessões paralelas no CLAUDE.md — é removida de `target_set`/`remaining`/`tiers` no próximo ciclo de re-checagem, mesmo sem nunca ter atingido um dos 5 status terminais locais). `remaining` = `target_set` menos as issues que já atingiram status terminal (`mergeada`, `draft-ci-vermelho`, `pulada` motivo `nao-destravavel-na-sessao` ou `decisao-adiada`, `entregue-fora-de-codigo`) — recalculado a cada atualização de status (mesmo ponto do passo 5 da Fase 1). `reached` = `remaining.length === 0`, só relevante quando `policy` ∈ `{exhaust_all, blocked_only}`.

`rescans_done` e `findings_depth` = **contadores puros de observabilidade no develop desde #4319** (sem cap, nenhuma lógica de parada lê o valor) — `rescans_done` incrementa a cada ciclo de re-checagem entre ondas ou re-varredura de convergência; `findings_depth` incrementa a cada finding gerado pela própria sessão que ela mesma consome. Reportados na Fase 2, não usados pra decidir nada durante a sessão. Com `policy: "table_only"`, `reached` fica `false` e ambos os contadores ficam `0` pela sessão inteira — não são avaliados, só presentes pra manter o schema estável.

`tier3_gate` = **array de disparos** do checkpoint antes do grupo 3 (seção própria, revisado #5321 — deixou de ser um gate obrigatório) — não um objeto único sobrescrito, porque pode disparar mais de uma vez na mesma sessão (fila volta pro grupo 1a, esgota de novo, retorna ao grupo 3 — cada retorno é uma reentrada, e pode registrar decisão diferente da vez anterior). Cada item: `asked_at` (timestamp ISO do disparo — nome do campo preservado por compat, o banner não é uma pergunta), `decision` ∈ `auto_entered` (default — ninguém interveio) | `editor_interrupted` (editor pediu pra pular/escolher subconjunto antes do tier abrir **por iniciativa própria dele** — nunca uma decisão do coordenador) | `coordinator_self_limited` (#5439 — o COORDENADOR decide encerrar a sessão antes do goal por um motivo próprio, ex: token budget real esgotado, tempo de execução real do harness; SEM pedido/intervenção do editor. Distinção que importa: `editor_interrupted` registra uma AÇÃO do editor; `coordinator_self_limited` registra uma decisão do coordenador sozinho — "escopo já muito extenso"/contagem de PRs/tempo decorrido/tamanho de refactor **não é** motivo válido pra nenhum dos dois em `exhaust_all`, é motivo pra continuar trabalhando; só vira `coordinator_self_limited` quando o limite é técnico e real, nunca uma leitura subjetiva de "já fiz bastante") | `entrar`|`parar`|`escolher`|`sem-resposta` (valores legados, `plan.json` gravado por sessão anterior ao #5321 — ler `entrar` como `auto_entered`, `parar`/`escolher`/`sem-resposta` como `editor_interrupted`), `selected` (array de números escolhidos quando o editor restringiu o subconjunto, `null` nos demais casos, incluindo sempre em `coordinator_self_limited`). Array vazio (`[]`) até o primeiro disparo. Um item já registrado **não** é re-disparado dentro do mesmo ciclo em resume (reler o último item do array) — mas uma nova entrada no grupo 3 depois de uma volta a tier anterior é um disparo novo, que vira um item novo no array, não um resume do anterior.

**`machine_id` (#3033).** `data/` é um junction do OneDrive sincronizado entre máquinas — o `plan.json` desta sessão fica visível pra QUALQUER outra máquina no mesmo OneDrive, e vice-versa. Ao criar/gravar `plan.json` (Fase 0 passo 9, e todo re-write subsequente), incluir o campo `machine_id` no nível raiz com o output de `npx tsx scripts/lib/machine-id.ts` (hostname desta máquina). Sem esse campo, a statusLine de outra máquina no mesmo OneDrive pode confundir o progresso desta sessão com o dela (`isForeignDevelopPlan` em `scripts/overnight-statusline.ts` filtra por esse campo; ausente = tratado como legado, não filtrado). Gravar 1x por sessão é suficiente (hostname não muda no meio de uma sessão) — não precisa reconsultar a cada write, mas preservar o campo em todo re-write do arquivo.

**`session_id` (#5156 item 11, campo ADITIVO, ainda não populado por esta skill).** `machine_id` sozinho não distingue DUAS sessões develop rodando na MESMA máquina — `isForeignDevelopPlan` foi estendida (`scripts/overnight-statusline.ts`) pra aceitar um `session_id` opcional em `plan.json`, que vira o discriminador PRIMÁRIO quando presente (mais específico que `machine_id`). Rollout pendente: `plan.json` é escrito via `Edit`/`Write` do coordenador (prosa desta skill), não por um script CLI que o hook `inject-session-id.mjs` possa interceptar — popular este campo exigiria um passo extra de query ao `session-registry.ts` (que JÁ recebe o `session_id` via injeção automática no `register` da Fase 0 passo 1) e não está implementado nesta rodada. Até lá, a statusLine cai de volta pro filtro por `machine_id` (comportamento pré-#5156, sem regressão) — duas sessões develop na mesma máquina continuam podendo se misturar na barra, risco aceito e documentado, não silencioso.

## Fronteira com o overnight nas ambíguas (cat C)

`/diaria-develop` **trabalha** as issues ambíguas de trade-off-real (cat. C — decisão de produto/editorial). **Fronteira resolvida (#2640):** o `/diaria-overnight` marca issues de trade-off-real como `pulada` motivo `ambígua/trade-off-real`, posta comentário na issue direcionando ao `/diaria-develop`, e **nunca** as inclui no seu briefing. Ambiguidade trivial-mas-não-documentada (escolha técnica sem impacto diferencial em usuário) continua no briefing do overnight; trade-off-real é escopo exclusivo do develop.

## Labels de máquina — `windows` / `server` (#5462 aposentou `local`)

**Não aplicar `local` a issue nova.** A label foi aposentada em 16/08/2026 porque colapsava três realidades distintas — máquina Windows, servidor Linux, e ação em conta de terceiro — e por isso não decidia nada. Ela continua existindo no GitHub só pelas issues **fechadas** que a carregam, e `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`) a **ignora**: uma issue marcada só com `local` cai no default `overnight`, não em `develop`. Aplicá-la hoje produz roteamento silenciosamente errado.

**Qual usar:**
- **`windows`** — exige a máquina Windows do editor: Chrome logado, ComfyUI, ou qualquer coisa que só existe lá. Classifica como **Develop** (o overnight roda no servidor Linux e não alcança).
- **`server`** — exige o servidor Linux 24/7: systemd, tarefas agendadas, Studio, OneDrive. **Não** tira do overnight — é exatamente a máquina onde ele já roda.
- **`external-blocker`** — não é máquina nenhuma: precisa de ação do editor numa conta de terceiro (allowlist, credencial, cadastro). Classifica como **Bloqueada**.

`/diaria-develop` roda por natureza com o editor presente, então issue `windows` é elegível aqui — é justamente o que o develop pega e o overnight não. `scripts/lib/exec-mode.ts` **não** decide isso: ele responde "esta sessão tem `data/`?", que no servidor Linux dá `local` inclusive pra uma issue que exige o Windows.

## Regras

- **Perguntar ao editor é permitido e central** (inverte a Regra 1 do overnight) — mas via os gates definidos; a sessão pressupõe editor presente e **nunca continua autônoma sem ele**.
- **Nunca** disparar a pipeline editorial ao vivo (mesmo guard do overnight) — **única exceção controlada:** `publish-*.ts --dry-run` p/ validar token recém-colado (cat. A), rodado pelo coordenador top-level, **nunca** pelo subagente implementador.
- **Nunca persistir segredo no repo:** credencial só em `.env`; o subagente recebe referência ao env var, **nunca o valor**.
- #633 (teste de regressão em bugfix) e validação determinística de estado externo (#573) valem a sessão inteira.
- Paralelização preserva o invariante de não-colisão do #636; cat. D sempre solo + Gate B.
- Toda issue **trabalhada ou bloqueada** recebe comentário com o que foi feito / o que falta (com dedup).
- `data/develop/` segue o blanket gitignore de `data/`.
- Stall passivo é inaceitável (#738): toda espera de CI usa `gh pr checks --watch` em background; timeout de CI = 30 min → tratar como CI vermelho.
- **Ação do coordenador que muda elegibilidade de issue já conhecida da sessão vira pendência de re-triagem (#5476, mesmo mecanismo do overnight).** Aplicar `gh issue edit N --add-label {not-this-week|trade-off-real|external-blocker|...}` fora do fluxo normal de decisão do Gate 1 (ex: reconciliação ad-hoc de labels da Triagem), ou encerrar/remover manualmente uma claim de `session-registry` mid-sessão, exige registrar: `npx tsx scripts/check-state-changed-pending.ts --add-pending {N} --plan data/develop/{AAMMDD}/plan.json`. Antes de escrever o relatório da Fase 2, checar `npx tsx scripts/check-state-changed-pending.ts --plan data/develop/{AAMMDD}/plan.json` — pendência (`exit 1`) → reavaliar dispatch pra essa issue (com o editor, se cair em cat. C) antes de fechar a sessão.

## Paralelismo entre sessões (#5156)

Esta skill e `/diaria-overnight` podem rodar **ao mesmo tempo** — mesma máquina (develop supervisionado numa janela, overnight drenando a fila noturna em outra) ou máquinas diferentes sincronizadas pelo mesmo junction OneDrive `data/`. Nenhuma das duas skills assume mais "sou a única sessão automatizada rodando". Mecanismo e convenção por item da auditoria original (#5156) — espelha a seção equivalente do `diaria-overnight/SKILL.md`, este lado documenta o que é específico do develop:

1. **`AskUserQuestion` negado por um overnight ativo na mesma máquina** — não se aplica DIRETAMENTE ao develop (o hook só nega `AskUserQuestion` a partir do marker que a sessão OVERNIGHT grava com `phase: "autonomous"` — a sessão develop nunca grava esse marker). O que mudou (#5156): antes, um overnight ativo na mesma máquina negava TODO `AskUserQuestion` da máquina, incluindo os gates desta skill — travamento duro sem workaround além de encerrar o overnight. Agora, `.claude/hooks/block-askuserquestion-overnight-autonomous.mjs` só bloqueia quando a chamada pertence à MESMA sessão que gravou o marker (`session_id`, injetado automaticamente por `.claude/hooks/inject-session-id.mjs`) — os gates bloqueantes desta skill (Gate 1, Gate de Onda, confirmação de colisão editorial) voltam a funcionar normalmente mesmo com um overnight autônomo ativo em paralelo. (O gate do grupo 3 não entra nesta lista desde #5321 — auto-entra por default, sem chamar `AskUserQuestion`; só uma intervenção do editor por iniciativa própria o afeta, e essa não passa pelo hook.) Nenhuma ação desta skill — o fix é inteiramente do lado do hook + do marker do overnight.
2. **Effort do review por PR cai pra `low` incorretamente enquanto o overnight está ativo** — mesmo fix do item 1 (`isOvernightRoundActive` session-aware em `pr-create-review.mjs`). Antes, todo PR `develop/fix-*` resolvia `low` (1 agente) sempre que qualquer overnight estivesse ativo na máquina, mesmo a skill documentando que PRs do develop deveriam resolver `max` (fleet de 5, ver "REVIEW DE FLEET PRÉ-MERGE" na seção Gates). Agora só resolve `low` se o PR pertencer à MESMA sessão overnight — o que nunca acontece pro develop, então PRs desta skill voltam a resolver `max` mesmo com overnight ativo em paralelo.
3. **Claim de issue entre sessões** — MECANIZADO via `session-registry.ts` (`is-claimed`/`claim-issue`), ver Fase 1 passo 4 acima (checado antes do fan-out, junto do Gate de Onda).
4. **Serialização de merge cross-sessão** — MECANIZADO via `session-registry.ts merge-lock-acquire`/`merge-lock-release`, ver seção Gates ("GATE 2 — IMPLEMENTAÇÃO/MERGE") acima.
5. **Checkout principal compartilhado** — SEM fix de código razoável além do merge lock do item 4. `git checkout master && git pull` (Fase 0 passo 1, e após cada merge da Fase 1) continuam sem lock próprio — risco residual raro e de baixo blast-radius, mesma nota do `diaria-overnight/SKILL.md`.
6. **Teto de concorrência por sessão** — PARCIALMENTE MECANIZADO (#5161 fleet review item 7): read-path mecanizado (`session-registry.ts list-active` soma `active_worktrees` de outras sessões antes de decidir quantos worktrees abrir nesta onda, ver "Paralelização segura" e Fase 1 passo 4 acima); write-path (`heartbeat --active-worktrees N`) **ainda não é chamado por nenhuma skill** — nenhum call site desta skill (nem do overnight) invoca esse comando conforme worktrees abrem/fecham, então `active_worktrees` fica sempre ausente na prática até isso ser implementado. A heurística do passo 4 hoje soma zero de qualquer sessão que não tenha esse write-side — não é um mecanismo furado, é um mecanismo com metade do circuito ainda não ligado.
7. **Herança de plano em voo** — MECANIZADO, ver Fase 0 passo 2 acima: `source: "inherited-overnight-in-flight"` quando a rodada overnight de origem ainda está ativa no `session-registry.ts`.
8. **Fase 1.5 revisa diff de sessão alheia** — já é o comportamento esperado ("findings sobre código alheio viram issue, nunca hotfix"), agora formalizado: com paralelismo isso é o CASO COMUM, não exceção — o diff acumulado da Fase 1.5 (e do "REVIEW DE FLEET PRÉ-MERGE" por unidade) pode incluir merges de uma sessão overnight concorrente.
9. **Cleanup de worktree global** — MECANIZADO, embutido no próprio `cleanup-merged-worktrees.ts` (ver Fase 2 acima).
10. **Marker overnight por-máquina vs por-sessão** — não se aplica ao develop (esta skill nunca escreveu/lê o marker do overnight, só o `plan.json` dele — item 7). Ver `diaria-overnight/SKILL.md` pro racional completo da coexistência marker antigo + registro novo.
11. **StatusLine mistura sessões da mesma máquina** — `isForeignDevelopPlan` (`scripts/overnight-statusline.ts`) foi estendida pra aceitar `session_id` como discriminador mais específico que `machine_id`; **wiring de `plan.session_id` ainda pendente** — ver a nota `session_id (#5156 item 11)` na seção `plan.json` acima pro racional completo e o que falta.

**Resumo do que ainda é risco aceito, não mecanizado (ou só parcialmente):** item 5 (corrida rara no checkout compartilhado, mitigada pelo merge lock do item 4), item 6 (o write-path `heartbeat --active-worktrees` ainda não é chamado por nenhuma skill — `active_worktrees` fica sempre ausente na prática, ver acima, #5161 fleet review item 7) e a metade não-wired do item 11 (duas sessões develop na mesma máquina ainda podem se misturar na statusLine até `plan.session_id` ser populado).
