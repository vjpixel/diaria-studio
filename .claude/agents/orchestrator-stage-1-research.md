---
name: orchestrator-stage-1-research
description: Stage 1 do orchestrator Diar.ia — pesquisa (inbox drain, RSS, researchers, discovery, dedup, categorize, score, render, gate). Lido pelo orchestrator principal. @see orchestrator-stage-0-preflight.md (Stage 0).
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 1 — Research

### 1a. Inbox drain

Sempre roda, antes da pesquisa:
```bash
npx tsx scripts/inbox-drain.ts
```
Lê novos e-mails de `diariaeditor@gmail.com` via Gmail API e anexa entradas em `data/inbox.md`. Retorna JSON `{ new_entries, urls[], topics[], most_recent_iso, skipped }`.
- Se `skipped: true` com `reason: "gmail_mcp_error"`: logar `warn` e prosseguir sem inbox (não aborta a pipeline).
- Se `skipped: true` com `reason: "inbox_disabled"`: prosseguir silenciosamente.
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
2. **Se fonte tem RSS**: disparar `Bash("npx tsx scripts/fetch-rss.ts --url <rss> --source <nome> --days <window_days>")` em paralelo. Rápido (~1-2s por fonte). Marca `method: "rss"`.
   - **Se a fonte tem `Topic filter`** (#347): adicionar `--topic-filter "<termos>"` ao comando — só artigos cujo `title+summary` contém ao menos 1 dos termos passam. Crítico pro arXiv (~600 papers/dia → ~80-120 após filtro).
3. **Se RSS falha ou retorna 0 artigos**: fallback automático — dispara `source-researcher` (WebSearch) pra mesma fonte. Marca `method: "websearch_fallback"`. 1 falha já dispara fallback.
4. **Se fonte NÃO tem RSS**: disparar `source-researcher` diretamente (via WebSearch com `site:` query). Marca `method: "websearch"`.

Preserva saúde da fonte em todos os casos: propagar `method` como campo extra no `RunRecord`.

### 1f. Dispatch de researchers e discovery

- Disparar N chamadas `Agent` paralelas com subagent `source-researcher` **apenas pras fontes que não têm RSS ou que tiveram fallback**, passando: nome da fonte, site query, **`cutoff_iso`** (data mais antiga aceita — calculada em 0a a partir de `anchor_iso = today`), `window_days`, `timeout_seconds: 180`. **Não passar `edition_date` como anchor da janela** (#560) — apenas como identificador, se necessário.
- Em paralelo, disparar M chamadas `Agent` com subagent `discovery-searcher` para queries temáticas (~5 PT + ~5 EN + **todos os `inbox_topics`** como queries adicionais — prioridade alta, vêm do próprio editor). Passar `cutoff_iso`, `window_days`, `timeout_seconds: 180`.
- Agregar resultados (cada subagente retorna JSON com `status`, `duration_ms`, `articles[]`, e `reason` se status != ok).

### 1g. Registrar saúde + log (batch, #40)

Em vez de N chamadas individuais, agregar todos os resultados (researchers + discovery) num único array. Convenção de `source`:
- **Researchers cadastrados**: nome exato da fonte em `context/sources.md` (ex: `"MIT Technology Review"`).
- **Discovery searchers**: formato `discovery:{topic_slug}` (ex: `"discovery:ai-regulation-brazil"`).
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

### 1h. Injetar inbox_urls (#593, #594)

**Automatizado via script** — substitui o passo manual que era fonte de bug (#594 — passo skipado em 260505, 0 dos 26 envios entraram). Política #593: TODOS os URLs de submissões do editor (incluindo forwards de newsletter) entram no pool de pesquisa.

```bash
npx tsx scripts/inject-inbox-urls.ts \
  --inbox-md data/inbox.md \
  --pool data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --out data/editions/{AAMMDD}/_internal/tmp-articles-raw.json \
  --editor diariaeditor@gmail.com \
  --validate-pool
```

Output stdout: `{ injected, already_in_pool, total_editor_urls, total_pool_size, editor_blocks, total_inbox_blocks }`. Logar como info no run-log.

**`--validate-pool`** força saída com erro se algum URL extraído do inbox **não** estiver no pool após injeção. Esse é o sentinel anti-#594 — passo 1h não pode mais ser skipado silenciosamente.

Cada URL vira um artigo sintético: `{ url, source: "inbox", title: "(inbox)", flag: "editor_submitted", submitted_at, submitted_subject, submitted_via }`. Categorizer prioriza `editor_submitted`. Tracking-only URLs (TLDR, Beehiiv mail links, CDN images) são filtradas — só conteúdo real.

### 1i. Link verification (script direto)

Gravar a lista de URLs da lista agregada em `data/editions/{AAMMDD}/_internal/tmp-urls-all.json` (array de strings) e rodar:
```bash
npx tsx scripts/verify-accessibility.ts \
  data/editions/{AAMMDD}/_internal/tmp-urls-all.json \
  data/editions/{AAMMDD}/_internal/link-verify-all.json
```
Ler `data/editions/{AAMMDD}/_internal/link-verify-all.json` (array de `{ url, verdict, finalUrl, note, resolvedFrom?, access_uncertain? }`). Então:
- **Remover** artigos com verdict `paywall`, `blocked` ou `aggregator` (sem `resolvedFrom`) que **não** sejam de inbox.
- **Manter com flag** artigos com verdict `anti_bot` (#320): adicionar `"access_uncertain": true`. Incluir no relatório do gate: `"⚠️ N artigo(s) marcados anti_bot — accessible no browser mas bloqueados por crawler. Revisar antes de aprovar."` com a lista de domínios.
- **Marcar** artigos com verdict `uncertain` adicionando `"date_unverified": true`. Esses artigos continuam no pipeline mas serão sinalizados com `⚠️` no gate para revisão manual.
- **Substituir URL** dos artigos com `resolvedFrom` presente: atualizar `url` para `finalUrl` e adicionar `resolved_from` ao artigo para rastreabilidade. Isso inclui URLs de shorteners que foram resolvidos pro destino real (#317).

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
Logar `removed.length`. Daqui em diante o input do research-reviewer é `_internal/tmp-filtered.json` (que já tem `{ kept: { lancamento, pesquisa, noticias, tutorial } }`) — extrair `kept` e usar como `categorized`.

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

### 1s. Enriquecer buckets + filtro de score mínimo

- **Enriquecer buckets com scores**: para cada artigo em `lancamento`, `pesquisa`, `noticias`, buscar o `score` correspondente em `all_scored` (join por `url`) e injetar como campo `score`. Ordenar cada bucket por `score` desc.
- **Filtro de score mínimo (#351)**: após enriquecer com scores, remover de cada bucket artigos com `score < 40`, exceto `flag === 'editor_submitted'` (inbox) e artigos já em `highlights` ou `runners_up`. Logar `"scorer threshold filter: removidos N artigos com score < 40"`.

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
  "highlights": ["...top 3 com rank/score/reason/article..."],
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
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD} --stage 1 --files 01-categorized.md,01-eia.md,01-eia-A.jpg,01-eia-B.jpg
```
Se `01-eia.md` ainda não existir (É IA? ainda processando):
```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD} --stage 1 --files 01-categorized.md
```
Anotar resultado em `sync_results[1]`; falhas reais (não warning) abortam. Falhas warning podem prosseguir mas precisam ser mencionadas no gate.

**Verificação anti-skip (#577)**: antes de apresentar o gate (passo 1x), se `DRIVE_SYNC = true`, confirmar que o cache registra push recente do `01-categorized.md`:

```bash
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('platform.config.json', 'utf8'));
if (cfg.drive_sync === false) { console.log('drive_sync=false, skip anti-skip check'); process.exit(0); }
if (!fs.existsSync('data/drive-cache.json')) {
  console.error('FATAL: drive_sync ativo mas data/drive-cache.json não existe. Step 1w foi skipado.');
  process.exit(1);
}
const cache = JSON.parse(fs.readFileSync('data/drive-cache.json', 'utf8'));
const f = cache.editions['{AAMMDD}']?.files?.['01-categorized.md'];
if (!f?.push_count) {
  console.error('FATAL: 01-categorized.md não foi pushed pra Drive. Step 1w foi skipado. Re-rodar push antes do gate.');
  process.exit(1);
}
console.log('✓ 01-categorized.md pushed to Drive (push #' + f.push_count + ')');
"
```

Se falhar, **re-rodar o push** antes de prosseguir pra 1x. Não apresentar gate sem confirmar push. Se `drive_sync = false` em `platform.config.json` (ex: rodando localmente sem Drive), check é skipado silenciosamente.

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
  Push do MD atualizado de volta para o Drive:
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 1 --files 01-categorized.md
  ```
- **Arquivar o inbox**: mover `data/inbox.md` → `data/inbox-archive/{YYYY-MM-DD}.md` e recriar `data/inbox.md` vazio com cabeçalho padrão. Garante que submissões do dia não voltem na próxima edição.
- **Atualizar `_internal/cost.md`.** Append linha na tabela de Stage 1, recalcular `Total de chamadas`, gravar com `Write`:
  ```
  | 1 | {stage_start} | {now} | inbox_drainer:1, refresh_dedup:1, source_researcher:{N}, discovery:{M}, link_verifier:{chunks}, categorizer:1, research_reviewer:1, scorer:1 | {soma_haiku} | 1 |
  ```
