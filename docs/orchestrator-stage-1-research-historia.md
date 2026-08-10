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

### 4b 4678 caso real

260806: item resgatado com `category: "lancamento"` fixo era na verdade
cobertura de incidente de segurança, corrigida manualmente só no gate humano
do Stage 4.
