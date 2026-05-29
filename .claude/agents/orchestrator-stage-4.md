---
name: orchestrator-stage-4
description: Detalhe da Etapa 4 (publicação paralela — newsletter + social) e do auto-reporter do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 4 — Publicação (paralelo: newsletter + social) — #38

`publish-newsletter` (Beehiiv), `publish-facebook.ts` (Graph API) e `publish-linkedin.ts` (Worker queue + Make.com webhook) rodam **em paralelo na mesma mensagem**, com **gate único** depois. O auto-reporter fecha o loop de observabilidade.

LinkedIn não usa Chrome — Cloudflare Worker enfileira em KV e dispara Make webhook no horário agendado (#971).

Manteve-se modo draft pra Beehiiv — `mode: "scheduled"` + scheduled_at sincronizado fica pra PR 2 (#38).

### Modos de execução (#1523 / #1571)

A skill que invoca este playbook define `pre_gate` no contexto (lido do SKILL.md). Dois fluxos:

- **`pre_gate = true` (default em `/diaria-edicao`):** o gate ao editor acontece **ANTES** do dispatch. Após 4a (pré-reqs + sync pull + invariants), executar **4a-pre-gate** descrito abaixo (pre-render newsletter HTML + social preview + upload pro draft worker → apresentar URLs → editor aprova). **Pós-aprovação**, prosseguir pra 4c (dispatch newsletter) → 4f (review test email) → 4g-bis (dispatch social) em paralelo. **PULAR 4g** (gate pós-dispatch) — a aprovação editorial já aconteceu no pre-gate.

- **`pre_gate = false` ou ausente (`/diaria-4-publicar` legacy interativo):** fluxo histórico — 4c dispatch newsletter → 4f review loop → 4f-bis verify → 4f-ter render social preview → **4g gate pós-dispatch** → 4g-bis social → fim.

A skill `/diaria-4-publicar` está em transição pra pre-gate (#1571 followup). Por enquanto, ela default-falha pra `pre_gate = false` a menos que `--pre-gate` seja passado explicitamente.

### 4a-pre-gate. Pré-render + apresentar preview ao editor (#1523 / #1571)

**Executar SOMENTE quando `pre_gate = true`.** Faz tudo que o dispatch precisa exceto enviar pros canais finais:

1. Roda upload-images-public newsletter mode (cobre 4c-pre):
   ```bash
   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/{AAMMDD}/ --mode newsletter
   ```
2. Pre-render do newsletter HTML — seguir steps 1-5 do `context/publishers/beehiiv-playbook.md` (extract-destaques + render-newsletter-html + substitute-image-urls + upload-html-public) **sem** o Chrome MCP / Beehiiv interaction. Output: `_internal/newsletter-final.html` + URL no draft worker (`https://draft.diaria.workers.dev/{AAMMDD}-{hash}`).
3. Pre-render do social — `npx tsx scripts/render-social-html.ts --md data/editions/{AAMMDD}/03-social.md --out _internal/social-preview.html` + `upload-html-public.ts --key {AAMMDD}-social` pra subir pro draft worker.
4. close-poll idempotente (set gabarito):
   ```bash
   npx tsx scripts/close-poll.ts --edition {AAMMDD} --idempotent
   ```
5. **PRE-GATE HUMANO:** apresentar bloco:
   ```
   📄 Newsletter HTML: https://draft.diaria.workers.dev/{AAMMDD}-{hash}
   📱 Social preview:  https://draft.diaria.workers.dev/{AAMMDD}-social-{hash}
   📁 Arquivos locais: 02-reviewed.md, 03-social.md
   📎 Imagens:        cover D1 (Cloudflare KV) + EIA A/B + d1/d2/d3 1x1 social
   
   Aprovar dispatch em todos os 3 canais? (sim / editar / abortar)
     - "sim" → prossegue pra 4c dispatch newsletter + 4g-bis social em paralelo
     - "editar" → halt; editor edita arquivos no Drive → pull → re-roda /diaria-4-publicar
     - "abortar" → encerra stage 4 sem publicar (sentinel não é escrito)
   ```
6. Logar resposta:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info \
     --message "pre_gate response: {sim|editar|abortar}"
   ```

**Pós-aprovação ("sim"):** consumir o consent automático em 4b (auto-approve path), saltar 4c-pre (já rodou step 1 acima) e ir pra 4c. PULAR 4g (gate pós-dispatch já é redundante).

**"editar":** rodar `update-stage-status --stage 4 --status pending` + halt banner. NÃO escrever sentinel. Editor edita e re-roda.

**"abortar":** logar warn, encerrar sem sentinel.

### Pré-condição: sentinel Stage 3

<!-- outputs must match the `write` call at the end of orchestrator-stage-3.md §Escrever sentinel de conclusão do Stage 3 -->
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 3 \
  --outputs "01-eia.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 3 não completou (sentinel ausente). Re-rodar `/diaria-3-imagens {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "Outputs do Stage 3 ausentes. Re-rodar Etapa 3." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level warn --message "stage3_sentinel_missing_legacy"`), continuar.

### 4a. Pré-requisitos + sync

**⚠️ MCP fail-fast (#738):** Durante qualquer passo desta etapa, se um `<system-reminder>` do runtime indicar que claude-in-chrome, beehiiv ou gmail MCP ficou offline, **parar imediatamente**, logar via:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator \
  --level warn --message "mcp_disconnect: {server_name}" \
  --details '{"server":"{server_name}","kind":"mcp_disconnect"}'
```
E renderizar halt banner pra alertar o editor (#737):
```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "4 — Publicação" \
  --reason "mcp__{server_name} desconectado (verifique extensão Chrome + login)" \
  --action "responda 'retry' para continuar ou 'abort' para encerrar Etapa 4"
```
Ao reconectar (MCP voltar a responder), logar:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator \
  --level info --message "mcp_reconnect: {server_name}" \
  --details '{"server":"{server_name}","kind":"mcp_reconnect"}'
```
Nunca aguardar passivamente. Este stage depende de claude-in-chrome (newsletter, social), beehiiv (API) e gmail (review-test-email). Disconnect de qualquer um exige ação explícita do editor — não tente "contornar" em silêncio. Os logs persistem em `data/run-log.jsonl` para auditoria pelo `collect-edition-signals.ts` (#759).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

- Logar início:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info --message 'etapa 4 publish parallel started'
  ```
- **Sync pull antes de começar** (todos os arquivos consumidos por newsletter + social):
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 4 --files 02-reviewed.md,01-eia-A.jpg,01-eia-B.jpg,03-social.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg
  ```
  Editor pode ter refinado texto/imagens ou ajustado posts no Drive. (Edições antigas pré-#192 usam `01-eia-real.jpg`/`01-eia-ia.jpg`.)
- **Staleness check (#120) — APÓS o pull:**
  ```bash
  npx tsx scripts/check-staleness.ts --edition-dir data/editions/{AAMMDD}/ --stage 6
  ```
  (mantém `--stage 6` por compat com o config existente — o check valida downstreams do Stage 3/4 vs `02-reviewed.md`). Exit code 0 = ok. Exit code 1 = pausar com a mensagem de re-run de Stage 3/4.
- Verificar pré-requisitos: `02-reviewed.md`, `01-eia.md`, `01-eia-A.jpg` + `01-eia-B.jpg` (ou legacy `01-eia-real.jpg` + `01-eia-ia.jpg` em edições pré-#192), `03-social.md`, `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`. Se algum faltar, pausar e instruir qual stage re-rodar.
- **Pre-dispatch invariants (#1007 Fase 1).** Validar que `06-public-images.json` está populado e env vars críticas (`DIARIA_LINKEDIN_CRON_URL`, `DIARIA_LINKEDIN_CRON_TOKEN`, `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN`) estão setadas. Falha = abort imediato — evita DLQ recurrence (incident 260508 #999):
  ```bash
  npx tsx scripts/check-invariants.ts --stage 4 --edition-dir data/editions/{AAMMDD}/
  ```
  Exit 1 = pausar com violations no stderr. Editor corrige (rodar `upload-images-public.ts` se imagens faltam, configurar env vars) e re-roda.

### 4a-bis. ~~Injetar URLs do poll É IA? por subscriber~~ — removido (#1175, script deletado #1185)

**Removido em #1175** (2026-05-12), script `inject-poll-urls.ts` deletado em #1185 junto com os custom fields órfãos `poll_a_url`/`poll_b_url`. O HTML render usa `{{poll_sig}}` + `{{email}}` desde #1083.

O patch correto roda em Stage 0 §0d.ter (`inject-poll-sig.ts --since-hours 96`), que filtra pra novos subscribers nas últimas 96h. `poll_sig` é HMAC permanente do email — 1× por subscriber, vitalício.

### 4b. Confirmar modo de publicação por canal (#336 — invertido em #1326)

**INVARIANTE (#1326): Default = tudo automático.** Stage 4 é dispatch, editor já revisou nos gates 1-3. Editor pode opt-out por canal via flag `--skip` no comando ou respondendo no gate interativo.

Casos:
- `auto_approve = true` (skill chamada com `--no-gates`) → tudo auto, sem perguntar.
- Skill chamada com `--skip {canal[,canal...]}` → canais listados ficam manual, resto auto.
- Sem flags, modo interativo → mostrar gate abaixo. **Default se editor não responder = tudo auto.**

**Auto-approve path (`auto_approve = true`):**

```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --auto-approve
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level warn \
  --message "Etapa 4 auto-approved via --no-gates: 3 canais dispatchados sem confirmacao por canal" \
  --details '{"channels":["newsletter","linkedin","facebook"]}'
```

Prosseguir direto pra 4c-pre. NÃO perguntar.

**Skip flag path (`--skip newsletter,facebook`, etc):**

```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --skip "{lista-de-canais}"
```

Parser aceita `newsletter`, `linkedin`, `facebook` (case-insensitive). Canais não-listados ficam auto.

**Gate path interativo (sem `auto_approve` e sem `--skip`):**

Antes do dispatch, perguntar ao editor:

```
Modo de publicação para a edição {AAMMDD} (default = tudo automático):

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

Aguardar resposta antes de prosseguir. Registrar a escolha em `_internal/05-publish-consent.json`. Se editor não responder no turno (linha em branco ou desistir do gate), invocar:
```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --default-auto
```
Se editor responder "none", gravar `05-published.json` com `status: "skipped_by_editor"` e encerrar Etapa 4.

**#1238 trade-off atualizado em #1380**: O user-activation guard do Beehiiv **só atinge o click de Schedule** — não o "Send test email". Validado em 260519 (4× test emails enviados consecutivamente via Chrome MCP). O trigger correto pra Send test email é o **chevron dropdown** ao lado do botão Preview:

1. Achar popover `.hidden.absolute` que contém o button "Send test email"
2. Achar sibling `.relative.z-0` com 2 buttons (`Preview` + chevron sem texto)
3. Clicar o chevron — popover abre
4. Clicar "Send test email" — toast `Test email sent` aparece

**Schedule continua sendo manual** (5 mecanismos testados em #1198 — todos rejeitados pelo guard). Quando auto_approve mode rodar até aqui, halt banner pós-gate 4g listará "click Schedule no draft_url" como passo final manual.

Se em runs futuros o click programático de Send test email falhar de novo (Beehiiv pode mudar guard), capturar via API timestamp check (`mcp__claude_ai_Beehiiv__get_post` retorna `last_test_email_sent_at`) e gravar `05-published.json` com `review_completed: false`, `review_status: "pending_manual_send"`. Pipeline ainda automatiza ~95% (draft created, HTML pasted, title/subject set, test email sent, social agendado) — só o Schedule click escapa.

### 4c-pre. Upload de imagens públicas (#999 fix — pré-requisito do dispatch)

**ANTES** do dispatch paralelo, se LinkedIn ou Facebook automático foram autorizados em 4b, rodar upload-images-public.ts pra popular o cache `06-public-images.json` com URLs Drive públicas:

```bash
npx tsx scripts/upload-images-public.ts --edition-dir data/editions/{AAMMDD}/ --mode social
```

Imagens publicadas viram payload `image_url` no webhook Make.com (LinkedIn) e attachment do Facebook Graph API. Sem isso, Make rejeita com `BundleValidationError: Missing value of required parameter 'url'` (caso real edição 260508 — image_url=null causou 5 retries → DLQ).

**Fail-loud:** se exit != 0, **halt** Stage 4 com banner:
```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "4 — Publicação" \
  --reason "upload-images-public.ts falhou: imagens não estão no Drive como pública" \
  --action "verifique credenciais Google + tente novamente, ou pule LinkedIn/FB automático em 4b"
```

Skip apenas se editor selecionou "manual" em **ambos** LinkedIn e Facebook em 4b (sem dispatch automático = sem necessidade de URLs públicas).

### 4c. Dispatch newsletter (primeiro, sozinha)

**#1501 — social dispatch é TARDIO.** Newsletter dispatcha primeiro (sozinha). Social dispatcha DEPOIS do gate 4g, quando o editor já revisou tudo e o `03-social.md` está final. Isso elimina posts com texto não-revisado e posts órfãos.

**Só dispatchar newsletter se o editor autorizou em 4b.** Canal manual fica com `status: pending_manual`.

**Newsletter Beehiiv (#1054 / #207 / #1114 / #1327)**: você (top-level) **lê `context/publishers/beehiiv-playbook.md` como playbook e executa direto** — Bash + Read + `mcp__claude-in-chrome__*` (incluindo `javascript_tool`). **Não tente dispatchar via `Agent`** — `javascript_tool` é restrito ao top-level e o paste-into-htmlSnippet falha em qualquer subagent. **Sempre usar Fase 2 Worker-hosted (~5K tokens, 1 javascript_tool fetch+paste)** — o caminho chunked-base64 vive só como fallback automático no apêndice do playbook (#1327). Nunca propor manualmente "vou chunkar" ou "vou fazer paste manual" antes de tentar Worker-hosted. Output: `_internal/05-published.json` com `draft_url`, `title`, `test_email_sent_at`, `template_used`.

**Tab isolation no Chrome**: `publish-newsletter` é o único agent Chrome em Etapa 4 — abre tab Beehiiv própria via `tabs_create_mcp`. LinkedIn (publish-linkedin.ts) e Facebook (publish-facebook.ts) são scripts shell sem browser.

**LinkedIn route — Worker queue + fallback Make (#887):** `publish-linkedin.ts` prefere o Cloudflare Worker `diaria-linkedin-cron` quando `cloudflare_worker_url` + `DIARIA_LINKEDIN_CRON_TOKEN` estão configurados E `scheduled_at` é futuro. Worker enfileira em KV e dispara o webhook Make no horário agendado. **Se o Worker falhar todos os retries** (503, KV down, deploy quebrado), o script cai automaticamente em `postToMakeWebhook` — Make posta **imediatamente** (ignora `scheduled_at`). Entry resultante traz `status: "draft"` (post live, sem agendamento futuro) + `fallback_used: true` + `fallback_reason: "{HTTP NNN: ...}"` (sanitizado, max ~110 chars) para auditoria. Política: post real > post falhado.

**Editor vê (gate 4g) — visibilidade do fallback:**
- `data/run-log.jsonl` entry com `level=warn` + `message=worker_fallback` (timestamp BRT + reason sanitizado).
- `_internal/06-social-published.json` entries do LinkedIn com `fallback_used: true` + `fallback_reason` + `status: "draft"` (não "scheduled" — Make postou imediato).
- Status final no relatório de Stage 4 (`4g`): destaca posts com `fallback_used` para revisão.

Se o agendamento era crítico, editor pode deletar o post no LinkedIn e re-rodar `/diaria-4-publicar social` quando o Worker voltar.

**Aguardar todos os 3 retornarem** antes de prosseguir. Falha/retry de um agent não bloqueia o outro (4d).

`publish-linkedin.ts` grava direto em `06-social-published.json` via store atomica (#918) — sem tmp file pra merge. `publish-facebook.ts` faz o mesmo.

### 4d. Retry chrome_disconnected (só playbook newsletter)

Apenas o playbook newsletter usa Chrome em Etapa 4. LinkedIn (publish-linkedin.ts) e Facebook (publish-facebook.ts) são scripts shell sem browser — falhas viram exit code do script, não `chrome_disconnected`.

Se uma chamada `mcp__claude-in-chrome__*` durante o playbook retornar `chrome_disconnected` (ou erro similar — "not connected", "extension", "disconnected", "no tab", "connection refused"):
1. Calcular delay: `30 * 2^(N-1)` segundos (tentativa 1 = 30s, 2 = 60s, 3 = 120s, 4 = 240s, 5 = 480s, 6 = 960s, 7 = 1920s, 8 = 3840s, 9 = 7680s, 10 = 15360s). Via `Bash("node -e \"process.stdout.write(String(30 * Math.pow(2, {N}-1)))\"")`.
2. Logar warn: `"chrome_disconnected em Etapa 4 (playbook newsletter), tentativa {N}/10 — aguardando {delay}s antes de re-disparar"`.
3. Aguardar: `Bash("sleep {delay}")`.
4. Re-executar o playbook newsletter do passo onde quebrou (ou início se ambíguo).
5. Se repetir, repetir do passo 1 incrementando N.
6. **Após 10 falhas consecutivas** (~17h acumuladas), logar erro e pausar:
   ```
   🔌 Claude in Chrome desconectou 10 vezes seguidas no playbook newsletter (Etapa 4).
      Verifique Chrome aberto + extensão Claude in Chrome ativa.
      ⚠️ Rascunho parcial no Beehiiv pode existir — delete antes do retry.
      Responda "retry" pra mais 10 tentativas, ou "skip" pra pular newsletter.
   ```
- **Reset do contador**: re-execução que sucede (mesmo se falhar por outro motivo depois) reseta N=1.
- Erros que **não** sejam `chrome_disconnected` (ex: login expirado, template errado) interrompem o loop e são tratados normalmente.
- Se o playbook detectar `beehiiv_login_expired` ou similar, pausar com instrução de re-logar (ver `docs/browser-publish-setup.md`).
- Se `publish-linkedin.ts` retornar exit code != 0 (ex: Worker offline), o script já trata fallback Make automaticamente. Falhas reais (token inválido, payload malformado) param o pipeline com erro claro.

### 4e. Validar template (publish-newsletter)

- Ler `05-published.json` retornado. Extrair `draft_url`, `title`, `test_email_sent_to`, `template_used`.
- **Validar template (obrigatório).** Ler `publishing.newsletter.template` de `platform.config.json` (ex: `"Default"`). Se `template_used` !== template esperado:
  1. Logar erro: `"Template incorreto: esperado '{expected}', usado '{template_used}'. Re-disparando publish-newsletter."`.
  2. Instruir o usuário a **deletar o rascunho incorreto** no Beehiiv antes do retry (rascunhos órfãos poluem a lista de posts): `"⚠️ Delete o rascunho '{title}' em {draft_url} antes do retry."`.
  3. Re-disparar `publish-newsletter` com os mesmos parâmetros (até 3 tentativas).
  4. Se o template continuar errado após 3 tentativas, pausar e instruir: `"O template '{expected}' não foi selecionado. Verifique se existe no Beehiiv (Settings → Templates) e re-rode /diaria-4-publicar newsletter."`.
  5. **Não prosseguir para o loop de review** enquanto o template não estiver correto — a newsletter sem template terá problemas estruturais (É IA? ausente, boxes não separados, etc.).

### 4f. Loop de review do email de teste (após newsletter retornar)

> NOTA: este loop **não bloqueia social** — `publish-facebook.ts` e `publish-linkedin.ts` já completaram em 4c. O loop só toca o draft do Beehiiv (newsletter). Social drafts ficam congelados desde 4c.

- **Loop de verificação e correção (OBRIGATÓRIO — até 10 iterações):**
  > **REGRA CRÍTICA:** Este loop NUNCA deve ser pulado. Ele é parte integral da Etapa 4. A Etapa 4 só está completa quando `review_completed: true` estiver gravado em `05-published.json`. Sem isso, o resume do pipeline re-executa o loop.

  Para `attempt` de 1 a 10:

  1. **Verificar email de teste.** Disparar `review-test-email` (Sonnet) passando:
     - `test_email` = `test_email_sent_to`
     - `edition_title` = `title`
     - `edition_dir`
     - `attempt`
  2. Se retornar `error: "chrome_disconnected"`, aplicar o mesmo backoff exponencial descrito acima (30s × 2^(N-1), até 10 tentativas de reconexão). Após reconexão, re-disparar `review-test-email` (não `publish-newsletter`).
  3. **Se retornar `status: "inconclusive"` (#1212 — fail-closed)**: logar warn `"review-test-email: inconclusive — email não chegou em 30s, review NÃO foi feito"` e **sair do loop**. **NÃO marcar `review_completed: true`** — gravar `review_status: "inconclusive"` em vez. Editor deve verificar visualmente no gate. Pre-#1212 o status era `email_not_found` que o orchestrator tratava como "review limpo" — falso negativo estrutural.
  4. Se `issues` estiver vazio E `status: "ok"`: **sair do loop** — email aprovado automaticamente.
  4.5. **Filtrar falso-positivos (#1421)**: o `review-test-email` em Haiku tem viés conhecido (vê acentos em URL slugs ou entities HTML-encoded como corruption). Antes de disparar fix-mode, cross-check determinístico:
     ```typescript
     import { filterAgentIssues } from "scripts/lib/agent-issue-validator.ts";
     const htmlLocal = readFileSync(`{edition_dir}/_internal/newsletter-final.html`, "utf8");
     const { kept, dropped } = filterAgentIssues(issues, htmlLocal, edition_date);
     for (const d of dropped) logar info `"dropped FP: ${d.issue} — ${d.reason}"`;
     ```
     Se `kept.length === 0` E `dropped.length > 0`: todos os issues eram FPs verificáveis. Logar info `"all {N} issues filtered as FPs, sair do loop com status=ok"` e **sair do loop**. Não disparar fix-mode.
     Senão: passar `kept` (não `issues`) pra step 5 abaixo. Issues não-validáveis (unexpected_content, formatting) preservam — caller decide via fix-mode.
  5. Se `kept` (issues pós-filtro) não estiver vazio:
     - Logar: `"review-test-email encontrou {N} problemas na tentativa {attempt}/10 (após filtro de FPs)"`.
     - Disparar `publish-newsletter` em **modo fix** passando:
       - `edition_dir`
       - `mode: "fix"`
       - `draft_url`
       - `issues` = `kept` (lista pós-filtro do reviewer)
     - Se retornar `unfixable_issues[]` não vazio, logar warn e **sair do loop** — correção manual necessária.
     - Caso contrário, continuar para a próxima iteração (re-verificar o email reenviado).

  Após 10 iterações sem sucesso, logar warn: `"Loop de verificação atingiu 10 tentativas sem resolver todos os issues"`.

  Armazenar resultado final: `test_email_check = { attempts: N, final_issues: [...], auto_fixed: true/false }`.

- **Gravar resultado da revisão em `05-published.json` (obrigatório).** Ler `05-published.json`, adicionar/atualizar os campos:
  - `review_completed: true` (apenas quando `status: "ok"` ou após fix-mode bem-sucedido)
  - `review_status: "ok" | "inconclusive" | "issues_unfixable"` (#1212 — explicita resultado real)
  - `review_attempts: N`
  - `review_final_issues: [...]` (vazio se tudo OK)

  Salvar com `Write`. O campo `review_completed` é usado na lógica de **resume** — sem ele `true`, o resume re-executa o loop de review. Em modo `inconclusive`, `review_completed` fica `false` mas pipeline continua (editor revisa no gate).

- Ler `05-published.json` (pode ter sido atualizado pelo fix mode).

### 4f-bis. Verify dispatch — confirma destinos reais (#917)

**Roda APENAS se houve dispatch de social** (consent-check em 4b incluiu Facebook automatico OU LinkedIn automatico). Se ambos foram manual ou skipped, pular essa secao.

```bash
npx tsx scripts/verify-stage-4-dispatch.ts --edition-dir data/editions/{AAMMDD}/
```

O script:
- Le `_internal/06-social-published.json` (entries de FB + LinkedIn).
- Pra Facebook (#974): GET `/{page_id}/scheduled_posts?fields=id,scheduled_publish_time,message`
  uma vez. Pra cada FB entry com `fb_post_id`, match por suffix do post_id.
  Fallback GET `/{post_id}?fields=id,permalink_url` quando o post não está na
  lista de scheduled (já publicado / saiu da queue).
- Pra cada LinkedIn entry com status != "failed" e sem `fallback_used`: GET
  Worker `/list` e confere que o destaque esta na fila KV.
- Persiste relatorio em `_internal/06-verify-dispatch.json` e printa report
  human-readable em stderr.

**Orchestrator:** ler `06-verify-dispatch.json` apos a chamada e expor o
relatorio dentro do gate (4g) — campo `Verificacao pos-dispatch:`.

Exit codes:
- `0` -> tudo verificado, prosseguir normal.
- `1` -> ao menos 1 post nao confirmado. Logar warn e PROSSEGUIR pro gate
  com o relatorio destacado (editor decide se reagenda manualmente). NAO
  bloquear automaticamente — o objetivo e visibilidade, nao gate rigido.

  Subcasos (`results[].reason`) e acao sugerida pro editor (#1180):
  - `fallback_used_immediate_publish` (LinkedIn) — Worker falhou, Make fire-now
    publicou IMEDIATO ignorando scheduled_at. Acao: deletar o post no LinkedIn
    manualmente e republicar com novo agendamento (re-rodar `/diaria-4-publicar
    social {AAMMDD}` apos a delecao).
  - `scheduled_at_in_past` (FB ou LinkedIn) — item esta na fila mas horario ja
    passou, vai disparar no proximo tick (~1min) publicando imediato. Acao:
    `npx tsx scripts/delete-test-schedules.ts --edition-dir data/editions/{AAMMDD}/`
    pra limpar agendamentos com data no passado + re-rodar `/diaria-4-publicar
    social {AAMMDD}` com `--no-skip-existing`.
  - `post_missing` / `nenhum item no Worker KV` (silent fail) — agent retornou
    sucesso mas o destino nao tem reflexo. Acao: re-rodar `publish-facebook` /
    `publish-linkedin` pra esse destaque (com `--no-skip-existing`).
  - `graph_api_error` / `missing_*_token` / `missing_worker_creds` — falha de
    config/auth. Acao: verificar env vars + creds antes de re-rodar.
- `2` -> erro de input (arquivo missing, env missing). Logar warn,
  prosseguir sem o bloco no gate (editor ainda revisa social manualmente).

⚠️ **Por que nao bloquear automaticamente?** Editor pode aceitar publicacao
parcial (ex: 1 post LinkedIn falhou mas os outros 5 estao OK), e force-block
travaria a edicao. O relatorio no gate da visibilidade — editor decide.

### 4f-ter. Render social preview HTML (#1545)

Gerar e subir preview HTML dos posts sociais para revisão no gate. O script `render-social-html.ts` renderiza cards por plataforma com imagens dos destaques (#1497).

```bash
npx tsx scripts/render-social-html.ts \
  --md data/editions/{AAMMDD}/03-social.md \
  --out data/editions/{AAMMDD}/_internal/social-preview.html \
  --images data/editions/{AAMMDD}/06-public-images.json

npx tsx scripts/upload-html-public.ts --edition {AAMMDD} \
  --key {AAMMDD}-social \
  --html data/editions/{AAMMDD}/_internal/social-preview.html
```

Capturar a URL retornada (campo `url` do JSON stdout) e incluir no bloco de links do gate 4g como `Social Preview HTML: {url}`.

Falha não bloqueia o gate — editor pode revisar o `03-social.md` diretamente. Logar warn e prosseguir.

### 4g. Gate único (legacy — PULAR quando pre_gate=true; #1571)

**Quando `pre_gate = true`** (default de `/diaria-edicao`), este step é PULADO — a aprovação editorial já aconteceu em 4a-pre-gate antes do dispatch. Saltar direto pra 4g-bis (dispatch social, em paralelo com newsletter que ainda está em test-email loop).

**Quando `pre_gate = false`** (legacy `/diaria-4-publicar` sem `--pre-gate`), mantém o fluxo histórico: newsletter já dispatchou em 4c, social ainda não. Editor revisa preview antes de aprovar.



- **Sync push antes do gate (#507):**
  1. Lista base: `_internal/05-published.json,06-social-published.json`
  2. Se `data/editions/{AAMMDD}/error.md` existir, append `,error.md` à lista.
  3. Rodar:
     ```bash
     npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 4 --files {lista}
     ```
  Anotar em `sync_results[4]`; ignorar falhas.
  > O drive-sync já trata arquivos inexistentes como warning não-fatal — mas verificar a existência de `error.md` antes de incluir evita esse warning nas edições sem erros.

- Ler `06-social-published.json` (já gerado por 4c).
- **GATE HUMANO:** mostrar **uma só vez**:

  **Links de preview e rascunhos (#1484)**

  Antes das seções detalhadas, exibir bloco consolidado de links para acesso rápido. O `draft_preview_url` vem de `05-published.json` (campo `draft_preview_url`, gerado por `upload-html-public.ts`) ou é construído inline com `https://draft.diaria.workers.dev/{AAMMDD}`. URLs sociais vêm de `06-social-published.json` (campo `url` e `scheduled_at` de cada post).

  ```
  📰 Newsletter:
    Preview HTML: https://draft.diaria.workers.dev/{AAMMDD}
    Rascunho Beehiiv: {draft_url}

  📱 Social:
    Preview HTML: {social_preview_url}  (gerado em 4f-ter)
    Facebook D1: {status} {scheduled_time} BRT — {fb_url}
    Facebook D2: {status} {scheduled_time} BRT — {fb_url}
    Facebook D3: {status} {scheduled_time} BRT — {fb_url}
    LinkedIn D1: {status} {scheduled_time} BRT (Worker queue) — {li_url}
    LinkedIn D2: {status} {scheduled_time} BRT (Worker queue) — {li_url}
    LinkedIn D3: {status} {scheduled_time} BRT (Worker queue) — {li_url}
  ```

  Regras de preenchimento:
  - `{draft_url}` = `05-published.json > draft_url`.
  - `{fb_url}` / `{li_url}` = `06-social-published.json > posts[].url` (pode ser null se draft sem URL pública — mostrar `(URL pendente)`).
  - `{status}` = status do post (`scheduled`, `draft`, `published`, `failed`). Posts `failed` aparecem com ❌ e `reason`.
  - `{scheduled_time}` = `scheduled_at` formatado como `HH:MM` BRT. Se ausente, omitir.
  - Se social ainda não dispatchou (pré-4g-bis), indicar: `(dispatch pendente — após aprovação do gate)`.

  **Newsletter (Beehiiv)**
  - URL do rascunho Beehiiv (`draft_url`)
  - Confirmação de envio do email de teste para `test_email_sent_to`
  - Template usado (`template_used`)
  - **Resultado da verificação do email de teste (#1212):**
    - Se `review_status === "ok"` e `review_final_issues` vazio E `unfixed_issues` vazio: `"✅ Email de teste verificado ({attempts} tentativa(s)) — nenhum problema detectado."`
    - Se `review_status === "inconclusive"`: `"⚠️ Review INCONCLUSIVO — email não chegou ao Gmail em 30s. Verifique visualmente no inbox antes de aprovar."` (fail-closed em vez de assumir "limpo")
    - Se `review_final_issues` não vazio OU `unfixed_issues` não vazio (#1212 — gate agora exibe AMBOS):
      ```
      ⚠️ Problemas restantes após {attempts} tentativa(s):
      Review issues:
         • {review_final_issues[0]}
         • {review_final_issues[1]}
      Unfixed issues (publish-newsletter):
         • {unfixed_issues[0].reason}: {unfixed_issues[0].details}
         • {unfixed_issues[1].reason}: ...
      Corrija manualmente no rascunho antes de publicar.
      ```
      Pre-#1212 o gate só lia `review_final_issues` — `unfixed_issues` ficava invisível pro editor descobrir manualmente. Agora ambos campos aparecem juntos.

  **Social (6 posts)** — tabela:
  ```
  Facebook  D1  draft      https://www.facebook.com/...  (API)
  Facebook  D2  draft      https://www.facebook.com/...  (API)
  Facebook  D3  draft      https://www.facebook.com/...  (API)
  LinkedIn  D1  draft      https://www.linkedin.com/...  (browser)
  LinkedIn  D2  draft      https://www.linkedin.com/...  (browser)
  LinkedIn  D3  scheduled  2026-04-19 16:00 BRT          (browser)
  ```
  Posts com `status: "failed"` aparecem destacados com `reason`.

  **Verificacao pos-dispatch (#917)** — se `_internal/06-verify-dispatch.json` existe, ler e mostrar resumo:
  ```
  Verificacao pos-dispatch: 5/6 confirmados (1 nao verificado)
    OK   facebook/d1 — scheduled at 09:00 BRT (Graph API)
    OK   facebook/d2 — scheduled at 12:30 BRT (Graph API)
    OK   facebook/d3 — scheduled at 17:00 BRT (Graph API)
    OK   linkedin/d1 — queued (Worker KV)
    FAIL linkedin/d2 — nenhum item no Worker KV pro destaque d2 (queue silent fail?)
    OK   linkedin/d3 — queued (Worker KV)
  ```
  Se algum FAIL, instruir o editor: "1+ post nao confirmado no destino. Verifique manualmente no Facebook/LinkedIn antes de aprovar; se faltar, re-rode `/diaria-4-publicar social {AAMMDD}` com `--no-skip-existing`."

  **Imagens (#1499):**
  ```
  📎 Imagens:
     • Cover (D1 2:1) — subida automaticamente pelo pipeline ✓
     • Inline D1 — via Worker KV (automático) ✓
     • D2 e D3 — sem imagem inline (só texto)
     • É IA? (A e B) — via Worker KV (automático) ✓
       Se não aparecerem no test email, subir manualmente:
       01-eia-A.jpg e 01-eia-B.jpg de data/editions/{AAMMDD}/
  ```

  **Instrução**: "Suba as imagens no Beehiiv, reenvie o email de teste pra conferir, revise os 6 social drafts no dashboard de cada plataforma, e só então aprove. Posts agendados serão publicados automaticamente no horário."

  **Opções**:
  - aprovar (segue para social dispatch + auto-reporter)
  - regenerar newsletter (re-dispatch `publish-newsletter`)
  - abortar

- **Atualizar `stage-status.md` (#1217 — removed cost.md).** Marcar stage 4 done via `update-stage-status.ts --stage 4 --status done --end ISO --duration-ms X [--cost-usd Y --models "sonnet-4-6"]`.

### 4g-bis. Dispatch social (APÓS gate — #1501)

**Social dispatcha DEPOIS do gate.** O `03-social.md` já passou por todas as revisões (humanizador, Clarice, edições manuais). Nenhum re-dispatch necessário.

**Em uma única mensagem**, disparar simultaneamente (apenas os autorizados em 4b):
1. `Bash("npx tsx scripts/publish-facebook.ts --edition-dir data/editions/{AAMMDD}/ --schedule")` — Graph API, ~30s.
2. `Bash("npx tsx scripts/publish-linkedin.ts --edition-dir data/editions/{AAMMDD}/ --schedule")` — Worker queue + Make webhook, ~3s (#971).

**Aguardar ambos retornarem.** Verificar dispatch:
```bash
npx tsx scripts/verify-stage-4-dispatch.ts --edition-dir data/editions/{AAMMDD}/
```

### 4h. Fechar poll É IA? (#465, #1044, #1367)

Após o editor aprovar o gate da Etapa 4 (publicação confirmada), registrar a resposta correta no Worker de votação:

```bash
# Closes the É IA? poll by registering the correct answer to the Worker
# This enables retroactive score updates and % display in next edition
npx tsx scripts/close-poll.ts --edition {AAMMDD}
```

**#1367 — close-poll é OBRIGATÓRIO. Halt em exit != 0.** Antes do #1367 (260518) close-poll era nice-to-have; falhou silenciosamente e a edição 260519 saiu sem gabarito → próxima edição não pôde exibir % de acertos. Agora é halt obrigatório:

```bash
if ! npx tsx scripts/close-poll.ts --edition {AAMMDD}; then
  npx tsx scripts/render-halt-banner.ts --stage "4 — Publicação" \
    --reason "close-poll falhou (ADMIN_SECRET ausente, network, ou Worker rejeitou)" \
    --action "rode \`npx tsx scripts/close-poll.ts --edition {AAMMDD}\` manualmente até exit 0, depois retome Stage 4i (sentinel)"
  exit 1
fi
```

O script `close-poll.ts` agora (#1367) faz **sanity check automático** após o POST /admin/correct:
- GET /stats?edition={AAMMDD}
- Confirma `correct_answer` retornado == answer registrado
- Grava marker `_internal/.close-poll-done.json` com snapshot do estado

Se sanity check falhar, exit 1 — Worker pode ter rejeitado silenciosamente.

### 4h-bis. Smoke test do voto (#1366 Stage 4 part)

**Imediatamente após close-poll**, validar que `valid_editions` inclui a edição corrente. Caso real 260519: maintain-valid-editions-window read_failed=true em Stage 0; sem smoke test, 482 subscribers receberiam email com botões A/B retornando 410.

```bash
if ! npx tsx scripts/smoke-test-vote.ts --edition {AAMMDD}; then
  npx tsx scripts/render-halt-banner.ts --stage "4 — Publicação" \
    --reason "smoke-test-vote falhou — edição não está em valid_editions OU Worker offline" \
    --action "rode \`npx tsx scripts/add-valid-edition.ts --edition {AAMMDD}\` e retentar"
  exit 1
fi
```

Smoke test exit codes:
- `0` → vote aceito (Worker incluiu edição em valid_editions)
- `2` → 410/403 (edição fora do set ou sig inválida) — halt obrigatório
- `3` → network timeout — halt (Stage 5 vai falhar de qualquer jeito)

**Publicação manual (sem `/diaria-4-publicar`):** se publicar direto pelo Beehiiv UI sem rodar este stage, ambos close-poll **e smoke-test-vote** devem ser invocados manualmente:

```bash
npx tsx scripts/close-poll.ts --edition {AAMMDD}
npx tsx scripts/smoke-test-vote.ts --edition {AAMMDD}
```

Sem close-poll, gabarito permanece `null` no Worker. Sem smoke test, edição pode estar fora de valid_editions silenciosamente.

### 4i. Escrever sentinel de conclusão (#978)

**Sempre** ao fim do Stage 4 — mesmo se publicação foi manual ou gate retornou `pending_manual`. Stage 0 da próxima edição usa o sentinel pra detectar que esta edição completou o ciclo (fix de #978):

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 4 \
  --outputs "_internal/05-published.json"
```

- Sentinel ausente faz Stage 0 da próxima edição re-investigar publicação via Beehiiv API (custo extra, ruído editorial).
- Falha do sentinel → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level warn --message 'sentinel_write_failed'`). Não bloquear.
- Quando publicação é manual (Pixel cria rascunho direto), `05-published.json` pode ter `status: "pending_manual"` ou similar — o sentinel registra que o **stage** terminou, não que a publicação foi 100% automática. Stage 0 valida estado real via `refresh-dedup` que cruza com Beehiiv API.

### 4j. Pós-publicação invariants (#1007 Fase 1)

Antes do auto-reporter, validar que (a) sentinel `_internal/.step-4-done.json` foi escrito, (b) `_internal/06-social-published.json` tem `posts[]` não-vazio sem entries `failed`:

```bash
npx tsx scripts/check-invariants.ts --stage 5 --edition-dir data/editions/{AAMMDD}/
```

Exit 1 = logar warn (não bloquear auto-reporter — sinaliza falha silenciosa que o auto-reporter deve transformar em issue). Falha aqui é evidência de bug downstream (publish-* não gravou store atomic).

---

## Etapa 4b — Auto-reporter (#57 / #79)

Após o gate da Etapa 4 (publicação paralela) aprovado, orchestrator coleta sinais da edição e apresenta gate de issues GitHub.

### 4b-0. Validar social published (#272)

Sempre, independente do exit code dos agents:
```bash
npx tsx scripts/validate-social-published.ts data/editions/{AAMMDD}/
```
Se exit != 0 (duplicates ou inconsistências detectados), incluir no relatório do gate de Etapa 4 (`4g`) antes de seguir. Não bloqueia o pipeline, mas editor vê o problema antes de aprovar.

### 4b-1. Coletar sinais

```bash
npx tsx scripts/collect-edition-signals.ts --edition-dir data/editions/{AAMMDD}/
```
Script lê `data/source-health.json`, `{edition_dir}/05-published.json` (`unfixed_issues[]`), e `data/run-log.jsonl` (chrome_disconnects). Grava `{edition_dir}/_internal/issues-draft.json`.

- **Se `data/editions/{AAMMDD}/error.md` existir (#507):** incluir o conteúdo do arquivo como contexto adicional ao disparar o `auto-reporter`. O arquivo documenta erros manuais registrados pelo editor durante a edição. O auto-reporter deve mencionar que `error.md` existe e sugerir criação de issue se o conteúdo descrever um bug ou comportamento inesperado recorrente.

### 4b-2. Avaliar output

Se `signals_count === 0`, logar info e pular auto-reporter — edição passou limpa, nada a reportar.

### 4b-3. Sempre rodar (#1502)

Auto-reporter roda em **todos os modos** (interativo, `auto_approve`). É o único mecanismo de observabilidade pós-edição — sem ele, bugs detectados durante a edição não viram issues.

- **`auto_approve = true`**: gate do auto-reporter é auto-aprovado (issues criadas automaticamente).
- **Modo interativo**: gate normal (editor aprova/skip/edit cada issue).

### 4b-4. Disparar auto-reporter

Se há sinais, disparar agent `auto-reporter` via `Agent` com:
- `edition_dir`
- `repo: "vjpixel/diaria-studio"`

Agent faz dedup contra GitHub issues abertas, apresenta gate humano ("aprovar 1,2,3 / skip / edit N"), executa ações aprovadas. Ver `.claude/agents/auto-reporter.md`.

### 4b-5. Logar resultado

Gravar resumo (#1217 — sem cost.md):
```
✅ Auto-reporter completo.
   {reported_count}/{signals_total} sinais reportados, {issues_created} novas issues criadas, {issues_commented} issues comentadas.
```

Se o agent retornar `action: "fallback_md"` (GitHub MCP indisponível), mostrar o path do MD gerado e instruir: "GitHub MCP falhou. Abra `{md_path}` e crie as issues manualmente quando tiver tempo."

### 4b-6. Enviar relatório por email (#1510)

Último passo do pipeline. Gera HTML report e envia via Gmail MCP:

```bash
npx tsx scripts/send-edition-report.ts \
  --edition {AAMMDD} \
  --edition-dir data/editions/{AAMMDD}/ \
  > data/editions/{AAMMDD}/_internal/edition-report.html \
  2> data/editions/{AAMMDD}/_internal/report-summary.json
```

Enviar via Gmail MCP `create_draft` (to: `vjpixel@gmail.com`, subject: `Diar.ia {AAMMDD} — relatório de edição`, htmlBody: conteúdo **completo** de `edition-report.html`). **Não reescrever HTML resumido** (#1548) — o script já gera tabela de duração por stage, destaques, status de publicação e warnings. Usar o arquivo como está.

**Falha não bloqueia** — logar warn e seguir. O relatório fica em `_internal/edition-report.html` pra consulta local mesmo se email falhar.

---

## Resumo final (após auto-reporter + relatório)

Após auto-reporter, apresentar resumo consolidado da edição. Se alguma parte foi pulada (ex: `CHROME_MCP = false` levou newsletter e LinkedIn a serem pulados), incluir bloco de retomada explícito:

```
🔁 Retomada manual pendente

Etapa 4a (newsletter no Beehiiv): pulado (claude-in-chrome MCP indisponível)
Etapa 4a (LinkedIn × 3): pulado (claude-in-chrome MCP indisponível)
Facebook × 3: agendado normal via Graph API ✓

Quando o MCP estiver ativo, rodar:
  /diaria-4-publicar newsletter {AAMMDD}   # cria rascunho Beehiiv + email teste
  /diaria-4-publicar social {AAMMDD}       # cria 3 posts LinkedIn (Facebook já agendado)

Artefatos prontos:
  - data/editions/{AAMMDD}/_internal/05-newsletter-body.html  (HTML pré-renderizado)
  - data/editions/{AAMMDD}/02-reviewed.md                      (newsletter)
  - data/editions/{AAMMDD}/03-social.md                        (copy LinkedIn + Facebook)
  - data/editions/{AAMMDD}/04-d{1,2,3}*.jpg                    (imagens)
  - data/editions/{AAMMDD}/01-eai*                             (É IA?)
```

Se nenhum stage foi pulado, omitir esse bloco — só listar outputs e métricas finais.
