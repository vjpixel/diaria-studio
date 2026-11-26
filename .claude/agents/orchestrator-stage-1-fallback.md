---
name: orchestrator-stage-1-fallback
description: Fallback do Stage 1 do orchestrator diar.ia.br (#14030) — prosa detalhada dos passos que `scripts/stage-1-run.ts` executa (1a-1e.5, 1f Path A, 1g-1m-bis, 1n-1p2, 1r-1w, 1y-bis, 1y-ter). Lido só quando o runner falta ou falha fora dos codes previstos, ou quando orchestrator-stage-1-research.md cita uma seção daqui. Não é um subagente invocável diretamente.
---

> Fallback de `.claude/agents/orchestrator-stage-1-research.md`, separado no #14030. Não executar diretamente e não ler no caminho normal: o runner `scripts/stage-1-run.ts` executa estes passos. Ler este arquivo quando o runner não existir ou falhar de um jeito não coberto pelos `code`s (aí seguir 1a-1y turno a turno, junto com os passos fora do runner do arquivo principal) ou quando o arquivo principal citar uma seção daqui. "Bloco acima", "abaixo" e as seções citadas que não estão aqui (§1f Path B, a captura de custo de §1g, §1m-ter, §1m-quater, §1m-quinquies, §1q, §1x, §1y) referem-se ao arquivo principal.

---

## Stage 1 — Research (fallback do runner)

### 1a. Inbox drain

Sempre roda, antes da pesquisa:
```bash
npx tsx scripts/inbox-drain.ts
```
Lê novos e-mails de `diariaeditor@gmail.com` via Gmail API e anexa entradas em `data/inbox.md`. Retorna JSON `{ new_entries, urls[], topics[], most_recent_iso, skipped, errors?, error_samples? }`.
- Se `skipped: true` com `reason: "local_error"` (#10026; o legado `gmail_mcp_error` é o mesmo caso — aceitar os dois): falha local (config, gravação de `data/inbox.md`/cursor), não MCP. Logar `warn` com o campo `error` e prosseguir sem inbox (não aborta a pipeline).
- Se `skipped: true` com `reason: "inbox_disabled"`: prosseguir silenciosamente.
- Se `skipped: true` com `reason: "search_failed"` (#665): Gmail falhou ao listar threads (timeout, schema change, 5xx). Tratar igual a `local_error` — logar `warn` e prosseguir sem inbox. Cursor não é avançado (drain não ocorreu).
- Se `skipped: true` com `reason: "auth_expired"` (#1973): OAuth Google expirado/revogado (`invalid_grant`/401) — o drain emite warn LOUD no stderr. **Surfaçar pro editor que submissões desta edição podem ter sido perdidas** + ação de re-auth (`npx tsx scripts/oauth-setup.ts` → `/diaria-inbox` pra recuperar). Idealmente o Stage 0 §0c já pegou via `check-google-token.ts`; este é o backstop. Cursor não avança.
- Se `errors > 0` (#667): drain parcial — algumas threads falharam ao carregar mas o drain prosseguiu. Logar `warn` com contagem + amostras de `error_samples`. As que falharam ficam em `failed_threads` no cursor e são re-buscadas por ID no próximo drain (#10030, `pending_retry`); `abandoned_threads` (após 5 tentativas) vai pro editor conferir no Gmail.
- Extrair `inbox_urls` = lista de URLs vindas do drainer + URLs de entradas já existentes em `data/inbox.md` que ainda não foram arquivadas. Extrair `inbox_topics` idem.
- **`new_entries: 0` é confiável por construção (#3201, resolvido por #3217 — [histórico](../../docs/orchestrator-stage-1-research-historia.md#1a-new-entries-0-confiavel-por-construcao)).** Por isso não é necessária uma segunda query de cross-check redundante contra a mesma fonte de dados — isso só duplicaria a chamada sem adicionar sinal novo. O guard que continua fazendo sentido é o já existente (`skipped`/`errors`/`auth_expired`): se o drain reportar sucesso (`skipped: false`, sem `errors`) e `new_entries: 0`, isso significa genuinamente que o editor não enviou nada no período — pode prosseguir sem alertar o editor. Se qualquer sinal de falha aparecer, tratar conforme os branches acima (nunca assumir "0 submissões" nesse caso).

### 1b. Preparação de fontes

- Ler `context/sources.md` e extrair os nomes+site queries de todas as fontes ativas.
- Ler `data/source-health.json` (se existir). Anotar fontes com 3+ `recent_outcomes` consecutivos não-ok — **ainda dispara**, mas sinaliza no relatório do Stage 1.

### 1c. Fetch poll stats da edição anterior (#201, #1044)

O `eia-compose.ts` (#110 fix 2) não depende de nenhum output do pipeline principal — disparar como **Bash em background** (`run_in_background: true`, na mesma mensagem dos researchers abaixo) — [histórico](../../docs/orchestrator-stage-1-research-historia.md#1d-eia-compose-bash-background).

```bash
npx tsx scripts/eia-compose.ts --edition {AAMMDD} --out-dir {EDITION_DIR}/
```

Armazenar `eia_bash_id` (output do `Bash(run_in_background=true)`) e `eia_dispatch_ts` (timestamp). **Persistir em disco (#5414)** — Stage 3 pode rodar como sessão nova (`/diaria-3-imagens`), sem `eia_bash_id` em memória:
```bash
npx tsx scripts/lib/eia-dispatch-state.ts --edition-dir {EDITION_DIR} \
  --bash-id "{eia_bash_id}" --dispatched-at "{eia_dispatch_ts}"
```
Stage 3 usa o `bashId` (só útil na mesma sessão) pra detectar conclusão OU — sempre, inclusive em sessão nova — faz file-presence check em `{EDITION_DIR}/01-eia.md`, lendo `dispatchedAt` de `eia-dispatch-state.json` (via `scripts/lib/eia-dispatch-state.ts`) para o timeout de 10min do §3a.

**Logging por caminho** (#110 fix 4):
- **Dispatch normal**: logar `info 'eia dispatched (background bash)'`.
- **Skip por resume** (`01-eia.md` já existir): logar `info 'eia dispatch skipped: already_exists (resume)'`. Não dispatchar (não gravar `eia-dispatch-state.json`).
- **Skip por dispatch failure** (Bash run_in_background indisponível ou erro imediato): logar `warn 'eia dispatch skipped: bash_unavailable'`. Ainda assim prosseguir com a Etapa 1 — Etapa 3 sinaliza ausência e oferece retry.

**Validação no gate da Etapa 1** (#110 fix 1): antes do gate principal, checar se `{EDITION_DIR}/01-eia.md` existe OU se há background bash ativo (via `eia_bash_id`). Se nenhum dos dois (skip silencioso), incluir bullet no relatório: `🟡 É IA?: não dispatchado — rode /diaria-3-imagens {AAMMDD} eai antes do gate da Etapa 4.`

### 1d. Método de fetch por fonte (#54)

Pra cada fonte em `context/sources.md`, escolher entre RSS (rápido, determinístico) e WebSearch (fallback):

1. Fontes com RSS têm linha `- RSS: {url}` em `context/sources.md`. Fontes com filtro de tópico (#347) têm linha `- Topic filter: {term1,term2,...}` logo abaixo.

**Preferido (#1209, #1270):** 2 passos curtos — `list-active-sources` gera batch, `fetch-rss-batch` dispara:

```bash
npx tsx scripts/list-active-sources.ts --format json --rss-only --out {EDITION_DIR}/_internal/rss-batch.json
npx tsx scripts/fetch-rss-batch.ts --sources {EDITION_DIR}/_internal/rss-batch.json --out {EDITION_DIR}/_internal/researcher-results.json --days {window_days}
```

35 fontes em ~9s. **Não construir `rss-batch.json` via parser inline** — `list-active-sources.ts` é canônico (#1270).

### 1d-bis. Pre-warm verify cache (background, #1554 P1)

**Imediatamente após RSS batch retornar**, kick off `prewarm-verify-cache.ts` em background pra popular o cache cross-edição enquanto os agents WebSearch (1f) rodam em paralelo. URLs do RSS estarão pre-verificadas quando o passo 1i principal rodar — elimina ~3-5min de wall clock duplicado.

```bash
Bash("npx tsx scripts/prewarm-verify-cache.ts --edition-dir {EDITION_DIR}/", run_in_background: true)
```

Capturar o `bash_id`. Não aguardar — segue direto pro 1e.5 e 1f. O processo termina sozinho enquanto agents WebSearch dispatch. Quando 1i rodar, URLs do RSS hitam cache e skipam HEAD+GET.

**Falhas são não-bloqueantes** — o script exit 0 em erro, e o 1i sempre cobre o que faltar. Não é necessário await formal; o cache é persistente e idempotente.

**Opção manual (legado):** se preferir dispatch individual:

2. **Se a URL na linha RSS termina em `sitemap.xml`** (#761): disparar `Bash("npx tsx scripts/fetch-sitemap.ts --url <sitemap_url> --source <nome> --days <window_days>")` em paralelo. Marca `method: "sitemap"`. Output shape compatível com `fetch-rss` (mesmas chaves `articles[]`, `error?`). Usado quando a fonte não tem RSS mas expõe sitemap.xml — nenhuma fonte ativa usa este caminho hoje (Perplexity Research, o único exemplo real, teve a RSS limpa em #8110: sitemap.xml nunca foi um feed válido).
3. **Se fonte tem RSS** (URL não termina em `sitemap.xml`): disparar `Bash("npx tsx scripts/fetch-rss.ts --url <rss> --source <nome> --days <window_days>")` em paralelo. Rápido (~1-2s por fonte). Marca `method: "rss"`.
   - **Se a fonte tem `Topic filter`** (#347): adicionar `--topic-filter "<termos>"` ao comando — só artigos cujo `title+summary` contém ao menos 1 dos termos passam. Crítico pro arXiv (~600 papers/dia → ~80-120 após filtro).
4. **Se RSS/sitemap falha ou retorna 0 artigos**: fallback automático — dispara `source-researcher` (WebSearch) pra mesma fonte. Marca `method: "websearch_fallback"`. 1 falha já dispara fallback.
5. **Se fonte NÃO tem RSS nem sitemap**: disparar `source-researcher` diretamente (via WebSearch com `site:` query). Marca `method: "websearch"`.

Preserva saúde da fonte em todos os casos: propagar `method` como campo extra no `RunRecord`.

### 1e.5. Extrair inbox_topics (#662)

Entradas de texto-puro do editor (sem URL) viram queries de discovery. Armazenar output como `inbox_topics` para o passo 1f:
```bash
npx tsx scripts/extract-inbox-topics.ts --inbox-md data/inbox.md --out {EDITION_DIR}/_internal/inbox-topics.json
```
Output: JSON array de strings (pode ser `[]`). Logar: `"inbox_topics: N topics extraídos"`.

### 1f. Dispatch de researchers e discovery — Path A

Os avisos ⛔ de §1f (nunca pular o passo; nunca pré-checar `BRAVE_API_KEY` no Bash) e o Path B ficam no arquivo principal.

#### Path A: Brave Search determinístico (DEFAULT desde #1560)

**Default desde 260529 (#1560).** Quando `BRAVE_API_KEY` está setada (default), usar script TS em vez dos agents Haiku. Economiza ~8-12min/edição ([histórico de validação](../../docs/orchestrator-stage-1-research-historia.md#path-a-validacao-paridade)). Setar `WEBSEARCH_BACKEND=agents` força fallback pro Path B.

**Logar a decisão de path ANTES de rodar o script (#3842 — [histórico](../../docs/orchestrator-stage-1-research-historia.md#path-a-logging-decisao)).** Primeiro checar se `WEBSEARCH_BACKEND=agents` está setada no ambiente (override manual, força Path B mesmo com a key presente). Se sim, logar e ir direto pro Path B — **não rodar** `fetch-websearch-batch.ts`:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator \
  --level warn --message "websearch_path: B (WEBSEARCH_BACKEND=agents)" \
  --details '{"path":"B","reason":"WEBSEARCH_BACKEND_agents"}'
```

Senão (override ausente), rodar o script abaixo normalmente:

```bash
# Gerar sources list
npx tsx scripts/list-active-sources.ts --format json --websearch-only \
  --out {EDITION_DIR}/_internal/websearch-batch.json

# Pre-flight blocklist (mesma lib usada no Path B)
# (Output já filtrado quando websearch-batch.json é gerado pelo list-active-sources.ts)

# Rodar dispatch determinístico
npx tsx scripts/fetch-websearch-batch.ts \
  --sources {EDITION_DIR}/_internal/websearch-batch.json \
  --discovery {EDITION_DIR}/_internal/inbox-topics.json \
  --cutoff-iso {cutoff_iso} \
  --window-days {window_days} \
  --edition {AAMMDD} \
  --out {EDITION_DIR}/_internal/websearch-results.json
```

Flag `--edition` (#1558): tagga cada Brave query no `data/brave-credits.jsonl` pra tracking de consumo no relatório de edição.

Output em `websearch-results.json` é RunRecord[] compatível com researcher-results.json — mergear no aggregate.

Exit code 3 do script = "BRAVE_API_KEY ausente" → fallback automático pro Path B (não falha o pipeline).

**Logar o desfecho (#3842)** assim que o script retornar:
- Exit 0 (Path A rodou com a key presente):
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator \
    --level info --message "websearch_path: A (brave_key_present)" \
    --details '{"path":"A","reason":"brave_key_present"}'
  ```
- Exit 3 (`BRAVE_API_KEY` ausente → fallback pro Path B abaixo):
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator \
    --level warn --message "websearch_path: B (brave_key_missing)" \
    --details '{"path":"B","reason":"brave_key_missing"}'
  ```

Melhorias trackeadas em #1559 (filtro de path FAQ/help + WebFetch OG tags).

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

1. Gravar em `{EDITION_DIR}/_internal/researcher-results.json` (rastreabilidade).
2. Rodar **uma vez** o script batch:
   ```bash
   npx tsx scripts/record-source-runs.ts \
     --runs {EDITION_DIR}/_internal/researcher-results.json \
     --edition {AAMMDD}
   ```
   Atualiza `data/source-health.json` + anexa linhas JSONL em `data/sources/{slug}.jsonl`. O script retorna JSON com `summary.sources_with_consecutive_failures_ge3` — usar no relatório do gate.

**Capturar custo de tokens dos dispatches (#3748):** fica no arquivo principal, seção "1g (custo dos dispatches)" — o runner não roda este passo.

### 1g-ter. Montar o pool inicial (`tmp-articles-raw.json`) — script, não manual (#4955)

**⛔ NUNCA montar `tmp-articles-raw.json` manualmente (retype campo a campo)** — causa raiz do #4955, [histórico](../../docs/orchestrator-stage-1-research-historia.md#4955-summary-sumindo-do-pool).
```bash
npx tsx scripts/assemble-research-pool.ts --runs {EDITION_DIR}/_internal/researcher-results.json --out {EDITION_DIR}/_internal/tmp-articles-raw.json
```
Contrato da transformação (#4985, [detalhe completo](../../docs/orchestrator-stage-1-research-historia.md#4985-contrato-pool-flatten)): **entra** `RunRecordLike[]`; **sai** `PoolArticle[]` flat; **preserva** TODOS os campos verbatim via spread (inclusive `summary` — sem allowlist); **transforma** filtrando `fail`/`timeout`, preenchendo `source` ausente, mergeando merge-safe. Output: `{ runs_total, runs_ok, articles_from_runs, already_in_pool, injected, total_pool_size }`.

### 1g-bis. Carry-over de candidatos não-selecionados (#655)

Reaproveita artigos não-aprovados da edição anterior (`runners_up` + buckets) como candidatos da edição atual. Roda antes do inject-inbox e do dedup — carry-over passa por todos os filtros normalmente, então duplicatas com novas coletas são resolvidas naturalmente.

```bash
npx tsx scripts/load-carry-over.ts \
  --edition-dir {EDITION_DIR} \
  --pool {EDITION_DIR}/_internal/tmp-articles-raw.json \
  --window-start {window_start} \
  --window-end {WINDOW_END} \
  --score-min 60
```

Output stdout: `{ prev, candidates_total, kept, skipped, total_pool_size }`. Se `prev: null` (edição N=1, sem anterior), pool fica inalterado e o script exit 0 silenciosamente. Logar como info no run-log. Cada artigo carregado vira `{ ..., flag: "carry_over", carry_over_from: "{prev}" }` e aparece no `01-categorized.md` com marker `[carry-over de {AAMMDD}]`.

### 1h. Injetar inbox_urls (#593, #594)

**Automatizado via script** — substitui o passo manual que era fonte de bug ([histórico #594](../../docs/orchestrator-stage-1-research-historia.md#1h-automatizado-via-script)). Política #593: TODOS os URLs de submissões do editor (incluindo forwards de newsletter) entram no pool de pesquisa.

```bash
npx tsx scripts/inject-inbox-urls.ts \
  --inbox-md data/inbox.md \
  --captured-articles {EDITION_DIR}/_internal/captured-newsletter-articles.json \
  --pool {EDITION_DIR}/_internal/tmp-articles-raw.json \
  --out {EDITION_DIR}/_internal/tmp-articles-raw.json \
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
  --edition-dir {EDITION_DIR} \
  --inbox-md data/inbox.md
```

Se exit 1: step 1h foi skipado ou falhou silenciosamente. Re-executar step 1h e repetir. Se exit 2: erro de leitura de arquivo. Verificar paths.

Logar resultado como info no run-log. **Não prosseguir para 1i se exit 1.**

### 1h.7. Marker check determinístico (#1330)

`inject-inbox-urls.ts` grava `_internal/.marker-inject-inbox-urls.json` ao final. Antes de 1i, assertar o marker — pega o cenário "orchestrator skipou 1h+1h.6 inteiros" (#594 260505, 260518) que a validação 1h.6 não captura sozinha porque também é skipada. `npx tsx scripts/pipeline-sentinel.ts assert-marker --edition {AAMMDD} --name inject-inbox-urls` — exit 0 prossegue; exit 1 **HALT** via `render-halt-banner.ts` com motivo "marker inject-inbox-urls ausente".

### 1i. Link verification (script direto)

Gravar a lista de URLs da lista agregada em `{EDITION_DIR}/_internal/tmp-urls-all.json` (array de strings) e rodar:
```bash
npx tsx scripts/verify-accessibility.ts \
  {EDITION_DIR}/_internal/tmp-urls-all.json \
  {EDITION_DIR}/_internal/link-verify-all.json \
  --bodies-dir {EDITION_DIR}/_internal/_forensic/link-verify-bodies \
  --cache data/link-verify-cache.json \
  --browser-concurrency 8
```

A flag `--cache` (#717 hipótese 2) ativa o cache cross-edição de verdicts. URLs já verificadas como `accessible`/`blocked`/`paywall` em qualquer edição passada (TTL default 7 dias) skipam HEAD+GET inteiro. Cache persistido em `data/link-verify-cache.json` (gitignored). Hit ratio típico esperado >50% após 1-2 semanas de runs. Override TTL com `--cache-ttl-days N`.

A flag `--bodies-dir` (#717 hipótese 1) persiste o body raw de cada GET bem-sucedido no path indicado. `verify-dates.ts` (rodado pelo step 1p1 research-review-dates) lê desse cache antes de fetchar — elimina ~3-4min de fetch duplicado em edições com 300+ URLs.

O fallback de browser (Puppeteer) usa worker pool com `--browser-concurrency 8` (#717 hipótese 3, default 4, bumped pra 8 em P5 #1553). URLs `uncertain` no first-pass são verificadas em paralelo com até N tabs no mesmo browser headless ([histórico de medição](../../docs/orchestrator-stage-1-research-historia.md#1i-browser-concurrency)). Descer pra 2-4 se a máquina estiver sob pressão de memória.

Ler `{EDITION_DIR}/_internal/link-verify-all.json` (array de `{ url, verdict, finalUrl, note, resolvedFrom?, access_uncertain? }`). Então:
- **Anotar (#778)**: para todos os artigos, adicionar `verify_verdict` e (quando presente) `verify_note` no artigo a partir do match por URL no `link-verify-all.json`. Isso permite que `render-categorized-md.ts` marque visualmente artigos editor-submitted que falharam acessibilidade (per #778) em vez de eles sumirem do gate.
- **Remover** artigos com verdict `paywall`, `blocked` ou `aggregator` (sem `resolvedFrom`) que **não** sejam de inbox. Editor-submitted (`flag: "editor_submitted"` ou `source: "inbox"`) **nunca** são dropados por verdict de acessibilidade — apenas anotados (#778). A regra de aggregator continua dropando inbox-aggregator que não foi expandido pelo `expand-inbox-aggregators.ts` (esse script já trata o caso primário-extraído).
- **Manter com flag** artigos com verdict `anti_bot` (#320): adicionar `"access_uncertain": true`. Incluir no relatório do gate: `"⚠️ N artigo(s) marcados anti_bot — accessible no browser mas bloqueados por crawler. Revisar antes de aprovar."` com a lista de domínios.
- **Marcar** artigos com verdict `uncertain` adicionando `"date_unverified": true`. Esses artigos continuam no pipeline mas serão sinalizados com `⚠️` no gate para revisão manual.
- **Substituir URL** dos artigos com `resolvedFrom` presente: atualizar `url` para `finalUrl` e adicionar `resolvedFrom` ao artigo para rastreabilidade. Isso inclui URLs de shorteners que foram resolvidos pro destino real (#317).

### 1j. Expandir links de agregadores do inbox (#483)

Quando o editor submete um link de agregador (ex: Perplexity Page, Flipboard), o link não é simplesmente descartado — seus links primários são extraídos e injetados no pipeline:
```bash
npx tsx scripts/expand-inbox-aggregators.ts \
  --articles {EDITION_DIR}/_internal/tmp-articles-post-verify.json \
  --verify   {EDITION_DIR}/_internal/link-verify-all.json \
  --out      {EDITION_DIR}/_internal/tmp-articles-expanded.json
```
Substitui cada artigo inbox com `verdict: "aggregator"` pelos links primários extraídos (até 10 por agregador, `source: "inbox_via_aggregator"`). Se nenhum link for encontrado, o agregador é descartado com warning. Artigos não-inbox com verdict `aggregator` continuam sendo descartados normalmente.

### 1k. Enriquecer artigos do inbox (#109)

URLs do editor entram com `title: "(inbox)"` e `summary: null`. Após a expansão de agregadores:
```bash
npx tsx scripts/enrich-inbox-articles.ts \
  --in {EDITION_DIR}/_internal/tmp-articles-enrich.json \
  --bodies-dir {EDITION_DIR}/_internal/_forensic/link-verify-bodies
```
O script toca: (a) artigos do **inbox** (`flag: "editor_submitted"` ou `source: "inbox"`) com título placeholder (`(inbox)`, `[INBOX] ...`) OU `summary` vazio — lê o body cacheado por `verify-accessibility.ts` no 1i (`--bodies-dir`); se ausente, faz fetch da URL final; e (b) **#1696**: artigos de **fonte regular** com título real mas `summary` vazio — preenche `og:description` (itens de seção secundária LANÇAMENTOS/RADAR sem summary renderizavam como título pelado). Para (b) o enrichment é **cache-only** (sem network fetch — bound de custo; o body já foi cacheado no 1i pros acessíveis); cache-miss vira outcome `cache_miss_skipped_non_inbox`. Extrai `og:title` / `og:description` (fallback `<title>` / `meta name=description`); títulos curados pelo editor preservados (non-inbox NÃO tem o título tocado — só summary). Falhas de fetch (inbox) viram `fetch_failed`. Ler o JSON de volta (mutated in place). Stderr loga `[enrich] body-cache: H/T hit (P%)`.

### 1l. Dedup

```bash
npx tsx scripts/dedup.ts \
  --articles {EDITION_DIR}/_internal/tmp-articles-raw.json \
  --past-editions data/past-editions.md \
  --window {window_days} \
  --out {EDITION_DIR}/_internal/tmp-dedup-output.json
```

Pré-passo automático (#485): artigos inbox com título placeholder `(inbox)` têm o título real resolvido via fetch antes do dedup principal, evitando falsos-positivos de similaridade entre artigos com mesmo placeholder. Ler `kept[]` do JSON de saída como lista de artigos daqui em diante. Logar `removed[]` (apenas contagem e motivos) para rastreabilidade. Limpar arquivos temporários com Bash — **exceto `_internal/tmp-dedup-output.json`** (#4229): o item 4a do gate (1x), mais adiante neste doc, lê `editorSubmittedLost[]` desse MESMO arquivo, com fallback silencioso ("vazio ou arquivo ausente: omitir") se ele já tiver sido apagado aqui.

**Proveniência do editor (#4192, #4193).** `flag: "editor_submitted"` nunca é descartado pelo Pass-1d (theme-entity match) — no máximo marcado (`theme_entity_flagged`). Quando uma submissão do editor É removida por outro pass, o próprio `dedup.ts` tenta primeiro resgatar a proveniência num sobrevivente same-story (URL duplicada, cluster #3920, ou o Pass-3 same-story cross-pass — o sobrevivente ganha `flag: "editor_submitted"` + `editor_submitted_url` apontando pro link original). Só o que **não** foi resgatado chega em `editorSubmittedLost[]` no JSON de saída. Guardar essa lista — é o input do item 4a do gate (1x) abaixo.

### 1m. Categorizar

Gravar `kept[]` em `{EDITION_DIR}/_internal/tmp-kept.json` e rodar:
```bash
npx tsx scripts/categorize.ts \
  --articles {EDITION_DIR}/_internal/tmp-kept.json \
  --out {EDITION_DIR}/_internal/tmp-categorized.json
```

Em seguida, rodar **enrich-primary-source** (#487) pra sinalizar notícias que parecem cobrir lançamentos (verbo + empresa conhecida no título) — o editor verá um marker `🚀→{dominio}` no MD do gate sugerindo busca da fonte primária:
```bash
npx tsx scripts/enrich-primary-source.ts \
  --in {EDITION_DIR}/_internal/tmp-categorized.json
```
In-place. Loga no stderr `N/M notícia(s) sinalizadas` e nunca falha. Ler `{EDITION_DIR}/_internal/tmp-categorized.json` como `{ lancamento, radar, use_melhor, video }` (#1629) para usar daqui em diante.

**1m-bis. Checkpoint de integridade (#4986):** `npx tsx scripts/verify-summary-integrity.ts --raw {EDITION_DIR}/_internal/tmp-articles-raw.json --check {EDITION_DIR}/_internal/tmp-categorized.json --edition {AAMMDD} --label tmp-categorized.json` — backstop determinístico pro #4955/#4988 ([detalhe](../../docs/orchestrator-stage-1-research-historia.md#4986-checkpoint-de-integridade)). Exit 1 = regressão de pipeline (nunca editorial) — investigar `dedup.ts`/`categorize.ts` antes de seguir.

**1m-ter, 1m-quater e 1m-quinquies** ficam no arquivo principal (passos fora do runner; 1m-quater também roda no runner, idempotente).

**Instrumentação type_hint vs categorize (#1718 fase 1) — silenciosa, append-only:** mede a divergência entre o `type_hint` do source-researcher e a decisão de lançamento do categorize, sem mudar nada. Acumula o dado pra decidir (em ~2 semanas) se vale inverter o ônus (type_hint primário). Nunca bloqueia:
```bash
npx tsx scripts/measure-type-hint-divergence.ts --in {EDITION_DIR}/_internal/tmp-categorized.json --edition {AAMMDD}
```
Append em `data/type-hint-divergence.jsonl`. Se `launch_disagreements > 0`, loga warn informativo (não-bloqueante).

### 1n. Topic clustering (#237)

Rodar `topic-cluster.ts` pra consolidar artigos do mesmo evento dentro do mesmo bucket:
```bash
npx tsx scripts/topic-cluster.ts \
  --in {EDITION_DIR}/_internal/tmp-categorized.json \
  --out {EDITION_DIR}/_internal/tmp-clustered.json
```

**Não passar `--threshold` explícito** (#4729) — o script escolhe o default correto por método sozinho: `0.85` para cosine similarity (via `gemini-embedding-001`, quando `GEMINI_API_KEY` está configurada — caminho normal de produção) ou `0.5` para o fallback Jaccard de tokens (sem key, ou quando todos os embeddings falham). Um `--threshold 0.3` fixo no CLI, como este arquivo documentava antes, é calibrado pra Jaccard e sobrescreve o default de 0.85 sempre que a key está presente — cosine com threshold 0.3 é extremamente agressivo (clustering falso-positivo dispara). False positives no fallback Jaccard são amortecidos pelo ranking intra-cluster (representante mantido é o de melhor qualidade). Daqui em diante usar `_internal/tmp-clustered.json`. Logar `clusters.length` (zero é normal).

Modelo de embedding vem de `platform.config.json > gemini.embedding_model` (default `gemini-embedding-001`, #4654 — sucede o `text-embedding-004` descontinuado). O script escreve `_internal/topic-cluster-stats.json` junto do `--out`; o pre-gate validator (Passo 3, `validate-stage-1-output.ts`) lê esse sidecar e vira um WARN visível no gate quando `GEMINI_API_KEY` está configurada mas os embeddings falharam (drift de catálogo, quota, rede) — nunca um `console.warn` perdido no stderr. Sem `GEMINI_API_KEY`, o fallback Jaccard é o caminho esperado e não gera warning.

### 1o. Filtro determinístico de janela (#233, #560)

Antes do step 1p1 (research-review-dates), rodar `scripts/filter-date-window.ts` pra garantir que **nenhum** artigo fora da janela chegue ao filtro de datas. **Anchor = `anchor_iso`** (today UTC), não `edition_iso` — assim a janela cobre o que foi publicado de fato nos últimos `window_days` dias, e não uma janela hipotética entre hoje e a publication date:
```bash
npx tsx scripts/filter-date-window.ts \
  --articles {EDITION_DIR}/_internal/tmp-clustered.json \
  --anchor-date {anchor_iso} \
  --edition-date {edition_iso} \
  --window-days {window_days} \
  --out {EDITION_DIR}/_internal/tmp-filtered.json
```
Logar `removed.length`. Daqui em diante o input do step 1p1 é `_internal/tmp-filtered.json` (que já tem `{ kept: { lancamento, radar, use_melhor, video } }`, #1629) — extrair `kept` e usar como `categorized`.

### 1p1. Research-review-dates (script, Filtro 1) — #1112

Rodar `scripts/research-review-dates.ts` ANTES do scorer (Filtro 1: verify-dates + filter-date-window com datas corrigidas). Determinístico, sem LLM:
```bash
npx tsx scripts/research-review-dates.ts \
  --in {EDITION_DIR}/_internal/tmp-filtered.json \
  --out {EDITION_DIR}/_internal/tmp-dates-reviewed.json \
  --edition-dir {EDITION_DIR}/ \
  --anchor-iso {anchor_iso} \
  --edition-iso {edition_iso} \
  --window-days {window_days} \
  --bodies-dir {EDITION_DIR}/_internal/_forensic/link-verify-bodies \
  --verify-cache data/link-verify-cache.json \
  --link-verify-json {EDITION_DIR}/_internal/link-verify-all.json
```
Output: `{ categorized, stats }`. Logar `stats.date_corrected`, `stats.fetch_failed`, `stats.removed_date_window`. `stats.editorSubmittedLost` (#4656) deveria ser sempre `[]` — submissão do editor nunca é removida pela janela de data (guard em `filter-date-window.ts`, mesmo precedente de `dedup.ts` Pass 1d/#4192); se vier não-vazio é regressão do guard, ver item 4b do gate abaixo.

**#1554 P2 — `--link-verify-json`**: passa o output do passo 1i (verify-accessibility). Verify-accessibility já fetcha cada URL e extrai `published_date` inline durante o GET. Quando esse campo está populado, o script aqui faz pre-skip do verifyDate (sem novo HTTP GET) — economiza 2-4 min em edições com 70+ artigos. URLs sem pre-extracted date (browser fallback, HEAD-only, fetch failed) caem no caminho normal de verifyDate.

### 1p2. ~~Research-reviewer~~ — REMOVIDO #1553 (theme dedup agora é `dedup.ts` Pass 1c/1d)

Se tema repetido escapar de `dedup.ts`: considerar lower `subjectVsPastThreshold` (0.6→0.55) ou re-introduzir o agent como fallback. Input do scorer (1q) vem direto de `tmp-dates-reviewed.json` (output de 1p1).

### 1r. Promoção de runners_up até 6 highlights

Roda **após 1q.5 OU 1q-fallback** (o `tmp-scored.json` já tem `highlights` + `runners_up`). Promover de `runners_up` pra completar 6 highlights se `highlights.length < 6`. Script puro:
```bash
npx tsx scripts/promote-runners-up.ts --scored {EDITION_DIR}/_internal/tmp-scored.json --out {EDITION_DIR}/_internal/tmp-scored.json
```
In-place. Stdout: `{ promoted, highlights_final: 6 }`. Logar info.

### 1s. Finalize Stage 1

Monta o output final estruturado que vai pro gate:
```bash
npx tsx scripts/finalize-stage1.ts \
  --scored {EDITION_DIR}/_internal/tmp-scored.json \
  --out {EDITION_DIR}/_internal/tmp-finalized.json
```
Output: `{ highlights, runners_up, lancamento, radar, use_melhor, video, clusters }`. Ler como `categorized` daqui em diante.

### 1t / 1u / 1u-bis / 1u-ter. Mínimos, strip verifier, dedup intra, evergreen (fase única)

Todas estas etapas vivem no mesmo phase determinístico; os scripts isolados (`check-min-sections.ts`, `strip-verifier.ts`, `dedupe-intra-edition.ts`, `filter-evergreen.ts`) foram removidos do repo — segui-los à mão produz `ERR_MODULE_NOT_FOUND`. Executar uma única chamada:
```bash
npx tsx scripts/stage-1-run.ts --phase post-select-render --edition {AAMMDD}
```
Isso executa, em sequência: sumarização de mínimos (1t, warn-only), remoção do campo `verifier` (1u, produz `tmp-categorized.json` — arquivo que o gate lê), os rebaixamentos 1u-quater/1u-quinquies (abaixo), dedup intra-edição (1u-bis) e filtro evergreen (1u-ter) — nessa ordem desde #9750. Nenhum passo bloqueia; saídas são logadas como info/warn.

**1u-quater (#9100, decisão do editor de 05/10/2026)** — `scripts/demote-same-fact-highlights.ts`, também dentro do `post-select-render`, antes do dedup intra-edição (1u-bis, #9750 — o dedup tem que comparar contra o top-3 já reordenado) e do render: candidato a destaque no top-3 que repete fato dos D1–D3 publicados nas 3 últimas edições (mesma URL, ou mesma entidade + ≥2 números idênticos) é **rebaixado, nunca descartado** — o próximo candidato sobe, o item fica no pool marcado `same_fact_demoted` e a lista vai para `_internal/01-same-fact-demoted.json` (`demoted[]`/`kept[]`). Preserva ≥1 destaque negativo (#3916): sem substituto negativo, o repetido fica (só aviso, `kept[]`). Na mesma passada (#10795, `scripts/lib/negative-promotion-eligibility.ts`): negativo de processo/acusação ou de entidade+tema que já foi destaque nos últimos 14 dias não fica no top-3 por promoção nem em D1 à frente de item de score maior — sai para o pool marcado `negative_promotion_excluded` (a vaga vai para o melhor negativo elegível, em D3) e entra no log como `negative_promotion[]`.

**1u-quinquies (#9462, decisão do editor de 05/10/2026)** — `scripts/demote-generic-study-highlights.ts`, logo depois do 1u-quater: candidato a destaque no top-3 que é **estudo/estatística ou case corporativo genérico sem fato novo concreto** (classificador léxico do TÍTULO em `scripts/lib/generic-study-penalty.ts`; lançamento, incidente, decisão, consequência para pessoas, comportamento de IA ou ângulo de serviço vetam; ângulo Brasil não é sinal) é **rebaixado, nunca descartado** — o próximo candidato sobe (nunca um item já rebaixado por MESMO FATO), o item fica no pool e a lista vai para `_internal/01-generic-study-demoted.json` (`applied`, `demoted[]`, `kept[]`). Preserva ≥1 destaque negativo (#3916). Flag `platform.config.json` → `selection.generic_study_penalty.enabled`; **desligada = modo sombra** (não reordena, grava `applied: false` com o que faria). Notas `⬇️`/`🔎` saem no relatório do `stage-1-run.ts`; no gate 1, mostrar junto do `same_fact_warnings`.

**1u-sexies (#10137)** — `scripts/primary-source-active-lookup.ts`, logo depois do 1u-quinquies (top-3 já final) e antes do 1u-bis: para cada destaque D1-D3 que tem `suggested_primary_domain` E verbo de lançamento no título (#10141), 1 query Brave `site:{domínio oficial} {título}`; troca a URL pela oficial SÓ se o resultado está no domínio oficial E é o mesmo assunto (similaridade ≥ 0,60 ou o mesmo produto com versão idêntica nos dois títulos — "Haiku 5.5"↔"Haiku 5.5", nunca só "Claude"/"GPT" nem "GPT-5.5"↔"GPT-5"; o matcher do dedup intra-edição NÃO é usado, #10141) E a URL não repete edição passada nem já está nesta edição. Anota `primary_source_substituted: { from, to }` + `primary_source_lookup` no artigo; log em `_internal/01-primary-source-lookup.json`. Fail-soft: sem `BRAVE_API_KEY`/rede, nada muda. Existe porque §1m-ter/§1y, delegados ao orchestrator desde o runner (#5415), não rodavam (zero substituição desde 260818). **#10162 (fonte oficial vence a cobertura em qualquer seção):** depois dos destaques, o mesmo passo roda sobre o pool — RADAR com `launch_candidate` (mesmo gate de verbo de lançamento) e USE MELHOR (empresa citada no título, URL fora do domínio oficial) —, até 6 buscas por edição (`--pool-max`); nunca troca submissão do editor nem URL já oficial, e não leva um domínio acima de 2 URLs na edição (#5735, `reason: official-domain-at-cap`). Notas `🔗`/`🔎` no relatório do `stage-1-run.ts`; no gate 1, mostrar as trocas `🔗` para o editor conferir.

### 1v. Render MD (categorized + approved)

```bash
npx tsx scripts/render-categorized-md.ts \
  --categorized {EDITION_DIR}/_internal/tmp-categorized.json \
  --out {EDITION_DIR}/01-categorized.md \
  --edition {AAMMDD} \
  --eia {EDITION_DIR}/01-eia.md
```

Grava também `_internal/01-categorized.json` (mesmo conteúdo, JSON) e `_internal/01-approved.json` (cópia idêntica — gate ainda não rodou, mas o arquivo já existe pra resume).

### 1v-scoring-features. Feature store de scoring (#7975, Camada 1 da #7972)

```bash
npx tsx scripts/backfill-scoring-features.ts --edition {AAMMDD} --editions-dir data/editions
```

Grava `_internal/scoring-features.json` — 1 linha por candidato do pool, com as features determinísticas (bônus aplicados, recência, domínio, link oficial, etc.) que a calibração de score (Fase 2, #7976) vai usar pra aprender pesos a partir das correções do editor. Read-only sobre `01-categorized.json`, só escreve o arquivo novo — nunca afeta a categorização/score real desta edição. **Roda no runner** desde o #7980 (fase `post-select-render`, logo depois de §1v) — até então este passo existia SÓ aqui na prosa e nunca era executado na prática, o que deixou 260914..260918 inteiras sem feature store. `validate-stage-1-output.ts` (§1w-bis) agora também carrega uma assertion `scoring_features_present` (warn-only) como backstop pro caminho em prosa. **Fail-soft**: exit 1 = logar `warn` (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator --level warn --message 'scoring_features_write_failed'`) e continuar — ausência do feature store atrasa a Fase 2, nunca bloqueia a edição. (Exit 0 sem gravar nada é possível se o diretório da edição ainda não existir em `--editions-dir` — inofensivo aqui, este passo só roda depois de 1v já ter criado `_internal/01-categorized.json`.)

### 1v-bis..1v-quinquies. Lints warn-only (rodam em sequência)

1. **1v-bis** — `lint-newsletter-md.ts --check tz-leak` (ex: "23h" sem fuso, "ontem" ambíguo).
2. **1v-ter** — `lint-newsletter-md.ts --check incomplete-sentences` (frases terminadas em vírgula, `...` sem continuação).
3. **1v-quater** — `lint-newsletter-md.ts --check duplicate-domains` (mais de 2 URLs do mesmo domínio registrável na edição inteira — #5735).
4. **1v-quinquies** — `lint-newsletter-md.ts --check video-links-are-youtube` (VÍDEOS só YouTube; backstop pro gate da Etapa 4).

Cada um: exit 0 = ok, exit 1 = violations (array no stdout) → logar `warn` cada violation. **Nunca bloqueia** — só informa pro gate.

### 1w-quint. Anti-skip 1f (BLOQUEIA) — #1091

```bash
npx tsx scripts/validate-stage-1-completeness.ts \
  --edition-dir {EDITION_DIR} \
  --inbox-md data/inbox.md
```
Valida que 1f (dispatch de researchers/discovery) **não foi pulado** — detecta o cenário onde o orchestrator omitiu o passo inteiro (causa raiz do #1091). Exit 1 = step 1f não executou → **HALT** via `render-halt-banner.ts` com motivo "validate-stage-1-completeness: step 1f não executou". Exit 2 = erro de leitura. **Este é um HALT obrigatório (code 2 do runner)** — não prosseguir, não bypassar com auto_approve.

### 1w-bis. Validate stage-1 output (blocker vira HALT)

```bash
npx tsx scripts/validate-stage-1-output.ts --edition-dir {EDITION_DIR}
```
Valida shape final do `01-categorized.md`/`_internal/01-categorized.json`/`_internal/01-approved.json` contra invariantes de publicação. Exit 1 = validation failed → **HALT** (code 2). Exit 2 = erro de leitura.

### 1w-quat. Check invariants: categorized-has-eia-section (BLOQUEIA)

```bash
npx tsx scripts/check-invariants.ts --stage 1 --edition-dir {EDITION_DIR}
```
Valida que o `01-categorized.md` tem a seção É IA? (injectado pelo `render-categorized-md.ts` a partir de `01-eia.md`). Exit 1 = missing → **HALT** (code 2).

### 1w-ter. Payload sizes

```bash
npx tsx scripts/payload-sizes.ts --edition-dir {EDITION_DIR}
```
Loga tamanhos dos arquivos de saída (`01-categorized.md`, `_internal/01-categorized.json`, `_internal/01-approved.json`, `websearch-results.json`, `researcher-results.json`, `link-verify-all.json`) pro relatório do gate.

### 1w-quint-b. Repeat-de-tema (fail-soft)

```bash
npx tsx scripts/check-highlight-themes.ts --categorized {EDITION_DIR}/_internal/01-categorized.json --past-editions data/past-editions.md --window 12 --editions-dir data/editions --secondary-window 10 --full-body-window 10 --current-edition {AAMMDD} --out-json {EDITION_DIR}/_internal/01-highlight-theme-check.json
```
Este é o comando REAL que `stage-1-run.ts` roda no runner determinístico (#8951 —
antes esta seção citava `check-repeat-theme.ts`, um script que nunca foi
chamado pelo runner de produção; a lógica calibrada dele contra o caso real
#8896 — D1 Wired 260928 × D1 Guardian 260925, mesmo evento, Jaccard ~0.22,
zero entidade compartilhada — foi incorporada aqui como o 4º gatilho de
`checkHighlightThemes`, `findCrossSourceMatch`, restrito às últimas 3
edições e ao threshold baixo do #8896). Stdout/`--out-json`: warnings de
repeat-de-tema (destaques contra destaques reais recentes + headline de
`past-editions.md`, secundários contra secundários, corpo inteiro contra
corpo inteiro). Logar info se houver warnings. Fail-soft — nunca bloqueia.

### 1y-bis. Arquivar inbox da edição (#662)

```bash
npx tsx scripts/archive-inbox.ts --edition {AAMMDD} --inbox-md data/inbox.md
```
Move entradas processadas de `data/inbox.md` pra `data/inbox-archive/{AAMMDD}.md`. Idempotente — re-rodar em resume é no-op. Falha → warn, não bloqueia.

---

### 1y-ter. Fechar stage-status + captura de custo

```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 1 --status done --end "{ISO_now}" --duration-ms {ms} [--cost-usd X] [--tokens-in N] [--tokens-out N] [--models "sonnet-5,haiku-4-5,opus-5"]
npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 1
```

