---
name: orchestrator-stage-0-preflight
description: Stage 0 do orchestrator Diar.ia — setup, parâmetros, checks pré-edição, refreshes (dedup, CTR, audience) e auto-reporter prep. Lido pelo orchestrator principal. @see orchestrator-stage-1-research.md (Stage 1).
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 0 — Setup e checks pré-edição

**MCP disconnect logging (#759):** Quando detectar `<system-reminder>` de MCP disconnect (Beehiiv, Gmail, etc.), logar: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn --message "mcp_disconnect: {server}" --details '{"server":"{server}","kind":"mcp_disconnect"}'`. Ao reconectar: mesmo comando com `--level info --message "mcp_reconnect: {server}"`. Persiste em `data/run-log.jsonl` para `collect-edition-signals.ts` (#759). **Sempre acompanhar** com halt banner pra alertar o editor: `npx tsx scripts/render-halt-banner.ts --stage "0 — Preflight" --reason "mcp__{server} desconectado" --action "reconecte e responda 'retry', ou 'abort' para abortar"` (#737).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

### 0a. Parâmetros de entrada

- `edition_date` recebido no formato `AAMMDD` (ex: `260423`). Usar como diretório: `data/editions/{edition_date}/`.
- Converter para ISO quando precisar de Date math:
  ```bash
  Bash("node -e \"const s='{edition_date}';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))\"")
  ```
  Armazenar como `edition_iso` (ex: `2026-04-23`).
- **Calcular `anchor_iso` e `cutoff_iso` (#560).** A janela de pesquisa é ancorada em "agora" (data de execução), não na publication date. Edições agendadas pra publicar dias à frente (ex: /diaria-edicao chamado com data futura) **continuam pesquisando o que foi publicado nos últimos `window_days` dias do ponto de vista de quem está rodando**, não a janela futura entre `today` e `edition_date`.
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
- **Receber `auto_approve` (opcional, default `false`).** Se `true`: auto-aprovar todos os gates, manter Drive sync ativo, manter social scheduling normal, copiar categorized → approved diretamente.

### 0b. Resume-aware

Antes de iniciar qualquer etapa, listar arquivos em `data/editions/{AAMMDD}/`. **Pipeline principal** (verificar de baixo para cima — parar na primeira condição verdadeira):

- Se `_internal/.step-6-done.json` existe → **Pipeline finalizado** (Stage 6 Agendamento concluído). **Nota sobre edições históricas (pré-Stage-6):** edições publicadas antes de #1694 (split Stage 5→6) têm `_internal/05-published.json` com `scheduled_at` ou `status: "published"` mas NÃO têm `.step-6-done.json`. Detectar pela presença de `scheduled_at` OU `status: "published"` em `_internal/05-published.json` junto com `_internal/06-social-published.json` populado — tratar como concluídas. NÃO re-agendar edições históricas.
- Se `_internal/06-social-published.json` existe **e** `posts[]` tem 6 entries com `status` ∈ `"draft"`, `"scheduled"`, `"pending_manual"` **e** (`_internal/05-published.json` tem `scheduled_at` OU `status: "published"`) → Pipeline finalizado. (Compat com edições históricas pré-Stage-6.)
- Se `_internal/06-social-published.json` existe **e** sentinel `.step-5-done.json` existe **mas não** `.step-6-done.json` → Etapa 5 completa; pular para **Etapa 6 (Agendamento)**. (Verifique que `_internal/05-published.json` não tem `scheduled_at` para confirmar que Stage 6 ainda não correu.)
- Se `_internal/06-social-published.json` existe mas com **menos de 6 entries** ou alguma `status: "failed"` → Etapa 5 parcial; re-disparar publicação Facebook e LinkedIn — ambos são resume-aware.
- Se `_internal/.step-5-done.json` existe (mas não `_internal/06-social-published.json`) → Etapa 5 em progresso (social dispatch falhou ou não completou); re-disparar `publish-facebook` + `publish-linkedin`.
- Se `_internal/05-published.json` existe **e** `status === "skipped"` (Chrome MCP estava indisponível) → **re-probar Chrome MCP** (`mcp__claude-in-chrome__tabs_context_mcp`). Se probe suceder: deletar o arquivo marcador e tratar como se Etapa 5 não tivesse rodado. Se probe falhar: pular para auto-reporter com `CHROME_MCP = false`.
- Se `_internal/05-published.json` existe **e** `review_completed === true` **e** `template_used` === valor de `publishing.newsletter.template` em `platform.config.json` (mas não `_internal/06-social-published.json`) → pular para Etapa 5b (social dispatch).
- Se `_internal/05-published.json` existe mas `template_used` !== template esperado → instruir o usuário a deletar o rascunho no Beehiiv e re-rodar Etapa 5 do zero. **Verificar template ANTES de review.**
- Se `_internal/05-published.json` existe mas `review_completed` é `false` ou ausente → Etapa 5 incompleta (newsletter parcial): pular publish-newsletter, rodar só o **loop de review-test-email** a partir do `draft_url` e `title`. Após completar, gravar `review_completed: true`. Em paralelo (se ainda não rodaram), disparar `publish-facebook` + `publish-linkedin`. Re-apresentar gate único.
- Se `04-d1-2x1.jpg` + `04-d1-1x1.jpg` + `04-d2-1x1.jpg` + `04-d3-1x1.jpg` existem (mas não `_internal/05-published.json`) → verificar se sentinel Step 4 (`_internal/.step-4-done.json`) existe. Se existe → Revisão (Stage 4) completa, pular para Etapa 5 (Publicação). Se não existe → pular para Etapa 4 (Revisão).
- Se `02-reviewed.md` + `03-social.md` existem (mas não `04-d1-2x1.jpg`) → pular para Etapa 3 (Imagens).
- Se `02-reviewed.md` existe mas **não** `03-social.md` → Etapa 2 parcial (newsletter ok, social não rodou); re-rodar Etapa 2 com `[social]`.
- Se `_internal/01-approved.json` existe (mas não `02-reviewed.md`) → pular para Etapa 2.
- Se `_internal/01-categorized.json` existe mas não `_internal/01-approved.json` → Etapa 1 foi interrompida no gate humano; reapresentar o gate.
- Caso contrário → começar do Stage 0 normalmente.

**É IA? (paralelo, #1111)** — verificar em qualquer ponto de resume:
- Se `01-eia.md` já existe → não disparar `eia-compose`.
- Se `01-eia.md` **não** existe e o resume está no Stage 1 ou acima → disparar `Bash(npx tsx scripts/eia-compose.ts --edition {AAMMDD} --out-dir data/editions/{AAMMDD}/, run_in_background=true)` (era Agent dispatch antes de #1111).
- **Pré-requisito da Etapa 5:** `01-eia.md` + imagens devem existir antes de publicar. Se o background bash ainda não completou quando a Etapa 5 for atingida, **bloquear e aguardar** via file-presence check.

Se o usuário responder "sim, refazer do zero", **pedir confirmação adicional digitando o nome da edição** (`AAMMDD`) antes de prosseguir — `sim`/`yes`/`confirmar` não valem, só o literal da edição (#101). Em seguida, **renomear** (não deletar) a pasta para `{AAMMDD}-backup-{timestamp}/` antes de começar.

### 0b-bis. Auto-capture newsletters (background) (#1514, #1518)

Captura newsletters de IA do inbox pessoal do editor antes do inbox drain.
Substitui o forward manual que o editor fazia diariamente.

> **NÃO PULAR (#1756).** Os e-mails de newsletter (Cyberman, TLDR, 7min.ai,
> Superhuman, Lenny, Marktechpost) são o **canal primário de submissões do
> editor** — a linha de cobertura ("você enviou X submissões") conta cada um
> como X. Como roda em background (`run_in_background: true`, passo 6), o custo
> de contexto no parent é desprezível: **não há justificativa de economia pra
> pular**. Único skip legítimo é Gmail MCP indisponível (passo abaixo). Pular
> por "economia de contexto" é erro de operação — aconteceu na 260603 (0b-bis
> pulado, 11 newsletters na janela, linha saiu "0 submissões").

**Por que após 0b (resume check):** se o pipeline está retomando uma edição que já passou do Stage 0, o resume (0b) pula direto para o stage pendente — evitando 30-40s de chamadas Gmail MCP desnecessárias. Mover este passo para antes do resume desperdiçaria esse tempo em todo resume.

1. Ler `platform.config.json > newsletter_auto_capture`. Se `enabled !== true`, skip silencioso.
2. Montar senders OR clause: `from:({sender1} OR {sender2} OR ...)`.
3. Buscar via Gmail MCP: `mcp__claude_ai_Gmail__search_threads` com query `from:({senders}) newer_than:2d` (usa `since_hours` da config, default 48h = `2d`). Limit 20.
4. Para cada thread, chamar `mcp__claude_ai_Gmail__get_thread` (messageFormat: `"FULL_CONTENT"`). Extrair `thread_id`, `sender` (From header), `subject`, `date` (ISO from internalDate), `body` (text/plain preferido, fallback text/html). Montar JSON array `CapturedThread[]`.
5. Salvar threads em `data/editions/{AAMMDD}/_internal/captured-newsletters.json`.
6. Rodar **em background** (`run_in_background: true`) — o resultado (`_internal/captured-newsletter-articles.json`) só é consumido no Stage 1 (1h inject-inbox-urls), então não precisa bloquear os health checks (0c) e refreshes (0d+):
   ```bash
   npx tsx scripts/capture-newsletter-urls.ts \
     --threads data/editions/{AAMMDD}/_internal/captured-newsletters.json \
     --out data/editions/{AAMMDD}/_internal/captured-newsletter-articles.json \
     --cursor data/newsletter-capture-cursor.json
   ```
   Writes `SyntheticInboxArticle[]` JSON directly to `_internal/captured-newsletter-articles.json` — no inbox.md intermediary (#1520). URL filtering (tracking, affiliate, sender-domain) is applied during capture.
7. Logar resultado quando o background completar (info). Falha não bloqueia (warn only).
8. **Guard determinístico (#1756):** se o search (passo 3) retornou **N>0 threads** mas `captured-newsletters.json` ficou **ausente/vazio** (e Gmail MCP estava disponível), logar **WARN loud** — sinal de que 0b-bis foi pulado ou falhou silenciosamente. O Stage 1 (1h inject-inbox-urls) deve re-checar: se há newsletters na janela do Gmail mas `captured_newsletter_count: 0` no marker, repetir o WARN antes do gate (o editor decide re-capturar/re-rodar). A linha de cobertura sairia com X subcontado caso contrário.

Se Gmail MCP estiver indisponível: skip silencioso (logar `info "0b-bis skipped: Gmail MCP unavailable"`). Esse é o **único** skip legítimo (#1756) — newsletter capture exige Gmail; sem ele não há como capturar.

### 0c. Inicialização de log + stage-status (#1217 — removed cost.md)

- **Log de início:** `Bash("npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level info --message 'edition run started'")`.
- **Ler flag de Drive sync.** Ler `platform.config.json` e armazenar `DRIVE_SYNC = platform.config.drive_sync` (default `true` se ausente). Se `DRIVE_SYNC = false`, informar ao usuário. Todos os blocos de sync verificam esta flag — se `false`, pular silenciosamente.
- **Pre-flight token OAuth Google (#1973) — CONSOLIDADO, rodar PRIMEIRO.** O mesmo refresh token cobre Drive + Gmail (inbox-drain) + upload de imagens sociais; quando expira, os 3 caem juntos e submissões do editor se perdem silenciosamente. Checar a validade ANTES de qualquer passo Drive/Gmail:
  ```bash
  npx tsx scripts/check-google-token.ts
  ```
  Exit 0 = válido (ou `expiring_soon` — funciona, mas imprime aviso de idade perto do limite de 7d). Exit 1 = expirado/inválido/ausente → o stderr traz **1 banner consolidado** com a ação (`oauth-setup.ts` + `/diaria-inbox` depois). Se exit 1, **alertar o editor com o banner e perguntar** se re-autentica agora (`npx tsx scripts/oauth-setup.ts`) antes de seguir, ou continua sem Drive/Gmail (submissões do editor desta edição não entrarão — ver `docs/google-oauth-production.md` pra causa raiz dos 7d). Isso substitui descobrir a expiração via 3 falhas espalhadas no meio do pipeline.
- **Pre-flight health check Drive (#121).** Se `DRIVE_SYNC = true`, rodar:
  ```bash
  npx tsx scripts/drive-sync.ts --health-check
  ```
  Output JSON: `{ ok: true, latency_ms }` (exit 0) ou `{ ok: false, error, remediation }` (exit 2). Se `ok: false`, alertar editor antes de prosseguir:
  > 🔐 Drive sync auth quebrada antes de iniciar a edição: {error}
  > {remediation}
  >
  > Continuar mesmo assim (sem Drive sync esta sessão) [y] ou abortar pra fix [n]?

  Se editor responder `n`, abortar. Se `y`, setar `DRIVE_SYNC = false` em sessão pra resto do pipeline.
- **Pre-flight Clarice REST (#1329).** Pinga `https://cortex.clarice.ai/api-correction` antes do Stage 2 saber se o fallback REST está saudável. Não bloqueia — só armazena `CLARICE_REST` (`true`/`false`) em sessão:
  ```bash
  npx tsx scripts/clarice-healthcheck.ts
  ```
  Output JSON: `{ ok, latency_ms?, error? }`. Exit 0 = saudável (`CLARICE_REST = true`); exit 2 = degradado (`CLARICE_REST = false`, logar warn com `error` e seguir). Stage 2 §3b consulta `CLARICE_REST` antes de tentar o fallback quando o MCP falha. Sem essa flag, Stage 2 ainda tenta o fallback — só perde a chance de pre-warn o editor.
- **Pre-flight Claude in Chrome MCP (#143).** Tentar `mcp__claude-in-chrome__tabs_context_mcp`. Setar `CHROME_MCP = true` se sucesso, `CHROME_MCP = false` se erro.
  - Se `CHROME_MCP = false`, logar warn. **Em modo interativo** (não `auto_approve`), alertar editor e aguardar `[y/n]`. **Em `auto_approve`**, prosseguir silenciosamente.
  - **Na Etapa 5**: checar `CHROME_MCP`. Se `false`, gravar `_internal/05-published.json` com `status: "skipped"` e LinkedIn entries com `status: "pending_manual"`. Não falhar.
- **Inicializar `stage-status.md` (#960, #1217).** Single source of truth pra timing + custo + tokens + modelos. `_internal/cost.md` (legado pré-#1217) foi removido — era redundante com stage-status e nunca foi preenchido na prática. Doc unificado de tempo + custo, atualizado incrementalmente durante o pipeline e visível no Drive. Editor abre durante runs longos pra ver progresso ao invés de esperar fim. Rodar:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ --init
  ```
  Idempotente — se já existe (resume), apenas reabre o estado anterior; não zera. Push ao Drive logo após init:
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 0 --files stage-status.md
  ```
  Falha não bloqueia (`stage-status.md` é observabilidade, não estado canônico).
  - **Marcar Stage 0 `running` logo após o init (#1783).** Sem isso o Stage 0 nunca passa por `running`, fica sem `start`, e o relatório mostra `-` na duração do preflight. **Não** passar `--start` — o auto-carimbo (#1789) põe `start = now` se ainda não há (e preserva o original em resume):
    ```bash
    npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ --stage 0 --status running
    ```

  **Atualização incremental durante o pipeline:** ao **começar** cada stage (1-5), chamar:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ \
    --stage N --status running --start "{ISO_now}"
  ```
  Ao **terminar** cada stage:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ \
    --stage N --status done --end "{ISO_now}" --duration-ms {ms} \
    [--cost-usd X] [--tokens-in N] [--tokens-out N] [--models "haiku-4-5,opus-4-7"]
  ```
  E re-push do `stage-status.md` ao Drive depois de cada update. Cost/tokens/models opcionais — campos vazios viram `-` no MD.

### 0d. Refresh automático de dedup (#895)

Rodar `scripts/refresh-dedup.ts` via Bash. O script:
- Usa a Beehiiv REST API direto (token em `BEEHIIV_API_KEY`); sem dependência de MCP ou subagente (#895 — o agent legado `refresh-dedup-runner` apontava pra UUID antigo de MCP que não existe mais; rodar inline no top-level pulava a regen do MD, regredindo #162).
- Detecta bootstrap (raw não existe) vs incremental (raw existe → busca só edições mais novas que `max(published_at)` do raw).
- **Sempre regenera `data/past-editions.md`** — mesmo com 0 novos posts (cobre o caso de `git pull` ter resetado o tracked file enquanto o raw, gitignored, ficou intacto; #162).
- Popula `links[]` resolvendo tracking URLs do Beehiiv (#234) e lendo `_internal/01-approved.json` local quando disponível (#238).
- Respeita `dedupEditionCount` do `platform.config.json`.
- Retorna JSON `{ mode, new_posts, total_in_base, most_recent_date, skipped: false, md_regenerated: true }`.
- **Se falhar (exit != 0)**, propagar o erro ao usuário e parar — não prossiga com dedup stale.

```bash
npx tsx scripts/refresh-dedup.ts
```

**Summary do dedup refresh (#314).** Após retornar, imprimir via Bash node snippet que lê `data/past-editions.md` e lista as 5 edições mais recentes (`## YYYY-MM-DD` sections). Se `new_posts > 0`, indicar `+{new_posts} nova(s)`. Como `skipped` agora é sempre `false` e o MD é sempre regenerado, indicar `no-op (MD regenerado)` quando `new_posts === 0`.

**Publicação manual (sem Stage 5 automático):** quando o editor publica diretamente no Beehiiv sem passar pela Etapa 5 do pipeline, `data/past-editions.md` não é atualizado automaticamente. Após qualquer publicação manual, rodar `/diaria-refresh-dedup` para sincronizar.

### 0d.bis Maintain `valid_editions` window do Worker (#1086, #1233)

O Worker `poll` rejeita votos pra editions que **não estão** no set `valid_editions` (KV). Pra subscribers continuarem podendo votar em edições arquivadas (clicar em emails de até 7 dias atrás), manter no set as **últimas 7 dias de edições publicadas** + edição corrente:

```bash
npx tsx scripts/maintain-valid-editions-window.ts --current {AAMMDD} --window-days 7
```

Substitui o legacy `add-valid-edition.ts` (que só adicionava a edição corrente — em set vazio criava state degenerate `[hoje]`, ativando o gate com APENAS hoje e rejeitando todas anteriores; caso real #1233 em 2026-05-13).

O script lê `data/past-editions-raw.json` (mantido por refresh-dedup no passo 0d acima), filtra por janela de 7 dias, une com `--current`, escreve set ordenado no KV via `wrangler kv key put`. Idempotente — re-rodar com mesmos parâmetros é no-op se nada mudou.

Política de preservação: nunca remove entries do set (editor pode ter adicionado especiais manualmente). Só ADICIONA o que faltar da janela. `removed[]` no JSON output é informativo only.

Exit codes:
- `0` → set OK ou foi atualizado (escrito no KV)
- `2` (#1234 review) → `read_failed=true`: wrangler retornou null. Pode ser (a) KV virgem (primeira execução, raro pós-#1233) ou (b) wrangler down. Conservador: NÃO escreve pra evitar destruir entries manuais em transient failure.
- `!=0` outro → erro inesperado (wrangler crashed, etc).

**HALT obrigatório em exit 2 (#1366).** Antes (até 260518) este caso era tratado como warn-and-continue, mas isso permitia silently rejection de **todos os votos** da edição em produção (caso real 260519: 482 subscribers receberiam email com botões A/B que retornariam 410 "Essa edição não aceita mais votos"). Agora é halt obrigatório:

```bash
npx tsx scripts/render-halt-banner.ts --stage "0 — Preflight" \
  --reason "maintain-valid-editions read_failed=true — KV virgem ou wrangler offline" \
  --action "rode \`npx tsx scripts/add-valid-edition.ts --edition AAMMDD\` pra popular o set e retentar"
```

Em `auto_approve = true` (ex: `/diaria-edicao --no-gates`), mesmo halt — auto-approve não pode bypassar bug que invalida feature inteira de É IA?. Editor precisa rodar `add-valid-edition.ts` uma vez manual; após KV populado, runs futuros respeitam normal.

**HALT em `!=0` outro também.** Voto silencioso rejeitado é a mesma classe de bug — pipeline deve parar antes de prosseguir.

> **#1186:** `inject-poll-sig` (§0d.ter) foi removido — o diário usa modo merge-tag (URL de voto sem `&sig=`). Não há mais patch de `poll_sig` por subscriber no Stage 0.

### 0e–0h. Refreshes paralelos pós-dedup (#717 hipótese 6)

Os passos **0e** (merge-local-pending), **0f** (sync-eia-used), **0g** (check-dedup-freshness) e **0h** (build-link-ctr) são todos independentes entre si — alguns dependem do output do `refresh-dedup` (passo 0d) e outros de nada — mas **nenhum depende dos outros 3**. Dispará-los como uma batelada paralela: **uma única mensagem com 4 Bash calls** (não 4 mensagens sequenciais).

Top-level Claude pode disparar múltiplas chamadas Bash em paralelo na mesma mensagem — usar isso aqui corta ~1-2min do Stage 0 sem mudar nada de comportamento. Cada um dos 4 passos abaixo retorna independentemente; processar resultados conforme retornam.

`update-audience` (passo **0i**) **DEPENDE** do output de `build-link-ctr` (data/link-ctr-table.csv). Mantém-se sequencial após 0h.

---

### 0e. Merge de edições locais pending-publish (#325)

Para evitar que URLs de edições aprovadas localmente mas ainda não publicadas no Beehiiv vazem pra edição atual:
```bash
npx tsx scripts/merge-local-pending.ts \
  --current {AAMMDD} \
  --anchor-iso {anchor_iso} \
  --editions-dir data/editions/ \
  --window-days 5 \
  --past-raw data/past-editions-raw.json
```
O script:
1. Escaneia `data/editions/*/` em busca de edições dos últimos 5 dias **a partir do `anchor_iso` (today)** que tenham `_internal/01-approved.json` mas **não** tenham `_internal/05-published.json` com `status: "published"`.
2. Extrai todas as URLs dessas edições e injeta em `data/past-editions.md` com flag `pending_publish: true`.
3. Se encontrar edições pending há > 2 dias **a partir de today**, alertar com mensagem `🟡 Edição {N} aprovada local há {D} dia(s) mas ainda draft no Beehiiv — URLs dela bloqueadas no dedup de hoje`.

**`--anchor-iso` (#863)**: A janela de pending detection é ancorada em "hoje" (data de execução), não em `edition_date`. Crítico para test mode com edição agendada no futuro — sem isso, pending legítimos da última semana saem da janela. Se omitido, default é `Date.now()` UTC.

Se o script não existir ainda (`ENOENT`) ou falhar com exit != 0 (#693): pular, mas **logar warn** explicitamente:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
  --informational \
  --message "merge-local-pending falhou ou não existe — URLs de edições pendentes podem não ter sido bloqueadas no dedup"
```

### 0f. Sync É IA? usado (#369)

Roda em paralelo com 0e/0g/0h (per nota da seção 0e–0h acima). Independente dos outros — só lê `data/editions/*/_internal/01-eia-meta.json`:
```bash
npx tsx scripts/sync-eia-used.ts --editions-dir data/editions/
```
Retorna JSON `{ scanned, added, already_present, skipped_no_meta }`. Se `added > 0`, logar `info`. Falha → logar `warn`, nunca bloqueia pipeline.

### 0g. Pre-flight de freshness do dedup (#230)

Roda em paralelo com 0e/0f/0h (per nota da seção 0e–0h acima):
```bash
npx tsx scripts/check-dedup-freshness.ts
```
Lê `data/past-editions-raw.json` e compara `max(published_at)` com `Date.now() - 48h`. Se fora da janela, **falha loud** (exit 1). Threshold = 48h (#236): tolera D-1 (atraso normal de fuso/processamento da Beehiiv) e fins de semana onde a newsletter não publica. Alarme dispara a partir de D-2, indicando provável falha real.

Se o script falhar:
1. Apresentar o JSON completo de output ao editor.
2. Pedir confirmação: `[c] continuar mesmo assim (override) | [a] abortar`. Default = `a`.
3. Se `c`, logar `level: warn` com `{ event: "dedup_freshness_override", most_recent, age_hours }` e prosseguir.

Saída fresh é silenciosa (logar `level: info` com `most_recent` + `age_hours`).

### 0h. Link CTR refresh (3 sub-passos: sync, enrich-via-MCP, build)

Roda em paralelo com 0e/0f/0g no nível do bloco, mas internamente é uma sequência de 3 sub-passos.

**0h.1 — Sync metadata + stats agregados (REST)**

```bash
npx tsx scripts/beehiiv-sync.ts
```

`beehiiv-sync.ts` (#1357) sincroniza posts + content + aggregate stats + `publication.json` via REST. **Não busca per-link clicks** — o endpoint `/posts/{id}/clicks` foi removido da API pública do Beehiiv (confirmado via OpenAPI spec; 50 endpoints, zero menção a "click"). Em vez disso, emite no resultado JSON um campo `posts_needing_clicks: [{id, title, email_clicks}]` com posts que precisam de enriquecimento (>7d, status=confirmed, `email.clicks>0`, `stats.clicks` vazio). Default: cap em 5 posts/run incremental; bootstrap/full emite tudo.

**0h.2 — Enriquece clicks via subagent (delegação pro `beehiiv-clicks-enricher`)**

Se `posts_needing_clicks` é não-vazio no output anterior, **delegue** pro subagent dedicado em vez de chamar a MCP do top-level:

```
Agent(subagent_type="beehiiv-clicks-enricher", prompt=<manifest items uma por linha>)
```

Cada item do prompt no formato `post_id=<id> title=<title>`. O agent itera, chama `mcp__claude_ai_Beehiiv__list_post_clicks` por post, pagina, e pipa cada response pro `scripts/apply-mcp-clicks.ts`. Retorna JSON summary `{processed, ok, fail, total_clicks_applied, failed_posts}`.

**Por que delegar pra subagent em vez de loop no top-level (mudou em #1361)**: tentamos a loop no top-level com `posts_needing_clicks` de 162 entries e o custo de contexto da conversa do editor foi insustentável (~200kb por batch de 20 posts). Subagents com MCP scope não consomem contexto da conversa parent — o pai só vê o summary final. Resolve backlog de 100+ posts em 1 invocação sem sacrificar usabilidade.

**Field mapping**: `apply-mcp-clicks.ts` (chamado pelo agent) mapeia os field names modernos da API (`total_clicked_verified`, etc.) pros legacy (`verified_clicks`, `unique_verified_clicks`, etc.) que `build-link-ctr.ts` espera.

**Manifest vazio**: skip 0h.2 inteiro. Apenas log info "no posts need clicks enrichment".

**0h.3 — Build CTR table**

```bash
npx tsx scripts/build-link-ctr.ts
```

Lê o cache enriquecido e regenera `data/link-ctr-table.csv`.

**Logging**: 0h.1 e 0h.3 silenciosos (warn-only). 0h.2 loga `info` quando processa posts, `warn` se MCP timeout/error em algum post (continua nos próximos). Falha de qualquer sub-passo não aborta pipeline.

### 0i. Audience profile refresh

Sequencial — **depende de 0h** (consome `data/link-ctr-table.csv`). Aguardar 0h completar antes de disparar:
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
Não bloqueia — se credenciais FB não existem ou nenhuma edição anterior tem `_internal/06-social-published.json`, logar `warn` e seguir.

### 0l. Verificação pré-edição de posts da edição anterior (#366)

Sempre roda, após Verify FB. Busca `_internal/06-social-published.json` da edição mais recente (Glob `data/editions/*/_internal/06-social-published.json`; pegar o mais recente por nome de pasta sort alfanumérico desc):
```bash
PREV_SOCIAL=$(node -e "
  const fs=require('fs');
  const dirs=fs.readdirSync('data/editions').filter(d=>/^\d{6}$/.test(d)).sort().reverse();
  const found=dirs.find(d=>fs.existsSync('data/editions/'+d+'/_internal/06-social-published.json'));
  process.stdout.write(found?'data/editions/'+found+'/_internal/06-social-published.json':'');
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

### 0n. Detecção de falhas de CI via Gmail (#740)

Fechar o loop de observabilidade: o GitHub envia notificações de CI falhou para o email do owner do repositório. Checar o inbox antes de iniciar a edição evita rodar o pipeline sobre código quebrado.

**Sempre roda, silencioso se sem falhas.** Usar Gmail MCP (`mcp__claude_ai_Gmail__search_threads`) para buscar:

```
from:notifications@github.com subject:("failed" OR "CI") newer_than:2d
```

Se não encontrar resultados: prosseguir silenciosamente.

Se encontrar threads:
1. Para cada thread, ler o conteúdo via `mcp__claude_ai_Gmail__get_thread` (messageFormat: `"FULL_CONTENT"`).
2. Extrair os campos:
   - `workflow`: nome do workflow (do subject, ex: "CI - feat(X): …")
   - `branch`: nome do branch (do subject ou corpo do email)
   - `run_url`: URL do run de CI (link "View workflow run" no corpo)
   - `failed_at`: timestamp do email
   - `summary`: motivo sumário (ex: "All jobs have failed", job name que falhou)
3. Persistir no arquivo append-only `data/ci-failures.jsonl` — uma entrada JSON por linha:
   ```json
   {"workflow":"CI","branch":"feat/x","run_url":"https://github.com/vjpixel/diaria-studio/actions/runs/…","failed_at":"2026-05-06T01:06:00Z","summary":"CI / test — Failed in 1 minute and 3 seconds"}
   ```
   Dedup por `run_url` — não adicionar se run_url já existir no arquivo.
4. Logar via `scripts/log-event.ts` (flag `--informational` pra não virar issue):
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
     --informational \
     --message "CI failures detectados: N falha(s) recentes" \
     --details '{"count":N,"branches":["feat/x"]}'
   ```
5. Exibir no terminal:
   ```
   ⚠️ CI failures detectados nas últimas 48h:
     • [feat/x] CI — All jobs have failed — 2026-05-06 01:06 BRT
       🔗 https://github.com/vjpixel/diaria-studio/actions/runs/…

   Esses failures podem indicar regressões no código atual.
   Continuar mesmo assim? [y/n] (default: y)
   ```
   Se editor responder `n`: abortar a edição.

Se Gmail MCP estiver indisponível (disconnect): pular `0n` silenciosamente (não bloqueia — CI check é informativo). Logar `info "0n skipped: Gmail MCP unavailable"`.

### 0-replies. Rascunhar respostas a assinantes (#1797, #2288) — SÓ sem --no-gates

**Roda SOMENTE quando `pre_gate === true`** (ou seja, **pulado com `--no-gates`**) — rascunhar respostas pessoais sem revisão não faz sentido em modo headless. No `/diaria-edicao` pre-gate default o editor está presente e os rascunhos são apresentados no gate do Stage 4. Análogo ao §0b-bis / §0n (Gmail MCP é top-level; orquestrar daqui).

1. Buscar via `mcp__claude_ai_Gmail__search_threads` na caixa do editor (reply-to da newsletter): query `to:vjpixel@gmail.com subject:(Re OR Res) newer_than:7d` (`Re`+`Res` cobre prefixos EN e PT-BR/Outlook; 7d cobre o intervalo entre edições + fim de semana). Limit 20. *Limitação conhecida (#1827): replies sem prefixo no assunto (só com header In-Reply-To) não são capturados nesta v1.*
2. Para cada thread, `mcp__claude_ai_Gmail__get_thread` (`FULL_CONTENT`). Montar JSON array `[{ thread_id, from, subject, date, body }]` em `data/editions/{AAMMDD}/_internal/captured-replies.json`.
3. Filtrar quais são respostas de assinante (determinístico):
   ```bash
   npx tsx scripts/filter-subscriber-replies.ts --in data/editions/{AAMMDD}/_internal/captured-replies.json
   ```
   (assunto `Re:` + remetente humano — exclui automáticos `no-reply`/`beehiiv`/`mailer-daemon` e os próprios endereços do editor.)
4. Para **cada** resposta filtrada (`replies[]`), rascunhar uma resposta **pessoal** (voz do Pixel/Diar.ia: agradecer + responder ao conteúdo da mensagem, curto, assinatura simples) via `mcp__claude_ai_Gmail__create_draft` — **NUNCA `send`** (princípio de segurança CLAUDE.md: só rascunhar; o envio é ação do editor).
5. **Apresentar no gate** a lista de rascunhos criados (remetente + assunto + 1ª linha do rascunho) pra o editor revisar/editar/descartar no Gmail antes de enviar.

Se Gmail MCP indisponível: pular silenciosamente (logar `info "0-replies skipped: Gmail MCP unavailable"`). Nunca bloqueia a edição. Se `pre_gate === false` (headless `--no-gates`): pular silenciosamente (logar `info "0-replies skipped: headless --no-gates"`).

### 0m. Auto-reporter — preparado pra rodar no final

Após a Etapa 4 (publicação paralela) completar, orchestrator deve disparar `collect-edition-signals.ts` + `auto-reporter` agent pra transformar sinais da edição em issues GitHub acionáveis. Detalhes completos no arquivo `orchestrator-stage-4.md` (seção "Etapa 4b — Auto-reporter").

### 0z. Pre-flight invariants (#1007 Fase 1)

Última verificação antes de gastar tokens na pesquisa. Valida env vars críticas (BEEHIIV_API_KEY, Drive credentials, past-editions-raw shape):

```bash
npx tsx scripts/check-invariants.ts --stage 0
```

Exit 1 = abort imediato com violations no stderr. Editor corrige (env, credentials) e re-roda. Esses checks são baratos (<1s) e evitam falhas tardias caras (Stage 4 sem `LINKEDIN_WORKER_URL`, etc — verificado novamente lá).

**Marcar Stage 0 `done` ao fim do preflight (#1783).** Fecha a duração do preflight (auto-carimbo de `end` via #1789; computa `end - start` do `running` lá do init). Sem isso o S0 ficaria eternamente `running` e sem duração no relatório:

```bash
npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ --stage 0 --status done
```

---

## Stage 1 — Research

