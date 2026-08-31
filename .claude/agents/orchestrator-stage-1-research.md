---
name: orchestrator-stage-1-research
description: Stage 1 do orchestrator diar.ia.br — pesquisa (inbox drain, RSS, researchers, discovery, dedup, categorize, score, render, gate). Lido pelo orchestrator principal. @see orchestrator-stage-0-preflight.md (Stage 0).
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 1 — Research

**MCP disconnect logging:** ver `orchestrator.md` § "MCP disconnect — logging + halt banner" (#759/#737). Nesta etapa: `--stage 1`, banner `--stage "1 — Pesquisa"`.

**`{EDITION_DIR}` (#2463/#3025/#3530):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Já foi resolvido no Stage 0 (§0a) — se este stage estiver rodando na mesma sessão que o Stage 0, reusar o valor. Se estiver rodando isolado (resume, skill separada), resolver de novo (idempotente — encontra o que já está no disco):
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

### Runner determinístico (`scripts/stage-1-run.ts`, #5415 incremento 3/3) — CAMINHO PRINCIPAL DO MIOLO

O miolo determinístico do Stage 1 (tudo entre os 7 pontos de dispatch `Agent()` do playbook original) agora roda via `scripts/stage-1-run.ts` em 5 fases. A prosa detalhada das subseções abaixo **permanece intacta** — é o que o script faz e por quê, além de ser o **fallback** se o script não existir ou falhar de forma inesperada.

Design de 5 fases (o script é um processo Node puro — não alcança MCP, Skill ou Agent):

1. **Fase `pre-research`** — §1a (inbox-drain) → §1c (poll stats, fail-soft) → §1d (eia-compose dispatchado em background via spawn detached) → §1e (RSS batch) → §1e-bis (prewarm cache, background) → §1e.5 (inbox topics) → §1f Path A (tentativa determinística). Se Path A falhar (key ausente) ou for desligado, pre-flight de Path B (blocklist + queries determinísticas) devolvido como `pendingAgentDispatch`.
   ```bash
   npx tsx scripts/stage-1-run.ts --phase pre-research --edition {AAMMDD}
   ```

2. **Fase `post-research-pre-score`** — Se Path B foi sinalizado na fase anterior, `--agent-research-results` é OBRIGATÓRIO (RunRecord[] agregado pelos dispatches Agent do orchestrator) — mergeado em researcher-results.json antes de seguir. §1g (record-source-runs) → §1g-ter (assemble pool) → §1g-bis (carry-over) → §1h (inject inbox urls + validate + marker) → §1i (verify-accessibility + anotação/remoção in-JS) → §1j (expand aggregators) → §1k (enrich inbox) → §1l (dedup) → §1m (categorize + enrich-primary-source + integrity checkpoint) → §1m-quater (check-promoted-dedup, idempotente mesmo sem 1m-ter) → §1n (topic-cluster) → §1o (filter-date-window) → §1p1 (research-review-dates) → §1q.1 (split-articles-for-scoring) → devolve `pendingAgentDispatch` pro scorer-chunk (chunked) OU sinaliza `needsScorerFallback` (pool pequeno, cai pro scorer single-call).
   ```bash
   # Se Path B rodou:
   npx tsx scripts/stage-1-run.ts --phase post-research-pre-score --edition {AAMMDD} \
     --agent-research-results {EDITION_DIR}/_internal/agent-research-results.json
   # Senão (Path A rodou):
   npx tsx scripts/stage-1-run.ts --phase post-research-pre-score --edition {AAMMDD}
   ```

3. **Fase `post-score`** (SÓ no caminho chunked) — §1q.3 (merge-scored-chunks, lendo os `scored-chunk-{i}.json` que o orchestrator escreveu nos paths canônicos após os dispatches scorer-chunk) → branch pelo exit code (#1669) → §1q.3-bis (integrity checkpoint) → devolve `pendingAgentDispatch` pro scorer-select.
   ```bash
   npx tsx scripts/stage-1-run.ts --phase post-score --edition {AAMMDD} --chunk-count N
   ```

4. **Fase `post-select-render`** — Exatamente um dos dois: §1q.5 (assemble-scored, caminho chunked) OU aceita o `tmp-scored.json` do scorer single-call diretamente (fallback) → §1r (promoção de runners_up até 6, in-JS) → §1s (finalize-stage1) → §1t (avisos de mínimo por seção, in-JS) → §1u (shape final + strip verifier, in-JS) → §1u-bis/§1u-ter (dedup intra-edição + evergreen) → §1v (render MD) → §1v-bis..1v-quinquies (lints warn-only) → §1w-quint (anti-skip 1f, BLOQUEIA) → §1w-bis (validate-stage-1-output, blocker vira HALT) → §1w-quat (check-invariants categorized-has-eia-section, BLOQUEIA) → §1w-ter (payload sizes) → §1w-quint-b (repeat-de-tema, fail-soft). Devolve tudo que o gate humano (§1x) precisa mostrar — a apresentação em si (texto formatado pro editor) continua do orchestrator.
   ```bash
   # Caminho chunked:
   npx tsx scripts/stage-1-run.ts --phase post-select-render --edition {AAMMDD} \
     --selection-json {EDITION_DIR}/_internal/tmp-selection.json
   # Caminho fallback:
   npx tsx scripts/stage-1-run.ts --phase post-select-render --edition {AAMMDD} \
     --fallback-scored-json {EDITION_DIR}/_internal/tmp-scored.json
   ```

5. **Fase `post-gate`** — §1y — aplica as edições do gate (ou `--auto`), re-renderiza MD, re-valida lançamentos, invariantes pós-apply (warn, não bloqueia), experimento D3-radar (opt-in via config), escreve sentinel, arquiva inbox, fecha stage-status + captura de custo.
   ```bash
   # Se editor editou o MD:
   npx tsx scripts/stage-1-run.ts --phase post-gate --edition {AAMMDD} --md {EDITION_DIR}/01-categorized.md
   # Se auto_approve:
   npx tsx scripts/stage-1-run.ts --phase post-gate --edition {AAMMDD} --auto
   ```

**Interpretar o JSON de saída (campo `code` + resto):**
- `code: 0` → fase concluída. Usar outputs do JSON.
- `code: 1` → erro duro (sub-script obrigatório falhou, args inválidos, merge catastrófico sem retry possível aqui) — parar e reportar `notes[]` ao editor.
- `code: 2` → HALT obrigatório (`haltRequired`, banner já renderizado pelo script) — parar mesmo com `auto_approve`.
- `pendingAgentDispatch[]` → para cada entry, disparar `Agent(subagent_type: entry.agent, prompt: <manifest em entry.manifestPath, 1 item por linha>)`. Após todos completarem, re-invocar a fase seguinte passando os resultados (quando requerido).
- `pendingHumanDecision[]` → apresentar `detail`/`prompt`/`options` ao editor e agir conforme a resposta.
- `delegatedSteps[]` — lista informativa dos passos que o script nunca tenta (§1m-ter, §1m-quinquies, §1f Path B queries temáticas PT/EN genéricas, §1y resolve-primary-source.ts, §1x gate presentation) — rodar essas seções normalmente, como sempre.

**Fallback**: se `scripts/stage-1-run.ts` não existir, ou falhar de um jeito não coberto pelos `code`s acima (erro de spawn, exceção fora do `try/catch` do script), seguir a prosa detalhada de 1a-1y abaixo turno a turno, exatamente como antes do #5415.

@see scripts/stage-1-run.ts (docstring no topo do arquivo tem o mapeamento completo dos 7 pontos de Agent() e como cada um foi tratado)

---

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

2. **Se a URL na linha RSS termina em `sitemap.xml`** (#761): disparar `Bash("npx tsx scripts/fetch-sitemap.ts --url <sitemap_url> --source <nome> --days <window_days>")` em paralelo. Marca `method: "sitemap"`. Output shape compatível com `fetch-rss` (mesmas chaves `articles[]`, `error?`). Usado quando a fonte não tem RSS mas expõe sitemap.xml (ex: Perplexity Research).
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

### 1f. Dispatch de researchers e discovery

**⛔ NUNCA PULE ESTE PASSO EM `/diaria-edicao` (#1091).** RSS batch (1e) **NÃO substitui** WebSearch dos publishers oficiais. Pular silenciosamente porque "RSS já trouxe artigos suficientes" é bug recorrente ([histórico](../../docs/orchestrator-stage-1-research-historia.md#1f-nunca-pule)). O passo 1w-quint (`validate-stage-1-completeness.ts`) detecta este skip e bloqueia o gate.

**⛔ NUNCA pré-checar `BRAVE_API_KEY` (ou qualquer var só em `.env`) via Bash antes de decidir o path (#3969).** `.env` só é carregado pelo processo Node (`import "dotenv/config"` em `scripts/fetch-websearch-batch.ts`) — nunca exportado pro shell Bash. Rodar `if [ -n "$BRAVE_API_KEY" ]` (ou equivalente) no Bash pra "adiantar" a decisão Path A/B vê a key como ausente mesmo quando ela está presente e válida no `.env`, causando fallback desnecessário pro Path B (~10× mais lento/caro). A decisão correta é **sempre** rodar `fetch-websearch-batch.ts` direto e ramificar pelo exit code (0 = Path A rodou; 3 = key ausente → Path B) — nunca inferir a presença da key por fora do processo Node que a lê.

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

#### Path B: Agents Haiku (fallback)

- **Pre-flight: skip aggregator-domain sources** (#717 hipótese 5). Antes de dispatchar agents, filtrar fontes que batem na blocklist de `source-researcher` (que voltariam com `articles: []` de qualquer jeito). Rodar:
  ```bash
  echo '[{"name":"...","url":"..."},...]' | npx tsx scripts/check-source-blocklist.ts
  ```
  Output JSON `{ kept[], skipped[] }`. Dispatchar source-researcher apenas pra `kept[]`. Logar `skipped[]` como info: cada entry tem `category` + `pattern` que casou. Economiza ~30s-1min de wall clock + ~50k Haiku tokens em edições com 11+ fontes em fallback (medido em #717 / 260506).

- **#1074 — sempre dispatchar pra TODAS as fontes.** Disparar N chamadas `Agent` paralelas com subagent `source-researcher` **pra todas as fontes cadastradas em `context/sources.md` que passaram no pre-flight de blocklist acima**, **independente do RSS ter retornado artigos ou não**. Razão (#1074): RSS feeds são incompletos / atrasados; fontes oficiais publicam no site antes do RSS atualizar; pular mascara coverage gaps que o editor não vê. Passar: nome da fonte, site query, **`cutoff_iso`** (data mais antiga aceita — calculada em 0a a partir de `anchor_iso = today`), `window_days`, `timeout_seconds: 180`. **Não passar `edition_date` como anchor da janela** (#560) — apenas como identificador, se necessário.

- Em paralelo, disparar M chamadas `Agent` com subagent `discovery-searcher` para queries temáticas (~5 PT + ~5 EN + **todos os `inbox_topics`** como queries adicionais — prioridade alta, vêm do próprio editor). `inbox_topics` vem do output do step 1e.5 (`scripts/extract-inbox-topics.ts`). Passar `cutoff_iso`, `window_days`, `timeout_seconds: 180`.

- **#2313 — SEMPRE incluir ≥2 queries how-to PT-BR como slots fixos**, independente de BRAVE_API_KEY. Path B (agents fallback) é a causa raiz ([histórico](../../docs/orchestrator-stage-1-research-historia.md#2313-how-to-slots)). Obter as queries via: `npx tsx -e "import {getHowToDiscoveryQueries} from './scripts/lib/use-melhor-curation.ts'; console.log(JSON.stringify(getHowToDiscoveryQueries(parseInt(process.env.EDITION_NUM??'0'), 2)))" EDITION_NUM={AAMMDD}` — resultado é array de 2 strings PT-BR. Dispatchar 1 `discovery-searcher` por query. Se a saída do Path A (script TS) já rodou, NÃO re-dispatchar (evitar duplicata): verificar se `researcher-results.json` já contém entries com `source` prefixo `"discovery: como "` ou `"discovery: guia "` (com espaço após o dois-pontos — formato gerado por `fetch-websearch-batch.ts`: `discovery: {query}`) ou similar how-to BR.

- **#3916/#3918 — SEMPRE incluir 1 query dedicada ao ângulo crítico/impacto-negativo como slot fixo**, independente de BRAVE_API_KEY (mesmo racional do #2313 acima — a regra editorial "sempre ≥1 destaque de impacto negativo" não se cumpre se o pool do dia não tiver candidato, e Path B é onde isso mais silenciosamente falta). Obter a query via: `npx tsx -e "import {getNegativeImpactDiscoveryQueries} from './scripts/lib/negative-impact-curation.ts'; console.log(JSON.stringify(getNegativeImpactDiscoveryQueries(parseInt(process.env.EDITION_NUM??'0'), 1)))" EDITION_NUM={AAMMDD}` — resultado é array de 1 string. Dispatchar 1 `discovery-searcher` com essa query. Se o Path A já rodou (`fetch-websearch-batch.ts` sempre injeta essa query quando `BRAVE_API_KEY` está presente), NÃO re-dispatchar — checar se `researcher-results.json` já tem uma entry `discovery:{slug}` cujo `query_used` bate com uma das strings de `NEGATIVE_IMPACT_DISCOVERY_TOPICS`.

- Agregar resultados (cada subagente retorna JSON com `status`, `duration_ms`, `articles[]`, e `reason` se status != ok).

- **#2668 — Reconciliar Path B após dispatch (determinístico).** Após despachar todos os agents E ter rodado ≥1 batch Path A (`fetch-websearch-batch`, que captura o header), emitir: `npx tsx scripts/reconcile-brave-path-b.ts --edition {AAMMDD}`. Deriva o uso do Path B do **gap real do header X-RateLimit-Remaining** (`delta_untracked`), não de um multiplicador hardcoded — então a contagem local passa a bater com o uso real do Brave. Idempotente. O **alerta** já usa o header direto desde #2668; isto é só pro breakdown local do relatório ([histórico](../../docs/orchestrator-stage-1-research-historia.md#2668-reconciliar-path-b)).

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

**Capturar custo de tokens dos dispatches (#3748):** junto com o batch acima, monte um array `[{agent_type, usage_raw}]` a partir do bloco `<usage>` que cada dispatch `Agent` (source-researcher/discovery-searcher) retornou e rode:
```bash
npx tsx scripts/record-agent-costs.ts --edition-dir {EDITION_DIR}/ --edition {AAMMDD} \
  --stage 1 --costs {EDITION_DIR}/_internal/tmp-agent-costs-stage1.json
```
Persiste breakdown por agent_type em `_internal/cost.json` — complementa o total do stage já capturado em `stage-status.json` (#3441), que não quebra por agente. Falha não-bloqueante (logar warn e seguir).

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

**Nota de robustez — 1m-ter pode terminar depois de 1n/1o/1p1 (#5471, 260817, [histórico](../../docs/orchestrator-stage-1-research-historia.md#5471-1m-ter-fora-de-ordem)).** O `discovery-searcher` do passo 1 acima é uma chamada `Agent` normal (síncrona, não background) — se ela demorar, é possível que 1n (topic-cluster)/1o (filter-date-window)/1p1 (research-review-dates) já tenham rodado sobre `tmp-categorized.json` antes de 1m-ter terminar. **Não é erro** — aplicar a promoção (passo 3) sobre o arquivo mais recente que já existir naquele momento (`tmp-dates-reviewed.json` em vez de `tmp-categorized.json`, se já existir), nunca sobre uma cópia stale. Ajustar o `--categorized` do 1m-quater (logo abaixo) pro MESMO arquivo onde a promoção foi de fato escrita — não assumir que é sempre `tmp-categorized.json`. Confirmado ao vivo (260817): resultado equivalente, sem gap de dedup (1m-quater sempre roda depois, sobre o arquivo certo). Se esta ordem-alternativa passar a se repetir com frequência (não mais one-off), reconsiderar mover 1m-ter pra antes do 1l (dedup) — ver histórico.

**1m-quater. Dedup pós-promoção (#2315).** `dedup.ts` (passo 1l) viu URLs de pesquisa originais — URLs oficiais introduzidas pelo passo 1m-ter NUNCA passaram pelo dedup. Re-checar agora. **Sempre rodar** (idempotente: sem `primary_source_substituted` → `checked: 0`):
```bash
npx tsx scripts/check-promoted-dedup.ts \
  --categorized {EDITION_DIR}/_internal/tmp-categorized.json \
  --past-editions data/past-editions.md --window 3
```
(`--categorized` acima assume o caminho normal — ver "Nota de robustez" logo acima para o caso em que 1m-ter rodou tarde e escreveu em `tmp-dates-reviewed.json`.)
Resultado `{ demoted[], checked }`. Logar info. Se `demoted.length > 0`: surfar no gate `⚠️ N lançamento(s) revertidos para RADAR (URL oficial repetia edição anterior, colidia com artigo nativo da própria edição, ou duplicava outra promoção — #2315/#4200)` (o `reason` de cada entrada em `demoted[]` diz qual dos três casos foi). Falha → warn + prosseguir.

**1m-quinquies. Resolver URLs de VÍDEO para YouTube (#3202).** Regra editorial: itens da seção VÍDEOS usam SEMPRE link do YouTube (`context/editorial-rules.md` — Seção "Vídeos"). Para cada artigo em `video` cuja URL NÃO seja `youtube.com/watch` ou `youtu.be` (checar com `isYoutubeUrl` de `scripts/lib/video-youtube-resolve.ts`):

1. **Buscar** o vídeo equivalente no YouTube — disparar `discovery-searcher` com a query `site:youtube.com {título do vídeo} {fonte/canal, se conhecido}`. (Um `discovery-searcher` por item; paralelo se houver mais de um — lembrar do cap de 2 vídeos/edição.)
2. **Consolidar** os `articles[]` retornados (`{ title, url, source_name }`) num JSON `{ [urlOriginal]: [candidatos...] }` e gravar em `{EDITION_DIR}/_internal/tmp-video-search-results.json`.
3. **Resolver determinístico** (score de similaridade de título, `subjectSimilarity` — mesmo helper do dedup; threshold `YOUTUBE_MATCH_THRESHOLD`):
   ```bash
   npx tsx scripts/resolve-video-youtube.ts \
     --categorized {EDITION_DIR}/_internal/tmp-categorized.json \
     --search-results {EDITION_DIR}/_internal/tmp-video-search-results.json
   ```
   In-place. Stdout: `{ resolved, flagged, alreadyYoutube }`. Match confiável → URL substituída + `video_url_resolved: { from, to, matched_title, score }` anotado no artigo (mesmo espírito de `primary_source_substituted`, #1699). Sem match confiável → `video_url_unverified: true` no artigo, **NUNCA** um fallback silencioso pra URL não-YouTube (princípio invariável CLAUDE.md — nunca fabricar/manter URL não verificada).
4. **Guard (gate-critical):** se `flagged > 0`, **surfar no gate da Etapa 1** cada item flagado: `⚠️ vídeo sem URL de YouTube verificável — cole o link ({título})`. O editor cola a URL correta manualmente no MD antes de aprovar, ou remove o item de VÍDEOS.
5. Se `video` bucket vazio (nenhum item), pular este passo inteiro (info no run-log).

Backstop gate-blocking em Stage 4 (`lint-newsletter-md.ts --check video-links-are-youtube`, ver `orchestrator-stage-4.md` §4c.2) garante que nenhum item não-YouTube sobrevive até a publicação, mesmo que este passo seja pulado ou o editor cole um link errado.

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

### 1q. Scorer (chunked-parallel, #1611)

O scorer single-call (esse mesmo caminho legado, hoje chamado **1q-fallback** — então em Opus, sobre ~80-150 artigos numa passada) gastava ~8min; desde #2772 roda em Sonnet. Agora o caminho principal roda em 5 sub-passos: pontuação em K chamadas paralelas (mesmo rubrico) + seleção holística sobre os finalistas ([histórico de paridade](../../docs/orchestrator-stage-1-research-historia.md#1q-paridade-chunked)). Pools pequenos caem no caminho legado — ver **1q-fallback**.

**1q.1 — Split.** Dividir o pool em chunks de ~30:
```bash
npx tsx scripts/split-articles-for-scoring.ts \
  --categorized {EDITION_DIR}/_internal/tmp-dates-reviewed.json \
  --out-dir {EDITION_DIR}/_internal/scoring-chunks \
  --chunk-size 30 \
  --pool-out {EDITION_DIR}/_internal/tmp-scoring-pool.json
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
  --categorized {EDITION_DIR}/_internal/tmp-scoring-pool.json \
  --chunk-scores {EDITION_DIR}/_internal/scoring-chunks/scored-chunk-0.json,...,scored-chunk-{N-1}.json \
  --allscored-out {EDITION_DIR}/_internal/tmp-allscored.json \
  --finalists-out {EDITION_DIR}/_internal/tmp-finalists.json \
  --top 15
MERGE_EXIT=$?   # capturar ANTES do echo (echo zera o $?)
echo "merge-scored-chunks exit: $MERGE_EXIT"   # 0 = ok/incompleto-recuperável · 1 = erro de args/input · 2 = CATASTRÓFICO (#1669)
```

**Ramificar pelo EXIT CODE em `$MERGE_EXIT` (#1669 — determinístico; NÃO dependa de parsear `catastrophic` do manifest stdout).** Split é round-robin, então um chunk perdido leva uma fatia dos MELHORES artigos, não os piores — sem o guard o #1 highlight some silenciosamente. **Os 3 códigos são exaustivos — não há catch-all "seguir":**
- **exit 2** (= `catastrophic: true` — um chunk inteiro ilegível `failed_chunks > 0`, ou `missing_count > 2`): **NÃO seguir com o resultado degradado** (os arquivos `tmp-allscored.json`/`tmp-finalists.json` foram escritos só pra diagnóstico). (a) **Retry** o(s) `scorer-chunk` que falhou(aram) — re-disparar o agent só pros `scored-chunk-{i}.json` ausentes/inválidos — e re-rodar o merge (1q.3). (b) Se ainda sair 2 após o retry, **cair no 1q-fallback** (single-call `scorer` sobre o `tmp-scoring-pool.json` quando existir, preservando as anotações determinísticas; usar `tmp-dates-reviewed.json` apenas se o pool não existir), descartando o resultado chunked. Logar `level: error`.
- **exit 1** (erro de invocação — args malformados — ou `tmp-scoring-pool.json` ausente/corrompido, ex: split rodou sem `--pool-out`; **nenhum output novo foi escrito**): **HALT — NÃO seguir.** Os `tmp-finalists.json`/`tmp-allscored.json` podem estar stale de um run anterior; **não** consumir em 1q.4/1q.5. Corrigir os args/input (confirmar que 1q.1 passou `--pool-out`) e re-rodar, ou cair no 1q-fallback. Logar `level: error`.
- **exit 0 + `incomplete: true`** (gap ≤ 2 artigos): logar `level: warn` e seguir — os artigos sem score viraram 0 e serão filtrados em 1s (ruído recuperável).
- **exit 0** (sem `incomplete`): seguir normalmente.

**1q.3-bis. Checkpoint de integridade (#4986), só se `$MERGE_EXIT` != 1:** `npx tsx scripts/verify-summary-integrity.ts --raw {EDITION_DIR}/_internal/tmp-articles-raw.json --check {EDITION_DIR}/_internal/tmp-finalists.json --edition {AAMMDD} --label tmp-finalists.json` — mesmo backstop do 1m-bis, no ponto exato onde o D1 do #4986 perdeu `summary` ao vivo. Exit 1 → investigar `split-articles-for-scoring.ts`/`merge-scored-chunks.ts` antes do `scorer-select` (1q.4).

**1q.4 — Seleção.** Disparar 1 agent `scorer-select`: input = `tmp-finalists.json`, out_path = `tmp-selection.json`. Retorna `highlights[]` (≤6, ordem editorial) + `runners_up[]`.

**1q.5 — Assemble scored.** (Roda após 1q.4, usa `tmp-selection.json` + `tmp-allscored.json` pra montar o shaped final com highlights/runners_up/buckets + clusters). Script: `npx tsx scripts/assemble-scored.ts --selection {EDITION_DIR}/_internal/tmp-selection.json --allscored {EDITION_DIR}/_internal/tmp-allscored.json --categorized {EDITION_DIR}/_internal/tmp-dates-reviewed.json --out {EDITION_DIR}/_internal/tmp-scored.json`. Output: `{ scored, stats }`.

**1q-fallback — Scorer single-call (pool pequeno OU merge catastrófico sem retry).** Quando `chunk_count <= 1` (pool pequeno) OU merge falhou catastroficamente e o retry não resolveu: disparar 1 agent `scorer` (Opus, `effort: low` no frontmatter) sobre `tmp-scoring-pool.json` (se existir, preservando anotações determinísticas; senão `tmp-dates-reviewed.json`). Output direto em `tmp-scored.json` + `tmp-selection.json` (o scorer single-call retorna ambos). Pula 1q.1-1q.4.

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

### 1t. Avisos de mínimo por seção (warn-only)

```bash
npx tsx scripts/check-min-sections.ts --categorized {EDITION_DIR}/_internal/tmp-finalized.json
```
Stdout: array de strings (ex: `["⚠️ Apenas 2 lançamento(s) — mínimo esperado: 3"]`). Logar cada um como warn. **Nunca bloqueia** — só informa pro editor no gate.

### 1u. Shape final + strip do campo `verifier`

Script `strip-verifier.ts` remove o campo `verifier` (interno do scorer) de todos os artigos recursivamente:
```bash
npx tsx scripts/strip-verifier.ts --in {EDITION_DIR}/_internal/tmp-finalized.json --out {EDITION_DIR}/_internal/tmp-categorized.json
```
Output em `_internal/tmp-categorized.json` — **este é o arquivo que o gate lê** (não o `tmp-finalized.json` com verifier). `render-categorized-md.ts` usa este.

### 1u-bis. Dedup intra-edição (#2013)

Script `dedupe-intra-edition.ts` remove duplicatas dentro da edição atual (mesmo story, URLs diferentes) — complementa o dedup principal (1l) que é cross-edição:
```bash
npx tsx scripts/dedupe-intra-edition.ts --categorized {EDITION_DIR}/_internal/tmp-categorized.json --out {EDITION_DIR}/_internal/tmp-categorized.json
```
In-place. Stdout: `{ removed, kept }`. Logar info.

### 1u-ter. Evergreen filter (#3409)

Script `filter-evergreen.ts` remove artigos evergreen da edição atual (não são notícias do dia):
```bash
npx tsx scripts/filter-evergreen.ts --categorized {EDITION_DIR}/_internal/tmp-categorized.json --out {EDITION_DIR}/_internal/tmp-categorized.json
```
In-place. Stdout: `{ removed, kept }`. Logar info.

### 1v. Render MD (categorized + approved)

```bash
npx tsx scripts/render-categorized-md.ts \
  --categorized {EDITION_DIR}/_internal/tmp-categorized.json \
  --out {EDITION_DIR}/01-categorized.md \
  --edition {AAMMDD} \
  --eia {EDITION_DIR}/01-eia.md
```

Grava também `_internal/01-categorized.json` (mesmo conteúdo, JSON) e `_internal/01-approved.json` (cópia idêntica — gate ainda não rodou, mas o arquivo já existe pra resume).

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
npx tsx scripts/check-repeat-theme.ts --categorized {EDITION_DIR}/_internal/tmp-categorized.json --past-editions data/past-editions.md --window 3
```
Stdout: `{ flagged, theme }` — temas que apareceram nas últimas 3 edições. Logar info se `flagged`. Fail-soft — nunca bloqueia.

---

### 1x. GATE HUMANO (§1x)

**Guarda contra `auto_approve = true`:** se `auto_approve = true`, **pule esta seção inteira** e vá direto para §1y via `apply-gate-edits.ts --auto`.

1. **Instrução de revisão** — Apresentar ao editor o resumo consolidado do Stage 1:
   - `01-categorized.md` (visual)
   - `minSectionWarnings` (do 1t)
   - `lancamentosWarnings` (do enrich-primary-source)
   - `validateOutput.assertions` (do 1w-bis, status=warn)
   - `payload sizes` (do 1w-ter)
   - `repeatTheme` (do 1w-quint-b, se houver)
   - `editorSubmittedLost` (do 1l, se houver — item 4a do gate)
   - `stats.editorSubmittedLost` do research-review-dates (1p1) — item 4b do gate (deveria ser vazio)

2. **Opções do editor:** **aprovar** / **editar MD** / **rejeitar e re-rodar**.

---

### 1y. Aplicar edições do gate (ou auto_approve)

Se editor editou o MD:
```bash
npx tsx scripts/apply-gate-edits.ts \
  --md {EDITION_DIR}/01-categorized.md \
  --json {EDITION_DIR}/_internal/01-categorized.json \
  --out {EDITION_DIR}/_internal/01-approved.json
```
Re-valida lançamentos (mesmo `validate-lancamentos.ts` do 1v) e invariantes pós-apply (warn, não bloqueia). Experimento D3-radar (opt-in via config): se `platform.config.json > stage1_experiments.d3_to_radar === true` e `highlights.length === 3`, mover D3 pra `radar` e promover melhor `runners_up` a D3 — regra determinística, não julgamento editorial.

Se `auto_approve`:
```bash
npx tsx scripts/apply-gate-edits.ts --auto --json {EDITION_DIR}/_internal/01-categorized.json --out {EDITION_DIR}/_internal/01-approved.json
```

**Escreve sentinel `_internal/.step-1-done.json` (#6827) — após o gate aplicado.** Esta é a única saída que o Stage 1 deixa pra trás que o runner (`scripts/lib/edition-stage-runner.ts`) usa pra decidir retomar/skipir o Stage 2+ — e o caminho headless (`claude --print`, runner agendado) é onde o erro aconteceu: a sessão completou todo o trabalho com outputs válidos e saiu sem chamar `pipeline-sentinel.ts write`, então `.step-1-done.json` nunca existiu e a próxima etapa re-executou o Stage 1 ou seguiu sem checkpoint. Chamada explícita, não implícita — vem em SEQUÊNCIA depois do `apply-gate-edits.ts` acima (manual ou `--auto`):

```bash
npx tsx scripts/pipeline-sentinel.ts write --edition {AAMMDD} --step 1 --outputs "01-categorized.md,_internal/01-approved.json"
```

- **Semântica em `scripts/pipeline-sentinel.ts`** (exit codes, `--bypass-reason`, e o `write` roda `check-invariants --stage 1` automaticamente, recusando o write se houver violação `severity: error`).
- **É o ÚLTIMO passo do Stage 1, sempre.** Em qualquer caminho (editor ou `--auto`), vem após o `apply-gate-edits.ts` concluir. Nunca antes do gate, nunca "quando der tempo".
- **Falha do `write` é fail-soft, não desculta para pular.** Se retornar exit != 0, logar `warn: sentinel_write_failed` e reeter com `--bypass-reason "<motivo>"` descrevendo o falso-positivo conhecido — nunca deixar o stage sem sentinel.

---

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

---

### Opcional, delegado (fail-soft): §1y pós-gate (resolve-primary-source.ts)

Para cada artigo em `radar` ou `use_melhor` aprovado (presente em `highlights` ou `runners_up` de `_internal/01-approved.json`) que tenha `suggested_primary_domain`, disparar `discovery-searcher` com a query `site:{suggested_primary_domain} {núcleo do título}`. Se verificado (oficial + acessível + mesmo tema), anotar `primary_source_substituted` no artigo do `_internal/01-approved.json`. **Nunca bloqueia** — preserva o artigo sem resultado confiável. Fail-soft por design.