---
name: orchestrator-stage-0-1
description: Detalhe dos Stages 0 (setup + dedup + checks) e 1 (pesquisa + É IA?) do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 0 — Setup e checks pré-edição

### 0a. Parâmetros de entrada

- `edition_date` recebido no formato `AAMMDD` (ex: `260423`). Usar como diretório: `data/editions/{edition_date}/`.
- Converter para ISO quando precisar de Date math:
  ```bash
  Bash("node -e \"const s='{edition_date}';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))\"")
  ```
  Armazenar como `edition_iso` (ex: `2026-04-23`).
- **Calcular `anchor_iso` e `cutoff_iso` (#560).** A janela de pesquisa é ancorada em "agora" (data de execução), não na publication date. Edições agendadas pra publicar dias à frente (test_mode, ou /diaria-edicao chamado com data futura) **continuam pesquisando o que foi publicado nos últimos `window_days` dias do ponto de vista de quem está rodando**, não a janela futura entre `today` e `edition_date`.
  ```bash
  Bash("node -e \"process.stdout.write(new Date().toISOString().slice(0,10))\"")
  ```
  Armazenar como `anchor_iso` (ex: `2026-05-04`). Calcular também `cutoff_iso = anchor_iso - window_days`:
  ```bash
  Bash("node -e \"const a=new Date('{anchor_iso}T00:00:00Z');a.setUTCDate(a.getUTCDate()-{window_days});process.stdout.write(a.toISOString().slice(0,10))\"")
  ```
  Esses dois valores **substituem** `edition_iso` em qualquer prompt de agente de pesquisa (1f) e qualquer chamada a `filter-date-window.ts` (1o). `edition_iso` permanece só como identificador da edição.
- Criar o diretório e subdiretório interno se não existirem: `Bash("mkdir -p data/editions/{edition_date}/_internal")`.
- **Receber `window_days` como parâmetro de entrada.** A skill que disparou este orchestrator já perguntou e confirmou a janela com o usuário antes de disparar. **Se não receber** (retrocompat), usar default: segunda/terça = 4, quarta-sexta = 3 — calcular via Bash node. Armazenar `window_days` — usado em Stage 1.
- **Receber `test_mode` (opcional, default `false`).** Se `true`: auto-aprovar todos os gates, desabilitar Drive sync, copiar `_internal/01-categorized.json` → `_internal/01-approved.json` diretamente.
- **Receber `with_publish` (opcional, default `false`, #568).** Só relevante quando `test_mode = true`. Controla se a Etapa 4 (publicação) roda no `/diaria-test`:
  - `with_publish = false` (default): Stage 0c força `CHROME_MCP = false`, fazendo Etapa 4 pular com `status: "skipped"`. Comportamento histórico do `/diaria-test` — fluxo de publicação fica fora do teste.
  - `with_publish = true`: Stage 0c roda o probe normal de Chrome MCP. Se sucesso, Etapa 4 dispatcha publish-newsletter / publish-facebook / publish-social com `schedule_day_offset = 10`. Editor é responsável por deletar manualmente os artefatos gerados (rascunho Beehiiv, posts agendados FB/LinkedIn).
- **Receber `auto_approve` (opcional, default `false`).** Se `true`: auto-aprovar todos os gates, manter Drive sync ativo, manter social scheduling normal, copiar categorized → approved diretamente.
  - Em resumo: `auto_approve` é "sem gates, resto normal"; `test_mode` é "sem gates + sem Drive + social 10 dias à frente".
- **Receber `schedule_day_offset` (opcional).** Se presente, usar como `day_offset` para todos os agendamentos sociais na Etapa 4. Usado pelo `/diaria-test` para agendar 10 dias à frente.

### 0b. Resume-aware

Antes de iniciar qualquer etapa, listar arquivos em `data/editions/{AAMMDD}/`. **Pipeline principal** (verificar de baixo para cima — parar na primeira condição verdadeira):

- Se `06-social-published.json` existe **e** `posts[]` tem 6 entries com `status` ∈ `"draft"`, `"scheduled"`, `"pending_manual"` → Etapa 4 completa. Pipeline finalizado. (Entries `pending_manual` são LinkedIn posts aguardando retomada com Chrome MCP — tratados como "já tratados" para fins de resume.)
- Se `06-social-published.json` existe mas com **menos de 6 entries** ou alguma `status: "failed"` → Etapa 4 parcial; re-disparar publicação Facebook e LinkedIn — ambos são resume-aware.
- Se `05-published.json` existe **e** `status === "skipped"` (Chrome MCP estava indisponível) → **re-probar Chrome MCP** (`mcp__claude-in-chrome__tabs_context_mcp`). Se probe suceder: deletar o arquivo marcador e tratar como se Etapa 4 não tivesse rodado. Se probe falhar: pular para auto-reporter com `CHROME_MCP = false`.
- Se `05-published.json` existe **e** `review_completed === true` **e** `template_used` === valor de `publishing.newsletter.template` em `platform.config.json` (mas não `06-social-published.json`) → pular para auto-reporter (Etapa 4b).
- Se `05-published.json` existe mas `template_used` !== template esperado → instruir o usuário a deletar o rascunho no Beehiiv e re-rodar Etapa 4 do zero. **Verificar template ANTES de review** — não faz sentido revisar email de um rascunho com template errado.
- Se `05-published.json` existe mas `review_completed` é `false` ou ausente → Etapa 4 incompleta (newsletter parcial): pular publish-newsletter, rodar só o **loop de review-test-email** a partir do `draft_url` e `title`. Após completar, gravar `review_completed: true`. Em paralelo (se ainda não rodaram), disparar `publish-facebook` + `publish-social`. Re-apresentar gate único.
- Se `04-d1-2x1.jpg` + `04-d1-1x1.jpg` + `04-d2-1x1.jpg` + `04-d3-1x1.jpg` existem (mas não `05-published.json`) → pular para Etapa 4.
- Se `02-reviewed.md` + `03-social.md` existem (mas não `04-d1-2x1.jpg`) → pular para Etapa 3 (Imagens).
- Se `02-reviewed.md` existe mas **não** `03-social.md` → Etapa 2 parcial (newsletter ok, social não rodou); re-rodar Etapa 2 com `[social]`.
- Se `_internal/01-approved.json` existe (mas não `02-reviewed.md`) → pular para Etapa 2.
- Se `_internal/01-categorized.json` existe mas não `_internal/01-approved.json` → Etapa 1 foi interrompida no gate humano; reapresentar o gate.
- Caso contrário → começar do Stage 0 normalmente.

**É IA? (paralelo)** — verificar em qualquer ponto de resume:
- Se `01-eia.md` já existe → não disparar eia-composer.
- Se `01-eia.md` **não** existe e o resume está no Stage 1 ou acima → disparar `eia-composer` em background.
- **Pré-requisito da Etapa 4:** `01-eia.md` + imagens devem existir antes de publicar. Se o eia-composer ainda não completou quando a Etapa 4 for atingida, **bloquear e aguardar** o Agent.

Se o usuário responder "sim, refazer do zero", **pedir confirmação adicional digitando o nome da edição** (`AAMMDD`) antes de prosseguir — `sim`/`yes`/`confirmar` não valem, só o literal da edição (#101). Em seguida, **renomear** (não deletar) a pasta para `{AAMMDD}-backup-{timestamp}/` antes de começar.

### 0c. Inicialização de log e cost.md

- **Log de início:** `Bash("npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level info --message 'edition run started'")`.
- **Ler flag de Drive sync.** Ler `platform.config.json` e armazenar `DRIVE_SYNC = platform.config.drive_sync` (default `true` se ausente). Se `DRIVE_SYNC = false`, informar ao usuário. Todos os blocos de sync verificam esta flag — se `false`, pular silenciosamente.
- **Pre-flight health check Drive (#121).** Se `DRIVE_SYNC = true` E não está em `test_mode`, rodar:
  ```bash
  npx tsx scripts/drive-sync.ts --health-check
  ```
  Output JSON: `{ ok: true, latency_ms }` (exit 0) ou `{ ok: false, error, remediation }` (exit 2). Se `ok: false`, alertar editor antes de prosseguir:
  > 🔐 Drive sync auth quebrada antes de iniciar a edição: {error}
  > {remediation}
  >
  > Continuar mesmo assim (sem Drive sync esta sessão) [y] ou abortar pra fix [n]?

  Se editor responder `n`, abortar. Se `y`, setar `DRIVE_SYNC = false` em sessão pra resto do pipeline.
- **Pre-flight Claude in Chrome MCP (#143, #568).** Se `test_mode = true` E `with_publish !== true`, setar `CHROME_MCP = false` diretamente (sem probe). Caso contrário (incluindo `test_mode = true` com `with_publish = true`), tentar `mcp__claude-in-chrome__tabs_context_mcp`. Setar `CHROME_MCP = true` se sucesso, `CHROME_MCP = false` se erro.
  - Se `CHROME_MCP = false`, logar warn. **Em modo interativo** (não `auto_approve` e não `test_mode`), alertar editor e aguardar `[y/n]`. **Em `auto_approve` ou `test_mode`**, prosseguir silenciosamente.
  - **Na Etapa 4**: checar `CHROME_MCP`. Se `false`, gravar `05-published.json` com `status: "skipped"` e LinkedIn entries com `status: "pending_manual"`. Não falhar.
- **Inicializar `_internal/cost.md`.** Se não existe, obter timestamp via Bash e gravar:
  ```markdown
  # Cost — Edição {AAMMDD}

  Orchestrator: claude-opus-4-7
  Início: {ISO}
  Fim: —
  Total de chamadas: 0

  | Stage | Início | Fim | Chamadas | Haiku | Sonnet |
  |-------|--------|-----|----------|-------|--------|
  ```
  Se já existe (resume), não sobrescrever — manter `Início` e linhas de stages anteriores intactos.

### 0d. Refresh automático de dedup

Disparar o subagente `refresh-dedup-runner` via `Agent`. O subagente:
- Garante `publicationId` em `platform.config.json` (descobre via `list_publications` se necessário).
- Detecta se é bootstrap (primeira vez) ou incremental (dia a dia).
- No incremental, só busca edições **mais novas** que a mais recente já na base (pode ser zero — nesse caso pula e reporta `skipped: true`).
- Regenera `context/past-editions.md` via `scripts/refresh-past-editions.ts`, respeitando `dedupEditionCount` do config.
- Retorna JSON `{ mode, new_posts, total_in_base, most_recent_date, skipped }`.
- **Se falhar**, propagar o erro ao usuário e parar — não prossiga com dedup stale.

**Summary do dedup refresh (#314).** Após retornar, imprimir via Bash node snippet que lê `context/past-editions.md` e lista as 5 edições mais recentes (`## YYYY-MM-DD` sections). Se `new_posts > 0`, indicar `+{new_posts} nova(s)`. Se `skipped`, indicar `no-op (MD regenerado)`.

**Publicação manual (sem Stage 4 automático):** quando o editor publica diretamente no Beehiiv sem passar pela Etapa 4 do pipeline, `context/past-editions.md` não é atualizado automaticamente. Após qualquer publicação manual, rodar `/diaria-refresh-dedup` para sincronizar.

### 0e. Merge de edições locais pending-publish (#325)

Sempre roda, após refresh. Para evitar que URLs de edições aprovadas localmente mas ainda não publicadas no Beehiiv vazem pra edição atual:
```bash
npx tsx scripts/merge-local-pending.ts \
  --current {AAMMDD} \
  --editions-dir data/editions/ \
  --window-days 5 \
  --past-raw data/past-editions-raw.json
```
O script:
1. Escaneia `data/editions/*/` em busca de edições dos últimos 5 dias que tenham `_internal/01-approved.json` mas **não** tenham `05-published.json` com `status: "published"`.
2. Extrai todas as URLs dessas edições e injeta em `context/past-editions.md` com flag `pending_publish: true`.
3. Se encontrar edições pending há > 2 dias, alertar com mensagem `🟡 Edição {N} aprovada local há {D} dia(s) mas ainda draft no Beehiiv — URLs dela bloqueadas no dedup de hoje`.

Se o script não existir ainda (`ENOENT`): pular silenciosamente e logar warn.

### 0f. Sync É IA? usado (#369)

Sempre roda, após merge-local-pending:
```bash
npx tsx scripts/sync-eia-used.ts --editions-dir data/editions/
```
Retorna JSON `{ scanned, added, already_present, skipped_no_meta }`. Se `added > 0`, logar `info`. Falha → logar `warn`, nunca bloqueia pipeline.

### 0g. Pre-flight de freshness do dedup (#230)

Sempre roda, após refresh:
```bash
npx tsx scripts/check-dedup-freshness.ts
```
Lê `data/past-editions-raw.json` e compara `max(published_at)` com `Date.now() - 48h`. Se fora da janela, **falha loud** (exit 1). Threshold = 48h (#236): tolera D-1 (atraso normal de fuso/processamento da Beehiiv) e fins de semana onde a newsletter não publica. Alarme dispara a partir de D-2, indicando provável falha real.

Se o script falhar:
1. Apresentar o JSON completo de output ao editor.
2. Pedir confirmação: `[c] continuar mesmo assim (override) | [a] abortar`. Default = `a`.
3. Se `c`, logar `level: warn` com `{ event: "dedup_freshness_override", most_recent, age_hours }` e prosseguir.

Saída fresh é silenciosa (logar `level: info` com `most_recent` + `age_hours`).

### 0h. Link CTR refresh

Sempre roda:
```bash
npx tsx scripts/build-link-ctr.ts
```
Regenera `data/link-ctr-table.csv` com CTR por link de todas as edições publicadas há mais de 7 dias. Resultado silencioso — logar apenas se falhar (`level: warn`, não aborta pipeline).

### 0i. Audience profile refresh

Sempre roda, após Link CTR:
```bash
npx tsx scripts/update-audience.ts
```
Regenera `context/audience-profile.md` combinando CTR comportamental (`data/link-ctr-table.csv`, primário) e survey declarativo (`data/audience-raw.json`, secundário). Resultado silencioso — logar apenas se falhar (`level: warn`, não aborta pipeline). Survey data é atualizada manualmente via `/diaria-atualiza-audiencia`.

### 0j. Pending issue drafts (#90)

Check drafts do `auto-reporter` órfãos de edições anteriores:
```bash
PENDING=$(npx tsx scripts/find-pending-issue-drafts.ts --current {AAMMDD} --window 3)
```
Se vazio (`[]`), skip silencioso. Se tiver entries, apresentar ao editor:
```
⚠️ N edições anteriores têm issues-draft não-processados:
  - 260423: 3 signals (1 source_streak, 2 chrome_disconnects)
  - 260422: 1 signal (1 unfixed_issue)

Processar agora? [s/n/d]
  s = disparar auto-reporter com as edições acima (multi-edition mode)
  n = pular, manter drafts pra próxima sessão
  d = dismiss (marcar como processados sem criar issues)
```
- Se `s`: invocar subagent `auto-reporter` via Agent com `{ edition_dirs, multi_edition: true, repo: "vjpixel/diaria-studio" }`.
- Se `n`: logar `info "deferred {count} pending drafts"`.
- Se `d`: gravar `_internal/issues-reported.json` com `dismissed: true` + array vazio cobrindo todos signals para cada edição pendente.

### 0k. Verify FB posts da edição anterior (#78)

Sempre roda, silencioso. Reconcilia posts Facebook agendados da edição anterior (status `scheduled` → `published`/`failed` via Graph API):
```bash
PREV=$(npx tsx scripts/find-last-edition-with-fb.ts --current {AAMMDD})
if [ -n "$PREV" ] && [ -f "data/.fb-credentials.json" ]; then
  npx tsx scripts/verify-facebook-posts.ts --edition-dir "$PREV/" || echo "verify-fb failed (non-fatal)"
fi
```
Não bloqueia — se credenciais FB não existem ou nenhuma edição anterior tem `06-social-published.json`, logar `warn` e seguir.

### 0l. Verificação pré-edição de posts da edição anterior (#366)

Sempre roda, após Verify FB. Busca `06-social-published.json` da edição mais recente (Glob `data/editions/*/06-social-published.json`; pegar o mais recente por nome de pasta sort alfanumérico desc):
```bash
PREV_SOCIAL=$(node -e "
  const fs=require('fs');
  const dirs=fs.readdirSync('data/editions').filter(d=>/^\d{6}$/.test(d)).sort().reverse();
  const found=dirs.find(d=>fs.existsSync('data/editions/'+d+'/06-social-published.json'));
  process.stdout.write(found?'data/editions/'+found+'/06-social-published.json':'');
")
```
Se o arquivo existir:
1. Posts com `status === "scheduled"` e `scheduled_at < now` (prazo passou): alertar editor com a lista.
2. Posts com `status === "failed"`: alertar editor com a lista.
3. Tudo ok ou arquivo não existe: silencioso.
Não bloqueia — alertas são informativos para o editor resolver antes de começar a nova edição.

**Importante (#565):** ao logar esses alertas via `scripts/log-event.ts`, **incluir flag `--informational`** pra evitar que o auto-reporter promova esses warns a issues GitHub falsas. Exemplo:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
  --informational \
  --message "edição anterior {PREV} tem N posts FB com status=failed" \
  --details '{"prev_edition":"{PREV}","failed_count":N}'
```
A flag injeta `informational: true` em `details` — `collect-edition-signals.ts` filtra por essa flag estruturada em vez do tag textual `(informativo)` no message (que era frágil).

### 0m. Auto-reporter — preparado pra rodar no final

Após a Etapa 4 (publicação paralela) completar, orchestrator deve disparar `collect-edition-signals.ts` + `auto-reporter` agent pra transformar sinais da edição em issues GitHub acionáveis. Detalhes completos no arquivo `orchestrator-stage-4.md` (seção "Etapa 4b — Auto-reporter").

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

### 1h. Injetar inbox_urls

Injetar `inbox_urls` na lista agregada antes da verificação: cada URL vira um artigo sintético com `{ url, source: "inbox", title: "(inbox)", flag: "editor_submitted" }`. O script de verificação decide se é acessível; depois o categorizer verá que é `editor_submitted` e o priorizará.

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

### 1w. Sync push do MD para o Drive (antes do gate)

Se `data/editions/{AAMMDD}/01-eia.md` existir (É IA? já completou em background):
```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD} --stage 1 --files 01-categorized.md,01-eia.md,01-eia-A.jpg,01-eia-B.jpg
```
Se `01-eia.md` ainda não existir (É IA? ainda processando):
```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD} --stage 1 --files 01-categorized.md
```
Anotar resultado em `sync_results[1]`; ignorar falhas (warn, nunca bloqueia).

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
