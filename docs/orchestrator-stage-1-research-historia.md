# Histórico — `.claude/agents/orchestrator-stage-1-research.md`

Narrativa histórica de incidente/decisão extraída do playbook operacional do
Stage 1 (#4816 — reduzir volume de prompt lido em toda edição sem perder o
histórico). Cada seção abaixo tem um link de volta a partir do trecho
correspondente em `orchestrator-stage-1-research.md`.

**Não editar a instrução operacional aqui** — este arquivo é só o "por que
chegamos aqui"; o "o que fazer" continua, íntegro e na mesma ordem, no
playbook original.

---

### 1a new entries 0 confiavel por construcao

Antes, o drain dependia de um forward `diariaeditor@gmail.com` →
`vjpixel@gmail.com` + filtro + label — 3 elos externos que podiam quebrar sem
sinal nenhum, deixando `new_entries: 0` indistinguível de "editor não enviou
nada" (caso real: 260709, 11 forwards perdidos silenciosamente, #3199/#3215).
Desde #3217, a query (`in:sent to:diariaeditor@gmail.com`) busca DIRETO na
pasta Enviados da própria conta autenticada — não há mais elo externo que
possa quebrar silenciosamente sem também quebrar a autenticação Gmail MCP em
si (que já é fail-fast).

### 1d eia compose bash background

Antes era dispatched como Agent Haiku que apenas invocava o script — wrapper
redundante, removido em #1111.

### 1f nunca pule

260512 incidente, mesma classe do #594.

### path a logging decisao

Esse fallback era completamente silencioso — nenhuma entrada em
`run-log.jsonl`, só descoberto via garimpo manual de `data/brave-credits.jsonl`.

### path a validacao paridade

Validação side-by-side em 260529 confirmou cobertura comparável + 10× speed
em relação aos agents Haiku (Path B).

### 2313 how to slots

Em 260616, 10 discovery-searcher rodaram mas ZERO com query casual.

### 2668 reconciliar path b

Substitui o estimate frágil `N*2+M+J` do #2608, que nunca rodava → 0
estimadas em maio+junho → causa do esgotamento dos $5 em jun/2026.

### 1h automatizado via script

#594 — passo skipado em 260505, 0 dos 26 envios entraram.

### 1i browser concurrency

Em 260506 (227 uncertain), serial era ~26-30min, com concurrency=4 cai pra
~7min, com concurrency=8 esperado ~4min.

### 1q paridade chunked

Paridade validada: top-6 overlap 5/6 vs. single-call, dentro do ruído
run-to-run do próprio scorer.

### 1v use melhor caso real

260604: dois posts da `latent.space` entraram em USE MELHOR sendo
newsletter/análise/cobertura, não tutorial — motivou o guard determinístico
warn-only que hoje pega esse mal-bucketamento antes do gate.

### 1v quater caso real

260602: destaque sobre o lançamento do RTX Spark usava um link de cobertura
de imprensa (Canaltech) em vez da fonte oficial — a regra #160 (LANÇAMENTOS
só com link oficial) cobria a seção LANÇAMENTOS, mas destaques sobre
lançamentos escapavam desse guard.

### 1v quinquies caso real

Edição 260727: D2 apontava pro Tecnoblog enquanto o anúncio oficial da
Anthropic (score 72) estava no RADAR, a um bucket de distância — passou
batido pelos guards existentes.

### 4955 summary sumindo do pool

Edição 260811 ao vivo: 9 de 10 artigos chegaram ao Stage 4 sem `summary`,
bloqueando o gate (`secondary-items-have-summary`). O campo existia em
`researcher-results.json` mas já estava ausente no PRIMEIRO snapshot do pool
(`tmp-articles-raw.json`) — a montagem era um passo implícito do orchestrator
(LLM), sem schema explícito, o que permitiu reconstrução manual do artigo
campo a campo em vez de repasse verbatim. Mesmo racional de
`assemble-scored.ts` (#1611/#720): assemblar em TS evita pedir pro agent
copiar array grande verbatim.

### 4985 contrato pool-flatten

Detalhe completo do contrato de `assemble-research-pool.ts` (#4985 — a versão
resumida vive em §1g-ter do playbook):
1. **Entra:** `researcher-results.json` — `RunRecordLike[]` (`{ source, outcome?/status?, articles?: Array<Record<string, unknown>> }`), um record por `source-researcher`/`discovery-searcher`/RSS/websearch dispatchado no passo 1f/1g.
2. **Sai:** `tmp-articles-raw.json` — `PoolArticle[]` flat (`{ url, [demais campos do artigo] }`), achatado de todos os `articles[]`.
3. **Campos garantidos preservados:** TODOS os campos originais de cada artigo, verbatim — via spread (`{ ...a, url: a.url, source: ... }`), nunca reconstrução campo a campo. Isso inclui `summary`, `title`, `published_at`, `author`, `type_hint` e qualquer campo futuro que um researcher venha a adicionar (não há allowlist de campos).
4. **Transformações aplicadas:** (a) só runs com `outcome`/`status` "ok" ou "empty" entram (`fail`/`timeout` descartados); (b) `source` é preenchido a partir do próprio artigo se já tiver (Path A/Brave), senão herdado do `source` do RunRecord (Path B/agents); (c) merge-safe — se `--out` já existir (resume), URLs já presentes são preservadas como estão, só URLs novas são anexadas.

### 4986 checkpoint de integridade

#4988/#4985/#4986 foram os outros 3 relatos do auto-reporter pro MESMO
incidente 260811 acima (#4955) — 2 duplicatas de causa raiz (#4988: 8/9
LANÇAMENTOS/RADAR sem `summary`; #4986: D1 especificamente) + 1 pedido de
documentação (#4985, resolvido acima em §1g-ter). A causa raiz já estava
corrigida por `assemble-research-pool.ts` quando esses 3 foram triados — o
trabalho restante foi (a) confirmar com teste de ponta-a-ponta
(`test/stage1-summary-pipeline-integration.test.ts`) que o pipeline real
(`dedup.ts`/`categorize.ts`/`merge-scored-chunks.ts`, todos scripts TS que já
preservam campos via spread) não reintroduz a perda em nenhum passo
intermediário, e (b) adicionar o backstop determinístico pedido pelo #4986
item 3 — `scripts/verify-summary-integrity.ts`, rodado em 1m-bis (pós
dedup+categorize) e 1q.3-bis (pós merge de finalists). Loga violação em
`data/run-log.jsonl` via `logEvent` (padrão já existente no repo) — não um
arquivo `invariant-violations.jsonl` dedicado, que não existe em nenhum outro
ponto do pipeline.

### 4b 4678 caso real

260806: item resgatado com `category: "lancamento"` fixo era na verdade
cobertura de incidente de segurança, corrigida manualmente só no gate humano
do Stage 4.

### 5471 1m-ter fora de ordem

Auto-reporter da edição 260817 (2026-08-16, `data/run-log.jsonl`
`2026-08-16T18:44:33.522Z`, `runtime_fix_lite`) detectou que o passo 1m-ter
(promoção de fonte primária) foi aplicado sobre `tmp-dates-reviewed.json`
(saída de 1p1) em vez de `tmp-categorized.json` (posição documentada, antes
de 1n/1o/1p1). Causa: o `discovery-searcher` do 1m-ter é uma chamada `Agent`
síncrona (não background, ao contrário do É IA?/1d) — nesta rodada, os
agents de busca demoraram a retornar o suficiente pra o orchestrator já ter
seguido adiante e rodado 1n (topic-cluster)/1o (filter-date-window)/1p1
(research-review-dates) antes da promoção terminar.

**Investigação (#5471):** varredura de `run-log.jsonl` (20 entradas de
1m-ter entre 260609 e 260813, uma por edição) e de issues fechadas
(`gh issue list --search "1m-ter"`/`"fora de ordem"`) não encontrou nenhuma
outra ocorrência do mesmo padrão — a mensagem `runtime_fix_lite`/"fora de
ordem" aparece só na entrada de 260817. **One-off, sem sinal de recorrência.**

**Resultado observado:** 2 artigos DeepSeek promovidos de RADAR → LANÇAMENTOS
(URLs oficiais `deepseek.com`), verificados via `categorize()` +
`verify-accessibility.ts` antes da promoção — as mesmas checagens que
rodariam na posição documentada. Sem gap de dedup pós-promoção: 1m-quater
(`check-promoted-dedup.ts`) ainda roda depois, sobre o arquivo onde a
promoção foi de fato escrita. Resultado final equivalente ao caminho
documentado.

**Decisão (P2/medium, sem indicação de corrupção de dado, sem recorrência —
critério da issue #5471 pra fechar via documentação):** não introduzir
barreira de sincronização nem tornar 1m-ter formalmente idempotente-em-
qualquer-ponto — o custo de qualquer uma das duas mudanças de código não se
paga contra um incidente único com resultado equivalente. Em vez disso, o
playbook (`orchestrator-stage-1-research.md`, nota logo antes de
1m-quater) passou a documentar explicitamente que essa variação de timing é
esperada e segura: aplicar a promoção sobre o arquivo mais recente
disponível, e apontar o `--categorized` de 1m-quater pro mesmo arquivo — sem
mudança de comportamento além de deixar explícito o que o orchestrator já
fez corretamente ao vivo. Se o padrão se repetir (2+ ocorrências futuras),
reconsiderar mover 1m-ter pra antes do 1l (dedup) — opção que eliminaria a
possibilidade de corrida com 1n/1o/1p1 por construção, ao custo de rodar a
busca de fonte primária sobre um pool ainda não deduplicado.
