---
name: orchestrator-stage-1-research
description: Stage 1 do orchestrator Diar.ia — pesquisa (inbox drain, RSS, researchers, discovery, dedup, categorize, score, render, gate). Lido pelo orchestrator principal. @see orchestrator-stage-0-preflight.md (Stage 0).
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 1 — Research

**MCP disconnect logging (#759):** Quando detectar `<system-reminder>` de MCP disconnect (Clarice, Beehiiv, Gmail, Chrome, etc.), logar: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator --level warn --message "mcp_disconnect: {server}" --details '{"server":"{server}","kind":"mcp_disconnect"}'`. Ao reconectar: mesmo comando com `--level info --message "mcp_reconnect: {server}"`. Persiste em `data/run-log.jsonl` para `collect-edition-signals.ts` (#759).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

### 1a. Inbox drain

Sempre roda, antes da pesquisa:
```bash
npx tsx scripts/inbox-drain.ts
```
Lê novos e-mails de `diariaeditor@gmail.com` via Gmail API e anexa entradas em `data/inbox.md`. Retorna JSON `{ new_entries, urls[], topics[], most_recent_iso, skipped, errors?, error_samples? }`.
- Se `skipped: true` com `reason: "gmail_mcp_error"`: logar `warn` e prosseguir sem inbox (não aborta a pipeline).
- Se `skipped: true` com `reason: "inbox_disabled"`: prosseguir silenciosamente.
- Se `skipped: true` com `reason: "search_failed"` (#665): Gmail falhou ao listar threads (timeout, schema change, 5xx). Tratar igual a `gmail_mcp_error` — logar `warn` e prosseguir sem inbox. Cursor não é avançado (drain não ocorreu).
- Se `errors > 0` (#667): drain parcial — algumas threads falharam ao carregar mas o drain prosseguiu. Logar `warn` com contagem + amostras de `error_samples`.
- Extrair `inbox_urls` = lista de URLs vindas do drainer + URLs de entradas já existentes em `data/inbox.md` que ainda não foram arquivadas. Extrair `inbox_topics` idem.

### 1b. Preparação de fontes

- Ler `context/sources.md` e extrair os nomes+site queries de todas as fontes ativas.
- Ler `data/source-health.json` (se existir). Anotar fontes com 3+ `recent_outcomes` consecutivos não-ok — **ainda dispara**, mas sinaliza no relatório do Stage 1.

### 1c. Fetch poll stats da edição anterior (#201)

O `eia-compose.ts` auto-preenche a linha "Resultado da última edição" se `_internal/04-eia-poll-stats.json` existir. Buscar antes de disparar o composer:
```bash
PREV_POST_ID=$(node -e "
  const r=require('fs').existsSync('data/past-editions-raw.json')
    ? JSON.parse(require('fs').readFileSync('data/past-editions-raw.json','utf8'))
    : [];
  process.stdout.write(r[0]?.id ?? '');
")
if [ -n "$PREV_POST_ID" ] && [ -n "$BEEHIIV_API_KEY" ]; then
  npx tsx scripts/fetch-beehiiv-poll-stats.ts \
    --post-id "$PREV_POST_ID" \
    --out data/editions/{AAMMDD}/_internal/poll-responses.json
  npx tsx scripts/compute-eia-poll-stats.ts \
    --edition {AAMMDD} \
    --responses data/editions/{AAMMDD}/_internal/poll-responses.json \
    --out data/editions/{AAMMDD}/_internal/04-eia-poll-stats.json
fi
```
Se `PREV_POST_ID` vazio, `BEEHIIV_API_KEY` não setada, ou qualquer script falhar com exit != 0 — prosseguir silenciosamente sem stats. **Não bloquear** o pipeline por ausência de stats.

### 1d. Dispatch É IA? em paralelo (background)

O `eia-composer` não depende de nenhum output do pipeline principal — disparar como `Agent` em **background** (na mesma mensagem dos researchers abaixo) passando:
- `edition_date`
- `out_dir = data/editions/{AAMMDD}/`

Armazenar `eia_dispatch_ts` (timestamp do momento do dispatch).

**Logging por caminho** (#110 fix 4):
- **Dispatch normal**: logar `info 'eia dispatched (background)'`.
- **Skip por resume** (`01-eia.md` já existir): logar `info 'eia dispatch skipped: already_exists (resume)'`.
- **Skip por dispatch failure** (Agent tool indisponível ou retornou erro imediato): logar `warn 'eia dispatch skipped: agent_unavailable'`. Ainda assim prosseguir com a Etapa 1 — a Etapa 3 vai sinalizar a ausência e oferecer retry manual.

**Validação no gate da Etapa 1** (#110 fix 1): antes de apresentar o gate principal, checar se `data/editions/{AAMMDD}/01-eia.md` existe OU se há Agent em background ativo. Se nenhum dos dois (skip silencioso detectado), incluir bullet no relatório do gate: `🟡 É IA?: não dispatchado — rode /diaria-3-imagens {AAMMDD} eai antes do gate da Etapa 4.`

### 1e. Método de fetch por fonte (#54)

Pra cada fonte em `context/sources.md`, escolher entre RSS (rápido, determinístico) e WebSearch (fallback):

1. Fontes com RSS têm linha `- RSS: {url}` em `context/sources.md`. Fontes com filtro de tópico (#347) têm linha `- Topic filter: {term1,term2,...}` logo abaixo.
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

- **Pre-flight: skip aggregator-domain sources** (#717 hipótese 5). Antes de dispatchar agents, filtrar fontes que batem na blocklist de `source-researcher` (que voltariam com `articles: []` de qualquer jeito). Rodar:
  ```bash
  echo '[{"name":"...","url":"..."},...]' | npx tsx scripts/check-source-blocklist.ts
  ```
  Output JSON `{ kept[], skipped[] }`. Dispatchar source-researcher apenas pra `kept[]`. Logar `skipped[]` como info: cada entry tem `category` + `pattern` que casou. Economiza ~30s-1min de wall clock + ~50k Haiku tokens em edições com 11+ fontes em fallback (medido em #717 / 260506).

- Disparar N chamadas `Agent` paralelas com subagent `source-researcher` **apenas pras fontes que não têm RSS ou que tiveram fallback E que passaram no pre-flight acima**, passando: nome da fonte, site query, **`cutoff_iso`** (data mais antiga aceita — calculada em 0a a partir de `anchor_iso = today`), `window_days`, `timeout_seconds: 180`. **Não passar `edition_date` como anchor da janela** (#560) — apenas como identificador, se necessário.
- Em paralelo, disparar M chamadas `Agent` com subagent `discovery-searcher` para queries temáticas (~5 PT + ~5 EN + **todos os `inbox_topics`** como queries adicionais — prioridade alta, vêm do próprio editor). `inbox_topics` vem do output do step 1e.5 (`scripts/extract-inbox-topics.ts`). Passar `cutoff_iso`, `window_days`, `timeout_seconds: 180`.
- Agregar resultados (cada subagente retorna JSON com `status`, `duration_ms`, `articles[]`, e `reason` se status != ok).

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
  --pool data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --out data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --validate-pool
```

Output stdout: `{ injected, already_in_pool, total_editor_urls, total_pool_size, editor_blocks, total_inbox_blocks }`. Logar como info no run-log.

**`--validate-pool`** força saída com erro se algum URL extraído do inbox **não** estiver no pool após injeção. Esse é o sentinel anti-#594 — passo 1h não pode mais ser skipado silenciosamente.

Cada URL vira um artigo sintético: `{ url, source: "inbox", title: "(inbox)", flag: "editor_submitted", submitted_at, submitted_subject, submitted_via }`. Categorizer prioriza `editor_submitted`. Tracking-only URLs (TLDR, Beehiiv mail links, CDN images) são filtradas — só conteúdo real.

### 1h.6. Validar injeção (#625)

Validador **externo** anti-skip — diferente de `--validate-pool` (interno/tautológico), este script roda após o step 1h e detecta o cenário onde o orchestrator skipou a chamada inteira:

```bash
npx tsx scripts/validate-stage-1-injection.ts \
  --edition-dir data/editions/{AAMMDD} \
  --inbox-md data/inbox.md
```

Se exit 1: step 1h foi skipado ou falhou silenciosamente. Re-executar step 1h e repetir. Se exit 2: erro de leitura de arquivo. Verificar paths.

Logar resultado como info no run-log. **Não prosseguir para 1i se exit 1.**

### 1i. Link verification (script direto)

Gravar a lista de URLs da lista agregada em `data/editions/{AAMMDD}/_internal/tmp-urls-all.json` (array de strings) e rodar:
```bash
npx tsx scripts/verify-accessibility.ts \
  data/editions/{AAMMDD}/_internal/tmp-urls-all.json \
  data/editions/{AAMMDD}/_internal/link-verify-all.json \
  --bodies-dir data/editions/{AAMMDD}/_internal/link-verify-bodies
```
A flag `--bodies-dir` (#717 hipótese 1) persiste o body raw de cada GET bem-sucedido no path indicado. `verify-dates.ts` (rodado pelo research-reviewer no passo 1p) lê desse cache antes de fetchar — elimina ~3-4min de fetch duplicado em edições com 300+ URLs.
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
  --in data/editions/{AAMMDD}/_internal/tmp-articles-enrich.json
```
O script só toca artigos com `flag: "editor_submitted"` ou `source: "inbox"` cujo título seja placeholder (`(inbox)`, `[INBOX] ...`) ou cujo `summary` esteja vazio. Para cada um, fetch da URL final + extração de `og:title` / `og:description` (com fallback pra `<title>` e `meta name=description`). Títulos curados pelo editor são preservados. Falhas de fetch viram outcome `fetch_failed` no stdout — não bloqueiam pipeline. Ler o JSON de volta após o script (mutated in place).

### 1l. Dedup

```bash
npx tsx scripts/dedup.ts \
  --articles data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --past-editions context/past-editions.md \
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
In-place. Loga no stderr `N/M notícia(s) sinalizadas` e nunca falha. Ler `data/editions/{AAMMDD}/_internal/tmp-categorized.json` como `{ lancamento, pesquisa, noticias }` para usar daqui em diante.

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

Antes do `research-reviewer`, rodar `scripts/filter-date-window.ts` pra garantir que **nenhum** artigo fora da janela chegue ao agente Haiku. **Anchor = `anchor_iso`** (today UTC), não `edition_iso` — assim a janela cobre o que foi publicado de fato nos últimos `window_days` dias, e não uma janela hipotética entre hoje e a publication date:
```bash
npx tsx scripts/filter-date-window.ts \
  --articles data/editions/{AAMMDD}/_internal/tmp-clustered.json \
  --anchor-date {anchor_iso} \
  --edition-date {edition_iso} \
  --window-days {window_days} \
  --out data/editions/{AAMMDD}/_internal/tmp-filtered.json
```
Logar `removed.length`. Daqui em diante o input do research-reviewer é `_internal/tmp-filtered.json` (que já tem `{ kept: { lancamento, pesquisa, noticias, tutorial, video } }`) — extrair `kept` e usar como `categorized`.

### 1p. Research-reviewer

Disparar `research-reviewer` passando `{ categorized: kept, edition_date, edition_iso, anchor_iso, edition_dir, window_days }`. O agent aplica:
1. **Datas (verificação + flag)**: roda `verify-dates.ts` pra confirmar `published_at` via fetch, corrige `article.date`, copia `date_unverified` direto do output do script (#226 — não recalcula).
2. **Janela**: roda `filter-date-window.ts` de novo internamente como sanity check (defesa em profundidade — depois do passo determinístico do orchestrator, o agente raramente remove algo aqui).
3. **Temas recentes**: remove artigos cujo tema já foi coberto pela Diar.ia nos últimos 7 dias (lê `context/past-editions.md`).

Retorna `categorized` limpo + `stats`. Logar `stats.removals[]`.

### 1q. Scorer

Disparar `scorer` (Opus) passando `categorized` (saída do research-reviewer) e `out_path: data/editions/{AAMMDD}/_internal/tmp-scored.json`. Retorna `highlights[]` (top 6 rankeados, ao menos 1 por bucket), `runners_up[]` (1-2) e `all_scored[]` (todos os artigos com score, ordenados por score desc).

### 1r. Validação pós-scorer (#104)

Se `highlights.length < 6` E `pool_size = sum(buckets.length) >= 6`, **promover** os top de `runners_up[]` (ordenados por score desc) para `highlights[]` até completar 6. Re-numerar os ranks. Logar warning explícito (`level: warn`, `agent: orchestrator`, `message: "scorer produziu apenas N highlights; promovi M runners_up para chegar a 6"`). Se mesmo após a promoção `highlights.length < 6` (pool insuficiente), seguir com o que houver — é caso legítimo.

### 1s. Enriquecer buckets + filtro de score mínimo (#351, #720, #721)

Rodar via script determinístico:
```bash
npx tsx scripts/finalize-stage1.ts \
  --scored data/editions/{AAMMDD}/_internal/tmp-scored.json \
  --categorized data/editions/{AAMMDD}/_internal/tmp-clustered.json \
  --out data/editions/{AAMMDD}/_internal/tmp-finalized.json \
  --edition {AAMMDD}
```

O script: join por URL exata (#720 — sem canonicalizar); recovery por título se mismatch (`score_recovered: true`); loga warn + run-log por cada mismatch; remove `score < 40` exceto highlights/runners_up e `flag === 'editor_submitted'` válidos; bypass endurece (#721): título não-placeholder, `length >= 15`, sem `/buttondown|subscribe|newsletter|sign.?up/i` — falha → `editor_submitted_placeholder: true`; ordena por score desc.

Daqui em diante usar `_internal/tmp-finalized.json` como os buckets enriquecidos.

### 1t. Verificação de mínimos por seção (#488)

Após o filtro de score, contar itens remanescentes em cada bucket e preparar lista de avisos para o gate:
- Se `lancamento.length < 3`: registrar `⚠️ Apenas {N} lançamento(s) — mínimo esperado: 3`
- Se `pesquisa.length < 3`: registrar `⚠️ Apenas {N} pesquisa(s) — mínimo esperado: 3`
- Se `pesquisa.length > 5`: truncar para top-5 por score antes de salvar o `01-categorized.json` e renderizar o MD.
- Se `noticias.length < 5`: registrar `⚠️ Apenas {N} notícia(s) — mínimo esperado: 5`

Avisos são exibidos no GATE HUMANO. Mínimos são avisos — não bloqueiam o gate.

### 1u. Estrutura e salvamento

Strip do campo `verifier` de cada artigo antes de salvar (só os acessíveis chegaram até aqui; o campo é redundante e polui o JSON). Estrutura final de `_internal/01-categorized.json`:
```json
{
  "highlights": ["...top 6 com rank/score/reason/article (scorer retorna 6; editor seleciona 3 no gate)..."],
  "runners_up": ["...2-3 candidatos com score..."],
  "lancamento": ["...artigos com campo score, ordenados por score desc..."],
  "pesquisa": ["..."],
  "noticias": ["..."],
  "clusters": ["...metadata de topic-cluster, runners-up consolidados (#237) — pode ser []..."]
}
```
`clusters` é preservado automaticamente por `filter-date-window.ts` (passthrough de campos extras desde #247). Mesmo se algum cluster member virou `removed` no filtro de janela, a metadata do cluster fica intacta — é informativo pro editor.

Salvar `data/editions/{AAMMDD}/_internal/01-categorized.json`.

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

Editor decide no gate. Auto-aprovação (test_mode/--no-gates) bypassa o lint mas loga warn no run-log.

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

### 1w-bis. Pre-gate validator (#581, #828)

Antes de apresentar o gate humano, rodar:

```bash
npx tsx scripts/validate-stage-1-output.ts \
  --edition {AAMMDD} \
  --edition-dir data/editions/{AAMMDD}/
```

Semântica completa (exit codes, output JSON, falha do próprio validator) em **[`docs/validate-stage-1-output-semantics.md`](../../docs/validate-stage-1-output-semantics.md)** — single source of truth (#832). Pipeline completo (`/diaria-edicao`) ganha o mesmo catch-net que o skill `/diaria-1-pesquisa` isolado tem (#828).

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
   (Derivar: `total_brutos` = soma de `articles[]` de todos researchers; `kept_dedup` = `kept[].length` do dedup.ts; `total_categorized` = `lancamento.length` + `pesquisa.length` + `noticias.length` do categorized.json)

2. **Métricas de cobertura (#346):** derivar perdas (janela, dedup, link-verify) a partir dos arquivos de pipeline e exibir:
   ```
   Artigos garimpados: {N_brutos} brutos → {N_final} após filtros
     -janela: {N_janela} (fora da janela de {window_days}d)
     -dedup: {N_dedup} (URLs repetidas das últimas edições)
     -link-verify: {N_verify} (paywall/blocked/aggregator)
   ```
   Se arquivo não existir ou falhar o parse, exibir "N/A" — nunca bloquear.

3. **Avisos de mínimos por seção (#488):** exibir avisos registrados na verificação de mínimos (ver 1t). Se não houver avisos, omitir este bloco.

4. **Relatório de saúde das fontes:**
   - `⚠️` por fonte com outcome não-ok *nesta execução*.
   - `🔴` por fonte com streak 3+, com timestamps de cada falha. Ex: `🔴 AI Breakfast — 3 timeouts seguidos: 2026-04-15T14:18Z, 2026-04-16T14:20Z, 2026-04-17T14:22Z — considere desativar em seed/sources.csv`.
   - Se tudo OK: "Todas as fontes responderam normalmente."

### 1y. Pós-gate (quando aprovado)

- **Pull do MD** (o editor pode ter editado no Drive):
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
  Se exit code != 0: avisar o editor — `"⚠️ validate-lancamentos detectou URLs não-oficiais em LANÇAMENTOS após edição no gate. Corrigir antes de continuar."` — mas **não bloquear automaticamente**.
  Push do MD atualizado de volta para o Drive:
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 1 --files 01-categorized.md
  ```
- **Escrever sentinel de conclusão do Stage 1:**
  ```bash
  npx tsx scripts/pipeline-sentinel.ts write \
    --edition {AAMMDD} --step 1 \
    --outputs "01-categorized.md,_internal/01-approved.json"
  ```
  Falha do sentinel → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator --level warn --message 'sentinel_write_failed'`). **Não bloquear** a aprovação do gate.
- **Arquivar o inbox** (#680): `mkdir -p data/inbox-archive` seguido de `mv data/inbox.md data/inbox-archive/{YYYY-MM-DD}.md`. Recriar `data/inbox.md` vazio. Sem o mkdir, falha em checkout limpo.
- **Atualizar `_internal/cost.md`.** Append linha na tabela de Stage 1, recalcular `Total de chamadas`, gravar com `Write`:
  ```
  | 1 | {stage_start} | {now} | inbox_drainer:1, refresh_dedup:1, source_researcher:{N}, discovery:{M}, link_verifier:{chunks}, categorizer:1, research_reviewer:1, scorer:1 | {soma_haiku} | 1 |
  ```
