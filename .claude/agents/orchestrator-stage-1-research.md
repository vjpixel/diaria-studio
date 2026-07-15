---
name: orchestrator-stage-1-research
description: Stage 1 do orchestrator Diar.ia — pesquisa (inbox drain, RSS, researchers, discovery, dedup, categorize, score, render, gate). Lido pelo orchestrator principal. @see orchestrator-stage-0-preflight.md (Stage 0).
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 1 — Research

**MCP disconnect logging:** ver `orchestrator.md` § "MCP disconnect — logging + halt banner" (#759/#737). Nesta etapa: `--stage 1`, banner `--stage "1 — Pesquisa"`.

### 1a. Inbox drain

Sempre roda, antes da pesquisa:
```bash
npx tsx scripts/inbox-drain.ts
```
Lê novos e-mails de `diariaeditor@gmail.com` via Gmail API e anexa entradas em `data/inbox.md`. Retorna JSON `{ new_entries, urls[], topics[], most_recent_iso, skipped, errors?, error_samples? }`.
- Se `skipped: true` com `reason: "gmail_mcp_error"`: logar `warn` e prosseguir sem inbox (não aborta a pipeline).
- Se `skipped: true` com `reason: "inbox_disabled"`: prosseguir silenciosamente.
- Se `skipped: true` com `reason: "search_failed"` (#665): Gmail falhou ao listar threads (timeout, schema change, 5xx). Tratar igual a `gmail_mcp_error` — logar `warn` e prosseguir sem inbox. Cursor não é avançado (drain não ocorreu).
- Se `skipped: true` com `reason: "auth_expired"` (#1973): OAuth Google expirado/revogado (`invalid_grant`/401) — o drain emite warn LOUD no stderr. **Surfaçar pro editor que submissões desta edição podem ter sido perdidas** + ação de re-auth (`npx tsx scripts/oauth-setup.ts` → `/diaria-inbox` pra recuperar). Idealmente o Stage 0 §0c já pegou via `check-google-token.ts`; este é o backstop. Cursor não avança.
- Se `errors > 0` (#667): drain parcial — algumas threads falharam ao carregar mas o drain prosseguiu. Logar `warn` com contagem + amostras de `error_samples`.
- Extrair `inbox_urls` = lista de URLs vindas do drainer + URLs de entradas já existentes em `data/inbox.md` que ainda não foram arquivadas. Extrair `inbox_topics` idem.
- **`new_entries: 0` é confiável por construção (#3201, resolvido por #3217).** Antes, o drain dependia de um forward `diariaeditor@gmail.com` → `vjpixel@gmail.com` + filtro + label — 3 elos externos que podiam quebrar sem sinal nenhum, deixando `new_entries: 0` indistinguível de "editor não enviou nada" (caso real: 260709, 11 forwards perdidos silenciosamente, #3199/#3215). Desde #3217, a query (`in:sent to:diariaeditor@gmail.com`) busca DIRETO na pasta Enviados da própria conta autenticada — não há mais elo externo que possa quebrar silenciosamente sem também quebrar a autenticação Gmail MCP em si (que já é fail-fast, ver `skipped`/`reason` acima). Por isso **não é necessária uma segunda query de cross-check redundante** contra a mesma fonte de dados — isso só duplicaria a chamada sem adicionar sinal novo. O guard que continua fazendo sentido é o já existente (`skipped`/`errors`/`auth_expired`): se o drain reportar sucesso (`skipped: false`, sem `errors`) e `new_entries: 0`, isso significa genuinamente que o editor não enviou nada no período — pode prosseguir sem alertar o editor. Se qualquer sinal de falha aparecer, tratar conforme os branches acima (nunca assumir "0 submissões" nesse caso).

### 1b. Preparação de fontes

- Ler `context/sources.md` e extrair os nomes+site queries de todas as fontes ativas.
- Ler `data/source-health.json` (se existir). Anotar fontes com 3+ `recent_outcomes` consecutivos não-ok — **ainda dispara**, mas sinaliza no relatório do Stage 1.

### 1c. Fetch poll stats da edição anterior (#201, #1044)

O `eia-compose.ts` auto-preenche "Resultado da última edição" se `_internal/04-eia-poll-stats.json` existir. Buscar do Cloudflare Worker `poll` (compatível com `eia-compose.ts` — `pct_correct`/`below_threshold`/`total_responses`; sem step intermediário `compute-eia-poll-stats.ts`):

```bash
PREV_EDITION=$(node -e "const r=require('fs').existsSync('data/past-editions-raw.json')?JSON.parse(require('fs').readFileSync('data/past-editions-raw.json','utf8')):[];const p=r[0];if(!p||!p.published_at){process.exit(0)}const d=new Date(p.published_at);process.stdout.write(String(d.getUTCFullYear()).slice(-2)+String(d.getUTCMonth()+1).padStart(2,'0')+String(d.getUTCDate()).padStart(2,'0'))")
if [ -n "$PREV_EDITION" ]; then
  npx tsx scripts/fetch-poll-stats.ts --edition "$PREV_EDITION" --out data/editions/{AAMMDD}/_internal/04-eia-poll-stats.json
fi
```

Se `PREV_EDITION` vazio ou Worker indisponível — prosseguir silenciosamente sem stats. **Não bloquear** o pipeline.

### 1d. Dispatch É IA? em paralelo (background) — #1111

O `scripts/eia-compose.ts` (#110 fix 2) não depende de nenhum output do pipeline principal — disparar como **Bash em background** (`run_in_background: true`, na mesma mensagem dos researchers abaixo). Antes era dispatched como Agent Haiku que apenas invocava o script — wrapper redundante, removido em #1111.

```bash
npx tsx scripts/eia-compose.ts --edition {AAMMDD} --out-dir data/editions/{AAMMDD}/
```

Armazenar `eia_bash_id` (output do `Bash(run_in_background=true)`) e `eia_dispatch_ts` (timestamp). Stage 3 usa o bashId pra detectar conclusão ou faz file-presence check em `data/editions/{AAMMDD}/01-eia.md`.

**Logging por caminho** (#110 fix 4):
- **Dispatch normal**: logar `info 'eia dispatched (background bash)'`.
- **Skip por resume** (`01-eia.md` já existir): logar `info 'eia dispatch skipped: already_exists (resume)'`. Não dispatchar.
- **Skip por dispatch failure** (Bash run_in_background indisponível ou erro imediato): logar `warn 'eia dispatch skipped: bash_unavailable'`. Ainda assim prosseguir com a Etapa 1 — Etapa 3 sinaliza ausência e oferece retry.

**Validação no gate da Etapa 1** (#110 fix 1): antes do gate principal, checar se `data/editions/{AAMMDD}/01-eia.md` existe OU se há background bash ativo (via `eia_bash_id`). Se nenhum dos dois (skip silencioso), incluir bullet no relatório: `🟡 É IA?: não dispatchado — rode /diaria-3-imagens {AAMMDD} eai antes do gate da Etapa 4.`

### 1e. Método de fetch por fonte (#54)

Pra cada fonte em `context/sources.md`, escolher entre RSS (rápido, determinístico) e WebSearch (fallback):

1. Fontes com RSS têm linha `- RSS: {url}` em `context/sources.md`. Fontes com filtro de tópico (#347) têm linha `- Topic filter: {term1,term2,...}` logo abaixo.

**Preferido (#1209, #1270):** 2 passos curtos — `list-active-sources` gera batch, `fetch-rss-batch` dispara:

```bash
npx tsx scripts/list-active-sources.ts --format json --rss-only --out data/editions/{AAMMDD}/_internal/rss-batch.json
npx tsx scripts/fetch-rss-batch.ts --sources data/editions/{AAMMDD}/_internal/rss-batch.json --out data/editions/{AAMMDD}/_internal/researcher-results.json --days {window_days}
```

35 fontes em ~9s. **Não construir `rss-batch.json` via parser inline** — `list-active-sources.ts` é canônico (#1270).

### 1e-bis. Pre-warm verify cache (background, #1554 P1)

**Imediatamente após RSS batch retornar**, kick off `prewarm-verify-cache.ts` em background pra popular o cache cross-edição enquanto os agents WebSearch (1f) rodam em paralelo. URLs do RSS estarão pre-verificadas quando o passo 1i principal rodar — elimina ~3-5min de wall clock duplicado.

```bash
Bash("npx tsx scripts/prewarm-verify-cache.ts --edition-dir data/editions/{AAMMDD}/", run_in_background: true)
```

Capturar o `bash_id`. Não aguardar — segue direto pro 1e.5 e 1f. O processo termina sozinho enquanto agents WebSearch dispatch. Quando 1i rodar, URLs do RSS hitam cache e skipam HEAD+GET.

**Falhas são não-bloqueantes** — o script exit 0 em erro, e o 1i sempre cobre o que faltar. Não é necessário await formal; o cache é persistente e idempotente.

**Opção manual (legado):** se preferir dispatch individual:

2. **Se a URL na linha RSS termina em `sitemap.xml`** (#761): disparar `Bash("npx tsx scripts/fetch-sitemap.ts --url <sitemap_url> --source <nome> --days <window_days>")` em paralelo. Marca `method: "sitemap"`. Output shape compatível com `fetch-rss` (mesmas chaves `articles[]`, `error?`). Usado quando a fonte não tem RSS mas expõe sitemap.xml (ex: Perplexity Research).
3. **Se fonte tem RSS** (URL não termina em `sitemap.xml`): disparar `Bash("npx tsx scripts/fetch-rss.ts --url <rss> --source <nome> --days <window_days>")` em paralelo. Rápido (~1-2s por fonte). Marca `method: "rss"`.
   - **Se a fonte tem `Topic filter`** (#347): adicionar `--topic-filter "<termos>"` ao comando — só artigos cujo `title+summary` contém ao menos 1 dos termos passam. Crítico pro arXiv (~600 papers/dia → ~80-120 após filtro).
4. **Se RSS/sitemap falha ou retorna 0 artigos**: fallback automático — dispara `source-researcher` (WebSearch) pra mesma fonte. Marca `method: "websearch_fallback"`. 1 falha já dispara fallback.
5. **Se fonte NÃO tem RSS nem sitemap**: disparar `source-researcher` diretamente (via WebSearch com `site:` query). Marca `method: "websearch"`.

Preserva saúde da fonte em todos os casos: propagar `method` como campo extra no `RunRecord`.

### 1e.5. Extrair inbox_topics (#662)

Entradas de texto-puro do editor (sem URL) viram queries de discovery. Armazenar output como `inbox_topics` para o passo 1f:
```bash
npx tsx scripts/extract-inbox-topics.ts --inbox-md data/inbox.md --out data/editions/{AAMMDD}/_internal/inbox-topics.json
```
Output: JSON array de strings (pode ser `[]`). Logar: `"inbox_topics: N topics extraídos"`.

### 1f. Dispatch de researchers e discovery

**⛔ NUNCA PULE ESTE PASSO EM `/diaria-edicao` (#1091).** RSS batch (1e) **NÃO substitui** WebSearch dos publishers oficiais. Pular silenciosamente porque "RSS já trouxe artigos suficientes" é bug recorrente (260512 incidente, mesma classe do #594). O passo 1w-quint (`validate-stage-1-completeness.ts`) detecta este skip e bloqueia o gate.

#### Path A: Brave Search determinístico (DEFAULT desde #1560)

**Default desde 260529 (#1560).** Quando `BRAVE_API_KEY` está setada (default), usar script TS em vez dos agents Haiku. Economiza ~8-12min/edição. Validação side-by-side em 260529 confirmou cobertura comparável + 10× speed. Setar `WEBSEARCH_BACKEND=agents` força fallback pro Path B.

```bash
# Gerar sources list
npx tsx scripts/list-active-sources.ts --format json --websearch-only \
  --out data/editions/{AAMMDD}/_internal/websearch-batch.json

# Pre-flight blocklist (mesma lib usada no Path B)
# (Output já filtrado quando websearch-batch.json é gerado pelo list-active-sources.ts)

# Rodar dispatch determinístico
npx tsx scripts/fetch-websearch-batch.ts \
  --sources data/editions/{AAMMDD}/_internal/websearch-batch.json \
  --discovery data/editions/{AAMMDD}/_internal/inbox-topics.json \
  --cutoff-iso {cutoff_iso} \
  --window-days {window_days} \
  --edition {AAMMDD} \
  --out data/editions/{AAMMDD}/_internal/websearch-results.json
```

Flag `--edition` (#1558): tagga cada Brave query no `data/brave-credits.jsonl` pra tracking de consumo no relatório de edição.

Output em `websearch-results.json` é RunRecord[] compatível com researcher-results.json — mergear no aggregate.

Exit code 3 do script = "BRAVE_API_KEY ausente" → fallback automático pro Path B (não falha o pipeline).

Melhorias trackeadas em #1559 (filtro de path FAQ/help + WebFetch OG tags).

#### Path B: Agents Haiku (fallback)

- **Pre-flight: skip aggregator-domain sources** (#717 hipótese 5). Antes de dispatchar agents, filtrar fontes que batem na blocklist de `source-researcher` (que voltariam com `articles: []` de qualquer jeito). Rodar:
  ```bash
  echo '[{"name":"...","url":"..."},...]' | npx tsx scripts/check-source-blocklist.ts
  ```
  Output JSON `{ kept[], skipped[] }`. Dispatchar source-researcher apenas pra `kept[]`. Logar `skipped[]` como info: cada entry tem `category` + `pattern` que casou. Economiza ~30s-1min de wall clock + ~50k Haiku tokens em edições com 11+ fontes em fallback (medido em #717 / 260506).

- **#1074 — sempre dispatchar pra TODAS as fontes.** Disparar N chamadas `Agent` paralelas com subagent `source-researcher` **pra todas as fontes cadastradas em `context/sources.md` que passaram no pre-flight de blocklist acima**, **independente do RSS ter retornado artigos ou não**. Razão (#1074): RSS feeds são incompletos / atrasados; fontes oficiais publicam no site antes do RSS atualizar; pular mascara coverage gaps que o editor não vê. Passar: nome da fonte, site query, **`cutoff_iso`** (data mais antiga aceita — calculada em 0a a partir de `anchor_iso = today`), `window_days`, `timeout_seconds: 180`. **Não passar `edition_date` como anchor da janela** (#560) — apenas como identificador, se necessário.
- Em paralelo, disparar M chamadas `Agent` com subagent `discovery-searcher` para queries temáticas (~5 PT + ~5 EN + **todos os `inbox_topics`** como queries adicionais — prioridade alta, vêm do próprio editor). `inbox_topics` vem do output do step 1e.5 (`scripts/extract-inbox-topics.ts`). Passar `cutoff_iso`, `window_days`, `timeout_seconds: 180`.
- **#2313 — SEMPRE incluir ≥2 queries how-to PT-BR como slots fixos**, independente de BRAVE_API_KEY. Path B (agents fallback) é a causa raiz: em 260616 10 discovery-searcher rodaram mas ZERO com query casual. Obter as queries via: `npx tsx -e "import {getHowToDiscoveryQueries} from './scripts/lib/use-melhor-curation.ts'; console.log(JSON.stringify(getHowToDiscoveryQueries(parseInt(process.env.EDITION_NUM??'0'), 2)))" EDITION_NUM={AAMMDD}` — resultado é array de 2 strings PT-BR. Dispatchar 1 `discovery-searcher` por query. Se a saída do Path A (script TS) já rodou, NÃO re-dispatchar (evitar duplicata): verificar se `researcher-results.json` já contém entries com `source` prefixo `"discovery: como "` ou `"discovery: guia "` (com espaço após o dois-pontos — formato gerado por `fetch-websearch-batch.ts`: `discovery: {query}`) ou similar how-to BR.
- Agregar resultados (cada subagente retorna JSON com `status`, `duration_ms`, `articles[]`, e `reason` se status != ok).
- **#2668 — Reconciliar Path B após dispatch (determinístico).** Após despachar todos os agents E ter rodado ≥1 batch Path A (`fetch-websearch-batch`, que captura o header), emitir: `npx tsx scripts/reconcile-brave-path-b.ts --edition {AAMMDD}`. Deriva o uso do Path B do **gap real do header X-RateLimit-Remaining** (`delta_untracked`), não de um multiplicador hardcoded — então a contagem local passa a bater com o uso real do Brave. Idempotente. (Substitui o estimate frágil `N*2+M+J` do #2608, que nunca rodava → 0 estimadas em maio+junho → causa do esgotamento dos $5 em jun/2026. O **alerta** já usa o header direto desde #2668; isto é só pro breakdown local do relatório.)

### 1g. Registrar saúde + log (batch, #40)

Em vez de N chamadas individuais, agregar todos os resultados (researchers + discovery) num único array. Convenção de `source`:
- **Researchers cadastrados**: nome exato da fonte em `context/sources.md` (ex: `"MIT Technology Review"`).
- **Discovery searchers**: formato `discovery:{topic_slug}` (ex: `"discovery:ai-regulation-brazil"`). **Garantir unicidade** (#692): se dois inbox_topics diferentes produzem o mesmo slug, suas health stats conflam no mesmo arquivo `data/sources/discovery-{slug}.jsonl`. Para inbox_topics, usar `discovery:{slugify(query)}-{sha1(query).slice(0,6)}` como source name — o hash curto garante que queries distintas geram slugs distintos.
- **Inbox URLs**: não passam por este batch — são injetadas diretamente na lista agregada sem virar "runs".

```json
[
  { "source": "MIT Technology Review", "outcome": "ok", "duration_ms": 4500, "query_used": "site:...", "articles": [] },
  { "source": "Tecnoblog (IA)", "outcome": "fail", "duration_ms": 2000, "query_used": "site:...", "reason": "fetch_error" },
  { "source": "discovery:ai-regulation-brazil", "outcome": "ok", "duration_ms": 8000, "query_used": "regulação IA Brasil", "articles": [] }
]
```

1. Gravar em `data/editions/{AAMMDD}/_internal/researcher-results.json` (rastreabilidade).
2. Rodar **uma vez** o script batch:
   ```bash
   npx tsx scripts/record-source-runs.ts \
     --runs data/editions/{AAMMDD}/_internal/researcher-results.json \
     --edition {AAMMDD}
   ```
   Atualiza `data/source-health.json` + anexa linhas JSONL em `data/sources/{slug}.jsonl`. O script retorna JSON com `summary.sources_with_consecutive_failures_ge3` — usar no relatório do gate.

Artigos de researchers com `status != ok` **não entram** na lista agregada (mas a saúde fica registrada).

### 1g-bis. Carry-over de candidatos não-selecionados (#655)

Reaproveita artigos não-aprovados da edição anterior (`runners_up` + buckets) como candidatos da edição atual. Roda antes do inject-inbox e do dedup — carry-over passa por todos os filtros normalmente, então duplicatas com novas coletas são resolvidas naturalmente.

```bash
npx tsx scripts/load-carry-over.ts \
  --edition-dir data/editions/{AAMMDD} \
  --pool data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --window-start {window_start} \
  --window-end {WINDOW_END} \
  --score-min 60
```

Output stdout: `{ prev, candidates_total, kept, skipped, total_pool_size }`. Se `prev: null` (edição N=1, sem anterior), pool fica inalterado e o script exit 0 silenciosamente. Logar como info no run-log. Cada artigo carregado vira `{ ..., flag: "carry_over", carry_over_from: "{prev}" }` e aparece no `01-categorized.md` com marker `[carry-over de {AAMMDD}]`.

### 1h. Injetar inbox_urls (#593, #594)

**Automatizado via script** — substitui o passo manual que era fonte de bug (#594 — passo skipado em 260505, 0 dos 26 envios entraram). Política #593: TODOS os URLs de submissões do editor (incluindo forwards de newsletter) entram no pool de pesquisa.

```bash
npx tsx scripts/inject-inbox-urls.ts \
  --inbox-md data/inbox.md \
  --captured-articles data/editions/{AAMMDD}/_internal/captured-newsletter-articles.json \
  --pool data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --out data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --validate-pool
```

Output stdout: `{ injected, already_in_pool, total_editor_urls, total_newsletter_urls, total_pool_size, editor_blocks, newsletter_blocks, total_inbox_blocks, newsletter_source }`. Logar como info no run-log.

**`--validate-pool`** força saída com erro se algum URL extraído do inbox **não** estiver no pool após injeção. Esse é o sentinel anti-#594 — passo 1h não pode mais ser skipado silenciosamente.

**#1520 — newsletter URLs from `captured-newsletter-articles.json`:** quando `--captured-articles` é fornecido, newsletter URLs vêm do JSON pré-filtrado produzido por `capture-newsletter-urls.ts` (Stage 0 §0b-bis) em vez de serem re-extraídos do inbox.md. Filtros (tracking, afiliados, sender-domain) já foram aplicados durante a captura. Se o arquivo não existir, fallback para extração do inbox.md (backward compat). Opt-out explícito: `--no-newsletters`.

**#1095 — extração de newsletters não-Pixel (legacy path):** quando `--captured-articles` não é fornecido, script processa blocks do inbox.md cujo sender ≠ editor (Cyberman, Superhuman, AlphaSignal, etc). Extrai URLs primárias (TechCrunch, Guardian, BBC, etc) e injeta como artigos com `flag: "newsletter_extracted"`, `source: "inbox_newsletter:{sender}"`. Filtros aplicados: tracking URLs, afiliados (hubspot offers, _bhiiv referral), auto-promo (URLs do próprio domínio/brand do sender). Opt-out: `--no-newsletters`.

Cada URL vira um artigo sintético:
- Forward do Pixel: `{ url, source: "inbox", title: "(inbox)", flag: "editor_submitted", submitted_at, submitted_subject, submitted_via }`.
- Extraído de newsletter: `{ url, source: "inbox_newsletter:{sender}", title: "(newsletter:{sender})", flag: "newsletter_extracted", submitted_at, submitted_subject, submitted_via }`.

Categorizer prioriza `editor_submitted`. `newsletter_extracted` recebe peso menor (não bypassa filters de acessibilidade). Tracking-only URLs (TLDR, Beehiiv mail links, CDN images) são filtradas — só conteúdo real.

### 1h.6. Validar injeção (#625)

Validador **externo** anti-skip — diferente de `--validate-pool` (interno/tautológico), este script roda após o step 1h e detecta o cenário onde o orchestrator skipou a chamada inteira:

```bash
npx tsx scripts/validate-stage-1-injection.ts \
  --edition-dir data/editions/{AAMMDD} \
  --inbox-md data/inbox.md
```

Se exit 1: step 1h foi skipado ou falhou silenciosamente. Re-executar step 1h e repetir. Se exit 2: erro de leitura de arquivo. Verificar paths.

Logar resultado como info no run-log. **Não prosseguir para 1i se exit 1.**

### 1h.7. Marker check determinístico (#1330)

`inject-inbox-urls.ts` grava `_internal/.marker-inject-inbox-urls.json` ao final. Antes de 1i, assertar o marker — pega o cenário "orchestrator skipou 1h+1h.6 inteiros" (#594 260505, 260518) que a validação 1h.6 não captura sozinha porque também é skipada. `npx tsx scripts/pipeline-sentinel.ts assert-marker --edition {AAMMDD} --name inject-inbox-urls` — exit 0 prossegue; exit 1 **HALT** via `render-halt-banner.ts` com motivo "marker inject-inbox-urls ausente".

### 1i. Link verification (script direto)

Gravar a lista de URLs da lista agregada em `data/editions/{AAMMDD}/_internal/tmp-urls-all.json` (array de strings) e rodar:
```bash
npx tsx scripts/verify-accessibility.ts \
  data/editions/{AAMMDD}/_internal/tmp-urls-all.json \
  data/editions/{AAMMDD}/_internal/link-verify-all.json \
  --bodies-dir data/editions/{AAMMDD}/_internal/_forensic/link-verify-bodies \
  --cache data/link-verify-cache.json \
  --browser-concurrency 8
```
A flag `--cache` (#717 hipótese 2) ativa o cache cross-edição de verdicts. URLs já verificadas como `accessible`/`blocked`/`paywall` em qualquer edição passada (TTL default 7 dias) skipam HEAD+GET inteiro. Cache persistido em `data/link-verify-cache.json` (gitignored). Hit ratio típico esperado >50% após 1-2 semanas de runs. Override TTL com `--cache-ttl-days N`.
A flag `--bodies-dir` (#717 hipótese 1) persiste o body raw de cada GET bem-sucedido no path indicado. `verify-dates.ts` (rodado pelo step 1p1 research-review-dates) lê desse cache antes de fetchar — elimina ~3-4min de fetch duplicado em edições com 300+ URLs.
O fallback de browser (Puppeteer) usa worker pool com `--browser-concurrency 8` (#717 hipótese 3, default 4, bumped pra 8 em P5 #1553). URLs `uncertain` no first-pass são verificadas em paralelo com até N tabs no mesmo browser headless — em 260506 (227 uncertain), serial era ~26-30min, com concurrency=4 cai pra ~7min, com concurrency=8 esperado ~4min. Descer pra 2-4 se a máquina estiver sob pressão de memória.
Ler `data/editions/{AAMMDD}/_internal/link-verify-all.json` (array de `{ url, verdict, finalUrl, note, resolvedFrom?, access_uncertain? }`). Então:
- **Anotar (#778)**: para todos os artigos, adicionar `verify_verdict` e (quando presente) `verify_note` no artigo a partir do match por URL no `link-verify-all.json`. Isso permite que `render-categorized-md.ts` marque visualmente artigos editor-submitted que falharam acessibilidade (per #778) em vez de eles sumirem do gate.
- **Remover** artigos com verdict `paywall`, `blocked` ou `aggregator` (sem `resolvedFrom`) que **não** sejam de inbox. Editor-submitted (`flag: "editor_submitted"` ou `source: "inbox"`) **nunca** são dropados por verdict de acessibilidade — apenas anotados (#778). A regra de aggregator continua dropando inbox-aggregator que não foi expandido pelo `expand-inbox-aggregators.ts` (esse script já trata o caso primário-extraído).
- **Manter com flag** artigos com verdict `anti_bot` (#320): adicionar `"access_uncertain": true`. Incluir no relatório do gate: `"⚠️ N artigo(s) marcados anti_bot — accessible no browser mas bloqueados por crawler. Revisar antes de aprovar."` com a lista de domínios.
- **Marcar** artigos com verdict `uncertain` adicionando `"date_unverified": true`. Esses artigos continuam no pipeline mas serão sinalizados com `⚠️` no gate para revisão manual.
- **Substituir URL** dos artigos com `resolvedFrom` presente: atualizar `url` para `finalUrl` e adicionar `resolvedFrom` ao artigo para rastreabilidade. Isso inclui URLs de shorteners que foram resolvidos pro destino real (#317).

### 1j. Expandir links de agregadores do inbox (#483)

Quando o editor submete um link de agregador (ex: Perplexity Page, Flipboard), o link não é simplesmente descartado — seus links primários são extraídos e injetados no pipeline:
```bash
npx tsx scripts/expand-inbox-aggregators.ts \
  --articles data/editions/{AAMMDD}/_internal/tmp-articles-post-verify.json \
  --verify   data/editions/{AAMMDD}/_internal/link-verify-all.json \
  --out      data/editions/{AAMMDD}/_internal/tmp-articles-expanded.json
```
Substitui cada artigo inbox com `verdict: "aggregator"` pelos links primários extraídos (até 10 por agregador, `source: "inbox_via_aggregator"`). Se nenhum link for encontrado, o agregador é descartado com warning. Artigos não-inbox com verdict `aggregator` continuam sendo descartados normalmente.

### 1k. Enriquecer artigos do inbox (#109)

URLs do editor entram com `title: "(inbox)"` e `summary: null`. Após a expansão de agregadores:
```bash
npx tsx scripts/enrich-inbox-articles.ts \
  --in data/editions/{AAMMDD}/_internal/tmp-articles-enrich.json \
  --bodies-dir data/editions/{AAMMDD}/_internal/_forensic/link-verify-bodies
```
O script toca: (a) artigos do **inbox** (`flag: "editor_submitted"` ou `source: "inbox"`) com título placeholder (`(inbox)`, `[INBOX] ...`) OU `summary` vazio — lê o body cacheado por `verify-accessibility.ts` no 1i (`--bodies-dir`); se ausente, faz fetch da URL final; e (b) **#1696**: artigos de **fonte regular** com título real mas `summary` vazio — preenche `og:description` (itens de seção secundária LANÇAMENTOS/RADAR sem summary renderizavam como título pelado). Para (b) o enrichment é **cache-only** (sem network fetch — bound de custo; o body já foi cacheado no 1i pros acessíveis); cache-miss vira outcome `cache_miss_skipped_non_inbox`. Extrai `og:title` / `og:description` (fallback `<title>` / `meta name=description`); títulos curados pelo editor preservados (non-inbox NÃO tem o título tocado — só summary). Falhas de fetch (inbox) viram `fetch_failed`. Ler o JSON de volta (mutated in place). Stderr loga `[enrich] body-cache: H/T hit (P%)`.

### 1l. Dedup

```bash
npx tsx scripts/dedup.ts \
  --articles data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --past-editions data/past-editions.md \
  --window {window_days} \
  --out data/editions/{AAMMDD}/_internal/tmp-dedup-output.json
```
Pré-passo automático (#485): artigos inbox com título placeholder `(inbox)` têm o título real resolvido via fetch antes do dedup principal, evitando falsos-positivos de similaridade entre artigos com mesmo placeholder. Ler `kept[]` do JSON de saída como lista de artigos daqui em diante. Logar `removed[]` (apenas contagem e motivos) para rastreabilidade. Limpar arquivos temporários com Bash.

### 1m. Categorizar

Gravar `kept[]` em `data/editions/{AAMMDD}/_internal/tmp-kept.json` e rodar:
```bash
npx tsx scripts/categorize.ts \
  --articles data/editions/{AAMMDD}/_internal/tmp-kept.json \
  --out data/editions/{AAMMDD}/_internal/tmp-categorized.json
```

Em seguida, rodar **enrich-primary-source** (#487) pra sinalizar notícias que parecem cobrir lançamentos (verbo + empresa conhecida no título) — o editor verá um marker `🚀→{dominio}` no MD do gate sugerindo busca da fonte primária:
```bash
npx tsx scripts/enrich-primary-source.ts \
  --in data/editions/{AAMMDD}/_internal/tmp-categorized.json
```
In-place. Loga no stderr `N/M notícia(s) sinalizadas` e nunca falha. Ler `data/editions/{AAMMDD}/_internal/tmp-categorized.json` como `{ lancamento, radar, use_melhor, video }` (#1629) para usar daqui em diante.

**1m-ter. Busca ATIVA de fonte primária (#1699).** O `enrich-primary-source` só sinaliza; #1699 manda buscar de fato. Para cada artigo em `radar` com `launch_candidate: true` (e `suggested_primary_domain`), o orchestrator:

1. **Buscar** o anúncio oficial — disparar `discovery-searcher` com a query `site:{suggested_primary_domain} {núcleo do título, sem o nome do veículo de imprensa}`. (Um `discovery-searcher` por candidato; rodar em paralelo se houver vários.)
2. **Verificar** o melhor resultado, OBRIGATÓRIO (todos):
   - **é oficial** — rodar `categorize({ url: candidato })` e exigir `=== "lancamento"` (reusa o whitelist `OFFICIAL_SOURCES`/`path_patterns` como check determinístico; `/careers`, `/charter` etc. não passam);
   - **acessível** — `verify-accessibility.ts` no candidato;
   - **mesmo tema** do artigo de imprensa (mesmo produto/modelo no título oficial — não um anúncio qualquer da empresa; julgamento do agent).
3. **Substituir + promover** SÓ se verificado: trocar a URL pela oficial e mover o artigo de `radar` → `lancamento` no `tmp-categorized.json`. Anotar **exatamente** `primary_source_substituted: { "from": "<URL-de-pesquisa-original>", "to": "<URL-oficial>" }` no artigo — campo obrigatório, nome exato (snake_case), dois sub-campos `from` e `to`. Sem este campo ou com nome diferente (`primary_source_replaced`, `primarySourceSubstituted`, etc.), `check-promoted-dedup.ts` silenciosamente ignora o artigo e a re-checagem de dedup não funciona.
4. **Guard (gate-critical):** nada verificado → **manter como notícia** (comportamento atual). **NUNCA fabricar/adivinhar URL.** Se a busca não achar oficial acessível e do tema, deixar quieto.
5. **Apresentar no gate da Etapa 1:** listar as substituições (`🚀 fonte primária: {título} — imprensa→oficial`) pro editor confirmar/reverter. Não é silencioso — o editor vê cada promoção.

Se `launch_candidate` count = 0, pular este passo (info no run-log). Falha de busca/verify nunca bloqueia — degrada pra "manter como notícia".
**1m-quater. Dedup pós-promoção (#2315).** `dedup.ts` (passo 1l) viu URLs de pesquisa originais — URLs oficiais introduzidas pelo passo 1m-ter NUNCA passaram pelo dedup. Re-checar agora. **Sempre rodar** (idempotente: sem `primary_source_substituted` → `checked: 0`):
```bash
npx tsx scripts/check-promoted-dedup.ts \
  --categorized data/editions/{AAMMDD}/_internal/tmp-categorized.json \
  --past-editions data/past-editions.md --window 3
```
Resultado `{ demoted[], checked }`. Logar info. Se `demoted.length > 0`: surfar no gate `⚠️ N lançamento(s) revertidos para RADAR (URL oficial repetia edição anterior — #2315)`. Falha → warn + prosseguir.

**1m-quinquies. Resolver URLs de VÍDEO para YouTube (#3202).** Regra editorial: itens da seção VÍDEOS usam SEMPRE link do YouTube (`context/editorial-rules.md` — Seção "Vídeos"). Para cada artigo em `video` cuja URL NÃO seja `youtube.com/watch` ou `youtu.be` (checar com `isYoutubeUrl` de `scripts/lib/video-youtube-resolve.ts`):

1. **Buscar** o vídeo equivalente no YouTube — disparar `discovery-searcher` com a query `site:youtube.com {título do vídeo} {fonte/canal, se conhecido}`. (Um `discovery-searcher` por item; paralelo se houver mais de um — lembrar do cap de 2 vídeos/edição.)
2. **Consolidar** os `articles[]` retornados (`{ title, url, source_name }`) num JSON `{ [urlOriginal]: [candidatos...] }` e gravar em `data/editions/{AAMMDD}/_internal/tmp-video-search-results.json`.
3. **Resolver determinístico** (score de similaridade de título, `subjectSimilarity` — mesmo helper do dedup; threshold `YOUTUBE_MATCH_THRESHOLD`):
   ```bash
   npx tsx scripts/resolve-video-youtube.ts \
     --categorized data/editions/{AAMMDD}/_internal/tmp-categorized.json \
     --search-results data/editions/{AAMMDD}/_internal/tmp-video-search-results.json
   ```
   In-place. Stdout: `{ resolved, flagged, alreadyYoutube }`. Match confiável → URL substituída + `video_url_resolved: { from, to, matched_title, score }` anotado no artigo (mesmo espírito de `primary_source_substituted`, #1699). Sem match confiável → `video_url_unverified: true` no artigo, **NUNCA** um fallback silencioso pra URL não-YouTube (princípio invariável CLAUDE.md — nunca fabricar/manter URL não verificada).
4. **Guard (gate-critical):** se `flagged > 0`, **surfar no gate da Etapa 1** cada item flagado: `⚠️ vídeo sem URL de YouTube verificável — cole o link ({título})`. O editor cola a URL correta manualmente no MD antes de aprovar, ou remove o item de VÍDEOS.
5. Se `video` bucket vazio (nenhum item), pular este passo inteiro (info no run-log).

Backstop gate-blocking em Stage 4 (`lint-newsletter-md.ts --check video-links-are-youtube`, ver `orchestrator-stage-4.md` §4c.2) garante que nenhum item não-YouTube sobrevive até a publicação, mesmo que este passo seja pulado ou o editor cole um link errado no Drive.

**Instrumentação type_hint vs categorize (#1718 fase 1) — silenciosa, append-only:** mede a divergência entre o `type_hint` do source-researcher e a decisão de lançamento do categorize, sem mudar nada. Acumula o dado pra decidir (em ~2 semanas) se vale inverter o ônus (type_hint primário). Nunca bloqueia:
```bash
npx tsx scripts/measure-type-hint-divergence.ts --in data/editions/{AAMMDD}/_internal/tmp-categorized.json --edition {AAMMDD}
```
Append em `data/type-hint-divergence.jsonl`. Se `launch_disagreements > 0`, loga warn informativo (não-bloqueante).

### 1n. Topic clustering (#237)

Rodar `topic-cluster.ts` pra consolidar artigos do mesmo evento dentro do mesmo bucket:
```bash
npx tsx scripts/topic-cluster.ts \
  --in data/editions/{AAMMDD}/_internal/tmp-categorized.json \
  --out data/editions/{AAMMDD}/_internal/tmp-clustered.json \
  --threshold 0.3
```
Threshold `0.3` é agressivo (Jaccard de tokens). False positives são amortecidos pelo ranking intra-cluster (representante mantido é o de melhor qualidade). Daqui em diante usar `_internal/tmp-clustered.json`. Logar `clusters.length` (zero é normal).

### 1o. Filtro determinístico de janela (#233, #560)

Antes do step 1p1 (research-review-dates), rodar `scripts/filter-date-window.ts` pra garantir que **nenhum** artigo fora da janela chegue ao filtro de datas. **Anchor = `anchor_iso`** (today UTC), não `edition_iso` — assim a janela cobre o que foi publicado de fato nos últimos `window_days` dias, e não uma janela hipotética entre hoje e a publication date:
```bash
npx tsx scripts/filter-date-window.ts \
  --articles data/editions/{AAMMDD}/_internal/tmp-clustered.json \
  --anchor-date {anchor_iso} \
  --edition-date {edition_iso} \
  --window-days {window_days} \
  --out data/editions/{AAMMDD}/_internal/tmp-filtered.json
```
Logar `removed.length`. Daqui em diante o input do step 1p1 é `_internal/tmp-filtered.json` (que já tem `{ kept: { lancamento, radar, use_melhor, video } }`, #1629) — extrair `kept` e usar como `categorized`.

### 1p1. Research-review-dates (script, Filtro 1) — #1112

Rodar `scripts/research-review-dates.ts` ANTES do scorer (Filtro 1: verify-dates + filter-date-window com datas corrigidas). Determinístico, sem LLM:
```bash
npx tsx scripts/research-review-dates.ts \
  --in data/editions/{AAMMDD}/_internal/tmp-filtered.json \
  --out data/editions/{AAMMDD}/_internal/tmp-dates-reviewed.json \
  --edition-dir data/editions/{AAMMDD}/ \
  --anchor-iso {anchor_iso} \
  --edition-iso {edition_iso} \
  --window-days {window_days} \
  --bodies-dir data/editions/{AAMMDD}/_internal/_forensic/link-verify-bodies \
  --verify-cache data/link-verify-cache.json \
  --link-verify-json data/editions/{AAMMDD}/_internal/link-verify-all.json
```
Output: `{ categorized, stats }`. Logar `stats.date_corrected`, `stats.fetch_failed`, `stats.removed_date_window`.

**#1554 P2 — `--link-verify-json`**: passa o output do passo 1i (verify-accessibility). Verify-accessibility já fetcha cada URL e extrai `published_date` inline durante o GET. Quando esse campo está populado, o script aqui faz pre-skip do verifyDate (sem novo HTTP GET) — economiza 2-4 min em edições com 70+ artigos. URLs sem pre-extracted date (browser fallback, HEAD-only, fetch failed) caem no caminho normal de verifyDate.

### 1p2. ~~Research-reviewer~~ — REMOVIDO #1553 (theme dedup agora é `dedup.ts` Pass 1c/1d)

Se tema repetido escapar de `dedup.ts`: considerar lower `subjectVsPastThreshold` (0.6→0.55) ou re-introduzir o agent como fallback. Input do scorer (1q) vem direto de `tmp-dates-reviewed.json` (output de 1p1).

### 1q. Scorer (chunked-parallel, #1611)

O scorer single-call (esse mesmo caminho legado, hoje chamado **1q-fallback** — então em Opus, sobre ~80-150 artigos numa passada) gastava ~8min; desde #2772 roda em Sonnet. Agora o caminho principal roda em 5 sub-passos: pontuação em K chamadas paralelas (mesmo rubrico) + seleção holística sobre os finalistas. Paridade validada (top-6 overlap 5/6 vs. single-call, dentro do ruído run-to-run do próprio scorer). Pools pequenos caem no caminho legado — ver **1q-fallback**.

**1q.1 — Split.** Dividir o pool em chunks de ~30:
```bash
npx tsx scripts/split-articles-for-scoring.ts \
  --categorized data/editions/{AAMMDD}/_internal/tmp-dates-reviewed.json \
  --out-dir data/editions/{AAMMDD}/_internal/scoring-chunks \
  --chunk-size 30 \
  --pool-out data/editions/{AAMMDD}/_internal/tmp-scoring-pool.json
```
O manifest stdout traz `chunk_count` + `chunk_files[]` + `pool_out` (quando `--pool-out` é passado). **Se `chunk_count <= 1`, pular pro 1q-fallback.**

`--pool-out` (#2496): grava o pool **capado** (pós `dedupeUseMelhorBucket`) em `tmp-scoring-pool.json`. O passo 1q.3 usa este arquivo como `--categorized` do merge — garante que o merge compare contra exatamente o que foi distribuído nos chunks. Sem isso, o merge recebia `tmp-dates-reviewed.json` (pool não-capado) e os artigos `use_melhor` capados apareciam como `missing` → falso `catastrophic`.

**1q.2 — Pontuar em paralelo.** Disparar `chunk_count` agents `scorer-chunk` **EM PARALELO** (uma chamada `Agent` por chunk, todas no MESMO bloco de tool calls). Cada um: input = `scoring-chunks/scoring-chunk-{i}.json`, out_path = `scoring-chunks/scored-chunk-{i}.json`.

**1q.3 — Merge.**
```bash
# #2496: usar tmp-scoring-pool.json (pool capado emitido pelo split) como --categorized,
# NÃO tmp-dates-reviewed.json. O merge compara artigos pontuados contra o pool que
# de fato foi distribuído nos chunks — evita falso catastrophic quando use_melhor
# é capado pelo split (ex: 31→15: os 16 capados apareciam como missing → exit 2 falso).
npx tsx scripts/merge-scored-chunks.ts \
  --categorized data/editions/{AAMMDD}/_internal/tmp-scoring-pool.json \
  --chunk-scores data/editions/{AAMMDD}/_internal/scoring-chunks/scored-chunk-0.json,...,scored-chunk-{N-1}.json \
  --allscored-out data/editions/{AAMMDD}/_internal/tmp-allscored.json \
  --finalists-out data/editions/{AAMMDD}/_internal/tmp-finalists.json \
  --top 15
MERGE_EXIT=$?   # capturar ANTES do echo (echo zera o $?)
echo "merge-scored-chunks exit: $MERGE_EXIT"   # 0 = ok/incompleto-recuperável · 1 = erro de args/input · 2 = CATASTRÓFICO (#1669)
```
**Ramificar pelo EXIT CODE em `$MERGE_EXIT` (#1669 — determinístico; NÃO dependa de parsear `catastrophic` do manifest stdout).** Split é round-robin, então um chunk perdido leva uma fatia dos MELHORES artigos, não os piores — sem o guard o #1 highlight some silenciosamente. **Os 3 códigos são exaustivos — não há catch-all "seguir":**
- **exit 2** (= `catastrophic: true` — um chunk inteiro ilegível `failed_chunks > 0`, ou `missing_count > 2`): **NÃO seguir com o resultado degradado** (os arquivos `tmp-allscored.json`/`tmp-finalists.json` foram escritos só pra diagnóstico). (a) **Retry** o(s) `scorer-chunk` que falhou(aram) — re-disparar o agent só pros `scored-chunk-{i}.json` ausentes/inválidos — e re-rodar o merge (1q.3). (b) Se ainda sair 2 após o retry, **cair no 1q-fallback** (single-call `scorer` sobre o `tmp-dates-reviewed.json` inteiro), descartando o resultado chunked. Logar `level: error`.
- **exit 1** (erro de invocação — args malformados — ou `tmp-scoring-pool.json` ausente/corrompido, ex: split rodou sem `--pool-out`; **nenhum output novo foi escrito**): **HALT — NÃO seguir.** Os `tmp-finalists.json`/`tmp-allscored.json` podem estar stale de um run anterior; **não** consumir em 1q.4/1q.5. Corrigir os args/input (confirmar que 1q.1 passou `--pool-out`) e re-rodar, ou cair no 1q-fallback. Logar `level: error`.
- **exit 0 + `incomplete: true`** (gap ≤ 2 artigos): logar `level: warn` e seguir — os artigos sem score viraram 0 e serão filtrados em 1s (ruído recuperável).
- **exit 0** (sem `incomplete`): seguir normalmente.

**1q.4 — Seleção.** Disparar 1 agent `scorer-select`: input = `tmp-finalists.json`, out_path = `tmp-selection.json`. Retorna `highlights[]` (≤6, ordem editorial) + `runners_up[]`.

**1q.5 — Assemble.**
```bash
npx tsx scripts/assemble-scored.ts \
  --selection data/editions/{AAMMDD}/_internal/tmp-selection.json \
  --allscored data/editions/{AAMMDD}/_internal/tmp-allscored.json \
  --out data/editions/{AAMMDD}/_internal/tmp-scored.json
```
Daqui em diante `tmp-scored.json` tem o **mesmo contrato** de antes (`highlights`, `runners_up`, `all_scored`) — 1r/1s seguem inalterados.

**1q-fallback (pool ≤ chunk-size).** Disparar `scorer` (Sonnet, #2772) passando `categorized` (de `tmp-dates-reviewed.json`) e `out_path: tmp-scored.json` — caminho single-call legado (`scorer` agent mantido). Para pools pequenos o overhead dos 5 passos não compensa. Também é o fallback se o split/merge falhar.

### 1r. Validação pós-scorer (#104)

Se `highlights.length < 6` E `pool_size = sum(buckets.length) >= 6`, **promover** os top de `runners_up[]` (ordenados por score desc) para `highlights[]` até completar 6. Re-numerar os ranks. Logar warning explícito (`level: warn`, `agent: orchestrator`, `message: "scorer produziu apenas N highlights; promovi M runners_up para chegar a 6"`). Se mesmo após a promoção `highlights.length < 6` (pool insuficiente), seguir com o que houver — é caso legítimo.

### 1s. Enriquecer buckets + filtro de score mínimo (#351, #720, #721)

Rodar via script determinístico:
```bash
npx tsx scripts/finalize-stage1.ts \
  --scored data/editions/{AAMMDD}/_internal/tmp-scored.json \
  --categorized data/editions/{AAMMDD}/_internal/tmp-dates-reviewed.json \
  --out data/editions/{AAMMDD}/_internal/tmp-finalized.json \
  --edition {AAMMDD}
```

⚠️ `--categorized` **deve** ser `tmp-dates-reviewed.json` (o pool que o scorer de
fato pontuou em 1q), **não** `tmp-clustered.json` (#1567 audit, finding D). O
clustered é um superset pré-review-de-datas: passá-lo faz cada artigo removido
pela janela de datas cair no join sem score (`url_mismatch: true`) e disparar um
warn `#720` espúrio (até ~48/edição), soterrando os mismatches REAIS (drift de
URL do scorer) que o canal `#720` existe pra pegar. Os buckets finais são
idênticos (esses artigos são removidos pelo filtro `<40` de qualquer forma) —
só o ruído de warning some.

O script: join por URL exata (#720 — sem canonicalizar); recovery por título se mismatch (`score_recovered: true`); loga warn + run-log por cada mismatch; remove `score < 40` exceto highlights/runners_up e `flag === 'editor_submitted'` válidos; bypass endurece (#721): título não-placeholder, `length >= 15`, sem `/buttondown|subscribe|newsletter|sign.?up/i` — falha → `editor_submitted_placeholder: true`; ordena por score desc.

Daqui em diante usar `_internal/tmp-finalized.json` como os buckets enriquecidos.

### 1t. Verificação de mínimos por seção (#488)

Após o filtro de score, contar itens remanescentes em cada bucket e preparar lista de avisos para o gate (#1629: 4 buckets agora):
- Se `lancamento.length < 3`: registrar `⚠️ Apenas {N} lançamento(s) — mínimo esperado: 3`
- Se `radar.length < 8`: registrar `⚠️ Apenas {N} item(ns) em RADAR — mínimo esperado: 8` (fusão de pesquisa + outras notícias do esquema pré-#1629)
- Se `use_melhor.length < 3`: registrar `⚠️ Apenas {N} tutorial(is) — mínimo esperado: 3 candidatos` (warn não-bloqueante; EN é aceitável — #1855). O **mínimo de 2 RENDERIZADOS** é enforçado depois, em Stage 2, pelo `promoteUseMelhorToMinimum` (promove runners-up `use_melhor`); se nem assim der 2, o `apply-stage2-caps` emite warn loud (`shortfall`) pro gate.

Avisos são exibidos no GATE HUMANO. Mínimos são avisos — não bloqueiam o gate.

### 1u. Estrutura e salvamento

Strip do campo `verifier` de cada artigo antes de salvar (só os acessíveis chegaram até aqui; o campo é redundante e polui o JSON). Estrutura final de `_internal/01-categorized.json` (#1629):
```json
{
  "highlights": ["...top 6 com rank/score/reason/article (scorer retorna 6; editor seleciona 3 no gate)..."],
  "runners_up": ["...2-3 candidatos com score..."],
  "lancamento": ["...artigos com campo score, ordenados por score desc..."],
  "radar": ["...mistura pesquisa+noticias do esquema antigo; cada artigo carrega category individual..."],
  "use_melhor": ["...tutoriais/cookbooks..."],
  "video": ["...vídeos curtos..."],
  "clusters": ["...metadata de topic-cluster, runners-up consolidados (#237) — pode ser []..."]
}
```
`clusters` é preservado automaticamente por `filter-date-window.ts` (passthrough de campos extras desde #247). Mesmo se algum cluster member virou `removed` no filtro de janela, a metadata do cluster fica intacta — é informativo pro editor.

Salvar `data/editions/{AAMMDD}/_internal/01-categorized.json`.

### 1u-bis. Dedup intra-edição (#2367, #2397, #2548)

Após salvar `01-categorized.json`, remover dos buckets secundários itens que cobrem o mesmo evento que um destaque:
```bash
npx tsx scripts/dedup-intra-edition.ts \
  --in data/editions/{AAMMDD}/_internal/01-categorized.json \
  --out data/editions/{AAMMDD}/_internal/01-categorized.json
```
Compara `radar`/`lancamento`/`use_melhor`/`video` contra **top-3 destaques por rank** por Jaccard ≥0.45, ≥2 entidades ou **domain-match** (#2548 Furo 2: RADAR com `suggested_primary_domain=google.com` + D1 em blog.google.com → cobertura de imprensa do mesmo lançamento). **#2587:** o domain-match exige um **segundo sinal** de mesmo-lançamento — `≥1 entidade-de-produto compartilhada além do nome da empresa` OU `Jaccard de título ≥0.2` — para não remover dois lançamentos DIFERENTES da mesma empresa (D1=produto A + RADAR=produto B no mesmo domínio). O caminho de entidade-de-produto cobre cobertura cross-lingual (D1 inglês + RADAR português, Jaccard ~0, mas ambos citam o produto). Strip sufixo de veículo. `01-categorized.json` reescrito in-place.

### 1u-ter. Dedup evergreen pós-categorização (#2548 — Furo 1)

Dedup sem janela para `use_melhor`/`video` (janela de 4 do dedup.ts é curta para evergreen re-descoberto meses depois):
```bash
npx tsx scripts/dedup-evergreen-buckets.ts --in data/editions/{AAMMDD}/_internal/01-categorized.json --out data/editions/{AAMMDD}/_internal/01-categorized.json --past-editions data/past-editions.md
```
Verifica URL de `use_melhor`/`video` em **qualquer** edição passada. `radar`/`lancamento` não tocados.

### 1v. Renderizar 01-categorized.md

**Nunca gerar o MD livre-forma** — o formato é responsabilidade do script, não do LLM:
```bash
npx tsx scripts/render-categorized-md.ts \
  --in data/editions/{AAMMDD}/_internal/01-categorized.json \
  --out data/editions/{AAMMDD}/01-categorized.md \
  --edition {AAMMDD} \
  --source-health data/source-health.json
```
O script produz o formato combinado (seção Destaques vazia no topo + seções Lançamentos/Pesquisas/Notícias com `⭐`, `[inbox]`, `(descoberta)` e `⚠️` inline) a partir do JSON. Candidatos do scorer ficam marcados com `⭐` nas seções de bucket; o editor move linhas para a seção Destaques.

**Regra absoluta**: qualquer mudança no `_internal/01-categorized.json` (edição, retry, regeneração do scorer) deve ser seguida de nova chamada deste script para manter o MD em sincronia. Se só mudou o JSON sem re-rodar o renderizador, o MD está stale — isso é um bug.

### 1v-early. Push incremental ao Drive (#903)

Subir `01-categorized.md` agora — antes de 1v-bis/1w-bis/1w. Editor começa a revisar enquanto pipeline ainda lint+valida. Falha não bloqueia (1w sobe de novo como fallback obrigatório).
```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 1 --files 01-categorized.md
```

### 1v-bis. Lint LANÇAMENTOS — bloqueia URLs não-oficiais antes do gate (#587)

Antes de apresentar o gate, validar que items em `## Lançamentos` do MD têm URL oficial (per regra invariável #160). Sem este check, o editor podia mover artigos com URL não-oficial pra LANÇAMENTOS no gate, e o writer da Etapa 2 silenciosamente reclassificava pra OUTRAS NOTÍCIAS — quebrando o contrato de aprovação.

```bash
npx tsx scripts/validate-lancamentos.ts data/editions/{AAMMDD}/01-categorized.md
```

Se exit code != 0, **incluir no gate output** as URLs problemáticas com sugestão pro editor:

```
⚠️  N URL(s) em LANÇAMENTOS não são oficiais (per regra #160):
  - linha {L}: {url}

Opções:
  - Mover artigo pra NOTÍCIAS (não cumpre #160)
  - Substituir URL por equivalente oficial (ex: openai.com/blog/X em vez de canaltech.com.br/X)
  - Forçar aceitação no gate (override editorial pontual)
```

**#1799 — não-produto (warn):** o mesmo comando emite `non_product[]` (exit 0, não bloqueia) pra itens que parecem governança/política/análise — não software/hardware (ex: `openai.com/index/public-policy-agenda` é oficial mas NÃO é lançamento de produto). Se não-vazio, **surfar no gate** pra o editor mover pra NOTÍCIAS. LANÇAMENTOS só lista produto (modelo/app/API/ferramenta/chip/dispositivo).

Editor decide no gate. Auto-aprovação (`--no-gates`) bypassa o lint mas loga warn no run-log.

### 1v-ter. Guard USE MELHOR — flagar não-tutorial antes do gate (#1798)

Antes do gate, rodar o guard determinístico que pega item mal-bucketado em `use_melhor` (newsletter/análise/cobertura em vez de tutorial — em 260604 dois posts da `latent.space` entraram). **Warn-only — nunca bloqueia** (o editor cura USE MELHOR no gate, 0-1 item):

```bash
npx tsx scripts/review-use-melhor.ts --approved data/editions/{AAMMDD}/_internal/01-approved.json
```

Se o JSON de saída tiver `suspicious[]` não-vazio, **incluir no gate output** os itens com o motivo (domínio newsletter/agregador **E** sem sinal de tutorial no título/slug — o vetor real de mis-bucket), pra o editor decidir manter ou trocar. USE MELHOR é tutorial de verdade, não cobertura/análise.

### 1v-quater. Guard fonte-primária em DESTAQUES (#1699)

Antes do gate, flagar destaque que é **lançamento** mas usa URL de cobertura de imprensa em vez da fonte primária (a #160 só cobre a seção LANÇAMENTOS; destaques sobre lançamentos escapavam — caso 260602: RTX Spark com link Canaltech). **Warn-only**:

```bash
npx tsx scripts/review-highlight-source.ts --approved data/editions/{AAMMDD}/_internal/01-approved.json
```

Se `flagged[]` não-vazio, **surfar no gate** cada destaque com a fonte oficial sugerida (`suggested_domain`), pra o editor trocar a URL pela newsroom/site oficial. (Busca ativa + substituição automática é fase 2 do #1699 — aqui só sinaliza melhor.)

### 1w. Sync push do MD para o Drive (antes do gate) — OBRIGATÓRIO (#577)

**Sem este push, o gate da Etapa 1 expõe MD apenas localmente** — editor não consegue revisar no Drive (mobile, telas grandes). Bug recorrente: orchestrator skipa silenciosamente este passo em sessões longas. **Não é opcional.**

Se `data/editions/{AAMMDD}/01-eia.md` existir (É IA? já completou em background):
```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD} --stage 1 --files 01-categorized.md,01-eia-A.jpg,01-eia-B.jpg
```
**Nota (#582):** `01-eia.md` **não vai pro Drive** — conteúdo (linha de crédito + gabarito) já está embutido em `01-categorized.md` (#371). Arquivo permanece local pra scripts (`render-categorized-md`, `normalize-newsletter`, `lint`, `eia-compose`, `publish-monthly`).

Se `01-eia.md` ainda não existir (É IA? ainda processando):
```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD} --stage 1 --files 01-categorized.md
```
Anotar resultado em `sync_results[1]`; falhas reais (não warning) abortam. Falhas warning podem prosseguir mas precisam ser mencionadas no gate.

**Verificação anti-skip (#577, #694)**: antes de apresentar o gate (passo 1x), se `DRIVE_SYNC = true`, confirmar que o cache registra push recente do `01-categorized.md`:

```bash
npx tsx scripts/check-drive-push.ts --edition {AAMMDD} --file 01-categorized.md
```

- Exit 0: pushed ok (ou drive_sync=false) — prosseguir
- Exit 1: não pushed (step 1w skipado) — **re-rodar o push** antes do gate
- Exit 2: schema inesperado no cache — logar warn e prosseguir (evita falso FATAL em refactors do drive-sync)

Se `drive_sync = false` em `platform.config.json`, o script exita 0 silenciosamente.

### 1w-quint. Validator anti-skip de 1f (#1091)

Antes do `validate-stage-1-output.ts`, rodar:

```bash
npx tsx scripts/validate-stage-1-completeness.ts \
  --edition-dir data/editions/{AAMMDD}/
```

Confere que o passo 1f rodou (i.e., `researcher-results.json` tem entries de `source-researcher` ou `discovery`, não só RSS). Exit 1 = passo 1f foi skipado silenciosamente — **bloquear o gate** e re-rodar 1f antes de prosseguir.

Defesa em 3 camadas contra o skip silencioso de 1f (#1091): warning no início da seção 1f (1ª), memory `feedback_no_skip_playbook.md` (2ª), este validator (3ª e primária — bloqueia o gate).

### 1w-bis. Pre-gate validator (#581, #828)

Antes de apresentar o gate humano, rodar:

```bash
npx tsx scripts/validate-stage-1-output.ts \
  --edition {AAMMDD} \
  --edition-dir data/editions/{AAMMDD}/
```

Semântica completa (exit codes, output JSON, falha do próprio validator) em **[`docs/validate-stage-1-output-semantics.md`](../../docs/validate-stage-1-output-semantics.md)** — single source of truth (#832). Pipeline completo (`/diaria-edicao`) ganha o mesmo catch-net que o skill `/diaria-1-pesquisa` isolado tem (#828).

### 1w-quat. Pre-gate invariants (#1007 Fase 1)

Só validar artefatos pré-gate (categorized.md). Approved.json ainda não existe:

```bash
npx tsx scripts/check-invariants.ts --stage 1 \
  --rule categorized-has-eia-section \
  --edition-dir data/editions/{AAMMDD}/
```

Exit 1 = bloquear gate (`01-categorized.md` sem seção "## É IA?"). Os outros checks de Stage 1 rodam pós-gate apply (passo 1y).

### 1w-ter. Log payload sizes (#891 — observability)

Antes do gate, registrar tamanho de cada JSON intermediário em `_internal/`. Visibilidade pra investigar context overflow (#891):

```bash
npx tsx scripts/log-stage-1-payload-sizes.ts --edition {AAMMDD}
```

Output: grava `_internal/01-payload-sizes.json` (relatório completo) e append em `data/run-log.jsonl` com `level: info`, `message: "stage1_payload_sizes"`, `details.totals` + `details.top_3`. Nunca falha — best-effort. Próximo PR usa esses dados pra escolher entre Opção A (subagents retornam só path) ou Opção B (agregação imediata) descritas no #891.

### 1w-quint-b. Check de repeat-de-tema nos destaques candidatos e itens secundários (#2073, #2652)

Antes do gate, verificar se algum candidato a destaque repete o TEMA de um destaque publicado nas **últimas 12 edições** e se algum item RADAR/LANÇAMENTOS repete empresa+sub-tema de itens em `01-approved.json` das **últimas 10 edições** (match: entidade + Jaccard ≥ 0.15 OU prefixo ≥ 6 chars). **Warn-only — nunca bloqueia.**

```bash
npx tsx scripts/check-highlight-themes.ts \
  --categorized data/editions/{AAMMDD}/_internal/01-categorized.json \
  --past-editions data/past-editions.md --window 12 \
  --editions-dir data/editions --secondary-window 10 --current-edition {AAMMDD} \
  --out-json data/editions/{AAMMDD}/_internal/01-highlight-theme-check.json
```

Exit 0 sempre. O JSON gerado é lido no gate (item 4 abaixo) para exibição. Se o script falhar por qualquer motivo (past-editions.md ausente, data/editions/ vazio, JSON corrompido): logar warn e **prosseguir** — esta checagem é best-effort, nunca bloqueia.

### 1x. GATE HUMANO

Apresentar ao usuário:

1. **Instrução de revisão** — não renderizar a lista no terminal. Apenas informar:
   ```
   📊 {total_brutos} artigos garimpados → {kept_dedup} após dedup → {total_categorized} categorizados

   📄 Abra data/editions/{AAMMDD}/01-categorized.md para revisar.
   📁 Drive: Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/01-categorized.md

   ✏️  Candidatos recomendados pelo scorer estão marcados com ⭐.
       Mova exatamente 3 linhas para a seção "Destaques" no topo do arquivo.
       A ORDEM FÍSICA das linhas em "Destaques" define D1/D2/D3 (de cima para baixo).
       Para reordenar, basta mover a linha dentro da seção Destaques.
       Se não mover nenhum artigo, os 3 primeiros candidatos do scorer serão usados.

   🖼️  É IA? está embutido no MD entre as seções Pesquisas e Notícias (#371).
       Se aparecer "⏳ ainda processando", o eai-composer ainda está em background —
       será revisado no gate da Etapa 3 quando as imagens forem aprovadas.
       Se a imagem do É IA? já estiver disponível, aprovação aqui consolida o review.
   ```
   (Derivar: `total_brutos` = soma de `articles[]` de todos researchers; `kept_dedup` = `kept[].length` do dedup.ts; `total_categorized` = `lancamento.length` + `radar.length` + `use_melhor.length` + `video.length` do categorized.json — #1629)

2. **Métricas de cobertura (#346):** derivar perdas (janela, dedup, link-verify) a partir dos arquivos de pipeline e exibir:
   ```
   Artigos garimpados: {N_brutos} brutos → {N_final} após filtros
     -janela: {N_janela} (fora da janela de {window_days}d)
     -dedup: {N_dedup} (URLs repetidas das últimas edições)
     -link-verify: {N_verify} (paywall/blocked/aggregator)
   ```
   Se arquivo não existir ou falhar o parse, exibir "N/A" — nunca bloquear.

3. **Avisos de mínimos por seção (#488):** exibir avisos registrados na verificação de mínimos (ver 1t). Se não houver avisos, omitir este bloco.

4. **⚠️ Repeat-de-tema em destaques (#2073) e RADAR (#2652):** ler `_internal/01-highlight-theme-check.json`. Exibir antes dos avisos. **Best-effort — nunca bloquear.** Se arquivo não existir, ambos=[]: omitir.
   `warnings[]` não-vazio (destaques):
   ```
   ⚠️  TEMA REPETIDO — D{rank} candidato repete tema de {matched_edition}:
       Candidato:  "{candidate_title}"
       Publicado:  "{matched_title}" ({matched_edition}) | Sim.: {jaccard*100}% → trocar candidato.
   ```
   `secondary_warnings[]` não-vazio (RADAR/LANÇAMENTOS): `⚠️ RADAR REPETIDO — [{bucket}] empresa+tema cobertos em {matched_edition}: "{item_title}" ({item_url}) ← "{matched_title}" | Empresa: {shared_entities} | {theme_evidence} → trocar ou manter se ângulo novo.` (#2684 item 7 — `item_url` incluído pra o editor identificar o item exato no gate mobile/Drive, onde título sozinho pode ser ambíguo.)

5. **Relatório de saúde das fontes:**
   - `⚠️` por fonte com outcome não-ok *nesta execução*.
   - `🔴` por fonte com streak 3+, com timestamps de cada falha. Ex: `🔴 AI Breakfast — 3 timeouts seguidos: 2026-04-15T14:18Z, 2026-04-16T14:20Z, 2026-04-17T14:22Z — considere desativar em seed/sources.csv`.
   - Se tudo OK: "Todas as fontes responderam normalmente."

### 1y. Pós-gate (quando aprovado)

- **`auto_approve = true` (#3459):** pular o pull do MD e chamar `apply-gate-edits.ts` com `--auto` em vez de `--md` (não há edição humana pra aplicar):
  ```bash
  npx tsx scripts/apply-gate-edits.ts \
    --auto \
    --json data/editions/{AAMMDD}/_internal/01-categorized.json \
    --out data/editions/{AAMMDD}/_internal/01-approved.json
  ```
  `--auto` simula um MD sem edição (seção Destaques vazia, buckets intactos) e aplica o mesmo slice `highlights: first-3` do fluxo com gate — **nunca copiar `01-categorized.json` literal pra `01-approved.json`** (preservaria os 6 highlights do scorer em vez de 3). Seguir direto pro passo "Pós-gate-apply invariants" abaixo (pula o re-render/validate-lancamentos/push do MD — não há edição do editor pra refletir).
- **Gate humano normal — pull do MD** (o editor pode ter editado no Drive):
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 1 --files 01-categorized.md
  ```
  Se o pull falhar, usar a versão local.
- **Aplicar as edições do gate** via `scripts/apply-gate-edits.ts`:
  ```bash
  npx tsx scripts/apply-gate-edits.ts \
    --md data/editions/{AAMMDD}/01-categorized.md \
    --json data/editions/{AAMMDD}/_internal/01-categorized.json \
    --out data/editions/{AAMMDD}/_internal/01-approved.json
  ```
  Comportamento:
  - `## Destaques`: primeiras 3 linhas na ordem física viram D1/D2/D3 (rank 1/2/3, renumeradas). Se < 3, completa com candidatos do scorer por rank. Se > 3, mantém as 3 primeiras.
  - `## Lançamentos` / `## Pesquisas` / `## Notícias`: honra EXATAMENTE as URLs que o editor deixou em cada seção, na ordem física. Artigos removidos do MD são dropados. Artigos movidos entre buckets respeitam o bucket do MD final.
  - URLs no MD que não existem no `_internal/01-categorized.json` original são logadas como warn e ignoradas.
- **Re-renderizar o MD** a partir do `_internal/01-approved.json`:
  ```bash
  npx tsx scripts/render-categorized-md.ts \
    --in data/editions/{AAMMDD}/_internal/01-approved.json \
    --out data/editions/{AAMMDD}/01-categorized.md \
    --edition {AAMMDD} \
    --source-health data/source-health.json
  ```
  Re-validar LANÇAMENTOS após edições do gate (#787) — o editor pode ter movido URLs não-oficiais para LANÇAMENTOS durante a revisão:
  ```bash
  npx tsx scripts/validate-lancamentos.ts data/editions/{AAMMDD}/01-categorized.md
  ```
  Se exit code != 0: avisar o editor — `"⚠️ validate-lancamentos detectou URLs não-oficiais OU itens sem sinal de produto (not_a_tool, #1968) em LANÇAMENTOS. Mover pra NOTÍCIAS, ou allowlistar slug atípico legítimo em seed/lancamentos-tool-allowlist.txt."` — mas **não bloquear automaticamente**.
  Push do MD atualizado de volta para o Drive:
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 1 --files 01-categorized.md
  ```
- **Pós-gate-apply invariants (#1007 Fase 1)** — agora `01-approved.json` existe:
  ```bash
  npx tsx scripts/check-invariants.ts --stage 1 --edition-dir data/editions/{AAMMDD}/
  ```
  Roda todos os checks de Stage 1 (incluindo `categorized-has-eia-section` e `approved-has-3-highlights` + `coverage-line-present`). Exit 1 = bug downstream — logar warn e seguir; o sentinel ainda é escrito.

- **Escrever sentinel de conclusão do Stage 1:**
  ```bash
  npx tsx scripts/pipeline-sentinel.ts write \
    --edition {AAMMDD} --step 1 \
    --outputs "01-categorized.md,_internal/01-approved.json"
  ```
  Falha do sentinel → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator --level warn --message 'sentinel_write_failed'`). **Não bloquear** a aprovação do gate.
- **Arquivar o inbox** (#680): `mkdir -p data/inbox-archive` seguido de `mv data/inbox.md data/inbox-archive/{YYYY-MM-DD}.md`. Recriar `data/inbox.md` vazio. Sem o mkdir, falha em checkout limpo.
- **Atualizar `stage-status.md` (#1217 — removed cost.md).** Marcar stage 1 done via `update-stage-status.ts` com `--end ISO`, `--duration-ms` e opcionalmente `--cost-usd`, `--tokens-in`, `--tokens-out`, `--models "haiku-4-5,opus-4-7"` quando o orchestrator tiver agregado token usage dos subagents.
