---
name: orchestrator-stage-1-research
description: Stage 1 do orchestrator diar.ia.br — pesquisa (inbox drain, RSS, researchers, discovery, dedup, categorize, score, render, gate). Roda via `scripts/stage-1-run.ts` (#5415); este arquivo tem o caminho do runner e os passos fora dele (Agent, gate), e a prosa de fallback está em orchestrator-stage-1-fallback.md (#14030). Lido pelo orchestrator principal. @see orchestrator-stage-0-preflight.md (Stage 0).
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 1 — Research

**MCP disconnect logging:** ver `orchestrator.md` § "MCP disconnect — logging + halt banner" (#759/#737). Nesta etapa: `--stage 1`, banner `--stage "1 — Pesquisa"`.

**`{EDITION_DIR}` (#2463/#3025/#3530):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Já foi resolvido no Stage 0 (§0a) — se este stage estiver rodando na mesma sessão que o Stage 0, reusar o valor. Se estiver rodando isolado (resume, skill separada), resolver de novo (idempotente — encontra o que já está no disco):
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

**Marcar Stage 1 `running` no início (#8866).** Sem isso `start` nunca é gravado antes do `--gate-at` de §1y1 — `pipeline_ms` sairia perto de zero (gate_at ≈ start) em vez de medir o pipeline real até o gate. Sem `--start` — auto-carimbo (#1789) preserva o original em resume:
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 1 --status running
```

### Runner determinístico (`scripts/stage-1-run.ts`, #5415 incremento 3/3) — CAMINHO PRINCIPAL DO MIOLO

O miolo determinístico do Stage 1 (tudo entre os 7 pontos de dispatch `Agent()` do playbook original) agora roda via `scripts/stage-1-run.ts` em 5 fases. A prosa detalhada de cada passo coberto vive em `.claude/agents/orchestrator-stage-1-fallback.md` (#14030) — é o que o script faz e por quê, e o **fallback** se o script não existir ou falhar de forma inesperada. No caminho normal esse arquivo não é lido: este arquivo guarda o bloco do runner e os passos que o orchestrator executa fora dele ("Passos fora do runner", abaixo).

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

3. **Fase `post-score`** (SÓ no caminho chunked, e só depois que TODOS os `scorer-chunk` concluíram — o Agent pode voltar assíncrono, #11749) — §1q.3 (merge-scored-chunks `--require-done`, lendo os `scored-chunk-{i}.json` que o orchestrator escreveu nos paths canônicos após os dispatches scorer-chunk; `mergePending: true` = chunk sem marcador de conclusão, esperar e re-chamar) → branch pelo exit code (#1669) → §1q.3-bis (integrity checkpoint) → devolve `pendingAgentDispatch` pro scorer-select.
   ```bash
   npx tsx scripts/stage-1-run.ts --phase post-score --edition {AAMMDD} --chunk-count N
   ```

4. **Fase `post-select-render`** — Exatamente um dos dois: §1q.5 (assemble-scored, caminho chunked) OU aceita o `tmp-scored.json` do scorer single-call diretamente (fallback) → §1r (promoção de runners_up até 6, in-JS) → §1s (finalize-stage1) → §1t (avisos de mínimo por seção, in-JS) → §1u (shape final + strip verifier, in-JS) → §1u-quater (rebaixa destaque com MESMO FATO, #9100, fail-soft) → §1u-quinquies (penalidade de estudo/case genérico, #9462, flag + fail-soft) → §1u-quinquies-b (rebaixa destaque com `date_unverified` cuja página declara data de mais de 30 dias, #13341, e destaque que repete URL ou incidente publicado há 31-84 dias, #13662, fail-soft) → §1u-sexies (busca ativa de fonte primária dos destaques D1-D3, #10137, fail-soft) → §1u-bis/§1u-ter (dedup intra-edição + evergreen — DEPOIS dos rebaixamentos, para comparar contra o top-3 já reordenado, #9750) → §1v (render MD) → §1v-scoring-features (feature store de scoring, fail-soft) → §1v-bis..1v-quinquies (lints warn-only) → §1w-quint (anti-skip 1f, BLOQUEIA) → §1w-bis (validate-stage-1-output, blocker vira HALT) → §1w-quat (check-invariants categorized-has-eia-section, BLOQUEIA) → §1w-ter (payload sizes) → §1w-quint-b (repeat-de-tema, fail-soft). Devolve tudo que o gate humano (§1x) precisa mostrar — a apresentação em si (texto formatado pro editor) continua do orchestrator.
   ```bash
   # Caminho chunked:
   npx tsx scripts/stage-1-run.ts --phase post-select-render --edition {AAMMDD} \
     --selection-json {EDITION_DIR}/_internal/tmp-selection.json
   # Caminho fallback:
   npx tsx scripts/stage-1-run.ts --phase post-select-render --edition {AAMMDD} \
     --fallback-scored-json {EDITION_DIR}/_internal/tmp-scored.json
   ```

5. **Fase `post-gate`** — §1y — aplica as edições do gate (ou `--auto`), re-renderiza MD, re-valida lançamentos, invariantes pós-apply (warn, não bloqueia), experimento D3-radar (opt-in via config), deriva os pedidos editoriais do gate (`derive-stage1`), escreve sentinel, arquiva inbox, fecha stage-status + captura de custo.
   ```bash
   # Se editor editou o MD:
   npx tsx scripts/stage-1-run.ts --phase post-gate --edition {AAMMDD} --md {EDITION_DIR}/01-categorized.md
   # Se auto_approve:
   npx tsx scripts/stage-1-run.ts --phase post-gate --edition {AAMMDD} --auto
   ```

**Interpretar o JSON de saída (campo `code` + resto):**
- `code: 0` → fase concluída. Usar outputs do JSON.
- `code: 1` → erro duro (sub-script obrigatório falhou, args inválidos, merge catastrófico sem retry possível aqui) — parar e reportar `notes[]` ao editor.
- `code: 2` → HALT obrigatório (`haltRequired`, banner já renderizado pelo script) — parar mesmo com `auto_approve`. O racional de cada HALT está no fallback, na seção do passo que parou: §1h.7 (marker do inject-inbox-urls), §1w-quint (anti-skip 1f), §1w-bis (validate-stage-1-output) e §1w-quat (check-invariants).
- `pendingAgentDispatch[]` → para cada entry, disparar `Agent(subagent_type: entry.agent, prompt: <manifest em entry.manifestPath, 1 item por linha>)`. Após todos completarem, re-invocar a fase seguinte passando os resultados (quando requerido).
- `pendingHumanDecision[]` → apresentar `detail`/`prompt`/`options` ao editor e agir conforme a resposta.
- `notes[]` com `inbox-drain skipped: auth_expired` → além de reportar, avisar o editor que submissões desta edição podem ter sido perdidas, com a ação de re-auth (`npx tsx scripts/oauth-setup.ts`, depois `/diaria-inbox` para recuperar), como §1a do fallback descreve. Os demais `reason`s do drain só logam warn.
- `delegatedSteps[]` — lista informativa dos passos que o script nunca tenta (§1m-ter, §1m-quinquies, §1f Path B queries temáticas PT/EN genéricas, §1g cost-capture `record-agent-costs.ts`, §1y resolve-primary-source.ts, §1x gate presentation) — rodar essas seções normalmente, como sempre. Elas ficam neste arquivo, em "Passos fora do runner" abaixo.

**Fallback**: se `scripts/stage-1-run.ts` não existir, ou falhar de um jeito não coberto pelos `code`s acima (erro de spawn, exceção fora do `try/catch` do script), ler `.claude/agents/orchestrator-stage-1-fallback.md` e seguir a prosa detalhada de 1a-1y de lá turno a turno, exatamente como antes do #5415, junto com os passos fora do runner deste arquivo (§1f Path B, custo de §1g, §1m-ter..§1m-quinquies, §1q, §1x, §1y).

@see scripts/stage-1-run.ts (docstring no topo do arquivo tem o mapeamento completo dos 7 pontos de Agent() e como cada um foi tratado)

---

### Passos fora do runner (#14030)

As seções abaixo são as que o orchestrator executa no caminho normal: os pontos de `Agent()` que o runner devolve em `pendingAgentDispatch` ou `delegatedSteps`, o gate humano e a aplicação do gate. A numeração é a do playbook original; os passos cobertos pelo runner que ficavam entre elas (1a-1e.5, 1f Path A, 1g-1m-bis fora a captura de custo de §1g, 1n-1p2, 1r-1w, 1y-bis, 1y-ter) estão em `orchestrator-stage-1-fallback.md`.

### 1f. Dispatch de researchers e discovery

**⛔ NUNCA PULE ESTE PASSO EM `/diaria-edicao` (#1091).** RSS batch (1e) **NÃO substitui** WebSearch dos publishers oficiais. Pular silenciosamente porque "RSS já trouxe artigos suficientes" é bug recorrente ([histórico](../../docs/orchestrator-stage-1-research-historia.md#1f-nunca-pule)). O passo 1w-quint (`validate-stage-1-completeness.ts`) detecta este skip e bloqueia o gate.

**⛔ NUNCA pré-checar `BRAVE_API_KEY` (ou qualquer var só em `.env`) via Bash antes de decidir o path (#3969).** `.env` só é carregado pelo processo Node (`import "dotenv/config"` em `scripts/fetch-websearch-batch.ts`) — nunca exportado pro shell Bash. Rodar `if [ -n "$BRAVE_API_KEY" ]` (ou equivalente) no Bash pra "adiantar" a decisão Path A/B vê a key como ausente mesmo quando ela está presente e válida no `.env`, causando fallback desnecessário pro Path B (~10× mais lento/caro). A decisão correta é **sempre** rodar `fetch-websearch-batch.ts` direto e ramificar pelo exit code (0 = Path A rodou; 3 = key ausente → Path B) — nunca inferir a presença da key por fora do processo Node que a lê.

#### Path A: Brave Search determinístico (DEFAULT desde #1560)

Coberto pela fase `pre-research` do runner (tentativa, log da decisão de path e queda para o Path B quando `fetch-websearch-batch.ts` sai 3). Prosa completa em `orchestrator-stage-1-fallback.md` §1f Path A.

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

- **#8370 Peça 1 — SEMPRE incluir até 2 queries de demanda de busca real como slots fixos**, mesmo mecanismo do #2313/#3916 acima. Fonte: pull mensal do Google Keyword Planner (#8366/#8476, `data/seo/google-keywords-{data}.json`), filtrado por competição LOW/MEDIUM + volume médio mensal ~200-5.000 (nicho alcançável, não volume de marca — ver `scripts/lib/search-demand-curation.ts`). Objetivo: quebrar o loop de reforço do scorer (formulário + CTR + fontes cadastradas são todos endógenos) com um sinal exógeno de demanda real, não de afinidade passada. Obter as queries via: `npx tsx -e "import {loadSearchDemandIdeas,pickSearchDemandDiscoveryQueries} from './scripts/lib/search-demand-curation.ts'; console.log(JSON.stringify(pickSearchDemandDiscoveryQueries(loadSearchDemandIdeas(process.cwd()), parseInt(process.env.EDITION_NUM??'0'), 2)))" EDITION_NUM={AAMMDD}` — resultado é array de até 2 strings (pode vir `[]` se o pull mensal nunca rodou ou não achou termo elegível — fail-soft, não bloqueia). Dispatchar 1 `discovery-searcher` por query retornada. Se o Path A já rodou (`fetch-websearch-batch.ts` sempre injeta essas queries quando `BRAVE_API_KEY` está presente), NÃO re-dispatchar — checar se `researcher-results.json` já tem uma entry `discovery:{slug}` cujo `query_used` bate com um dos termos.

- Agregar resultados (cada subagente retorna JSON com `status`, `duration_ms`, `articles[]`, e `reason` se status != ok).

- **#2668 — Reconciliar Path B após dispatch (determinístico).** Após despachar todos os agents E ter rodado ≥1 batch Path A (`fetch-websearch-batch`, que captura o header), emitir: `npx tsx scripts/reconcile-brave-path-b.ts --edition {AAMMDD}`. Deriva o uso do Path B do **gap real do header X-RateLimit-Remaining** (`delta_untracked`), não de um multiplicador hardcoded — então a contagem local passa a bater com o uso real do Brave. Idempotente. O **alerta** já usa o header direto desde #2668; isto é só pro breakdown local do relatório ([histórico](../../docs/orchestrator-stage-1-research-historia.md#2668-reconciliar-path-b)).

### 1g (custo dos dispatches). Fora do runner

§1g (record-source-runs) roda na fase `post-research-pre-score` (prosa em `orchestrator-stage-1-fallback.md` §1g). A captura de custo abaixo não: precisa do bloco `<usage>` dos dispatches `Agent`, que só o orchestrator vê (`delegatedSteps`).

**Capturar custo de tokens dos dispatches (#3748):** junto com o batch acima, monte um array `[{agent_type, usage_raw}]` a partir do bloco `<usage>` que cada dispatch `Agent` (source-researcher/discovery-searcher) retornou e rode:
```bash
npx tsx scripts/record-agent-costs.ts --edition-dir {EDITION_DIR}/ --edition {AAMMDD} \
  --stage 1 --costs {EDITION_DIR}/_internal/tmp-agent-costs-stage1.json
```
Persiste breakdown por agent_type em `_internal/cost.json` — complementa o total do stage já capturado em `stage-status.json` (#3441), que não quebra por agente. Falha não-bloqueante (logar warn e seguir).

### 1m-ter / 1m-quater / 1m-quinquies. Passos de §1m fora do runner

§1m (categorize + enrich-primary-source), 1m-bis e a instrumentação type_hint rodam na fase `post-research-pre-score` (prosa em `orchestrator-stage-1-fallback.md` §1m). 1m-quater também roda lá (idempotente); fica descrito aqui porque precisa rodar de novo depois de uma promoção do 1m-ter.

**1m-ter. Busca ATIVA de fonte primária (#1699).** (#10137: para os DESTAQUES D1-D3 a busca já roda deterministicamente em §1u-sexies, dentro do `stage-1-run.ts`; #10162: o mesmo §1u-sexies também cobre o RADAR com `launch_candidate` e o USE MELHOR, até 6 buscas por edição — este passo só se aplica ao que exceder esse teto.) O `enrich-primary-source` só sinaliza; #1699 manda buscar de fato. Para cada artigo em `radar` com `launch_candidate: true` (e `suggested_primary_domain`), o orchestrator:

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
  --past-editions data/past-editions.md
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

**Esperar a CONCLUSÃO de cada agente, não o arquivo (#11749).** A chamada `Agent` pode voltar assíncrona mesmo quando o driver da sessão diz que é síncrona (edição 261103: `scorer-chunk` e `scorer-select` voltaram em background). JSON parseável em `scored-chunk-{i}.json` não prova que o agente terminou — ele pode estar corrigindo o arquivo. Só seguir pro 1q.3 depois da notificação de conclusão de TODOS os `scorer-chunk`; o guard mecânico é o marcador `scored-chunk-{i}.json.done`, gravado por último pelo agente e exigido pelo merge (`--require-done`, exit 3 = pendente). Mesma regra pro `scorer-select` (1q.4): esperar a conclusão do agente antes da fase `post-select-render`.

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
  --top 15 \
  --require-done
MERGE_EXIT=$?   # capturar ANTES do echo (echo zera o $?)
echo "merge-scored-chunks exit: $MERGE_EXIT"   # 0 = ok/incompleto-recuperável · 1 = erro de args/input · 2 = CATASTRÓFICO (#1669) · 3 = chunk pendente (#11749)
```

**Ramificar pelo EXIT CODE em `$MERGE_EXIT` (#1669 — determinístico; NÃO dependa de parsear `catastrophic` do manifest stdout).** Split é round-robin, então um chunk perdido leva uma fatia dos MELHORES artigos, não os piores — sem o guard o #1 highlight some silenciosamente. **Os 4 códigos são exaustivos — não há catch-all "seguir":**
- **exit 3** (#11749 — algum `scored-chunk-{i}.json` sem marcador `.done`, ou reescrito depois dele; `pending_chunks` no stdout; **nada foi gravado**): o agente daquele chunk ainda não terminou. Esperar a conclusão e re-rodar o merge. Se o agente já retornou e o marcador não existe, re-disparar só aquele chunk. Na fase `post-score` do `stage-1-run.ts` isso volta como `code: 1` + `mergePending: true`.
- **exit 2** (= `catastrophic: true` — um chunk inteiro ilegível `failed_chunks > 0`, ou `missing_count > 2`): **NÃO seguir com o resultado degradado** (os arquivos `tmp-allscored.json`/`tmp-finalists.json` foram escritos só pra diagnóstico). (a) **Retry** o(s) `scorer-chunk` que falhou(aram) — re-disparar o agent só pros `scored-chunk-{i}.json` ausentes/inválidos — e re-rodar o merge (1q.3). (b) Se ainda sair 2 após o retry, **cair no 1q-fallback** (single-call `scorer` sobre o `tmp-scoring-pool.json` quando existir, preservando as anotações determinísticas; usar `tmp-dates-reviewed.json` apenas se o pool não existir), descartando o resultado chunked. Logar `level: error`.
- **exit 1** (erro de invocação — args malformados — ou `tmp-scoring-pool.json` ausente/corrompido, ex: split rodou sem `--pool-out`; **nenhum output novo foi escrito**): **HALT — NÃO seguir.** Os `tmp-finalists.json`/`tmp-allscored.json` podem estar stale de um run anterior; **não** consumir em 1q.4/1q.5. Corrigir os args/input (confirmar que 1q.1 passou `--pool-out`) e re-rodar, ou cair no 1q-fallback. Logar `level: error`.
- **exit 0 + `incomplete: true`** (gap ≤ 2 artigos): logar `level: warn` e seguir — os artigos sem score viraram 0 e serão filtrados em 1s (ruído recuperável).
- **exit 0** (sem `incomplete`): seguir normalmente.

**1q.3-bis. Checkpoint de integridade (#4986), só se `$MERGE_EXIT` != 1:** `npx tsx scripts/verify-summary-integrity.ts --raw {EDITION_DIR}/_internal/tmp-articles-raw.json --check {EDITION_DIR}/_internal/tmp-finalists.json --edition {AAMMDD} --label tmp-finalists.json` — mesmo backstop do 1m-bis, no ponto exato onde o D1 do #4986 perdeu `summary` ao vivo. Exit 1 → investigar `split-articles-for-scoring.ts`/`merge-scored-chunks.ts` antes do `scorer-select` (1q.4).

**1q.4 — Seleção.** Disparar 1 agent `scorer-select`: input = `tmp-finalists.json`, out_path = `tmp-selection.json`. Retorna `highlights[]` (≤6, ordem editorial) + `runners_up[]`.

**1q.5 — Assemble scored.** (Roda após 1q.4, usa `tmp-selection.json` + `tmp-allscored.json` pra montar o shaped final com highlights/runners_up/buckets + clusters). Script: `npx tsx scripts/assemble-scored.ts --selection {EDITION_DIR}/_internal/tmp-selection.json --allscored {EDITION_DIR}/_internal/tmp-allscored.json --categorized {EDITION_DIR}/_internal/tmp-dates-reviewed.json --out {EDITION_DIR}/_internal/tmp-scored.json --edition {AAMMDD}`. Output: `{ scored, stats }`. `--edition` é o que permite debitar a cota SEMANAL de exploração (#8370 Peça 2) na semana certa; sem ele o script só avisa e pula a cota.

**1q-fallback — Scorer single-call (pool pequeno OU merge catastrófico sem retry).** Quando `chunk_count <= 1` (pool pequeno) OU merge falhou catastroficamente e o retry não resolveu: disparar 1 agent `scorer` (Opus, `effort: low` no frontmatter) sobre `tmp-scoring-pool.json` (se existir, preservando anotações determinísticas; senão `tmp-dates-reviewed.json`). Output direto em `tmp-scored.json` + `tmp-selection.json` (o scorer single-call retorna ambos). Pula 1q.1-1q.4.

---

### 1x. GATE HUMANO (§1x)

**Guarda contra `auto_approve = true`:** se `auto_approve = true`, **pule esta seção inteira** e vá direto para §1y via `apply-gate-edits.ts --auto`.

**Marcador de `gate_at` (#8866) — fail-soft, nunca bloqueia.** Imediatamente antes de apresentar o resumo pela 1ª vez, gravar o timestamp de apresentação do gate (usado por `pipeline_ms` — tempo do pipeline até o gate, excluindo a espera pela resposta do editor):
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 1 --status running --gate-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```
Chamada idempotente — reapresentações (após "rejeitar e re-rodar") não sobrescrevem um `gate_at` já gravado (1ª apresentação vence, ver `update-stage-status.ts`). Erro do comando = ignorar e seguir.

1. **Instrução de revisão** — Apresentar ao editor o resumo consolidado do Stage 1:
   - `01-categorized.md` (visual)
   - `minSectionWarnings` (do 1t)
   - `lancamentosWarnings` (do enrich-primary-source)
   - `validateOutput.assertions` (do 1w-bis, status=warn)
   - `payload sizes` (do 1w-ter)
   - `top3-merit-warning` (#10792) — apresentar o aviso determinístico de item fora do top-3 com score ≥ maior do trio; é somente aviso, sem reordenar. O runner já o inclui nas notas pré-gate. No caminho manual, rodar `npx tsx scripts/check-invariants.ts --stage 1 --rule top3-merit-warning --edition-dir {EDITION_DIR}` e mostrar as violações.
   - `same_fact_warnings` (do 1w-quint-b, #9100) — **apresentar PRIMEIRO e destacado**: produto+versão em comum com um DESTAQUE recente (ex: "Sonnet 5.5"), candidato a destaque ou pool. Desde #9595 também `evidence: "numbers"` — candidato a destaque com ≥2 cifras distintivas em comum (`shared_numbers`) com um destaque recente: a mesma história de outro veículo (ex: "554 deepfakes", Lula 379/Flávio 190). Alta precisão; só sinaliza, o editor decide trocar/remover. Em `--auto` o aviso dos destaques aprovados sai nas notas do `stage-1-run.ts` pós-gate. Desde #9100, mostrar também `_internal/01-same-fact-demoted.json` (`demoted[]`): itens já rebaixados do top-3 por MESMO FATO, que seguem no pool — o editor pode promovê-los de volta se for ângulo novo.
   - `study_source_warnings` (do 1w-quint-b, #11763) — item (candidato a destaque ou pool) que cobre, via imprensa, um estudo/relatório já publicado nos últimos 30 dias (mesmo publicador + documento + número-chave em comum com o texto publicado). Apresentar como 🚨 junto do `same_fact_warnings`; só sinaliza, o editor decide. Em `--auto` sai nas notas do `stage-1-run.ts`, e o gate 4 repete o aviso pela invariante `study-source-recurrence`.
   - `repeatTheme` (do 1w-quint-b, se houver)
   - `secondary_warnings` com `possible_repeat: true` (do 1w-quint-b, #13143) — item do pool (RADAR, LANÇAMENTOS, USE MELHOR) com entidade E termo de conteúdo em comum com item publicado nas últimas 10 edições, destaques inclusive (caso 261116: RADAR "Claude transformou planilha em uma conversa" × destaque de 261113 sobre o Claude Sheets). Só sinaliza, nunca remove: o editor corta se for o mesmo fato e mantém se for desdobramento com fato novo. Em `--auto` sai nas notas do `stage-1-run.ts`, e o gate 4 repete o aviso pela invariante `secondary-theme-possible-repeat`.
   - `editorSubmittedLost` (do 1l, se houver — item 4a do gate)
   - `stats.editorSubmittedLost` do research-review-dates (1p1) — item 4b do gate (deveria ser vazio)

2. **Opções do editor:** **aprovar** / **editar MD** / **rejeitar e re-rodar**.

---

### 1y. Aplicar edições do gate (ou auto_approve)

**No caminho do runner (#14030):** a fase `post-gate` roda o `apply-gate-edits.ts` (editor ou `--auto`), as duas passadas do `apply-same-fact-removal.ts`, as invariantes pós-apply, o experimento D3-radar, a derivação de pedidos editoriais (`derive-editor-requests.ts derive-stage1`, abaixo, antes do sentinel desde o #14030), o sentinel, §1y-bis e §1y-ter. Nada destes passos é repetido à mão depois da fase.

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
Em seguida (#9386, só no `--auto`, fail-soft — `stage-1-run.ts` já roda): `npx tsx scripts/apply-same-fact-removal.ts --approved {EDITION_DIR}/_internal/01-approved.json --theme-check {EDITION_DIR}/_internal/01-highlight-theme-check.json --out-log {EDITION_DIR}/_internal/01-same-fact-removed.json` — remove do RADAR/LANÇAMENTOS os itens com `same_fact_warnings` (sem gate 1 o aviso não tinha onde agir); destaques ficam só com aviso; a lista vai para o gate 4.

Depois do gate 1, em ambos os modos (#13844; `stage-1-run.ts` já roda): `npx tsx scripts/apply-same-fact-removal.ts --approved {EDITION_DIR}/_internal/01-approved.json --current-edition {AAMMDD} --out-log {EDITION_DIR}/_internal/01-same-fact-removed.json`. Compara RADAR/LANÇAMENTOS/USE MELHOR com os destaques finais, preserva itens pinados e registra cada item completo em `removed[].item` para restauração no gate 4. Não altera os destaques.


**Derivar pedidos editoriais do gate do Stage 1 (#7964).** Em SEQUÊNCIA, sempre (auto ou editor — a função internamente é no-op quando `auto_approved: true`, ver docstring de `deriveStage1`):
```bash
npx tsx scripts/derive-editor-requests.ts derive-stage1 --edition {AAMMDD}
```
Sem snapshot dedicado — `01-categorized.json` (pré-gate) já é o baseline imutável, `01-approved.json` é o pós-gate. Captura `bucket-move`/`link-swap`/`pool-cut`/`pool-add` (mover item entre Lançamentos/Radar/Use Melhor/Vídeos) e `destaque-swap`/`destaque-cut`/`destaque-promote` (trocar/cortar/promover destaque), gravados com `stage: 1`, `source: "derived"` — só quando o gate teve edição humana real (`_internal/.step-1-gate.json.auto_approved === false`); sob `--no-gates` é sempre 0 pedidos, por design. **Idempotente por CONTEÚDO, não só por edição** (marcador `_internal/.step-1-editor-requests-derived.json` guarda um hash de `01-categorized.json` + `01-approved.json`, #8081/#8106): retomar um Stage 1 interrompido DEPOIS deste passo já ter rodado uma vez re-chama o comando com segurança — não duplica entradas em `editor-requests.jsonl` — mas um "rejeitar e re-rodar" que regenera os dois arquivos com conteúdo diferente sempre deriva de novo (o hash não bate), mesmo com o marcador da 1ª passada em disco. Exit code handling: `0` = derivação concluída (contagem no stdout); `!=0` = logar warn, não bloquear.

**Escreve sentinel `_internal/.step-1-done.json` (#6827) — após o gate aplicado.** Esta é a única saída que o Stage 1 deixa pra trás que o runner (`scripts/lib/edition-stage-runner.ts`) usa pra decidir retomar/skipir o Stage 2+ — e o caminho headless (`claude --print`, runner agendado) é onde o erro aconteceu: a sessão completou todo o trabalho com outputs válidos e saiu sem chamar `pipeline-sentinel.ts write`, então `.step-1-done.json` nunca existiu e a próxima etapa re-executou o Stage 1 ou seguiu sem checkpoint. Chamada explícita, não implícita — vem em SEQUÊNCIA depois do `apply-gate-edits.ts` acima (manual ou `--auto`):

```bash
npx tsx scripts/pipeline-sentinel.ts write --edition {AAMMDD} --step 1 --outputs "01-categorized.md,_internal/01-approved.json"
```

- **Semântica em `scripts/pipeline-sentinel.ts`** (exit codes, `--bypass-reason`, e o `write` roda `check-invariants --stage 1` automaticamente, recusando o write se houver violação `severity: error`).
- **É o ÚLTIMO passo do Stage 1, sempre.** Em qualquer caminho (editor ou `--auto`), vem após o `apply-gate-edits.ts` concluir. Nunca antes do gate, nunca "quando der tempo".
- **O `write` também grava o registro imutável do Stage 1 (#9372)** — `_internal/01-approved.gate1.json` (cópia do `01-approved.json` no fim do gate 1; o arquivo vivo é reescrito no Stage 4) e `_internal/stage1-funnel.json` (por URL: etapa em que saiu do funil + motivo). Write-once, mecânico, nada a fazer aqui; só não apague esses arquivos. Inspeção/backfill: `scripts/build-stage1-funnel.ts`.
- **Falha do `write` é fail-soft, não desculpa para pular.** Se retornar exit != 0, logar `warn: sentinel_write_failed` e retentar com `--bypass-reason "<motivo>"` descrevendo o falso-positivo conhecido — nunca deixar o stage sem sentinel.

---

### Opcional, delegado (fail-soft): §1y pós-gate (resolve-primary-source.ts)

Para cada artigo em `radar` ou `use_melhor` aprovado (presente em `highlights` ou `runners_up` de `_internal/01-approved.json`) que tenha `suggested_primary_domain`, disparar `discovery-searcher` com a query `site:{suggested_primary_domain} {núcleo do título}`. Se verificado (oficial + acessível + mesmo tema), anotar `primary_source_substituted` no artigo do `_internal/01-approved.json`. **Nunca bloqueia** — preserva o artigo sem resultado confiável. Fail-soft por design.
