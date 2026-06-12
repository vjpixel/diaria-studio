---
name: orchestrator-stage-5
description: Detalhe da Etapa 5 (publicação paralela — newsletter + social) e do auto-reporter do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execução — não é um subagente invocável diretamente.
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Etapa 5 — Publicação (paralelo: newsletter + social) — #38

`publish-newsletter` (Beehiiv), `publish-facebook.ts` (Graph API) e `publish-linkedin.ts` (Worker queue + Make.com webhook) rodam **em paralelo na mesma mensagem**, com **gate único** depois. O auto-reporter fecha o loop de observabilidade.

LinkedIn não usa Chrome — Cloudflare Worker enfileira em KV e dispara Make webhook no horário agendado (#971).

Manteve-se modo draft pra Beehiiv — `mode: "scheduled"` + scheduled_at sincronizado fica pra PR 2 (#38).

### Pré-condição: sentinel Stage 4

<!-- outputs must match the `write` call at the end of orchestrator-stage-4.md §Escrever sentinel de conclusão do Stage 4 -->
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 4 \
  --outputs "02-reviewed.md,03-social.md"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 4 (Revisão) não completou (sentinel ausente). Re-rodar `/diaria-4-revisao {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "Outputs do Stage 4 ausentes. Re-rodar Etapa 4." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level warn --message "stage4_sentinel_missing_legacy"`), continuar.

### Modos de execução (#1523 / #1571 — movidos do Stage 4 original)

Stage 5 é **dispatch puro** — sem gate próprio. O gate de revisão editorial está no Stage 4. Os dois modos históricos do pre-gate continuam suportados para retrocompat com o fluxo `/diaria-4-publicar` legado:

- **`pre_gate = true` (default em `/diaria-edicao`):** o gate ao editor aconteceu **no Stage 4**. Aqui apenas despachar. Prosseguir direto pra 5c (dispatch newsletter) → 5f (review test email) → 5g-bis (dispatch social).

- **`pre_gate = false` ou ausente (`/diaria-4-publicar` legacy):** fluxo histórico — 5c dispatch newsletter → 5f review loop → 5f-bis verify → 5f-ter render social preview → **5g gate pós-dispatch** → 5g-bis social → fim.

### 5a. Pré-requisitos + sync

**Marcar Stage 5 `running` no início (#1783).** Garante o `start` pra que o `done` do §5i feche a duração no relatório. Sem `--start` — auto-carimbo (#1789) preserva o original em resume:
```bash
npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ --stage 5 --status running
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
  --stage "5 — Publicação" \
  --reason "mcp__{server_name} desconectado (verifique extensão Chrome + login)" \
  --action "responda 'retry' para continuar ou 'abort' para encerrar Etapa 5"
```
Ao reconectar (MCP voltar a responder), logar:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator \
  --level info --message "mcp_reconnect: {server_name}" \
  --details '{"server":"{server_name}","kind":"mcp_reconnect"}'
```
Nunca aguardar passivamente. Este stage depende de claude-in-chrome (newsletter, social), beehiiv (API) e gmail (review-test-email). Disconnect de qualquer um exige ação explícita do editor — não tente "contornar" em silêncio. Os logs persistem em `data/run-log.jsonl` para auditoria pelo `collect-edition-signals.ts` (#759).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

- Logar início:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level info --message 'etapa 5 publish parallel started'
  ```
- **Sync pull antes de começar** (todos os arquivos consumidos por newsletter + social):
  ```bash
  npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 5 --files 02-reviewed.md,01-eia-A.jpg,01-eia-B.jpg,03-social.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg
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

### 5a-poll-preflight. Gate de poll ANTES do envio — SEMPRE (#1803)

**Roda em TODO entry path, nos dois modos (`pre_gate` true/false), antes de qualquer pré-render/dispatch.** Resolve o P1 #1803: num resume direto pro Stage 5, os passos de poll do Stage 0 (§0d.bis `maintain-valid-editions`, §0d.ter `inject-poll-sig`) não rodam e o "É IA?" quebra ao vivo (410/403) pra todos os subscribers — silenciosamente. Como está no início do Stage 5, **um resume sempre o atravessa**. O script faz FIX idempotente (maintain + inject, warn-only) → VERIFY (smoke-test, **gate duro**), bloqueando o envio antes da newsletter sair — não depois (o antigo §4h-bis rodava tarde demais).

```bash
npx tsx scripts/preflight-poll-dispatch.ts --edition {AAMMDD}
```

Exit code handling:
- `0` → poll pronto. Prosseguir pro dispatch.
- `1` → **FATAL:** o próprio script já renderizou o halt banner (motivo + ação). **NÃO enviar a newsletter.** Editor corrige (tipicamente `add-valid-edition.ts --edition {AAMMDD}` ou conferir `POLL_SECRET`) e re-roda Etapa 5.

### 5a-pre-gate. Pré-render + apresentar preview ao editor (legacy `pre_gate = false`)

**Executar SOMENTE quando `pre_gate = false`** (legacy `/diaria-4-publicar` sem `--pre-gate`). Quando `pre_gate = true` (default via `/diaria-edicao`), este passo já rodou no Stage 4 — pular e ir direto pra 5b.

Faz tudo que o dispatch precisa exceto enviar pros canais finais:

0. **capture-livros-promo — ANTES do upload (#2071).** Re-captura o screenshot da página de livros se o conteúdo mudou (md5 diferente). Exit code 2 = sem mudança (ok, continuar); exit code 1 = erro fatal (logar warn, continuar — é opcional):
   ```bash
   npx tsx scripts/capture-livros-promo.ts --edition-dir data/editions/{AAMMDD}/
   ```
   Exit code handling: `0` = imagem nova gravada em `data/editions/{AAMMDD}/04-livros-promo.jpg`; `2` = md5 igual, nada a fazer; `1` = falha (puppeteer ou rede) — logar warn + continuar.

1. **upload-images-public — TODOS modos** (cobre 5c-pre completo):
   ```bash
   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/{AAMMDD}/ --mode newsletter
   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/{AAMMDD}/ --mode social
   ```
2. Pre-render do newsletter HTML — seguir steps 1-5 do `context/publishers/beehiiv-playbook.md` **sem** o Chrome MCP / Beehiiv interaction. Output: `_internal/newsletter-final.html` + URL no draft worker. **Capturar a `url` do JSON stdout de `upload-html-public.ts`** — Worker usa key `html:{AAMMDD}-{contentHash}` (#1494).
3. Pre-render do social preview HTML:
   ```bash
   npx tsx scripts/render-social-html.ts --md data/editions/{AAMMDD}/03-social.md --out data/editions/{AAMMDD}/_internal/social-preview.html --images data/editions/{AAMMDD}/06-public-images.json
   npx tsx scripts/upload-html-public.ts --edition {AAMMDD}-social --html data/editions/{AAMMDD}/_internal/social-preview.html --persist-to data/editions/{AAMMDD}/_internal/05-social-preview.json --field social_preview_url
   ```
4. close-poll (set gabarito — script já é idempotente, sem flag):
   ```bash
   npx tsx scripts/close-poll.ts --edition {AAMMDD}
   ```
5. **PRE-GATE HUMANO** (só quando `pre_gate = false`):
   ```
   📄 Newsletter HTML: {newsletter_url}
   📱 Social preview:  {social_url}
   📁 Arquivos locais: 02-reviewed.md, 03-social.md

   Aprovar dispatch em todos os 3 canais? (sim / editar / abortar)
   ```
6. Logar resposta:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level info \
     --message "pre_gate response: {sim|editar|abortar}"
   ```

**"editar":** rodar `update-stage-status --stage 5 --status pending` + halt banner. NÃO escrever sentinel.
**"abortar":** logar warn, encerrar sem sentinel.

### 5a-bis. ~~Injetar URLs do poll É IA? por subscriber~~ — removido (#1175, script deletado #1185)

**Removido em #1175** (2026-05-12). O HTML render usa `{{poll_sig}}` + `{{email}}` desde #1083.

### 5b. Confirmar modo de publicação por canal (#336 — invertido em #1326)

**INVARIANTE (#1326): Default = tudo automático.** Stage 5 é dispatch, editor já revisou no Stage 4 (Revisão). Editor pode opt-out por canal via flag `--skip` no comando ou respondendo no gate interativo.

Casos:
- `auto_approve = true` (skill chamada com `--no-gates`) → tudo auto, sem perguntar.
- Skill chamada com `--skip {canal[,canal...]}` → canais listados ficam manual, resto auto.
- Sem flags, modo interativo → mostrar gate abaixo. **Default se editor não responder = tudo auto.**

**Auto-approve path (`auto_approve = true`):**

```bash
npx tsx scripts/build-publish-consent.ts --edition {AAMMDD} --auto-approve
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level warn \
  --message "Etapa 5 auto-approved via --no-gates: 3 canais dispatchados sem confirmacao por canal" \
  --details '{"channels":["newsletter","linkedin","facebook"]}'
```

Prosseguir direto pra 5c-pre. NÃO perguntar.

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
Se editor responder "none", gravar `05-published.json` com `status: "skipped_by_editor"` e encerrar Etapa 5.

**#1238 trade-off atualizado em #1380**: O user-activation guard do Beehiiv **só atinge o click de Schedule** — não o "Send test email". Validado em 260519 (4× test emails enviados consecutivamente via Chrome MCP). O trigger correto pra Send test email é o **chevron dropdown** ao lado do botão Preview:

1. Achar popover `.hidden.absolute` que contém o button "Send test email"
2. Achar sibling `.relative.z-0` com 2 buttons (`Preview` + chevron sem texto)
3. Clicar o chevron — popover abre
4. Clicar "Send test email" — toast `Test email sent` aparece

**Schedule continua sendo manual** (5 mecanismos testados em #1198 — todos rejeitados pelo guard).

### 5c-pre. Upload de imagens públicas (#999 fix — pré-requisito do dispatch)

**ANTES** do dispatch paralelo, se LinkedIn ou Facebook automático foram autorizados em 5b, rodar upload-images-public.ts pra popular o cache `06-public-images.json` com URLs Drive públicas:

```bash
npx tsx scripts/upload-images-public.ts --edition-dir data/editions/{AAMMDD}/ --mode social
```

**Fail-loud:** se exit != 0, **halt** Stage 5 com banner:
```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "5 — Publicação" \
  --reason "upload-images-public.ts falhou: imagens não estão no Drive como pública" \
  --action "verifique credenciais Google + tente novamente, ou pule LinkedIn/FB automático em 5b"
```

Skip apenas se editor selecionou "manual" em **ambos** LinkedIn e Facebook em 5b.

### 5c. Dispatch newsletter (primeiro, sozinha)

**#1501 — social dispatch é TARDIO.** Newsletter dispatcha primeiro (sozinha). Social dispatcha DEPOIS do gate 5g, quando o editor já revisou tudo e o `03-social.md` está final.

**Só dispatchar newsletter se o editor autorizou em 5b.** Canal manual fica com `status: pending_manual`.

**Newsletter Beehiiv (#1054 / #207 / #1114 / #1327)**: você (top-level) **lê `context/publishers/beehiiv-playbook.md` como playbook e executa direto** — Bash + Read + `mcp__claude-in-chrome__*` (incluindo `javascript_tool`). **Não tente dispatchar via `Agent`** — `javascript_tool` é restrito ao top-level. **Sempre usar Fase 2 Worker-hosted (~5K tokens, 1 javascript_tool fetch+paste)** (#1327). Nunca propor manualmente "vou chunkar" ou "vou fazer paste manual" antes de tentar Worker-hosted. Output: `_internal/05-published.json`.

**Tab isolation no Chrome**: `publish-newsletter` é o único agent Chrome em Etapa 5 — abre tab Beehiiv própria via `tabs_create_mcp`. LinkedIn e Facebook são scripts shell sem browser.

**LinkedIn route — Worker queue + fallback Make (#887):** `publish-linkedin.ts` prefere o Cloudflare Worker `diaria-linkedin-cron` quando `cloudflare_worker_url` + `DIARIA_LINKEDIN_CRON_TOKEN` estão configurados E `scheduled_at` é futuro. Se o Worker falhar todos os retries (503, KV down, deploy quebrado), o script cai automaticamente em `postToMakeWebhook` — Make posta **imediatamente** (ignora `scheduled_at`). Entry resultante traz `status: "draft"` (post live, sem agendamento futuro) + `fallback_used: true` + `fallback_reason` para auditoria.

**Aguardar todos os 3 retornarem** antes de prosseguir.

`publish-linkedin.ts` grava direto em `06-social-published.json` via store atomica (#918).

### 5d. Retry chrome_disconnected (só playbook newsletter)

Apenas o playbook newsletter usa Chrome em Etapa 5. **Antes de passos com clique real, rodar o preflight de visibilidade da aba (#2015 — ver "Preflight de visibilidade" no beehiiv-playbook.md).**

Se uma chamada `mcp__claude-in-chrome__*` retornar `chrome_disconnected`:
1. Calcular delay: `30 * 2^(N-1)` segundos (tentativa 1 = 30s, 2 = 60s, ..., 10 = 15360s).
2. Logar warn: `"chrome_disconnected em Etapa 5 (playbook newsletter), tentativa {N}/10 — aguardando {delay}s"`.
3. Aguardar: `Bash("sleep {delay}")`.
4. Re-executar o playbook newsletter do passo onde quebrou.
5. **Após 10 falhas consecutivas** (~17h acumuladas), logar erro e pausar com instrução ao editor.
- **Reset do contador**: re-execução que sucede reseta N=1.

### 5e. Validar template (publish-newsletter)

- Ler `05-published.json`. Extrair `draft_url`, `title`, `test_email_sent_to`, `template_used`.
- **Validar template (obrigatório).** Ler `publishing.newsletter.template` de `platform.config.json`. Se `template_used` !== template esperado:
  1. Logar erro + instruir a **deletar o rascunho incorreto** no Beehiiv.
  2. Re-disparar `publish-newsletter` (até 3 tentativas).
  3. Se o template continuar errado após 3 tentativas, pausar com instrução ao editor.
  4. **Não prosseguir para o loop de review** enquanto o template não estiver correto.

### 5f. Loop de review do email de teste (após newsletter retornar)

> NOTA: este loop **não bloqueia social** — `publish-facebook.ts` e `publish-linkedin.ts` já completaram em 5c. O loop só toca o draft do Beehiiv (newsletter).

- **Loop de verificação e correção (OBRIGATÓRIO — até 10 iterações):**
  > **REGRA CRÍTICA:** Este loop NUNCA deve ser pulado. A Etapa 5 só está completa quando `review_completed: true` estiver gravado em `05-published.json`.

  ```typescript
  // #2047 / #2061: declarar UMA vez ANTES do loop — evita re-fetch do mesmo URL
  const linkCheckCache = new Map<string, boolean>();
  ```

  Para `attempt` de 1 a 10:

  1. **Verificar email de teste.** Disparar `review-test-email` passando `test_email`, `edition_title`, `edition_dir`, `attempt`.
  2. Se retornar `error: "chrome_disconnected"`, aplicar o mesmo backoff exponencial descrito acima.
  3. **Se retornar `status: "inconclusive"` (#1212 — fail-closed)**: logar warn e **sair do loop**. Gravar `review_status: "inconclusive"`. NÃO marcar `review_completed: true`.
  4. Se `issues` estiver vazio E `status: "ok"`: **sair do loop**.
  4.5. **Filtrar falso-positivos (#1421, #2013, #2047)**:
     ```typescript
     import { filterAgentIssues } from "scripts/lib/agent-issue-validator.ts";
     const htmlLocal = readFileSync(`{edition_dir}/_internal/newsletter-final.html`, "utf8");
     const { kept, dropped } = await filterAgentIssues(issues, htmlLocal, edition_date, fetch, linkCheckCache);
     for (const d of dropped) logar info `"dropped FP: ${d.issue} — ${d.reason}"`;
     ```
     Se `kept.length === 0` E `dropped.length > 0`: todos eram FPs — **sair do loop** sem fix-mode.
  5. Se `kept` não estiver vazio:
     - Logar: `"review-test-email encontrou {N} problemas na tentativa {attempt}/10"`.
     - Disparar `publish-newsletter` em **modo fix** com `edition_dir`, `mode: "fix"`, `draft_url`, `issues: kept`.
     - Se `unfixable_issues[]` não vazio, logar warn e sair do loop.

  Após 10 iterações sem sucesso, logar warn: `"Loop atingiu 10 tentativas sem resolver todos os issues"`.

- **Gravar resultado da revisão em `05-published.json` (obrigatório).** Campos: `review_completed`, `review_status`, `review_attempts`, `review_final_issues`.

### 5f-bis. Verify dispatch — confirma destinos reais (#917)

**Roda APENAS se houve dispatch de social.**

```bash
npx tsx scripts/verify-stage-4-dispatch.ts --edition-dir data/editions/{AAMMDD}/
```

O script verifica Facebook via Graph API e LinkedIn via Worker KV. Persiste relatório em `_internal/06-verify-dispatch.json`.

Exit codes:
- `0` → tudo verificado, prosseguir normal.
- `1` → ao menos 1 post não confirmado. Logar warn e PROSSEGUIR pro gate com o relatório destacado.
- `2` → erro de input. Logar warn, prosseguir sem o bloco no gate.

### 5f-ter. Render social preview HTML (#1545)

```bash
npx tsx scripts/render-social-html.ts \
  --md data/editions/{AAMMDD}/03-social.md \
  --out data/editions/{AAMMDD}/_internal/social-preview.html \
  --images data/editions/{AAMMDD}/06-public-images.json

npx tsx scripts/upload-html-public.ts --edition {AAMMDD}-social \
  --html data/editions/{AAMMDD}/_internal/social-preview.html --persist-to data/editions/{AAMMDD}/_internal/05-social-preview.json --field social_preview_url
```

Falha não bloqueia o gate — editor pode revisar o `03-social.md` diretamente. Logar warn e prosseguir.

### 5g. Gate único (legacy — PULAR quando pre_gate=true; #1571)

**Quando `pre_gate = true`** (default de `/diaria-edicao`), este step é PULADO. Saltar direto pra 5g-bis.

**Quando `pre_gate = false`** (legacy `/diaria-4-publicar` sem `--pre-gate`), mantém o fluxo histórico.

- **Sync push antes do gate (#507):**
  1. Lista base: `03-social.md,_internal/05-published.json,_internal/06-social-published.json`.
  2. Se `data/editions/{AAMMDD}/error.md` existir, append `,error.md`.
  3. Rodar:
     ```bash
     npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 5 --files {lista}
     ```

- **GATE HUMANO:** mostrar bloco consolidado:

  **Newsletter** — resultado da verificação do email de teste (#1212):
  - Se `review_status === "ok"` e `review_final_issues` vazio E `unfixed_issues` vazio: `"✅ Email de teste verificado"`
  - Se `review_status === "inconclusive"`: `"⚠️ Review INCONCLUSIVO — email não chegou."`
  - Se `review_final_issues` não vazio OU `unfixed_issues` não vazio (gate exibe AMBOS #1212):
    ```
    ⚠️ Problemas restantes:
    Review issues:      • {review_final_issues[0]}
    Unfixed issues:     • {unfixed_issues[0].reason}: {unfixed_issues[0].details}
    ```

  **Opções**: aprovar / regenerar newsletter / abortar.

- **Atualizar `stage-status.md` (#1217).** ⚠️ O **mark-done canônico do Stage 5 é o §5i** (#1783), que sempre roda nos dois modos antes do relatório; este passo (§5g) é pulado quando `pre_gate=true`.

### 5g-bis. Dispatch social (APÓS gate — #1501)

**Social dispatcha DEPOIS do gate.** Em uma única mensagem, disparar simultaneamente (apenas os autorizados em 5b):
1. `Bash("npx tsx scripts/publish-facebook.ts --edition-dir data/editions/{AAMMDD}/ --schedule")`
2. `Bash("npx tsx scripts/publish-linkedin.ts --edition-dir data/editions/{AAMMDD}/ --schedule")`

Aguardar ambos retornarem. Verificar dispatch:
```bash
npx tsx scripts/verify-stage-4-dispatch.ts --edition-dir data/editions/{AAMMDD}/
```

### 5h. Fechar poll É IA? (#465, #1044, #1367)

Após o editor aprovar o gate da Etapa 5 (publicação confirmada), registrar a resposta correta no Worker de votação:

```bash
if ! npx tsx scripts/close-poll.ts --edition {AAMMDD}; then
  npx tsx scripts/render-halt-banner.ts --stage "5 — Publicação" \
    --reason "close-poll falhou (ADMIN_SECRET ausente, network, ou Worker rejeitou)" \
    --action "rode \`npx tsx scripts/close-poll.ts --edition {AAMMDD}\` manualmente até exit 0, depois retome Stage 5i (sentinel)"
  exit 1
fi
```

O script `close-poll.ts` faz **sanity check automático** após o POST /admin/correct:
- GET /stats?edition={AAMMDD}
- Confirma `correct_answer` retornado == answer registrado
- Grava marker `_internal/.close-poll-done.json`

### 5h-bis. Smoke test do voto — belt-and-suspenders (#1366, #1803)

> O gate autoritativo de poll é o **§5a-poll-preflight**. Este passo pós-close-poll é redundante no caminho feliz.

```bash
npx tsx scripts/smoke-test-vote.ts --edition {AAMMDD}  # exit 2 (410/403) ou 3 (net) = halt obrigatório
```

### 5i. Escrever sentinel de conclusão (#978)

**Sempre** ao fim do Stage 5 — mesmo se publicação foi manual ou gate retornou `pending_manual`:

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 5 \
  --outputs "_internal/05-published.json"
```

**Marcar Stage 5 `done` AQUI (#1783).** Este é o ponto que **sempre** roda nos dois modos e acontece **antes** do auto-reporter/relatório. Auto-carimbo de `end` via #1789:

```bash
npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ --stage 5 --status done
```

- Sentinel ausente faz Stage 0 da próxima edição re-investigar publicação via Beehiiv API.
- Falha do sentinel → logar warn. Não bloquear.

### 5j. Pós-publicação invariants (#1007 Fase 1)

Antes do auto-reporter, validar que (a) sentinel `_internal/.step-5-done.json` foi escrito, (b) `_internal/06-social-published.json` tem `posts[]` não-vazio sem entries `failed`:

```bash
npx tsx scripts/check-invariants.ts --stage 5 --edition-dir data/editions/{AAMMDD}/
```

Exit 1 = logar warn (não bloquear auto-reporter).

---

## Etapa 5b — Auto-reporter (#57 / #79)

Após o gate da Etapa 5 (publicação paralela) aprovado, orchestrator coleta sinais da edição e apresenta gate de issues GitHub.

### 5b-0. Validar social published (#272)

Sempre, independente do exit code dos agents:
```bash
npx tsx scripts/validate-social-published.ts data/editions/{AAMMDD}/
```
Se exit != 0, incluir no relatório do gate antes de seguir. Não bloqueia o pipeline.

### 5b-1. Coletar sinais

```bash
npx tsx scripts/collect-edition-signals.ts --edition-dir data/editions/{AAMMDD}/
```
Script grava `{edition_dir}/_internal/issues-draft.json`.

- **Se `data/editions/{AAMMDD}/error.md` existir (#507):** incluir o conteúdo como contexto adicional ao disparar o `auto-reporter`.

### 5b-2. Avaliar output

Se `signals_count === 0`, logar info e pular auto-reporter.

### 5b-3. Sempre rodar (#1502)

Auto-reporter roda em **todos os modos** (interativo, `auto_approve`). É o único mecanismo de observabilidade pós-edição.

- **`auto_approve = true`**: gate do auto-reporter é auto-aprovado.
- **Modo interativo**: gate normal.

### 5b-4. Disparar auto-reporter

Se há sinais, disparar agent `auto-reporter` via `Agent` com `edition_dir` e `repo: "vjpixel/diaria-studio"`.

### 5b-5. Logar resultado

```
✅ Auto-reporter completo.
   {reported_count}/{signals_total} sinais reportados, {issues_created} novas issues criadas, {issues_commented} issues comentadas.
```

### 5b-6. Enviar relatório por email (#1510)

Último passo do pipeline:

```bash
npx tsx scripts/send-edition-report.ts \
  --edition {AAMMDD} \
  --edition-dir data/editions/{AAMMDD}/ \
  --out data/editions/{AAMMDD}/_internal/edition-report.html
```

**INVARIANTE (#1579):** Enviar via Gmail MCP `create_draft` (to: `vjpixel@gmail.com`, subject: `Diar.ia {AAMMDD} — relatório de edição`, htmlBody: `readFileSync('_internal/edition-report.html', 'utf8')` LITERAL). **NUNCA construir htmlBody programaticamente.**

**Falha não bloqueia** — logar warn e seguir.

---

## Resumo final (após auto-reporter + relatório)

Após auto-reporter, apresentar resumo consolidado da edição. **Não enumerar as issues criadas pelo auto-reporter (#1825)** — reportar só a contagem. Se alguma parte foi pulada (ex: `CHROME_MCP = false`), incluir bloco de retomada explícito:

```
🔁 Retomada manual pendente

Etapa 5a (newsletter no Beehiiv): pulado (claude-in-chrome MCP indisponível)
Etapa 5a (LinkedIn × 3): pulado (claude-in-chrome MCP indisponível)
Facebook × 3: agendado normal via Graph API ✓

Quando o MCP estiver ativo, rodar:
  /diaria-5-publicacao newsletter {AAMMDD}   # cria rascunho Beehiiv + email teste
  /diaria-5-publicacao social {AAMMDD}       # cria 3 posts LinkedIn (Facebook já agendado)
```

Se nenhum stage foi pulado, omitir esse bloco — só listar outputs e métricas finais.
