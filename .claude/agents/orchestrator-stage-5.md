---
name: orchestrator-stage-5
description: Detalhe da Etapa 5 (publicacao auto — draft Beehiiv + social agendado) do orchestrator Diar.ia. ZERO interacao humana. Lido pelo orchestrator principal durante a execucao — nao e um subagente invocavel diretamente.
---

> Este arquivo e referenciado por `orchestrator.md` via `@see`. Nao executar diretamente.

---

## Etapa 5 — Publicacao (auto, ZERO interacao) — #38 / #1694

Stage 5 e **dispatch puro** — sem gate proprio. O gate de revisao editorial esta no Stage 4; o gate de agendamento esta no Stage 6 (Agendamento).

Tres acoes em paralelo: (1) criar rascunho Beehiiv + enviar test email + rodar loop review; (2) LinkedIn agendado; (3) **Facebook AGENDADO** (`--schedule`).

**PARA antes do Schedule do Beehiiv** — a newsletter fica como RASCUNHO com test email enviado e o loop review concluido. O clique de "Schedule" NAO acontece no Stage 5 — e responsabilidade do Stage 6.

Output: `05-published.json` (newsletter draft_url + test_email_sent_at + review status) + `06-social-published.json` (social dispatched). Sentinel `.step-5-done.json`.

LinkedIn nao usa Chrome — Cloudflare Worker enfileira em KV e dispara Make webhook no horario agendado (#971).

**`{EDITION_DIR}` (#2463/#3025):** diretorio REAL da edicao no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edicao foi criada. Resolver **uma vez**, logo apos ter `{AAMMDD}`, e usar em todo path abaixo — nunca montar `data/editions/` + `{AAMMDD}` a mao:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

### Pre-condicao: sentinel Stage 4

<!-- outputs must match the `write` call at the end of orchestrator-stage-4.md §Escrever sentinel de conclusao do Stage 4 -->
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 4 \
  --outputs "02-reviewed.md,03-social.md"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 4 (Revisao) nao completou (sentinel ausente). Re-rodar `/diaria-4-revisao {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "Outputs do Stage 4 ausentes. Re-rodar Etapa 4." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level warn --message "stage4_sentinel_missing_legacy"`), continuar.

### 5a. Pre-requisitos + sync

**Marcar Stage 5 `running` no inicio (#1783).** Garante o `start` pra que o `done` do §5h feche a duracao no relatorio. Sem `--start` — auto-carimbo (#1789) preserva o original em resume:
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 5 --status running
```

**⚠️ MCP fail-fast (#738):** Durante qualquer passo desta etapa, se um `<system-reminder>` do runtime indicar que claude-in-chrome, beehiiv ou gmail MCP ficou offline, **parar imediatamente**, logar via:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator \
  --level warn --message "mcp_disconnect: {server_name}" \
  --details '{"server":"{server_name}","kind":"mcp_disconnect"}'
```
E renderizar halt banner pra alertar o editor (#737):
```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "5 — Publicacao" \
  --reason "mcp__{server_name} desconectado (verifique extensao Chrome + login)" \
  --action "responda 'retry' para continuar ou 'abort' para encerrar Etapa 5"
```
Ao reconectar (MCP voltar a responder), logar:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator \
  --level info --message "mcp_reconnect: {server_name}" \
  --details '{"server":"{server_name}","kind":"mcp_reconnect"}'
```
Nunca aguardar passivamente. Este stage depende de claude-in-chrome (newsletter), beehiiv (API) e gmail (review-test-email). Disconnect de qualquer um exige acao explicita do editor. Os logs persistem em `data/run-log.jsonl` para auditoria pelo `collect-edition-signals.ts` (#759).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

- Logar inicio:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level info --message 'etapa 5 publicacao started'
  ```
- **Sync pull antes de comecar** (todos os arquivos consumidos por newsletter + social):
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir {EDITION_DIR}/ --stage 5 --files 02-reviewed.md,01-eia-A.jpg,01-eia-B.jpg,03-social.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg
  ```
  Editor pode ter refinado texto/imagens ou ajustado posts no Drive. (Edicoes antigas pre-#192 usam `01-eia-real.jpg`/`01-eia-ia.jpg`.)
- **Staleness check (#120) — APOS o pull:**
  ```bash
  npx tsx scripts/check-staleness.ts --edition-dir {EDITION_DIR}/ --stage 6
  ```
  (mantem `--stage 6` por compat com o config existente — o check valida downstreams do Stage 3/4 vs `02-reviewed.md`). Exit code 0 = ok. Exit code 1 = pausar com a mensagem de re-run de Stage 3/4.
- Verificar pre-requisitos: `02-reviewed.md`, `01-eia.md`, `01-eia-A.jpg` + `01-eia-B.jpg` (ou legacy `01-eia-real.jpg` + `01-eia-ia.jpg` em edicoes pre-#192), `03-social.md`, `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`. Se algum faltar, pausar e instruir qual stage re-rodar.
- **Pre-dispatch invariants (#1007 Fase 1).** Validar que `06-public-images.json` esta populado e env vars criticas (`DIARIA_LINKEDIN_CRON_URL`, `DIARIA_LINKEDIN_CRON_TOKEN`, `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN`) estao setadas. `INSTAGRAM_BUSINESS_ACCOUNT_ID` + `INSTAGRAM_ACCESS_TOKEN` sao checadas como **warning** (#49 — ausencia pula Instagram, nao bloqueia os demais canais). Falha (error) = abort imediato — evita DLQ recurrence (incident 260508 #999):
  ```bash
  npx tsx scripts/check-invariants.ts --stage 5 --edition-dir {EDITION_DIR}/
  ```
  Exit 1 = pausar com violations no stderr. Editor corrige (rodar `upload-images-public.ts` se imagens faltam, configurar env vars) e re-roda.

### 5a-poll-preflight. Gate de poll ANTES do envio — SEMPRE (#1803)

**Roda em TODO entry path, antes de qualquer pre-render/dispatch.** Resolve o P1 #1803: num resume direto pro Stage 5, o passo de poll do Stage 0 (§0d.bis `maintain-valid-editions`) nao roda e o "E IA?" quebra ao vivo (410) pra todos os subscribers — silenciosamente. Como esta no inicio do Stage 5, **um resume sempre o atravessa**. O script faz FIX idempotente (maintain, warn-only) → VERIFY (smoke-test, **gate duro**), bloqueando o envio antes da newsletter sair — nao depois. **#1186:** `inject-poll-sig` foi removido — modo merge-tag, sem sig HMAC.

```bash
npx tsx scripts/preflight-poll-dispatch.ts --edition {AAMMDD}
```

Exit code handling:
- `0` → poll pronto. Prosseguir pro dispatch.
- `1` → **FATAL:** o proprio script ja renderizou o halt banner (motivo + acao). **NAO enviar a newsletter.** Editor corrige (tipicamente `add-valid-edition.ts --edition {AAMMDD}`) e re-roda Etapa 5.

### 5b. Confirmar modo de publicacao por canal (#336 — invertido em #1326)

**INVARIANTE (#1326): Default = tudo automatico.** Stage 5 e dispatch puro — sem gate interativo (o gate de revisao ja ocorreu no Stage 4 e o gate de agendamento ocorre no Stage 6).

Casos:
- `auto_approve = true` (skill chamada com `--no-gates`) → tudo auto, registrar consent.
- Skill chamada com `--skip {canal[,canal...]}` → canais listados ficam manual, resto auto.
- Modo interativo → usar default auto (sem gate interativo no Stage 5).

**Auto-approve path (`auto_approve = true`):**

```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --auto-approve
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level warn \
  --message "Etapa 5 auto-approved via --no-gates: canais dispatchados sem confirmacao por canal" \
  --details '{"channels":["newsletter","linkedin","facebook","instagram","threads"]}'
```

**Skip flag path (`--skip newsletter,facebook`, etc):**

```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --skip "{lista-de-canais}"
```

**Default auto (sem flags, modo interativo):** Stage 5 e dispatch puro — sem gate.

```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --default-auto
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level info \
  --message "Stage 5 dispatch auto (sem gate — Stage 4 revisao aprovado)" \
  --details '{"source":"default_auto","channels":["newsletter","linkedin","facebook","instagram","threads"]}'
```

**#1238 trade-off atualizado em #1380**: O user-activation guard do Beehiiv **so atinge o click de Schedule** — nao o "Send test email". Validado em 260519 (4x test emails enviados consecutivamente via Chrome MCP). O trigger correto pra Send test email e o **chevron dropdown** ao lado do botao Preview:

1. Achar popover `.hidden.absolute` que contem o button "Send test email"
2. Achar sibling `.relative.z-0` com 2 buttons (`Preview` + chevron sem texto)
3. Clicar o chevron — popover abre
4. Clicar "Send test email" — toast `Test email sent` aparece

**Schedule continua sendo do Stage 6** (gate humano + automacao).

### 5c-pre. Upload de imagens publicas (#999 fix — pre-requisito do dispatch)

**ANTES** do dispatch paralelo, se LinkedIn ou Facebook automatico foram autorizados em 5b, rodar upload-images-public.ts pra popular o cache `06-public-images.json` com URLs Cloudflare KV (d1/d2/d3 vao pro KV desde #2147):

```bash
npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode social
```

**Fail-loud:** se exit != 0, **halt** Stage 5 com banner:
```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "5 — Publicacao" \
  --reason "upload-images-public.ts falhou: upload de d1/d2/d3 pro Cloudflare KV nao completou" \
  --action "verifique CLOUDFLARE_API_TOKEN + platform.config.json poll.kv_namespace_id + tente novamente, ou pule LinkedIn/FB automatico em 5b"
```

Skip apenas se editor selecionou "manual" em **ambos** LinkedIn e Facebook em 5b.

### 5c. Dispatch newsletter — primeiro, antes do social (#2454)

**So dispatchar se o canal foi autorizado em 5b.** Canal manual fica com `status: pending_manual`.

**ORDEM OBRIGATORIA (#2454): newsletter ANTES do social.** O social usa `{edition_url}` no comment_diaria — essa URL so pode ser derivada do slug do draft depois que o draft Beehiiv for criado. Disparo em paralelo causava fallback silencioso pra `https://diar.ia.br` (raiz) quando `05-edition-url.txt` ainda nao existia. A partir de #2454, o fluxo e sequencial: draft Beehiiv → resolve URL → dispatch social.

**Passo 5c-1: Newsletter Beehiiv.**

**Newsletter Beehiiv (#1054 / #207 / #1114 / #1327)**: voce (top-level) **le `context/publishers/beehiiv-playbook.md` como playbook e executa direto** — Bash + Read + `mcp__claude-in-chrome__*` (incluindo `javascript_tool`). Seguir o playbook **criando o rascunho e enviando o test email** — **NAO executar o passo de Schedule do Beehiiv** (§9-10 do playbook). O draft fica como rascunho com test email enviado. **Nao tente dispatchar via `Agent`** — `javascript_tool` e restrito ao top-level. **⚠️ DEGRADADO desde 260623 (#2495) — o fetch da Fase 3 (in-page, de `app.beehiiv.com` pro Worker) está bloqueado por CSP `connect-src` (o upload da Fase 2 ainda funciona). O auto-fallback NÃO dispara (o fetch pendura com exit 0), então selecione o caminho chunked base64 (apêndice do playbook) manualmente enquanto o bloqueio persistir (#2500). Editor finaliza metadata na UI. Ver `context/publishers/beehiiv-playbook.md` para instruções detalhadas.** Output: `_internal/05-published.json`.

Playbook ja grava `_internal/05-edition-url.txt` (ver §"Gravar 05-edition-url.txt" no beehiiv-playbook.md). Se por qualquer razao o playbook nao gravou, gravar manualmente:

```bash
npx tsx scripts/resolve-edition-url.ts \
  --edition-dir {EDITION_DIR}/ \
  --title "{titulo_d1}"
# Usa seoSlug(titulo) — mesmo algoritmo de 4a-bis do beehiiv-playbook (§"Setar slug SEO").
# Se o titulo nao estiver disponivel, usar --slug {slug_correto} ou --edition-url {url_literal}.
```

**Tab isolation no Chrome**: publish-newsletter e o unico agent Chrome em Etapa 5 — abre tab Beehiiv propria via `tabs_create_mcp`. LinkedIn e Facebook sao scripts shell sem browser.

**Passo 5c-2: Guard anti-placeholder (#2454).**

**SO APOS o draft Beehiiv retornar** (passo 5c-1 completo), verificar que `05-edition-url.txt` existe. Se o arquivo foi gravado pelo playbook (§6.1 do beehiiv-playbook.md), apenas rodar o guard de validacao — sem re-escrever o arquivo:

```bash
# Se ausente — gravar agora (ver passo 5c-1 acima):
if [ ! -f {EDITION_DIR}/_internal/05-edition-url.txt ]; then
  npx tsx scripts/resolve-edition-url.ts --edition-dir {EDITION_DIR}/ --title "{titulo_d1}"
fi

# Guard anti-placeholder: aborta (exit 3) se {edition_url}
# sobreviveu em 03-social.md. Nao dispatchar social se exit != 0.
# Nota: {outros_count} e DEFERRED (resolvido por publish-linkedin no dispatch) — nao rejeitado aqui.
EDITION_URL="$(cat {EDITION_DIR}/_internal/05-edition-url.txt)"
npx tsx scripts/resolve-edition-url.ts --edition-dir {EDITION_DIR}/ --edition-url "${EDITION_URL}" --validate-social
```

Exit code do guard:
- `0` → {edition_url} resolvido, prosseguir pro dispatch do social.
- `3` → **FATAL: {edition_url} nao-resolvido em 03-social.md.** NAO dispatchar o social. Logar erro e parar com instrucao ao editor: o social seria publicado com `{edition_url}` literal — o dispatch precisa ser corrigido primeiro.

**Passo 5c-3: Dispatch social — APOS a URL estar resolvida.**

**Em uma unica mensagem, disparar simultaneamente** (so apos passo 5c-2 retornar exit 0):

1. `Bash("npx tsx scripts/publish-facebook.ts --edition-dir {EDITION_DIR}/ --schedule")` — passa `--schedule` para **agendar** (NAO imediato). Usa mesmos horarios do LinkedIn via `compute-social-schedule.ts`.
2. `Bash("npx tsx scripts/publish-linkedin.ts --edition-dir {EDITION_DIR}/ --schedule")` — Worker queue + Make webhook x 3. Le `_internal/05-edition-url.txt` para substituir `{edition_url}` (ja existe do passo 5c-1).
3. `Bash("npx tsx scripts/publish-instagram.ts --edition-dir {EDITION_DIR}/")` — publica imediato no Instagram via Graph API (2 passos: container → media_publish). **Requer `INSTAGRAM_ACCESS_TOKEN` + `INSTAGRAM_BUSINESS_ACCOUNT_ID` no env** e `_internal/06-public-images.json` populado (gerado no 5c-pre). Se as env vars nao estiverem setadas, o script **encerra com exit 0** (skip gracioso, nao exit 1) — nao bloqueia os outros canais nem mascara violations de consent de LinkedIn/Facebook (#2486).
4. `Bash("npx tsx scripts/publish-threads.ts --edition-dir {EDITION_DIR}/")` — publica imediato no Threads via Threads API oficial da Meta (2 passos: container → threads_publish). **Requer `THREADS_ACCESS_TOKEN` + `THREADS_USER_ID` no env.** Textos >500 chars sao automaticamente encadeados (thread). Se as env vars nao estiverem setadas, o script **encerra com exit 0** (skip gracioso, nao exit 1) — nao bloqueia os outros canais (#2479).

Aguardar todos retornarem antes de prosseguir.

**LinkedIn route — Worker queue + fallback Make (#887):** `publish-linkedin.ts` prefere o Cloudflare Worker `diaria-linkedin-cron` quando `cloudflare_worker_url` + `DIARIA_LINKEDIN_CRON_TOKEN` estao configurados E `scheduled_at` e futuro. Se o Worker falhar todos os retries (503, KV down, deploy quebrado), o script cai automaticamente em `postToMakeWebhook` — Make posta **imediatamente** (ignora `scheduled_at`). Entry resultante traz `status: "draft"` (post live, sem agendamento futuro) + `fallback_used: true` + `fallback_reason` para auditoria.

`publish-linkedin.ts` grava direto em `06-social-published.json` via store atomica (#918).

### 5d. Retry chrome_disconnected (so playbook newsletter)

Apenas o playbook newsletter usa Chrome em Etapa 5. **Antes de passos com clique real, rodar o preflight de visibilidade da aba (#2015 — ver "Preflight de visibilidade" no beehiiv-playbook.md).**

Se uma chamada `mcp__claude-in-chrome__*` retornar `chrome_disconnected`:
1. Calcular delay: `30 * 2^(N-1)` segundos (tentativa 1 = 30s, 2 = 60s, ..., 10 = 15360s).
2. Logar warn: `"chrome_disconnected em Etapa 5 (playbook newsletter), tentativa {N}/10 — aguardando {delay}s"`.
3. Aguardar: `Bash("sleep {delay}")`.
4. Re-executar o playbook newsletter do passo onde quebrou.
5. **Apos 10 falhas consecutivas** (~17h acumuladas), logar erro e pausar com instrucao ao editor.
- **Reset do contador**: re-execucao que sucede reseta N=1.

### 5e. Validar template (publish-newsletter)

- Ler `05-published.json`. Extrair `draft_url`, `title`, `test_email_sent_to`, `template_used`.
- **Validar template (obrigatorio).** Ler `publishing.newsletter.template` de `platform.config.json`. Se `template_used` !== template esperado:
  1. Logar erro + instruir a **deletar o rascunho incorreto** no Beehiiv.
  2. Re-disparar publish-newsletter (ate 3 tentativas).
  3. Se o template continuar errado apos 3 tentativas, pausar com instrucao ao editor.
  4. **Nao prosseguir para o loop de review** enquanto o template nao estiver correto.

### 5f. Loop de review do email de teste (apos newsletter retornar)

> NOTA: este loop **nao bloqueia social** — `publish-facebook.ts` e `publish-linkedin.ts` ja completaram em 5c. O loop so toca o draft do Beehiiv (newsletter).

- **Loop de verificacao e correcao (OBRIGATORIO — ate 10 iteracoes):**
  > **REGRA CRITICA:** Este loop NUNCA deve ser pulado. A Etapa 5 so esta completa quando `review_completed: true` estiver gravado em `05-published.json`.

  ```typescript
  // #2047 / #2061: declarar UMA vez ANTES do loop — evita re-fetch do mesmo URL
  const linkCheckCache = new Map<string, boolean>();
  ```

  Para `attempt` de 1 a 10:

  1. **Verificar email de teste.** Disparar `review-test-email` passando `test_email`, `edition_title`, `edition_dir`, `attempt`.
  2. Se retornar `error: "chrome_disconnected"`, aplicar o mesmo backoff exponencial descrito acima.
  3. **Se retornar `status: "inconclusive"` (#1212 — fail-closed)**: logar warn e **sair do loop**. Gravar `review_status: "inconclusive"`. NAO marcar `review_completed: true`.
  4. Se `issues` estiver vazio E `status: "ok"`: **sair do loop**.
  4.5. **Filtrar falso-positivos (#1421, #2013, #2047)**:
     ```typescript
     import { filterAgentIssues } from "scripts/lib/agent-issue-validator.ts";
     const htmlLocal = readFileSync(`{edition_dir}/_internal/newsletter-final.html`, "utf8");
     const { kept, dropped } = await filterAgentIssues(issues, htmlLocal, edition_date, fetch, linkCheckCache);
     for (const d of dropped) logar info `"dropped FP: ${d.issue} — ${d.reason}"`;
     ```
     Se `kept.length === 0` E `dropped.length > 0`: todos eram FPs — **sair do loop** sem fix-mode.
  5. Se `kept` nao estiver vazio:
     - Logar: `"review-test-email encontrou {N} problemas na tentativa {attempt}/10"`.
     - Disparar `publish-newsletter` em **modo fix** com `edition_dir`, `mode: "fix"`, `draft_url`, `issues: kept`.
     - Se `unfixable_issues[]` nao vazio, logar warn e sair do loop.

  Apos 10 iteracoes sem sucesso, logar warn: `"Loop atingiu 10 tentativas sem resolver todos os issues"`.

- **Gravar resultado da revisao em `05-published.json` (obrigatorio).** Campos: `review_completed`, `review_status`, `review_attempts`, `review_final_issues`.
  O resumo para o Stage 6 deve incluir AMBOS `review_final_issues` e `unfixed_issues` (#1212): se `review_final_issues` nao vazio OU `unfixed_issues` nao vazio, listar ambos no bloco de status passado para o gate do Stage 6.

### 5f-bis. Verify dispatch — confirma destinos reais (#917)

**Roda APENAS se houve dispatch de social.**

```bash
npx tsx scripts/verify-stage-4-dispatch.ts --edition-dir {EDITION_DIR}/
```

O script verifica Facebook via Graph API e LinkedIn via Worker KV. Persiste relatorio em `_internal/06-verify-dispatch.json`.

Exit codes:
- `0` → tudo verificado, prosseguir normal.
- `1` → ao menos 1 post nao confirmado. Logar warn e PROSSEGUIR pro Stage 6 com o relatorio registrado.
- `2` → erro de input. Logar warn, prosseguir sem o bloco.

### 5f-ter. Render social preview HTML (#1545)

```bash
npx tsx scripts/render-social-html.ts \
  --md {EDITION_DIR}/03-social.md \
  --out {EDITION_DIR}/_internal/social-preview.html \
  --images {EDITION_DIR}/06-public-images.json
```

Publicar via `Artifact` (#3214 — mesmo mecanismo do Stage 4 §4b step 3, chamado aqui de novo pra refletir qualquer resolucao de URL que so existe pos-dispatch, ex: `{edition_url}`). Resume-aware: ler URL ja persistida em `05-social-preview.json` e passar via `url` do tool pra atualizar o MESMO artifact em vez de mintar um novo:

```bash
node -e "
  const fs = require('fs');
  const p = '{EDITION_DIR}/_internal/05-social-preview.json';
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.social_preview_url) console.log(j.social_preview_url);
  }
"
```

`Artifact` com `file_path: "{EDITION_DIR}/_internal/social-preview.html"` + `url` (se a leitura acima imprimiu algo) + `description`/`favicon` iguais aos usados no Stage 4. Persistir a URL retornada:

```bash
npx tsx -e "
  import { persistFieldToJsonFile } from './scripts/upload-html-public.ts';
  persistFieldToJsonFile('{EDITION_DIR}/_internal/05-social-preview.json', 'social_preview_url', '{social_url}');
"
```

Falha nao bloqueia — logar warn e prosseguir.

### 5g. Fechar poll E IA? (#465, #1044, #1367)

Apos dispatch completo (newsletter + social), registrar a resposta correta no Worker de votacao:

```bash
if ! npx tsx scripts/close-poll.ts --edition {AAMMDD}; then
  npx tsx scripts/render-halt-banner.ts --stage "5 — Publicacao" \
    --reason "close-poll falhou (ADMIN_SECRET ausente, network, ou Worker rejeitou)" \
    --action "rode `npx tsx scripts/close-poll.ts --edition {AAMMDD}` manualmente ate exit 0, depois retome Stage 5h (sentinel)"
  exit 1
fi
```

O script `close-poll.ts` faz **sanity check automatico** apos o POST /admin/correct:
- GET /stats?edition={AAMMDD}
- Confirma `correct_answer` retornado == answer registrado
- Grava marker `_internal/.close-poll-done.json`

### 5g-bis. Smoke test do voto — belt-and-suspenders (#1366, #1803)

> O gate autoritativo de poll e o **§5a-poll-preflight**. Este passo pos-close-poll e redundante no caminho feliz.

```bash
npx tsx scripts/smoke-test-vote.ts --edition {AAMMDD}  # exit 2 (410/403) ou 3 (net) = halt obrigatorio
```

### 5h. Escrever sentinel de conclusao (#978)

**Sempre** ao fim do Stage 5 — mesmo se publicacao foi manual ou algum canal ficou `pending_manual`:

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 5 \
  --outputs "_internal/05-published.json"
```

**Marcar Stage 5 `done` AQUI (#1783).** Este e o mark-done canônico do Stage 5 é o §5i — acontece **antes** do Stage 6. Auto-carimbo de `end` via #1789:

```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 5 --status done
```

- Sentinel ausente faz Stage 0 da proxima edicao re-investigar publicacao via Beehiiv API.
- Falha do sentinel → logar warn. Nao bloquear.

### 5i. Pos-publicacao invariants (#1007 Fase 1)

Antes de prosseguir pro Stage 6, validar que (a) sentinel `_internal/.step-5-done.json` foi escrito, (b) `_internal/06-social-published.json` tem `posts[]` nao-vazio sem entries `failed`:

```bash
npx tsx scripts/check-invariants.ts --stage 5 --edition-dir {EDITION_DIR}/
```

Exit 1 = logar warn (nao bloquear Stage 6).

---

## Resumo apos Stage 5 (pre-Stage 6)

Apresentar resumo para o editor saber que dispatch completou e Stage 6 esta pendente:

```
Publicacao dispatchada — edicao {AAMMDD}
  Newsletter: rascunho criado + test email enviado — review {status}
  LinkedIn: agendado x 3
  Facebook: agendado x 3
  Instagram: publicado x 3 (ou "env vars ausentes — pular" se nao configurado)

Proximo passo → /diaria-6-agendamento {AAMMDD}
(agendamento Beehiiv + auto-reporter)
```

Se alguma parte foi pulada (ex: `CHROME_MCP = false`), incluir bloco de retomada explicito:

```
Retomada manual pendente

Etapa 5 (newsletter no Beehiiv): pulado (claude-in-chrome MCP indisponivel)
LinkedIn x 3: agendado normal via Worker ✓
Facebook x 3: agendado normal via Graph API ✓
Instagram x 3: publicado normal via Graph API ✓

Quando o MCP estiver ativo, rodar:
  /diaria-5-publicacao newsletter {AAMMDD}   # cria rascunho Beehiiv + email teste
```

Se nenhum stage foi pulado, omitir esse bloco — so listar outputs e status do dispatch.
