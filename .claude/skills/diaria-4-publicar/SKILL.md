---
name: diaria-4-publicar
description: Roda a Etapa 4 (publicação paralela — newsletter Beehiiv + 6 posts sociais) com gate único, e auto-reporter. Uso — `/diaria-4-publicar [all|newsletter|social] AAMMDD`.
---

# /diaria-4-publicar

Dispara a Etapa 4 unificada (publicação paralela: Beehiiv + Facebook + LinkedIn em paralelo, gate único) e em seguida o auto-reporter.

## Argumentos

- `/diaria-4-publicar all AAMMDD` — roda publicação paralela + auto-reporter
- `/diaria-4-publicar newsletter AAMMDD` — re-dispara só `publish-newsletter` (Beehiiv); útil pra fix isolado após template errado
- `/diaria-4-publicar social AAMMDD` — re-dispara só `publish-facebook` + `publish-linkedin`; útil pra retry de social falhado sem regerar Beehiiv

**Opt-out por canal (#1326):** flag `--skip {newsletter,linkedin,facebook}` (CSV) ignora dispatch dos canais listados. Default = tudo auto. Exemplos:
- `/diaria-4-publicar AAMMDD --skip newsletter` — só social automático, newsletter manual
- `/diaria-4-publicar AAMMDD --skip linkedin,facebook` — só newsletter automático
- `/diaria-4-publicar AAMMDD --skip newsletter,linkedin,facebook` — tudo manual (equivalente ao default antigo)

Se não passar data, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 4` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`. Editor pode interromper se errado.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 3 aprovado e Stage 4 incompleto. Rode /diaria-3-imagens primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: perguntar ao editor qual: `Múltiplas edições em curso: {lista}. Qual processar?`

Crítico: este é o stage **publicador** (Beehiiv + LinkedIn + Facebook); rodar na edição errada causa publicação real de conteúdo desatualizado. Quando assumir edição em curso, o passo 0 abaixo (confirmar canais) já dá ao editor a chance de abortar antes de qualquer publicação.

## Pré-requisitos

- Etapas 1–3 completas: `02-reviewed.md`, `03-social.md`, `01-eia.md` + `01-eia.jpg`, `04-d{1,2,3}.jpg`
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`)
- Logado em Beehiiv, LinkedIn e Facebook (Meta Business Suite) no Chrome
- Bloco `publishing` em `platform.config.json` configurado
- `FACEBOOK_PAGE_ACCESS_TOKEN` no env pra Graph API

## Passo -2 — Pre-flight CORS check (#1132 P2.4)

Antes de qualquer Chrome MCP work, validar que o Worker `poll` responde com `Access-Control-Allow-Origin: *` no endpoint `/img/{key}`. Sem isso, paste flow falha com "Failed to fetch" opaco em runtime e gasta ~30min de debug (caso 260512).

```bash
npx tsx scripts/check-worker-cors.ts --worker-url https://poll.diaria.workers.dev
```

Output JSON `{ ok: true/false, header?: string, status?: number, reason?: string }`.

- Se `ok: true` → prosseguir normalmente.
- Se `ok: false` → halt + sugerir: "Worker CORS faltando. Faça `cd workers/poll && npx wrangler deploy` e re-rode."

## Passo -1 — Task tracking setup (#904)

**Defensive cleanup**: varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores (`Stage 0*` a `Stage 3*`). Em seguida, criar tasks pra esta etapa: `Stage 4a — confirm channels`, `Stage 4b — dispatch publishers (newsletter + social paralelo)`, `Stage 4c — review-test-email loop`, `Stage 4d — gate humano final`, `Stage 4e — auto-reporter`. Marcar `completed` quando cada passo retornar. Detalhe completo em `.claude/agents/orchestrator.md` § "Task tracking — UI hygiene". **No-op se TaskCreate/TaskUpdate não estiver disponível**.

## Passo 0 — Confirmar modo de publicação antes de qualquer dispatch (#336, invertido em #1326)

**Default = tudo automático** (#1326). Editor pode opt-out por canal via flag `--skip` ou via gate interativo.

**Path 1 — flag `--skip` foi passado:**
```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --skip "{lista}"
```
Canais listados ficam `manual`, resto fica `auto`. Skip de todos os 3 canais = comportamento "manual em tudo" antigo.

**Path 2 — `auto_approve = true` (via `/diaria-edicao --no-gates`):**
```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --auto-approve
```
Tudo auto, sem gate.

**Path 3 — gate interativo (sem `--skip` e sem `auto_approve`):**

```
Modo de publicação para esta edição (default = tudo automático):

  [1] Beehiiv automático  — top-level segue context/publishers/beehiiv-playbook.md (Worker-hosted)
  [2] Beehiiv manual      — você faz o paste no Beehiiv; arquivo: data/editions/{AAMMDD}/02-reviewed.md
  [3] LinkedIn automático — Worker queue + Make webhook (agenda 17:00 BRT)
  [4] LinkedIn manual     — você posta; copy: data/editions/{AAMMDD}/03-social.md
  [5] Facebook automático — Graph API agenda os 3 posts
  [6] Facebook manual     — você posta; copy: data/editions/{AAMMDD}/03-social.md

Digite os números separados por vírgula (ex: "1,3,5" pra tudo automático)
ou "all" pra automático em tudo, ou "none" pra encerrar sem publicar.
Default se não responder = TUDO AUTOMÁTICO (#1326).
```

Aguardar resposta. Se editor pular o gate (linha em branco / desistir) → `--default-auto`. Se "none" → grava `status: skipped_by_editor` e encerra.

## O que faz

### Etapa 4a.0 — Pre-upload de imagens sociais pro Drive (#725)

**Executar antes do dispatch paralelo** — LinkedIn precisa de URL pública pra `image_url` no payload Make.com. O upload é rápido (~2s por imagem, 3 imagens) e popula o cache `{edition_dir}/06-public-images.json`.

```bash
npx tsx scripts/upload-images-public.ts \
  --edition-dir data/editions/{AAMMDD}/ \
  --mode social
```

Resume-aware: re-execuções pularão imagens já no cache. Falha = **warning**, nunca bloqueia — `publish-linkedin.ts` faz graceful fallback pra `null` se o cache não existir (comportamento anterior: post sem imagem).

### Etapa 4a.1 — Pre-gate (#1523)

**Este gate é apresentado quando `pre_gate = true`** (default em `/diaria-edicao`, flag em `/diaria-4-publicar`). É o único gate de toda a pipeline no modo pre-gate.

Antes de disparar publishers, executar pré-render completo da newsletter:
1. Lint intentional-error + sync JSONL (beehiiv-playbook §0)
2. Extract metadata (beehiiv-playbook §1.1)
3. Upload imagens Cloudflare KV (beehiiv-playbook §1.2)
4. Render HTML + substitute images (beehiiv-playbook §1.3)
5. Setar gabarito É IA? (beehiiv-playbook §1.4)
6. Upload HTML pro Worker (beehiiv-playbook Fase 2)

Apresentar ao editor:

```
📄 Newsletter HTML: {worker_url}  (revise no browser/celular)
📄 Social: data/editions/{AAMMDD}/03-social.md
📁 Drive: Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/

Aprovar para disparar publicação em todos os canais? (sim/não/editar)
```

- **sim** → prosseguir para dispatch dos publishers (Etapa 4a)
- **não** → abortar sem publicar
- **editar** → editor edita arquivos, responde `sim` quando pronto

**Se `--no-gates` ou `auto_approve = true`:** pular este gate, ir direto pro dispatch.

### Etapa 4a — Publicação paralela (#38)

**Em uma única mensagem dispatcham 2 scripts em paralelo + você (top-level) executa o playbook newsletter** (ver `.claude/agents/orchestrator.md` § Etapa 4):

1. `publish-facebook.ts --schedule` (Graph API, ~30s) — `--schedule` é obrigatório (#503); nunca chamar sem essa flag
2. `publish-linkedin.ts` (Make.com webhook → LinkedIn company page) — 3 posts (#506):
   ```bash
   npx tsx scripts/publish-linkedin.ts --edition-dir data/editions/{AAMMDD} --schedule
   ```
3. **Newsletter Beehiiv (#1054 / #207 / #1114)**: você (top-level Claude Code) **lê `context/publishers/beehiiv-playbook.md` como playbook e executa direto** — Bash + Read + `mcp__claude-in-chrome__*` incluindo `javascript_tool`. **Não tente dispatchar via `Agent`** — javascript_tool é restrito ao top-level e o paste-into-htmlSnippet vai falhar em qualquer subagent (Haiku/Sonnet/Opus). O playbook produz `_internal/newsletter-final.html` + chunks `_b64_*.txt`, navega Beehiiv via Chrome MCP, cola via execCommand insertText, salva rascunho e envia email de teste.

LinkedIn não usa mais Chrome — sem necessidade de tab isolada para LinkedIn.

Após todos retornarem, **loop de review-test-email** roda em cima do draft Beehiiv (não bloqueia social, que já está pronto).

**Gate único**: URL Beehiiv + status do test email + tabela 6 social posts + checklist de upload manual de imagens. Editor aprova → segue auto-reporter.

### Etapa 4b — Auto-reporter (#57 / #79)

1. Coleta sinais da edição (`collect-edition-signals.ts`).
2. Se `signals_count > 0` e não é test_mode: dispara agent `auto-reporter` (gate humano de issues GitHub).
3. Pula auto-reporter se test_mode/auto_approve.

## Output

- `05-published.json` — `draft_url`, `test_email_sent_at`, `template_used`, `review_completed`
- `06-social-published.json` — 6 posts com `platform`, `destaque`, `url`, `status`, `scheduled_at`
- `_internal/issues-draft.json` (se auto-reporter rodou) — sinais coletados

## Notas

- **Nada é publicado automaticamente.** Newsletter vira rascunho + teste; social vira rascunho ou agendado. Editor dispara manualmente.
- **Resume-aware**: re-rodar pula o que já existe (newsletter rascunho, social posts).
- **Tab isolation**: agents Chrome usam tabs próprias — sem conflito mesmo rodando em paralelo.
- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
