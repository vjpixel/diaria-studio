# `/diaria-develop` — análise de consumo de tokens (#3328)

**Status:** levantamento concluído. **Necessariamente mais especulativo que
a análise irmã de `/diaria-overnight` (#3327, `docs/overnight-token-analysis-3327.md`)**
— não existe, até o momento, um dataset real de uma rodada `/diaria-develop`
com `subagent_tokens`/`tool_uses`/`duration_ms` por unidade. Este documento
(a) transplanta o que generaliza da análise do overnight (mesma maquinaria de
implementação reusada, ver `SKILL.md` linha 24), (b) identifica onde a
mecânica do develop **diverge de fato** do overnight por leitura direta dos
dois `SKILL.md` (não por suposição), e (c) recomenda como e quando medir uma
rodada real antes de agir em qualquer coisa não-trivial. Todo item abaixo
está rotulado **EVIDENCIADO** (confirmado lendo `.claude/skills/diaria-develop/SKILL.md`
e/ou `.claude/skills/diaria-overnight/SKILL.md` diretamente) ou
**ESPECULATIVO** (hipótese razoável, sem dado de nenhuma rodada real).

---

## 1. Por que este documento parte de uma base mais fraca

A issue #3327 teve a sorte de nascer no meio de uma rodada overnight que já
tinha 19 dispatches medidos. Não existe equivalente para `/diaria-develop`
nesta sessão — a skill não rodou hoje. Isso significa:

- Nenhum número de `subagent_tokens`, `tool_uses` ou `duration_ms` real está
  disponível para develop.
- Toda estimativa de "quanto custa" abaixo é **transplantada por analogia**
  do overnight (mesmo tipo de subagente `general-purpose` com
  `isolation: worktree`, mesmo bootstrap `npm ci` + `tsc --noEmit` + testes
  afetados, mesmo self-review + fixer + gate de 2 condições — tudo reusado
  verbatim, conforme documentado na própria `SKILL.md` do develop, linha 24)
  — mas a analogia tem limites reais listados na Seção 3.
- **A recomendação de maior prioridade deste documento é, portanto,
  instrumentar a PRÓXIMA rodada real de `/diaria-develop`** com as mesmas
  3 colunas (`subagent_tokens`, `tool_uses`, `duration_ms`) que permitiram a
  análise do #3327, antes de decidir qualquer corte não-trivial (Recomendação
  1).

---

## 2. O que transplanta do overnight (mesmo mecanismo, mesma conclusão provável)

### 2.1 Boilerplate de dispatch repetido por unidade

O `SKILL.md` do develop (linha 24) documenta o "reuso verbatim" da Fase 1 de
implementação do overnight numa única frase densa que cobre: `npm ci` →
`tsc --noEmit` → testes afetados (nunca suíte completa, #2959) → branch → PR
`Closes #NNNN` → self-review (#2038) → fixer 2-agentes → resolução de
threads com carve-out FORBIDDEN → gate determinístico (#2210/#2222) →
squash-merge → verify (#573) → #633 (regressão em bugfix) → retry
GitHub 401/429 → guard de publicação → #738 (fail-fast MCP) → `plan.json`
como fonte pós-compaction → timeline via `render-overnight-timeline.ts`.

Isso é o **mesmo tipo de boilerplate** identificado no #3327 — um bloco fixo
de regras que precisa ser comunicado a cada subagente dispatchado. A análise
do #3327 (Seção 2, item 1) mediu esse candidato como real porém pequeno
(~0,24%-0,67% do total de tokens de subagente na rodada overnight, dado que
o texto fixo não domina a variância de tokens entre unidades — o que domina
é `tool_uses`). **Não há razão estrutural para esperar um resultado
qualitativamente diferente em develop** — é o mesmo tipo de subagente
implementador rodando a mesma maquinaria. **EVIDENCIADO por analogia direta
de mecanismo, não por medição própria.**

Recomendação transplantada: se a extração para arquivo compartilhado
(Recomendação 4 do #3327) for feita, fazer **uma vez só, cobrindo os dois
prompts de dispatch** (overnight E develop apontam pro mesmo arquivo em
`context/`) — não duplicar o trabalho de extração por skill.

### 2.2 Log-events + timeline

O develop já reusa `scripts/log-event.ts` e
`scripts/render-overnight-timeline.ts` (linha 116, com `--title`/`--total-label`
customizados via o parâmetro fluxo-neutro `renderTimeline`, #2637) —
mesma mecânica, mesmo custo marginal por chamada (~150-300 tokens,
confirmado por leitura do script no #3327). **Volume por rodada não é
conhecido** (não sabemos quantas unidades uma sessão develop típica
despacha), mas o custo por chamada é idêntico ao overnight. **EVIDENCIADO
o mecanismo, ESPECULATIVO o volume total.**

### 2.3 Análise de cluster de conflito já otimizada para fila grande

Vale registrar que o develop **já tem** uma otimização de token equivalente
ao que a Recomendação 3 do #3327 propõe para o overnight: para filas
>8 issues validadas na onda (#2754), a análise de cluster de conflito
(mapeamento de arquivos por issue) pode ser delegada a um subagente
`general-purpose` com `model: haiku` explícito em vez do coordenador rodar
isso serialmente — só essa etapa de mapeamento (puro grep/leitura), nunca a
implementação em si (que continua sempre `sonnet`). **Não é um candidato de
corte — já está implementado.** Mencionado aqui para não perder o achado
positivo: uma otimização de token já existe no develop que o overnight
sequer precisa (o overnight nunca tem uma "onda" de >8 issues simultâneas
por construção do #636).

---

## 3. Onde a analogia com overnight quebra — diferenças reais confirmadas por leitura do `SKILL.md`

### 3.1 As 3 camadas de stall detection do overnight **não existem no develop — nada a cortar**

Busca direta por `ScheduleWakeup`, `stall_events`, `watchdog`,
`check-watchdog-armed`, `overnight-fallback-wake` e `classifyResumeSignal` no
`.claude/skills/diaria-develop/SKILL.md` não retorna nenhuma ocorrência
funcional (a única menção a "watchdog" no arquivo é dentro da definição da
label `local`, citando `scripts/overnight-watchdog.ts` como exemplo de
recurso machine-local — não uma chamada real dentro do fluxo do develop). A
única menção a stall no develop é a linha final de Regras: "Stall passivo é
inaceitável (#738): toda espera de CI usa `gh pr checks --watch` em
background; timeout de CI = 30 min → tratar como CI vermelho" — ou seja,
develop herda **só** o timeout de CI simples, nenhuma das 3 camadas
específicas do overnight (#2379 detecção-no-wake, #2688 watchdog externo,
#2896 fallback wake determinístico).

**Isso confirma diretamente a intuição já registrada na issue #3328**
("as 3 camadas de stall detection do overnight fazem menos sentido aqui")
— mas com uma correção importante: **não é um candidato de corte, porque
não há nada lá pra cortar.** O develop nunca replicou esse mecanismo. Não
existe economia de token a capturar aqui — é um item que a issue original
levantou como hipótese e que a leitura do código já resolve (negativamente,
no sentido de "não se aplica").

### 3.2 Develop não pina `model`/`effort` no frontmatter — overnight pina os dois

Comparação direta dos dois arquivos de frontmatter:

| Skill | `model` | `effort` |
|---|---|---|
| `/diaria-overnight` | `sonnet` (explícito, #2941) | `xhigh` (explícito, #2941) |
| `/diaria-develop` | **ausente** | **ausente** |

O overnight pina os dois explicitamente (racional documentado: "o coordenador
é majoritariamente orquestração + decisão estruturada... rodar o coordenador
em Opus por horas custaria mais sem ganho proporcional"). O develop **não
pina nada** — o coordenador do develop roda com o que quer que seja o
modelo/effort ambiente da sessão interativa do editor no momento da
invocação. Isso é uma diferença estrutural real, não mencionada na issue
original, e tem duas leituras possíveis:

- **Leitura A (risco de custo):** se o editor costuma manter a sessão
  interativa em Opus/effort alto (razoável para trabalho supervisionado de
  julgamento ao vivo — decisões cat. C, avaliação de Gate B), o coordenador
  do develop pode estar rodando, sem intenção explícita, num regime mais
  caro que o do overnight durante as fases mecânicas (Fase 1 implementação,
  Fase 1.5 review leve) que não exigem esse nível de raciocínio.
- **Leitura B (design intencional):** ao contrário do overnight (autônomo,
  sem editor pra consultar), o develop existe justamente para decisões que
  precisam de julgamento humano-assistido ao vivo (cat. C/D/E) — manter o
  coordenador num modelo mais forte pode ser a escolha certa aqui, porque a
  qualidade da mediação de decisão importa mais do que no overnight.

**Não dá pra saber qual leitura está certa sem medir** — mas o fato de não
haver pin nenhum (nem para "mais barato" nem confirmando "mais forte de
propósito") sugere que a ausência é por omissão, não por decisão explícita
registrada. Recomendação: decidir e pinar intencionalmente (Recomendação 3),
independente da direção escolhida — previsibilidade de custo é boa por si
só.

### 3.3 Paralelização de até 6 worktrees — otimiza velocidade, não tokens, por design explícito

Diferente do overnight, cuja `SKILL.md` afirma explicitamente "overnight
otimiza tokens, não tempo" (racional do #2754 para o teto de lote), o
`SKILL.md` do develop afirma o **oposto** para o teto de paralelização:
"develop otimiza velocidade, não tokens" (linha 43, racional do teto de 6
worktrees). Isso é uma inversão real de objetivo entre as duas skills, e
tem uma implicação direta para qualquer recomendação de corte de token
aqui: **paralelizar N worktrees concorrentes paga o custo fixo de bootstrap
(`npm ci`, exploração de convenções) N vezes**, exatamente o mesmo efeito
que motiva o agrupamento em lote no overnight (Recomendação 3 do #3327) —
mas em develop essa redundância é uma **troca consciente e documentada**,
não um descuido. Reduzir paralelização para economizar o bootstrap
repetido:

- **cortaria exatamente o objetivo declarado da skill** (throughput/latência
  com o editor presente e aguardando), e
- teria retorno de token real (mesma lógica do #2754 — bootstrap amortizado),
  mas ESSE NÃO É O TRADE-OFF QUE O DEVELOP FAZ POR DESIGN.

**Recomendação: não propor reduzir o teto de paralelização como corte de
token.** Se o editor concordar explicitamente que token importa mais que
velocidade numa sessão develop específica, a ferramenta já existe:
`--serial` (desliga a paralelização, volta a 1-PR-por-vez) fica disponível
como opt-in por sessão — não precisa virar o default.

### 3.4 Briefing front-loaded (Fase 0.5, #2966) já é uma otimização de token/interrupção

O develop já resolve, por construção, a preocupação equivalente ao "gate de
efeito repetitivo" do overnight: a Fase 0.5 já front-loada TODAS as
perguntas antecipáveis (ordem de ataque, decisões cat. C em lote, tokens
cat. A em lote, confirmações cat. B em lote, política de onda, política de
pré-autorização cat. D) numa sequência de chamadas `AskUserQuestion` no
início da sessão, precisamente para minimizar interrupções mid-sessão. Isso
já é o padrão "pergunte tudo de uma vez" que se poderia propor como
otimização — **já implementado**, não é candidato de corte adicional.

### 3.5 Cadeia de re-entrada de findings (depth 0→1→2) não existe no develop

A Fase 1.5 do develop é explicitamente "mais leve" — roda **só se houve ≥1
merge e o diff > ~50 linhas**, um único `/code-review` sem `--comment`, sem
a cadeia depth-2 do overnight ("se o editor quer atacar um finding na hora,
ele vira a próxima issue da Fase 1" — resolvido interativamente, não via
mini-rodada autônoma). **Candidato #4 da issue-irmã #3327 (vale depth-2?)
não se aplica ao develop — já é mais enxuto por design.**

---

## 4. Candidatos da issue #3328 avaliados um a um

| # | Candidato (da issue) | Achado | Veredito |
|---|---|---|---|
| 1 | Boilerplate de dispatch repetido (herdado do #3327) | Mesmo mecanismo do overnight; overnight mediu impacto pequeno (~0,24-0,67% do total de subagente) | **Provavelmente pequeno também — transplantar a mesma prioridade baixa-mas-real do #3327** (Recomendação 2, Seção 5) |
| 2 | 3 camadas de stall detection fazem menos sentido no develop | Confirmado por leitura direta: **não existem no develop** | **Não é um corte — não há nada lá.** Fechado sem ação. |
| 3 | Paralelização de 6 worktrees paga bootstrap N vezes | Confirmado: é o mesmo padrão de redundância do #2754, mas aqui é **trade-off intencional documentado** (velocidade > token) | **Não recomendado como corte** — cortaria o propósito declarado da skill. `--serial` já existe como opt-in. |
| 4 | "Perguntar é permitido e central" — não cortar a interação, só o overhead mecânico ao redor | O overhead mecânico ao redor (log-events, timeline) já é idêntico ao overnight em custo por chamada (confirmado por reuso de script) | Nenhuma ação nova — já herda o padrão barato do overnight nesse eixo específico. |

---

## 5. Recomendações priorizadas

### 1. Instrumentar a próxima rodada real de `/diaria-develop` **(pré-requisito de tudo que segue)**

- **Risco:** nenhum.
- **Esforço:** baixo — reportar, ao final de cada unidade despachada
  (issue solo ou onda), as mesmas 3 métricas usadas no #3327:
  `subagent_tokens`, `tool_uses`, `duration_ms`. Como o develop já usa
  `plan.json` com timeline por unidade (`scripts/render-overnight-timeline.ts`),
  o `timeline` já dá `duration_ms` de graça — falta só capturar
  `subagent_tokens`/`tool_uses` do retorno de cada subagente (se o harness
  expuser essa informação por invocação do `Agent` tool).
- **Retorno:** transforma toda a Seção 3 deste documento de "leitura de
  código + analogia" para "medido" — a mesma virada de qualidade que
  diferenciou a análise do #3327 (com dados) de uma análise puramente
  especulativa.

### 2. Se a extração de boilerplate do #3327 (Recomendação 4) for feita, cobrir os dois prompts numa passada só

- **Risco:** baixo-médio (mesmo risco documentado no #3327 — edita um
  `SKILL.md` de produção).
- **Esforço:** marginal, se a Recomendação 4 do #3327 já estiver sendo
  feita — é o mesmo arquivo compartilhado, só apontado pelas duas skills.
- **Retorno:** modesto em token (mesma ordem de grandeza do #3327, não
  medido para develop especificamente), mas evita fazer o trabalho de
  extração duas vezes.

### 3. Decidir e pinar `model`/`effort` do coordenador develop explicitamente **(ESPECULATIVO na direção do ganho, EVIDENCIADO que hoje não há decisão registrada)**

- **Risco:** baixo — mudança de frontmatter, reversível.
- **Esforço:** trivial — mas requer uma decisão real do editor primeiro
  ("develop deveria rodar mais forte que overnight por causa do julgamento
  ao vivo, ou o custo extra não se justifica nas fases mecânicas?"), não é
  uma mudança puramente mecânica como a do #3327.
- **Retorno:** desconhecido em magnitude (pode ser economia OU pode
  confirmar que o regime atual já é o correto) — o valor real desta
  recomendação é **previsibilidade**, não necessariamente economia. Uma vez
  pinado, a Recomendação 1 (instrumentação) permite medir se valeu a pena.

### 4. Não propor cortar paralelização nem front-loading — já otimizados para o objetivo certo

- Ambos já resolvidos por design (Seção 3.3, 3.4). Incluído aqui só para
  registrar explicitamente que foram avaliados e descartados como
  candidatos, não esquecidos.

---

## 6. Resumo executivo

Diferente do #3327, este documento não tem uma rodada real para medir —
toda conclusão aqui é leitura de código + transplante por analogia
mecanicista, e está rotulada como tal ao longo do texto. As duas conclusões
mais seguras (por serem verificáveis diretamente no `SKILL.md`, não por
estimativa) são: **(1)** as 3 camadas de stall detection do overnight
simplesmente não existem no develop — não há corte a fazer aí, contrariando
a premissa implícita de que seria um "candidato mais óbvio que no overnight"
citada na issue; **(2)** a paralelização de 6 worktrees é uma troca
intencional de token por velocidade, documentada explicitamente no próprio
`SKILL.md` ("develop otimiza velocidade, não tokens") — reduzi-la para
economizar token contrariaria o propósito declarado da skill, não é um bug
a corrigir. A ação de maior valor imediato é instrumentar uma rodada real
(Recomendação 1) — sem isso, qualquer decisão sobre o `effort` do
coordenador (a única lacuna estrutural real encontrada: develop não pina
`model`/`effort`, ao contrário do overnight) fica no mesmo regime de
"achismo" que a issue-irmã #3327 pede para evitar.
