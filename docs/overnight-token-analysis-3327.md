# `/diaria-overnight` — análise de consumo de tokens (#3327)

**Status:** levantamento concluído, baseado em dados reais da rodada 260711 (a
própria rodada que gerou esta issue). Não implementa nenhum corte de código —
produz o mapeamento de onde os tokens realmente foram e recomendações
priorizadas por retorno estimado, cada uma rotulada **EVIDENCIADO** (medido
nesta rodada) ou **ESPECULATIVO** (plausível, sem medição direta).

**Dataset primário:** 19 dispatches de subagente implementador (`Agent`,
`subagent_type: "general-purpose"`, `isolation: "worktree"`) na rodada
260711, cobrindo 27 issues (16 dispatches solo = 16 issues, 3 lotes = 11
issues), com `subagent_tokens`/`tool_uses`/`duration_ms` reportados pelo
coordenador ao final de cada unidade. Fonte: fornecido no prompt de dispatch
desta própria unidade (#3327/#3328) pelo coordenador da rodada — não
re-derivado, mas a aritmética abaixo (somas, médias, ratio solo/lote) foi
recalculada e conferida independentemente.

---

## 1. Onde os tokens realmente foram

| Métrica | Valor |
|---|---|
| Total de tokens em subagentes implementadores | **3.971.927** |
| Dispatches (unidades de trabalho) | 19 |
| Issues cobertas | 27 (16 solo + 11 em 3 lotes) |
| Tool uses totais | 1.389 |
| Duração cumulativa dos subagentes | 12.436.605 ms ≈ **3h27min** |
| Média de tokens/dispatch | 209.049 |
| Média de tokens/issue (ponderada por lote) | 147.108 |
| Média de tokens/tool_use | ≈ 2.860 |
| Dispatches de agente fixer (2º agente, #2038) | **0** |

**Achado central: a esmagadora maioria do orçamento de tokens da rodada está
nos subagentes implementadores, não na mecânica do coordenador.** Os 5
candidatos listados na issue original (boilerplate de dispatch, effort do
coordenador, 3 camadas de stall detection, cadeia de re-entrada de findings,
log-events/ScheduleWakeup) são todos overhead do **coordenador** — e o
dataset não inclui uma única métrica de consumo de tokens do coordenador em
si (só dos subagentes que ele despacha). Isso é uma lacuna real do
levantamento, tratada na Seção 4.

### 1.1 Solo vs. lote — o efeito de agrupamento é real e mensurável nesta rodada

| | Dispatches | Issues | Tokens totais | Tokens/issue |
|---|---|---|---|---|
| Solo | 16 | 16 | 2.996.637 | 187.290 |
| Lote | 3 | 11 | 975.290 | **88.663** |

Issues despachadas em lote custaram **~2,1× menos por issue** que issues solo
nesta rodada específica (88.663 vs. 187.290 tokens/issue). A direção bate com
o precedente já documentado no `CLAUDE.md` (medição da rodada 260630: ~26k
tokens/item em lote vs. ~114k tokens/item solo — uma razão de ~4,4×; aqui a
razão observada foi menor, ~2,1×, o que é esperado — a composição de issues
por lote varia rodada a rodada, e a amostra de "solo" desta noite inclui
issues de escopo real variável, não só issues pequenas: `#3118` é um
"umbrella" de ~15 itens dentro de 1 issue e `#3209` toca 9 arquivos, então o
bucket "solo" não é comparável item a item com o bucket "lote"). **A
conclusão qualitativa se sustenta de novo (agrupar economiza tokens/issue),
mas a magnitude exata varia — não generalizar "2,1×" nem "4,4×" como
constante fixa.**

Nota sobre o `Ratio ~2,1x`: como o teto de agrupamento do passo 6 da Fase 0
já é "cabe sem forçar compaction, não um número fixo de issues", o
mecanismo em si já está desenhado corretamente — o que falta é uma
heurística mais agressiva para PROPOR agrupamento com issues de baixo risco
(ver Recomendação 3).

### 1.2 Tokens correlacionam com tool_uses, não com o tamanho do prompt de dispatch

| Unidade | tokens | tool_uses | tokens/tool_use |
|---|---|---|---|
| #3311 (auditoria ampla) | 324.303 | 190 | 1.707 |
| #3145 | 271.275 | 108 | 2.512 |
| lote brevo-dash-ui | 341.463 | 144 | 2.371 |
| #3307 (comment-only) | 85.023 | 15 | 5.668 |
| #3269 (análise, sem código) | 226.461 | 50 | 4.529 |

A correlação forte é **tokens totais ∝ número de tool_uses** (`Read`, `Edit`,
`Bash`, `Grep`/`Glob`, saídas de teste) — a unidade com mais tool_uses
(#3311, 190 chamadas) teve o maior total absoluto de tokens, mas o MENOR
custo por tool_use (1.707), sugerindo que exploração ampla com chamadas
pequenas e repetidas (grep/read direcionado) é mais barata por chamada que
poucas chamadas "pesadas" (ex: `#3307`, comment-only, só 15 tool_uses mas
5.668 tokens/chamada — provavelmente porque cada chamada carrega mais
raciocínio/contexto por vez num PR pequeno e simples). **O boilerplate fixo
do prompt de dispatch (candidato #1 da issue) não aparece como o fator
dominante nessa variância** — unidades com prompts de dispatch
essencialmente idênticos (mesma seção "Regras obrigatórias") variam de
85k a 342k tokens, uma faixa de 4×, explicada por tool_uses e não pelo texto
fixo do prompt.

### 1.3 Sinais qualitativos fornecidos pelo coordenador — custo de token ZERO, não são candidatos

Para não perder essa evidência: os 3 achados operacionais adicionais
relatados pelo coordenador da rodada (teste flaky `test/resolve-edition-url.test.ts`
causando re-run de CI em 3 PRs; gate `check-pr-bugfix.ts` pegando o
coordenador de surpresa 2× em PRs de `.claude/agents/*.md`/comentário puro)
foram **explicitamente descritos como custando 0 tokens extras de subagente**
— só latência de wall-clock/coordenador. Não são candidatos de corte de
token por definição, mas o segundo item (gate de bugfix) tem uma
correção barata que vale anotar: ver Recomendação 7 (extra opcional).

---

## 2. Candidatos da issue original avaliados contra os dados

| # | Candidato (da issue #3327) | Evidência real desta rodada | Veredito |
|---|---|---|---|
| 1 | Boilerplate "Regras obrigatórias" repetido ~19× | Bloco-fonte no `SKILL.md` (Fase 1 passo 2, linhas 158-168) mede ~5.350 chars / ~1.338 tokens **se colado por inteiro incluindo a prosa de racional**; uma versão enxuta (só os bullets acionáveis, sem o "porquê" — o padrão real usado no dispatch desta própria unidade, ver Seção 3) fica mais perto de 400-700 tokens. Faixa estimada: **500-1.400 tokens × 19 dispatches ≈ 9.500-26.600 tokens totais**, ou **0,24%-0,67% do total de 3.971.927 tokens de subagente**. | **Real, mas pequeno em tokens de subagente.** O ganho de token é modesto; o ganho real é em **hygiene/consistência do lado do coordenador** (evita a classe de bug do #3321: convenção não seguida porque só estava documentada em prosa narrativa, não em checklist). Ver Recomendação 4. |
| 2 | Coordenador roda `effort: xhigh` a rodada inteira | **Não medido nesta rodada** — o dataset cobre só `subagent_tokens`, não o consumo do próprio coordenador (que roda ~8h, faz toda a triagem, dispatch-writing, 19× review leve de diff, compilação do relatório). | **Sem evidência direta — mas é o candidato de maior potencial teórico**, porque effort escala custo por token gerado nos modelos de raciocínio, e o coordenador é o único ator da rodada que roda o tempo inteiro. Ver Recomendação 1 (maior prioridade, mas com pré-requisito de instrumentação). |
| 3 | 3 camadas de stall detection (#2379+#2688+#2896) | Camada (ii) roda via Task Scheduler **fora da sessão Claude** — **custo de LLM = zero por definição**, é um script Node puro. Camada (iii) é 1 `ScheduleWakeup` por dispatch/resume — 19 chamadas × ~50-100 tokens ≈ ~1.000-1.900 tokens. Camada (i) é raciocínio embutido no wake normal do coordenador, sem chamada extra — só custa quando de fato dispara (halt banner + log-event), e **esta rodada teve 0 stalls conhecidos** (as 19 unidades completaram na 1ª invocação, zero `SendMessage`/resume por travamento). | **Já são baratas quando ociosas — o dataset desta rodada confirma isso diretamente** (zero disparos, custo perto de zero). Cortar aqui não ataca o vetor de custo real (ver Seção 1). Ver Recomendação 6 (não cortar). |
| 4 | Cadeia de re-entrada de findings (depth 0→1→2) | **Não medido nesta rodada.** "Zero dispatches de agente fixer" no dataset é sobre o fixer do fluxo de 2 agentes DENTRO da Fase 1 (self-review de cada PR) — não diz nada sobre se a Fase 1.5 rodou, em qual profundidade parou, quantos findings surgiram ou foram filados. | **Sem evidência nem a favor nem contra.** Não dá pra concluir se depth-2 se paga ou não com o que foi fornecido. Ver Recomendação 5 (instrumentar antes de decidir). |
| 5 | Log-events + ScheduleWakeup a cada dispatch/resume | Lido `scripts/log-event.ts` (115 linhas) — CLI trivial, 1 append JSONL, saída de 1 linha (`logged {level} → {path}`). Custo por chamada ≈ 150-300 tokens (comando + stdout curto). Volume estimado: ~3-4 log-events por unidade (dispatch, pr_opened, ci_green/merged, ocasionalmente fix_iteration) × 19 unidades ≈ 60-76 chamadas ≈ **11.000-23.000 tokens no total**, mais ~1.000-1.900 do `ScheduleWakeup`. Tudo isso é custo do **coordenador**, não aparece no total de 3.971.927 (que é só subagente). | **Confirmado barato — a própria issue já suspeitava disso** ("não parece o maior vetor de custo"). Não vale engenharia. Ver Recomendação 6. |

---

## 3. O que os dados NÃO cobrem (lacunas do levantamento)

1. **Tokens do próprio coordenador.** A rodada inteira (~8h, 19 dispatches,
   triagem de ~57+ issues, 19× review leve de diff, compilação do relatório
   final) roda em `sonnet`/`xhigh` no coordenador — mas nenhuma métrica de
   consumo de token do coordenador em si foi fornecida ou está disponível
   nos artefatos padrão da rodada (`plan.json` não grava isso;
   `run-log.jsonl` também não). Sem essa métrica, qualquer recomendação
   sobre baixar o `effort` do coordenador (candidato #2) é necessariamente
   especulativa quanto à magnitude — só o mecanismo (effort escala custo)
   é bem estabelecido em outras partes do repo (`CLAUDE.md`, #3218).
2. **Profundidade real da cadeia de findings (1.5/1.5b/1.5c) nesta
   rodada.** Não sabemos se ela rodou, nem quantos findings surgiram, nem
   quantos foram filados vs. descartados pela barra de filing (#2754).
3. **Distribuição de tempo entre CI-wait e trabalho ativo do coordenador.**
   A soma de `duration_ms` dos subagentes (~3h27min) é bem menor que a
   duração total da rodada (~8h, "loop estendido"). A diferença (~4h30min) é
   coordenador + espera de CI + Fase 0 (briefing) + Fase 1.5 (review
   consolidado) + Fase 2 (relatório) — não é um dado de token, mas contextualiza
   que uma fatia grande do tempo da noite não é "subagente rodando".

---

## 4. Recomendações priorizadas

Cada item traz: rótulo de evidência, risco, esforço de implementação,
retorno estimado.

### 1. Instrumentar tokens do próprio coordenador **(EVIDENCIADO como lacuna; pré-requisito para o resto)**

- **Risco:** nenhum (só observabilidade).
- **Esforço:** baixo — logar, ao final de cada fase (Fase 0, cada unidade
  da Fase 1, Fase 1.5, Fase 2), um evento `coordinator_tokens_estimate` no
  run-log (se o harness expuser `usage` da sessão programaticamente) ou, na
  falta disso, ao menos registrar `context_size_estimate` a cada
  compaction/checkpoint como proxy.
- **Retorno:** hoje ~50% do orçamento real de tokens da rodada (o lado do
  coordenador) é invisível. Toda decisão sobre effort/model do coordenador
  continua no escuro até isso existir. **Este é o item que desbloqueia
  medir de verdade a Recomendação 2** em vez de "mergear e torcer".

### 2. Baixar `effort: xhigh` → um nível menor no coordenador **(ESPECULATIVO no tamanho do ganho; mecanismo bem estabelecido)**

- **Risco:** baixo — mudança reversível de 1 linha no frontmatter do
  `SKILL.md`, sem tocar lógica. Precedente direto: `orchestrator`,
  `scorer-select` e `analyst-monthly` já rodam em `effort: low` (#3218) sob
  o racional de que "julgamento holístico não precisa de reasoning effort
  alto" — o coordenador do overnight faz majoritariamente triagem
  estruturada + gate de 2 condições + review consolidado, tarefas do mesmo
  gênero.
- **Esforço:** trivial (1 linha), mas só deve ser feito **junto com** a
  Recomendação 1, ou o resultado nunca é medido e a mudança fica no mesmo
  regime de "achismo" que a issue pede pra evitar.
- **Retorno:** potencialmente o maior de todos os candidatos (effort é
  historicamente o driver de custo mais não-linear em modelos de
  raciocínio), mas **não há dado desta rodada que quantifique isso** — é o
  único candidato onde "maior retorno provável" e "zero evidência direta"
  coexistem.
- **Precedente operacional direto:** a memória do editor já registra que,
  para troca de config barata/reversível (model tier, effort), a preferência
  é **mergear e monitorar pós-hoc**, não travar numa A/B prévia (#3216/#3218,
  260710). Aplica-se aqui sem ressalva — não é preciso rodar 2 rodadas
  paralelas pra comparar; basta trocar, instrumentar (Recomendação 1) e
  observar a próxima rodada.

### 3. Agrupamento mais agressivo para unidades de baixo risco **(EVIDENCIADO — direção; magnitude por rodada)**

- **Risco:** baixo — o próprio agrupamento já é gated por "nenhuma issue do
  lote conflita com outra"; a mudança é só tornar a heurística do passo 6
  mais propensa a sugerir lote para issues de tipo comprovadamente seguro
  (docs-only, comment-only, mudança isolada em 1 `.claude/agents/*.md`),
  independente de "mesmo subsistema" — issues pequenas e de baixo blast
  radius podem compartilhar 1 subagente mesmo sem relação temática, porque
  o ganho vem do bootstrap amortizado (`npm ci`, exploração de convenções),
  não da coesão editorial.
- **Esforço:** médio — ajustar o critério do passo 6 da Fase 0 (`SKILL.md`)
  para incluir explicitamente "baixo-risco + baixo-blast-radius" como
  critério de agrupamento alternativo a "mesmo subsistema".
- **Retorno:** nesta rodada, 5 das 16 unidades solo eram candidatas
  plausíveis a esse tipo de agrupamento por perfil de risco (`#3306`
  agent-prompt, `#3326`, `#3256`, `#3259` docs, `#3307` comment-only),
  somando **630.582 tokens reais** para essas 5 issues (média de
  126.116 tokens/issue — já abaixo da média solo geral de 187.290, porque
  são issues simples). Se essas 5 tivessem sido despachadas como 1 lote à
  taxa batch observada nesta rodada (~88.663 tokens/issue), o custo
  hipotético cairia para ~443.315 tokens — uma economia da ordem de
  **~187.000 tokens nesta rodada específica** (calculado a partir dos
  valores reais dessas 5 unidades, não da média solo geral — usar a média
  geral aqui teria inflado a estimativa). **Não é uma constante garantida
  para toda rodada futura** — a taxa batch varia com a composição real do
  lote (#2754 já observou taxas de 26k a 89k tokens/item batch em rodadas
  diferentes) — mas confirma que o efeito é real e da ordem de centenas de
  milhares de tokens por rodada, não desprezível.

### 4. Dedup do boilerplate "Regras obrigatórias" em arquivo compartilhado **(EVIDENCIADO — real, mas pequeno)**

- **Risco:** baixo-médio — o texto em si é trivial de extrair, mas o
  arquivo-fonte (`SKILL.md`) é lido/seguido em produção toda noite; um erro
  de referência (path errado, arquivo não commitado no worktree do
  subagente) quebraria dispatches silenciosamente.
- **Esforço:** baixo — criar algo como
  `context/overnight-dispatch-rules.md` com os bullets acionáveis (branch
  convention, bootstrap, testes #2959, self-review #2038, guard de
  publicação), e o `SKILL.md` passa a instruir o coordenador a **citar o
  path no prompt de dispatch** em vez de reproduzir o texto — o subagente lê
  via `Read` no início da sua própria sessão. Nota importante de
  expectativa: **isso não elimina o custo do subagente ler o conteúdo**
  (ele ainda precisa carregar o texto no próprio contexto, só que via
  `Read` em vez de prompt inicial) — o ganho de token é majoritariamente do
  lado do **coordenador** (prompt de dispatch mais curto, menos texto
  crescendo na própria conversa do coordenador ao longo da noite), estimado
  em ~9.500-26.600 tokens/rodada (Seção 2, item 1) — não nos 3,97M do lado
  do subagente.
- **Retorno real:** modesto em tokens (<1% do total medido), mas **positivo
  em manutenibilidade** — centraliza a fonte da verdade e reduz o risco da
  classe de incidente #3321 (convenção documentada só em prosa, ignorada
  numa rodada inteira porque não estava em formato checklist explícito no
  ponto de uso).
- **Por que não foi implementado nesta unidade:** editar `SKILL.md` é editar
  um prompt de orquestração usado em produção toda noite, com blast radius
  real (afeta merges autônomos em master) — diferente do precedente do
  #3269 (extração de `tealDot()`, uma função pura sem efeito em decisão
  autônoma). O retorno de token é pequeno o bastante para não justificar
  esse risco sem revisão dedicada e teste do fluxo de dispatch real.

### 5. Instrumentar a cadeia de findings (depth 0→1→2) antes de cortar **(lacuna, não uma recomendação de corte)**

- **Risco:** nenhum (observabilidade).
- **Esforço:** baixo — já existem os campos `findings_depth` e
  `review_1_5b_has_p2` em `plan.json`; falta só agregar, ao longo de
  5-10 rodadas, quantas vezes a cadeia chega a depth 1 vs depth 2, e quantos
  findings P2+ cada nível realmente produz.
- **Retorno:** decide com dado se depth-2 (1.5c) se paga. O `CLAUDE.md` já
  documenta o tipo de evidência que justificaria um corte (rodada 260630:
  issues follow-up-de-follow-up custaram ~413k tokens numa única rodada,
  o que motivou a barra de filing #2754) — mas essa mitigação **já existe**
  desde então; antes de cortar depth-2 de novo, medir se a barra de filing
  já reduziu a taxa de disparo de mini-rodadas o suficiente.

### 6. NÃO cortar: 3 camadas de stall detection, log-events, ScheduleWakeup **(EVIDENCIADO — já são baratas)**

- Confirmado pela leitura direta dos scripts (`log-event.ts`,
  `overnight-fallback-wake.ts`) e pelo dataset desta rodada (zero stalls,
  custo perto de zero quando ociosas). Cortar qualquer uma das 3 camadas
  reintroduziria exatamente os incidentes que cada uma fechou (#2768,
  #2896, #2379 — ver histórico extenso já documentado no `SKILL.md`), por
  uma economia de tokens que os próprios números desta rodada mostram ser
  desprezível. **Risco alto, retorno perto de zero — não vale a pena.**

### 7. Extra opcional, baixíssimo risco: marcador `no-regression-test` proativo para PRs docs/comment-only

- **Risco:** muito baixo.
- **Esforço:** trivial — 1 linha a mais na seção de instruções obrigatórias
  do dispatch: "se a unidade é só docs/comentário/prompt sem código
  executável, incluir desde o início no PR body o marcador literal
  `no-regression-test: <razão>` — não esperar o hook `check-pr-bugfix.ts`
  reclamar."
- **Retorno:** evidenciado por esta própria rodada — o gate pegou o
  coordenador de surpresa **2 vezes** (PR de mudança em `.claude/agents/*.md`
  e PR de comentário puro), cada vez custando 1 rodada extra de
  `gh pr edit --body-file` + espera de CI. Custo de token é ~zero (é
  latência de coordenador, não tokens de subagente, conforme a Seção 1.3),
  então este item é sobre reduzir fricção/latência, não tokens — incluído
  aqui só porque está diretamente evidenciado nos dados fornecidos e é
  praticamente gratuito de implementar junto da Recomendação 4 (mesma
  seção do arquivo compartilhado).

---

## 5. Resumo executivo

Os tokens desta rodada foram dominados (>99%, pela própria natureza do
dataset) pelos 19 subagentes implementadores — não há evidência de que os
5 candidatos de overhead mecânico da issue original (boilerplate, stall
detection, log-events) sejam, individualmente, vetores de custo relevantes;
os 3 primeiros já foram medidos como pequenos ou nulos aqui. O único
candidato com **potencial de alto retorno é o `effort` do coordenador**, mas
justamente esse é o único sem nenhuma medição direta nesta rodada —
recomendação principal: instrumentar o consumo do coordenador (Recomendação
1) e só então trocar o effort com monitoramento pós-merge (Recomendação 2),
seguindo o precedente já estabelecido pelo editor para esse tipo de troca.
Em paralelo, o lote de segunda maior confiança é tornar o agrupamento de
issues pequenas mais agressivo (Recomendação 3) — o efeito de lote
(~2,1× menos tokens/issue) já está confirmado nesta própria rodada.
