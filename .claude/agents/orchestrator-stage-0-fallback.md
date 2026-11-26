---
name: orchestrator-stage-0-fallback
description: Fallback do Stage 0 do orchestrator diar.ia.br (#14030) — prosa detalhada dos passos que `scripts/stage-0-run.ts` executa (0a, 0b-bis, checks HTTPS/token de 0c, 0d-0f, 0h, 0i, 0k, 0l, 0o, 0z). Lido só quando o runner falta ou falha fora dos codes previstos, ou quando orchestrator-stage-0-preflight.md cita uma seção daqui. Não é um subagente invocável diretamente.
---

> Fallback de `.claude/agents/orchestrator-stage-0-preflight.md`, separado no #14030. Não executar diretamente e não ler no caminho normal: o runner `scripts/stage-0-run.ts` executa estes passos. Ler este arquivo quando o runner não existir ou falhar de um jeito não coberto pelos `code`s (aí seguir 0a-0z turno a turno) ou quando o arquivo principal citar uma seção daqui. As seções que o orchestrator executa sempre ficaram no arquivo principal: 0b (resume), os pings MCP de 0c, 0g e 0j (decisões humanas), 0n e 0m; §0-replies está em `orchestrator-stage-0-replies.md`. "Bloco acima" e "passo N do bloco acima" referem-se ao bloco do runner no arquivo principal.

---

## Stage 0 — Setup e checks pré-edição (fallback do runner)

### 0a. Parâmetros de entrada (→ coberto por `stage-0-run.ts`, ver bloco acima; texto abaixo é referência/fallback)

- `edition_date` recebido no formato `AAMMDD` (ex: `260423`).
- **Resolver `{EDITION_DIR}` (#2463/#3025/#3530) — ANTES de criar qualquer diretório.** Diretório REAL da edição no disco: encontra a edição existente (flat legado OU nested novo, o que já estiver lá — resume-safe) ou, se ainda não existe, retorna o path NESTED (`data/editions/{AAMM}/{AAMMDD}/`, o layout que toda edição nova passa a usar a partir daqui). **Nunca** montar `data/editions/` + `{edition_date}` à mão daqui em diante — usar `{EDITION_DIR}` em todo path deste arquivo e dos Stages 1-3:
  ```bash
  EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {edition_date})
  ```
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
- Criar o diretório e subdiretório interno se não existirem: `Bash("mkdir -p {EDITION_DIR}/_internal")`.
  **Nota (#3530 — migrado; supersede a nota #3526):** este `mkdir` (e toda referência subsequente dentro de Stages 0-3) usa `{EDITION_DIR}` resolvido acima — mesmo padrão disk-aware que `orchestrator-stage-{4,5,6}.md` já usam desde #3025. Compat bidirecional: uma edição criada ANTES desta migração (flat) continua sendo encontrada e usada em flat pelo resume (§0b) — `resolveEditionDir()` prioriza o que já existe no disco sobre o layout default. Só edições **novas** (que ainda não têm diretório em nenhum layout) passam a nascer em nested. Não requer `migrate-edition-layout.ts --execute` (Gate B) — coexistência dos dois layouts é o estado normal até essa migração rodar.
- **Receber `window_days` como parâmetro de entrada.** A skill que disparou este orchestrator já perguntou e confirmou a janela com o usuário antes de disparar. **Se não receber** (retrocompat), usar default: segunda/terça = 4, quarta-sexta = 3 — calcular via Bash node. Armazenar `window_days` — usado em Stage 1.
- **Receber `auto_approve` (opcional, default `false`).** Se `true`: auto-aprovar todos os gates, manter social scheduling normal. No Stage 1, gerar `_internal/01-approved.json` via `npx tsx scripts/apply-gate-edits.ts --auto --json ... --out ...` (nunca copiar `_internal/01-categorized.json` literal — #3459, perdia o slice `highlights: first-3`).

### 0b-bis. Auto-capture newsletters (background) (#1514, #1518) (→ coberto por `stage-0-run.ts`; referência/fallback)

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
2. Montar lista de senders como string separada por vírgulas a partir de `newsletter_auto_capture.senders[]`. **Janela (#9584):** `{since_hours}` é `newsletter_auto_capture.since_hours`, exceto em edição de **segunda/terça** (janela de pesquisa de 4 dias), onde vira `max(since_hours, window_days × 24)` — ~96h, pra cobrir o que as newsletters mandaram na quinta/sexta. Regra em `captureSinceHoursForEdition` (`scripts/stage-0-run.ts`); `since_hours_by_sender` segue como override por sender.
3. **Usar script TS em vez de MCP direto (#2452 — token-reduction):** chamar via Bash:
   ```bash
   npx tsx scripts/fetch-newsletter-threads.ts \
     --senders "{sender1},{sender2},..." \
     --since-hours {since_hours} \
     --out {EDITION_DIR}/_internal/captured-newsletters.json
   ```
   O script usa a Gmail REST API diretamente (OAuth via `data/.credentials.json`), extrai somente `text/plain` (fallback HTML stripped+truncado a 8000 chars por thread), e escreve `CapturedThread[]` JSON. **Isso evita que até 20× `get_thread FULL_CONTENT` (80–112k chars HTML cada) entre no contexto do orchestrator.** O script faz a própria busca (Gmail REST `threads.list`) — **não chamar `mcp__claude_ai_Gmail__search_threads` neste passo**: busca e fetch são ambos feitos pelo script.
   - Se o script terminar com exit 0: ler o JSON de summary do stdout (campos `threads_found`, `threads_written`, `skipped_no_body`) e logar via `log-event.ts`.
   - Se o script terminar com exit 1 (erro de credenciais OAuth, rede, etc.): tratar como MCP indisponível — logar warn e fazer skip (mesmo comportamento do fallback Gmail MCP).
4. Salvar threads em `{EDITION_DIR}/_internal/captured-newsletters.json` (feito pelo script no passo 3).
5. Rodar **em background** (`run_in_background: true`) — o resultado (`_internal/captured-newsletter-articles.json`) só é consumido no Stage 1 (1h inject-inbox-urls), então não precisa bloquear os health checks (0c) e refreshes (0d+):
   ```bash
   npx tsx scripts/capture-newsletter-urls.ts \
     --threads {EDITION_DIR}/_internal/captured-newsletters.json \
     --out {EDITION_DIR}/_internal/captured-newsletter-articles.json \
     --cursor data/newsletter-capture-cursor.json
   ```
   Writes `SyntheticInboxArticle[]` JSON directly to `_internal/captured-newsletter-articles.json` — no inbox.md intermediary (#1520). URL filtering (tracking, affiliate, sender-domain) is applied during capture. **Cursor por edição (#9368):** edição vem de `--edition` ou do `--out`; registra `thread_id → edições`; re-run da mesma edição re-extrai (nunca grava `[]` por achar as threads "consumidas", caso 260921); thread é reoferecida em até 3 edições; o cursor só avança depois que a saída é gravada e relida numa edição real.
5b. Rodar `npx tsx scripts/audit-newsletter-intake.ts --edition {AAMMDD} --edition-dir {EDITION_DIR}` após a captura. O runner também descobre newsletters novas no inbox (`fetch-newsletter-threads.ts --discover --since-hours {since_hours} --out {EDITION_DIR}/_internal/discovered-newsletters.json --skip-ids-from {EDITION_DIR}/_internal/captured-newsletters.json`), identificadas por List-ID/List-Unsubscribe e lidas só pelos metadados. A descoberta grava em arquivo PRÓPRIO, lido só pela auditoria: nunca no `captured-newsletters.json` (que alimenta a linha de cobertura) e nunca toca o sentinel `.capture-newsletter-failed.json`; falha dela é `warn` próprio, e o sucesso da captura depende só dos grupos de remetente. Classificação é exclusivamente por `seed/newsletter-senders.json` versionado: aprovado = IA, rejeitado = não-IA, novo = incerta até decisão em lote no gate 4. Preservar threads com erro no intake. Não produzir resumo.
6. Logar resultado quando o background completar (info). Falha não bloqueia (warn only). **Guard #9368:** threads de remetente APROVADO em `seed/newsletter-senders.json` em `captured-newsletters.json` > 0 (sender só do config, ainda não aprovado, é filtrado por decisão e não conta) e `captured-newsletter-articles.json` vazio → `error` no run-log (`stage-0-run.ts`) e linha `❌ 1h:` no relatório do Stage 1 (`stage-1-run.ts`) — nunca warning silencioso.
7. **Guard determinístico (#1756):** se `threads_found > 0` (do summary do passo 3) mas `captured-newsletters.json` ficou **ausente/vazio**, logar **WARN loud** — sinal de que o script falhou silenciosamente. O Stage 1 (1h inject-inbox-urls) deve re-checar: se `captured_newsletter_count: 0` no marker mas `threads_found > 0`, repetir o WARN antes do gate (o editor decide re-capturar/re-rodar). A linha de cobertura sairia com X subcontado caso contrário.

Se `fetch-newsletter-threads.ts` retornar exit 1 (credenciais inválidas, OAuth expirado, sem acesso à rede): skip do passo (logar `info "0b-bis skipped: fetch-newsletter-threads falhou"`). Esse é o **único** skip legítimo (#1756). **Não usar `mcp__claude_ai_Gmail__get_thread` como fallback** — o volume de HTML no contexto é o problema que este corte resolve. **Não é mais silencioso pro resto da pipeline (#2878):** o próprio script grava `_internal/.capture-newsletter-failed.json` (`{ failed: true, error, at }`) antes de sair 1 — `inject-inbox-urls.ts` (Stage 1 §1h) lê esse sentinel e propaga `capture_failed`/`capture_error` pro marker `.marker-inject-inbox-urls.json`. Sem isso, `captured_newsletter_count: 0` era indistinguível de "editor genuinamente não enviou newsletter nenhuma" — a coverage line (Stage 2) e o gate do Stage 4 checam esse sinal e trocam "X submissões" por um aviso `⚠️ contagem de submissões indisponível` em vez de afirmar "0 submissões" (histórico: `docs/stage-0-incident-history.md` §0b-bis).

### 0c. Inicialização de log + stage-status (#1217 — removed cost.md) (→ os 3 checks HTTPS/token cobertos por `stage-0-run.ts`; os 2 pings MCP continuam manuais, ver passo 2 do bloco acima; texto abaixo é referência/fallback)

- **Log de início:** `Bash("npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level info --message 'edition run started'")`.
- **Pre-flight unificado de travas externas (#2358) — rodar ANTES dos checks individuais.** Agrega todos os checks de autenticação externos num único resumo de prontidão antes de gastar tokens em pesquisa. Travas que vencem silenciosamente (OAuth expirado, token CF inválido, API key ausente) são detectadas aqui, não no meio do stage que as usa:
  ```bash
  npx tsx scripts/lib/preflight-external-locks.ts
  ```
  Exit 0 = todas as travas ok ou unchecked. Exit 1 = trava(s) bloqueante(s) detectada(s) → stderr imprime o resumo `✅/ℹ️/❌` por dependência com `blocks_stages` e ação de reauth. Se exit 1:
  1. Imprimir o resumo de prontidão.
  2. Para cada trava bloqueante: renderizar banner (não é o halt bloqueante do #738 — este é aviso informativo, ver passo 3):
     ```bash
     npx tsx scripts/render-halt-banner.ts \
       --stage "0 — Preflight" \
       --reason "{dependency} — {state}" \
       --action "{reauth_action}"
     ```
  3. **Default (#5321, "Perguntar é exceção"): seguir a pipeline com o banner já renderizado**, sem aguardar o editor — nenhum critério do rubrico se aplica (não é MCP disconnect do #738/token de sessão travando um `AskUserQuestion` do #3938; é OAuth/token de plataforma expirado, reversível, sem trade-off editorial). Registrar o impacto (`blocks_stages` do resumo) via `log-event.ts --level warn` — o editor resolve a trava quando quiser, os stages afetados falham fail-soft na hora (não silenciosamente).
  Conectores MCP (Gmail) são reportados como `unchecked` — verificados em runtime pelo orchestrator (#738), não neste preflight TS. A Beehiiv não entra (#11225: só arquivo histórico).
- **Pre-flight token OAuth Google (#1973) — coberto pelo preflight unificado acima.** O check individual `check-google-token.ts` NÃO deve ser executado aqui — o preflight unificado (#2358) já chama `checkOAuthLock` → `checkTokenHealth` e emite o halt banner se o token estiver expirado/ausente. Rodar os dois causaria double-halt: o editor seria parado pelo preflight unificado, confirmaria continuar, e seria parado novamente pelo check individual. Se o preflight unificado não estiver disponível (ex: worktree antigo sem o arquivo), rodar como fallback:
  ```bash
  npx tsx scripts/check-google-token.ts
  ```
  Exit 0 = válido. Exit 1 = expirado/inválido/ausente → **default (#5321): alertar o editor (banner) e seguir sem bloquear** — registrar warn no run-log; o editor roda `npx tsx scripts/oauth-setup.ts` quando quiser reautenticar. Com o app OAuth em produção desde 22/10/2026 (#10785), token inválido é revogação, não o vencimento de 7d do modo Testing (`docs/google-oauth-production.md`).
- **Pre-flight token Cloudflare/wrangler (#2286).** O `CLOUDFLARE_API_TOKEN` expirado só estoura em `maintain-valid-editions` (§0d.bis) — depois de gastar tokens em dedup e CTR. Checar ANTES, análogo ao check-google-token:
  ```bash
  npx tsx scripts/check-cloudflare-token.ts
  ```
  Exit 0 = ativo OU erro de rede transitório (não bloqueia pipeline — soft note no stderr). Exit 1 = ausente/inválido/não-ativo → stderr traz banner com ação (`wrangler login` ou renovar no `.env`). (Exit 2 removido em #2306 — transitório agora sai 0.) Se exit 1, **default (#5321): alertar o editor com o banner e seguir sem bloquear** (impacto registrado: `maintain-valid-editions` e KV do É IA? vão falhar no §0d.bis — o editor renova o token quando quiser). Setar `CLOUDFLARE_TOKEN_OK = false` em sessão se exit 1 — §0d.bis usa pra decidir se tenta ou salta com halt.
- **Pre-flight Clarice REST (#1329).** Pinga `https://cortex.clarice.ai/api-correction` antes do Stage 2 saber se o fallback REST está saudável. Não bloqueia — só armazena `CLARICE_REST` (`true`/`false`) em sessão:
  ```bash
  npx tsx scripts/clarice-healthcheck.ts
  ```
  Output JSON: `{ ok, latency_ms?, error? }`. Exit 0 = saudável (`CLARICE_REST = true`); exit 2 = degradado (`CLARICE_REST = false`, logar warn com `error` e seguir). Stage 2 §3b consulta `CLARICE_REST` antes de tentar o fallback quando o MCP falha. Sem essa flag, Stage 2 ainda tenta o fallback — só perde a chance de pre-warn o editor. **MCP também (#11312):** o probe REST não diz nada do MCP `clarice` (outro endpoint; header montado pelo Claude Code via `headersHelper`, #11251), cujo 401 só aparecia no Stage 2 — rodar `npx tsx scripts/clarice-healthcheck.ts --mcp --via-headers-helper` (key resolvida pelo MESMO `scripts/mcp/clarice-headers.mjs` do `.mcp.json`; exit 0 → `CLARICE_MCP = true`, exit 2 → `CLARICE_MCP = false` + warn, nunca bloqueia). Stage 2 §3b lê `clariceMcp`: `false` → direto pro fallback REST. Limite: o script não vê o trust da pasta, e o fallback pro header estático usa o ambiente deste processo, não o do Claude Code.
- **Pings Claude in Chrome MCP (#143) e Gmail MCP (#3451); sem ping da Beehiiv (#11225):** ficam no arquivo principal, seção "§0c (pings MCP)" — rodam também no caminho do runner (passo 2).
- **Persistir os sinais acima em disco (#5414; `CLARICE_MCP` desde #11312; `BEEHIIV_MCP` não é mais apurado desde #11225 e fica `null`) — não confiar só na memória desta conversa.** Os checks acima (`CHROME_MCP`, `GMAIL_MCP`, `CLARICE_REST`, `CLARICE_MCP`, `CLOUDFLARE_TOKEN_OK`) só existiam "em sessão" até esta issue — um stage disparado depois como sessão NOVA (`/diaria-2-escrita`, `/diaria-5-publicacao`, a premissa do #5414 de rodar contexto limpo entre etapas) nunca rodou este Stage 0 na própria conversa, então não tem como "lembrar" desses valores. Gravar de uma vez, logo após o último dos checks:
  ```bash
  npx tsx scripts/lib/preflight-state.ts --edition-dir {EDITION_DIR} \
    --chrome-mcp {CHROME_MCP} --gmail-mcp {GMAIL_MCP} \
    --clarice-rest {CLARICE_REST} --clarice-mcp {CLARICE_MCP} --cloudflare-token-ok {CLOUDFLARE_TOKEN_OK}
  ```
  (`{X}` = `true`/`false` já apurado no passo correspondente acima.) Escreve/faz upsert em `{EDITION_DIR}/_internal/preflight-state.json`. Stage 2 §3b e Stage 5 leem este arquivo no início do próprio stage em vez de depender de variável de sessão — ver `scripts/lib/preflight-state.ts` pro contrato completo (`null` = "nunca verificado", mesma semântica permissiva de antes).
- **Inicializar `stage-status.md` (#960, #1217).** Single source of truth pra timing + custo + tokens + modelos. `_internal/cost.md` (legado pré-#1217) foi removido — era redundante com stage-status e nunca foi preenchido na prática. Doc unificado de tempo + custo, atualizado incrementalmente durante o pipeline. Editor abre localmente durante runs longos pra ver progresso ao invés de esperar fim. Rodar:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --init
  ```
  Idempotente — se já existe (resume), apenas reabre o estado anterior; não zera.

  - **Reconciliar stages `running` órfãos no resume (#2525).** Logo após o `--init`, rodar reconcile: uma interrupção (Claude fechado, crash, timeout) deixa o stage corrente em `running` pra sempre, travando a barra de progresso da statusLine (fica em "5/7 Publicação" e nunca avança). Edição fresca = no-op (tudo `pending`); resume = marca os `running` órfãos como `failed` pro orchestrator decidir re-rodar:
    ```bash
    npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --reconcile-running
    ```

  - **Marcar Stage 0 `running` logo após o init (#1783).** Sem isso o Stage 0 nunca passa por `running`, fica sem `start`, e o relatório mostra `-` na duração do preflight. **Não** passar `--start` — o auto-carimbo (#1789) põe `start = now` se ainda não há (e preserva o original em resume):
    ```bash
    npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 0 --status running
    ```

  **Atualização incremental durante o pipeline:** ao **começar** cada stage (1-5), chamar:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ \
    --stage N --status running --start "{ISO_now}"
  ```
  Ao **terminar** cada stage:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ \
    --stage N --status done --end "{ISO_now}" --duration-ms {ms} \
    [--cost-usd X] [--tokens-in N] [--tokens-out N] [--models "haiku-4-5,opus-4-7"]
  ```
  Cost/tokens/models opcionais — campos vazios viram `-` no MD.

### 0d. Refresh automático de dedup (#895) (→ coberto por `stage-0-run.ts`; referência/fallback)

Rodar `scripts/refresh-dedup.ts` via Bash. O script:
- Usa a Beehiiv REST API direto (token em `BEEHIIV_API_KEY`); sem dependência de MCP ou subagente (#895; histórico: `docs/stage-0-incident-history.md` §0d).
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

### 0d.bis Maintain `valid_editions` window do Worker (#1086, #1233) (→ coberto por `stage-0-run.ts`, incluindo o HALT obrigatório; referência/fallback)

O Worker `poll` rejeita votos pra editions que **não estão** no set `valid_editions` (KV). Pra subscribers continuarem podendo votar em edições arquivadas (clicar em emails de até 7 dias atrás), manter no set as **últimas 7 dias de edições publicadas** + edição corrente:

```bash
npx tsx scripts/maintain-valid-editions-window.ts --current {AAMMDD} --window-days 7
```

Substitui o legacy `add-valid-edition.ts` (histórico do #1233: `docs/stage-0-incident-history.md` §0d.bis).

O script lê `data/past-editions-raw.json` (mantido por refresh-dedup no passo 0d acima), filtra por janela de 7 dias, une com `--current`, escreve set ordenado no KV via `wrangler kv key put`. Idempotente — re-rodar com mesmos parâmetros é no-op se nada mudou.

Política de preservação: nunca remove entries do set (editor pode ter adicionado especiais manualmente). Só ADICIONA o que faltar da janela. `removed[]` no JSON output é informativo only.

Exit codes:
- `0` → set OK ou foi atualizado (escrito no KV)
- `2` (#1234 review) → `read_failed=true`: wrangler retornou null. Pode ser (a) KV virgem (primeira execução, raro pós-#1233) ou (b) wrangler down. Conservador: NÃO escreve pra evitar destruir entries manuais em transient failure.
- `!=0` outro → erro inesperado (wrangler crashed, etc).

**HALT obrigatório em exit 2 (#1366; histórico: `docs/stage-0-incident-history.md` §0d.bis).** Warn-and-continue permitia silently rejection de **todos os votos** da edição em produção. Agora é halt obrigatório:

```bash
npx tsx scripts/render-halt-banner.ts --stage "0 — Preflight" \
  --reason "maintain-valid-editions read_failed=true — KV virgem ou wrangler offline" \
  --action "rode \`npx tsx scripts/add-valid-edition.ts --edition AAMMDD\` pra popular o set e retentar"
```

Em `auto_approve = true` (ex: `/diaria-edicao --no-gates`), mesmo halt — auto-approve não pode bypassar bug que invalida feature inteira de É IA?. Editor precisa rodar `add-valid-edition.ts` uma vez manual; após KV populado, runs futuros respeitam normal.

**HALT em `!=0` outro também.** Voto silencioso rejeitado é a mesma classe de bug — pipeline deve parar antes de prosseguir.

> **#1186:** `inject-poll-sig` (§0d.ter) foi removido — o diário usa modo merge-tag (URL de voto sem `&sig=`). Não há mais patch de `poll_sig` por subscriber no Stage 0.

### 0e–0h. Refreshes paralelos pós-dedup (#717 hipótese 6) (→ coberto por `stage-0-run.ts` — o script já roda os 4 em paralelo via `Promise.all`; referência/fallback)

Os passos **0e** (merge-local-pending), **0f** (sync-eia-used), **0g** (check-dedup-freshness) e **0h** (build-link-ctr) são todos independentes entre si — alguns dependem do output do `refresh-dedup` (passo 0d) e outros de nada — mas **nenhum depende dos outros 3**. Dispará-los como uma batelada paralela: **uma única mensagem com 4 Bash calls** (não 4 mensagens sequenciais).

Top-level Claude pode disparar múltiplas chamadas Bash em paralelo na mesma mensagem — usar isso aqui corta ~1-2min do Stage 0 sem mudar nada de comportamento. Cada um dos 4 passos abaixo retorna independentemente; processar resultados conforme retornam.

`update-audience` (passo **0i**) **DEPENDE** do output de `build-link-ctr` (data/link-ctr-table.csv). Mantém-se sequencial após 0h.

---

### 0e. Merge de edições locais pending-publish (#325) (→ coberto por `stage-0-run.ts`; referência/fallback)

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
1. Escaneia `data/editions/*/` em busca de edições dos últimos 5 dias **a partir do `anchor_iso` (today)** que tenham `_internal/01-approved.json` mas **não** estejam publicadas — checado via `_internal/05-published.json` com `status: "published"` **OU** (#3207) já presentes em `--past-raw data/past-editions-raw.json` (fonte Beehiiv REST, cross-check por data). O segundo caso cobre edições publicadas em outra sessão/máquina, cujo `_internal/05-published.json` local nunca chega a ser escrito — sem o cross-check isso gerava falso-positivo de `pending_publish` mesmo já publicada de verdade.
2. Extrai todas as URLs dessas edições e injeta em `data/past-editions.md` com flag `pending_publish: true`.
3. Se encontrar edições pending há > 2 dias **a partir de today**, alertar com mensagem `🟡 Edição {N} aprovada local há {D} dia(s) mas ainda draft no Beehiiv — URLs dela bloqueadas no dedup de hoje`.

**`--anchor-iso` (#863)**: A janela de pending detection é ancorada em "hoje" (data de execução), não em `edition_date`. Crítico para test mode com edição agendada no futuro — sem isso, pending legítimos da última semana saem da janela. Se omitido, default é `Date.now()` UTC.

Se o script não existir ainda (`ENOENT`) ou falhar com exit != 0 (#693): pular, mas **logar warn** explicitamente:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
  --informational \
  --message "merge-local-pending falhou ou não existe — URLs de edições pendentes podem não ter sido bloqueadas no dedup"
```

### 0f. Sync É IA? usado (#369) (→ coberto por `stage-0-run.ts`; referência/fallback)

Roda em paralelo com 0e/0g/0h (per nota da seção 0e–0h acima). Independente dos outros — só lê `data/editions/*/_internal/01-eia-meta.json`:
```bash
npx tsx scripts/sync-eia-used.ts --editions-dir data/editions/
```
Retorna JSON `{ scanned, added, already_present, skipped_no_meta }`. Se `added > 0`, logar `info`. Falha → logar `warn`, nunca bloqueia pipeline.

### 0h. Link CTR refresh (2 sub-passos: sync, build) (→ 0h.1/0h.3 cobertos por `stage-0-run.ts`; referência/fallback)

Roda em paralelo com 0e/0f/0g no nível do bloco, mas internamente é uma sequência de 2 sub-passos. (O 0h.2, enrichment de clicks via subagent `beehiiv-clicks-enricher`, foi aposentado no #11225: a Beehiiv é só arquivo histórico e não publica edição nova.)

**0h.1 — Sync metadata + stats agregados (REST)**

```bash
npx tsx scripts/beehiiv-sync.ts
```

`beehiiv-sync.ts` (#1357) sincroniza posts + content + aggregate stats + `publication.json` via REST. **Não busca per-link clicks** — o endpoint `/posts/{id}/clicks` foi removido da API pública do Beehiiv (confirmado via OpenAPI spec; 50 endpoints, zero menção a "click"). O campo `posts_needing_clicks` que ele ainda emite no JSON é ignorado desde o #11225 (o enricher que o consumia foi aposentado).

**0h.3 — Build CTR table**

```bash
npx tsx scripts/build-link-ctr.ts
```

Lê o cache e regenera `data/link-ctr-table.csv`.

**Logging**: 0h.1 e 0h.3 silenciosos (warn-only). Falha de qualquer sub-passo não aborta pipeline.

### 0i. Audience profile refresh (→ coberto por `stage-0-run.ts`; referência/fallback)

Sequencial — **depende de 0h** (consome `data/link-ctr-table.csv`). Aguardar 0h completar antes de disparar:
```bash
npx tsx scripts/update-audience.ts
```
Regenera `context/audience-profile.md` combinando CTR comportamental (`data/link-ctr-table.csv`, primário) e survey declarativo (`data/audience-raw.json`, secundário). Resultado silencioso — logar apenas se falhar (`level: warn`, não aborta pipeline). Survey data é atualizada manualmente via `/diaria-atualiza-audiencia`.

**Snapshot por edição (#4842).** Logo em seguida, arquivar a versão do profile que esta edição de fato usa:
```bash
npx tsx scripts/snapshot-audience-profile.ts --edition-dir {EDITION_DIR}
```
Copia `context/audience-profile.md` (que acabou de ser regerado) para `{EDITION_DIR}/_internal/audience-profile-snapshot.md`. O profile é regerado toda edição e pode derivar rápido (medido: 9 de 17 posições em 5 dias) — sem esse snapshot não dá pra saber retroativamente qual tabela de CTR/audiência o `scorer`/`scorer-chunk` desta edição efetivamente leu. Fail-soft (mesmo padrão do `update-audience.ts` acima) — sai 0 e loga warning se o profile fonte não existir; nunca aborta o Stage 0.

### 0k. Verify FB + LinkedIn/Instagram/Threads + Twitter da edição anterior (#78, #5766, #5801) (→ coberto por `stage-0-run.ts`; referência/fallback)

Sempre roda, silencioso. Reconcilia `scheduled` → `published`/`failed` da edição anterior: Facebook via Graph API, LinkedIn/Instagram/Threads via `GET /list`/`GET /dlq` do Worker `diaria-linkedin-cron`, e (#5766) Twitter via API GraphQL do Buffer (`api.buffer.com/graphql` — NÃO a REST legacy `api.bufferapp.com`, que rejeita token pessoal com 401). Instagram/Threads: entrega real confirmada; LinkedIn: confiança mais fraca (só aceite do webhook Make) — via `verification_note`, ver `scripts/verify-social-worker-dispatch.ts`. Não bloqueia — credenciais/Worker/token ausentes logam `warn` e seguem. **`verify-twitter-posts.ts` roda sempre, sem gate por `BUFFER_ACCESS_TOKEN` (#6152)** — o script carrega o próprio `.env` (`import "dotenv/config"`) e decide sozinho; sem token, sai com código != 0 e o `|| echo` abaixo (fail-soft) já é a nota — um `if [ -n "$BUFFER_ACCESS_TOKEN" ]` prévio caçoava o passo do relatório em silêncio quando a var não estava pré-carregada no shell (achado ao vivo #6152: `.env` tinha o token e o `if` mesmo assim calava, porque a var só existe no processo que já carregou `.env`, nunca no shell puro).
```bash
PREV=$(npx tsx scripts/find-last-edition-with-fb.ts --current {AAMMDD})
# #10505/#10542: credencial é por página (scripts/lib/facebook-pages.ts: env OU o arquivo legado da diaria); stage-0-run.ts (facebookVerifyGate) PULA este passo, com nota, quando nenhuma página tem credencial completa.
[ -n "$PREV" ] && (npx tsx scripts/verify-facebook-posts.ts --edition-dir "$PREV/" || echo "verify-fb failed (non-fatal)")
[ -n "$PREV" ] && (npx tsx scripts/verify-social-worker-dispatch.ts --edition-dir "$PREV/" || echo "verify-social-worker failed (non-fatal)")
[ -n "$PREV" ] && (npx tsx scripts/verify-twitter-posts.ts --edition-dir "$PREV/" || echo "verify-twitter failed (non-fatal, sem BUFFER_ACCESS_TOKEN ou outra falha — ver stderr)")
```

### 0l. Verificação pré-edição de posts da edição anterior (#366) (→ coberto por `stage-0-run.ts`; referência/fallback)

Sempre roda, após Verify FB. Busca `_internal/06-social-published.json` da edição mais recente. **#3530:** reusa `find-last-edition-with-fb.ts` (já disk-aware desde #3483/#3484 — `enumerateEditionDirs()` internamente, cobre flat legado e nested) em vez de `readdirSync('data/editions')` cru, que só varre 1 nível e perderia edições no layout nested (`data/editions/{AAMM}/{AAMMDD}/`), tratando a mais recente como inexistente. Mesmo critério de "tem o arquivo" do 0k (o script já filtra por isso, incluindo fallback pra raiz em edições anteriores ao #158 via `existsInEditionDir`) — mesmo comportamento de antes (só `_internal/`), sem reimplementar a lógica de enumeração inline:
```bash
PREV_SOCIAL_DIR=$(npx tsx scripts/find-last-edition-with-fb.ts --current {AAMMDD})
PREV_SOCIAL=""
if [ -n "$PREV_SOCIAL_DIR" ] && [ -f "$PREV_SOCIAL_DIR/_internal/06-social-published.json" ]; then
  PREV_SOCIAL="$PREV_SOCIAL_DIR/_internal/06-social-published.json"
fi
```
**Classificação determinística desde o #5756** — não julgar em prosa (regra #573):
```bash
npx tsx scripts/check-prev-social-status.ts --prev-dir "$PREV_SOCIAL_DIR" --prev-edition "$(basename "$PREV_SOCIAL_DIR")"
```
Sai 0 sempre. Linha `edição anterior ...:` → alertar o editor com ela; `nenhum post social exige atenção` ou arquivo ausente → seguir em silêncio. A regra anterior (`scheduled` + prazo vencido) supunha que todo canal vira `published` — só o Facebook vira —, gerando ~12 falsos alarmes por edição, todo dia. Racional e medição: docstring de `scripts/lib/prev-social-status.ts`. Não bloqueia — alertas são informativos para o editor resolver antes de começar a nova edição.

**Importante (#565):** ao logar esses alertas via `scripts/log-event.ts`, **incluir flag `--informational`** pra evitar que o auto-reporter promova esses warns a issues GitHub falsas. Exemplo:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
  --informational \
  --message "edição anterior {PREV} tem N posts FB com status=failed" \
  --details '{"prev_edition":"{PREV}","failed_count":N}'
```
A flag injeta `informational: true` em `details` — `collect-edition-signals.ts` filtra por essa flag estruturada em vez do tag textual `(informativo)` no message (que era frágil).

### 0o. Entrega por provedor (#7021, reduzido em #7402 — sem fallback, docstring de `stage-0-run.ts`) — só mede entrega/abertura da edição anterior via Kit por provedor (`kit-provider-split.ts`, registro em `data/kit-delivery/history.jsonl`); não propõe mais onda dry-run do aquecimento Gmail — esse passo (`0o.2`) saiu em 04/09/2026 porque a coorte que ele servia esgotou (ver docstring de `scripts/stage-0-run.ts`). Sem proposta, não há mais artefato por edição pro Stage 4 exibir (§4c.8 foi removido pelo mesmo motivo).

### 0z. Pre-flight invariants (#1007 Fase 1) (→ coberto por `stage-0-run.ts`, junto com o fechamento do stage e a captura de custo; referência/fallback)

Última verificação antes de gastar tokens na pesquisa. Valida env vars críticas (Drive credentials, past-editions-raw shape; `BEEHIIV_API_KEY` só quando `read_backend` ainda é `"beehiiv"` — #11225):

```bash
npx tsx scripts/check-invariants.ts --stage 0
```

Exit 1 = abort imediato com violations no stderr. Editor corrige (env, credentials) e re-roda. Esses checks são baratos (<1s) e evitam falhas tardias caras (Stage 4 sem `LINKEDIN_WORKER_URL`, etc — verificado novamente lá).

**Marcar Stage 0 `done` ao fim do preflight (#1783).** Fecha a duração do preflight (auto-carimbo de `end` via #1789; computa `end - start` do `running` lá do init). Sem isso o S0 ficaria eternamente `running` e sem duração no relatório:

```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 0 --status done
```

**Capturar custo/tokens reais (#3441).** Logo em seguida, rodar `capture-stage-usage.ts` — lê `_internal/stage-status.json` (o `--end` que acabou de ser gravado), agrega o `usage` real das chamadas do coordenador dentro da janela `[start, end]` do stage a partir do transcript local da sessão (`~/.claude/projects/`), e popula `cost_usd`/`tokens_in`/`tokens_out`/`models` — nunca fabrica número: sem transcript local (sessão cloud) ou sem entradas na janela, imprime `source: "unavailable"` e não escreve nada:

```bash
npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 0
```

Ler o JSON de stdout: se `"source":"unavailable"`, logar warn (mesmo padrão do sentinel — #5475) e não bloquear:

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
  --message 'stage_usage_capture_unavailable' --details '{"reason":"<reason do stdout>"}'
```

