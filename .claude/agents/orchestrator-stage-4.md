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

### 4b. Confirmar modo de publicação por canal (#336)

**INVARIANTE: NUNCA dispatch publish-* agent ou script sem confirmação explícita do editor no turno atual.** Se em `auto_approve = true`, pular o gate mas registrar warn no run-log (`"Etapa 4 auto-approved: publish dispatch sem confirmação explícita"`).

Antes do dispatch, perguntar ao editor (a menos que `auto_approve = true`):

```
Modo de publicação para a edição {AAMMDD}:

  [1] Beehiiv automático  — Claude in Chrome cria rascunho + envia email de teste
  [2] Beehiiv manual      — você faz o paste no Beehiiv; arquivo: data/editions/{AAMMDD}/02-reviewed.md
  [3] LinkedIn automático — Claude in Chrome cria 3 rascunhos
  [4] LinkedIn manual     — você posta; copy: data/editions/{AAMMDD}/03-social.md
  [5] Facebook automático — Graph API agenda os 3 posts
  [6] Facebook manual     — você posta; copy: data/editions/{AAMMDD}/03-social.md

Digite os números separados por vírgula (ex: "1,3,5" pra tudo automático)
ou "all" pra automático em tudo, ou "none" pra encerrar sem publicar.
Default se não responder = manual em tudo.
```

Aguardar resposta antes de prosseguir. Registrar a escolha em `_internal/05-publish-consent.json`.
Se editor responder "none", gravar `05-published.json` com `status: "skipped_by_editor"` e encerrar Etapa 4.

### 4c. Dispatch paralelo (UMA mensagem, 3 chamadas)

**Só dispatchar os canais que o editor autorizou em 4b.** Canais manuais ficam com status `pending_manual`.

**Em uma única mensagem**, disparar simultaneamente (apenas os autorizados):
1. `Bash("npx tsx scripts/publish-facebook.ts --edition-dir data/editions/{AAMMDD}/ --schedule --skip-existing")` — Graph API, ~30s. Se `test_mode = true` e `schedule_day_offset` definido, adicionar `--day-offset {schedule_day_offset}`.
2. `Agent` → `publish-newsletter` com `edition_dir = data/editions/{AAMMDD}/`.
3. `Bash("npx tsx scripts/publish-linkedin.ts --edition-dir data/editions/{AAMMDD}/ --schedule --skip-existing")` — Worker queue + Make webhook, ~3s (#971). Se `test_mode = true` e `schedule_day_offset` definido, adicionar `--day-offset {schedule_day_offset}`.

**Tab isolation no Chrome**: `publish-newsletter` é o único agent Chrome em Etapa 4 — abre tab Beehiiv própria via `tabs_create_mcp`. LinkedIn (publish-linkedin.ts) e Facebook (publish-facebook.ts) são scripts shell sem browser.

**LinkedIn route — Worker queue + fallback Make (#887):** `publish-linkedin.ts` prefere o Cloudflare Worker `diaria-linkedin-cron` quando `cloudflare_worker_url` + `DIARIA_LINKEDIN_CRON_TOKEN` estão configurados E `scheduled_at` é futuro. Worker enfileira em KV e dispara o webhook Make no horário agendado. **Se o Worker falhar todos os retries** (503, KV down, deploy quebrado), o script cai automaticamente em `postToMakeWebhook` — Make posta **imediatamente** (ignora `scheduled_at`). Entry resultante traz `status: "draft"` (post live, sem agendamento futuro) + `fallback_used: true` + `fallback_reason: "{HTTP NNN: ...}"` (sanitizado, max ~110 chars) para auditoria. Política: post real > post falhado.

**Editor vê (gate 4g) — visibilidade do fallback:**
- `data/run-log.jsonl` entry com `level=warn` + `message=worker_fallback` (timestamp BRT + reason sanitizado).
- `_internal/06-social-published.json` entries do LinkedIn com `fallback_used: true` + `fallback_reason` + `status: "draft"` (não "scheduled" — Make postou imediato).
- Status final no relatório de Stage 4 (`4g`): destaca posts com `fallback_used` para revisão.

Se o agendamento era crítico, editor pode deletar o post no LinkedIn e re-rodar `/diaria-4-publicar social` quando o Worker voltar.

**Aguardar todos os 3 retornarem** antes de prosseguir. Falha/retry de um agent não bloqueia o outro (4d).

`publish-linkedin.ts` grava direto em `06-social-published.json` via store atomica (#918) — sem tmp file pra merge. `publish-facebook.ts` faz o mesmo.

### 4d. Retry chrome_disconnected (só publish-newsletter)

Apenas `publish-newsletter` usa Chrome em Etapa 4. LinkedIn (publish-linkedin.ts) e Facebook (publish-facebook.ts) são scripts shell sem browser — falhas viram exit code do script, não `chrome_disconnected`.

Se `publish-newsletter` retornar `error: "chrome_disconnected"`:
1. Calcular delay: `30 * 2^(N-1)` segundos (tentativa 1 = 30s, 2 = 60s, 3 = 120s, 4 = 240s, 5 = 480s, 6 = 960s, 7 = 1920s, 8 = 3840s, 9 = 7680s, 10 = 15360s). Via `Bash("node -e \"process.stdout.write(String(30 * Math.pow(2, {N}-1)))\"")`.
2. Logar warn: `"chrome_disconnected em Etapa 4 (publish-newsletter), tentativa {N}/10 — aguardando {delay}s antes de re-disparar"`.
3. Aguardar: `Bash("sleep {delay}")`.
4. Re-disparar publish-newsletter com mesmos parâmetros.
5. Se repetir, repetir do passo 1 incrementando N.
6. **Após 10 falhas consecutivas** (~17h acumuladas), logar erro e pausar:
   ```
   🔌 Claude in Chrome desconectou 10 vezes seguidas em publish-newsletter (Etapa 4).
      Verifique Chrome aberto + extensão Claude in Chrome ativa.
      ⚠️ Rascunho parcial no Beehiiv pode existir — delete antes do retry.
      Responda "retry" pra mais 10 tentativas, ou "skip" pra pular este agent.
   ```
- **Reset do contador**: re-dispatch que sucede (mesmo se falhar por outro motivo depois) reseta N=1.
- Erros que **não** sejam `chrome_disconnected` (ex: login expirado, template errado) interrompem o loop e são tratados normalmente.
- Se `publish-newsletter` retornar `error: "beehiiv_login_expired"` ou similar, pausar com instrução de re-logar (ver `docs/browser-publish-setup.md`).
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
  3. Se retornar `status: "email_not_found"`, logar warn e **sair do loop** (email pode ter demorado; não é um problema do rascunho).
  4. Se `issues` estiver vazio: **sair do loop** — email aprovado automaticamente.
  5. Se `issues` não estiver vazio:
     - Logar: `"review-test-email encontrou {N} problemas na tentativa {attempt}/10"`.
     - Disparar `publish-newsletter` em **modo fix** passando:
       - `edition_dir`
       - `mode: "fix"`
       - `draft_url`
       - `issues` (a lista do reviewer)
     - Se retornar `unfixable_issues[]` não vazio, logar warn e **sair do loop** — correção manual necessária.
     - Caso contrário, continuar para a próxima iteração (re-verificar o email reenviado).

  Após 10 iterações sem sucesso, logar warn: `"Loop de verificação atingiu 10 tentativas sem resolver todos os issues"`.

  Armazenar resultado final: `test_email_check = { attempts: N, final_issues: [...], auto_fixed: true/false }`.

- **Gravar resultado da revisão em `05-published.json` (obrigatório).** Ler `05-published.json`, adicionar/atualizar os campos:
  - `review_completed: true`
  - `review_attempts: N`
  - `review_final_issues: [...]` (vazio se tudo OK)

  Salvar com `Write`. O campo `review_completed` é usado na lógica de **resume** — sem ele `true`, o resume re-executa o loop de review.

- Ler `05-published.json` (pode ter sido atualizado pelo fix mode).

### 4f-bis. Verify dispatch — confirma destinos reais (#917)

**Roda APENAS se houve dispatch de social** (consent-check em 4b incluiu Facebook automatico OU LinkedIn automatico). Se ambos foram manual ou skipped, pular essa secao.

```bash
npx tsx scripts/verify-stage-4-dispatch.ts --edition-dir data/editions/{AAMMDD}/
```

O script:
- Le `_internal/06-social-published.json` (entries de FB + LinkedIn).
- Pra cada FB entry com `fb_post_id` e status != "failed": GET Graph API
  `/{post_id}?fields=is_published,scheduled_publish_time,...` confirmando
  que o post existe + esta agendado/publicado conforme esperado.
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
- `2` -> erro de input (arquivo missing, env missing). Logar warn,
  prosseguir sem o bloco no gate (editor ainda revisa social manualmente).

⚠️ **Por que nao bloquear automaticamente?** Editor pode aceitar publicacao
parcial (ex: 1 post LinkedIn falhou mas os outros 5 estao OK), e force-block
travaria a edicao. O relatorio no gate da visibilidade — editor decide.

### 4g. Gate único

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

  **Newsletter (Beehiiv)**
  - URL do rascunho Beehiiv (`draft_url`)
  - Confirmação de envio do email de teste para `test_email_sent_to`
  - Template usado (`template_used`)
  - **Resultado da verificação do email de teste:**
    - Se `final_issues` vazio: `"✅ Email de teste verificado ({attempts} tentativa(s)) — nenhum problema detectado."`
    - Se `final_issues` não vazio:
      ```
      ⚠️ Problemas restantes após {attempts} tentativa(s):
         • {issue 1}
         • {issue 2}
      Corrija manualmente no rascunho antes de publicar.
      ```

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

  **Upload manual de imagens (gate obrigatório, só para newsletter)** — as imagens do email de teste do Beehiiv são placeholders (localhost). Editor DEVE subir as imagens no Beehiiv antes de aprovar:
  ```
  📎 Suba as imagens no rascunho do Beehiiv ANTES de aprovar:
     • Cover/Thumbnail → 04-d1-2x1.jpg (1600×800)
     • Inline D1  → 04-d1-2x1.jpg
     • Inline D2  → 04-d2-1x1.jpg
     • Inline D3  → 04-d3-1x1.jpg
     • É IA? (A)  → 01-eia-A.jpg
     • É IA? (B)  → 01-eia-B.jpg
     📁 Arquivos em data/editions/{AAMMDD}/ ou no Drive.
  ```
  Social posts não exigem upload manual — Facebook foi via Graph API com upload já feito; LinkedIn drafts têm imagens já anexadas pelo agent.

  **Instrução**: "Suba as imagens no Beehiiv, reenvie o email de teste pra conferir, revise os 6 social drafts no dashboard de cada plataforma, e só então aprove. Posts agendados serão publicados automaticamente no horário."

  **Opções**:
  - aprovar (segue para auto-reporter)
  - regenerar newsletter (re-dispatch `publish-newsletter`)
  - regenerar social (re-dispatch `publish-facebook` + `publish-linkedin`, com `--skip-existing` pra resume-aware)
  - regenerar tudo (volta a 4b)
  - abortar

- **Atualizar `_internal/cost.md`.** Append linha unificada na tabela da Etapa 4, recalcular `Total de chamadas`, gravar:
  ```
  | 4 | {stage_start} | {now} | publish_newsletter:1, publish_facebook:1, publish_social:1, review_test_email:{review_attempts} | 0 | {3 + review_attempts} |
  ```

### 4h. Fechar poll É IA? (#465)

Após o editor aprovar o gate da Etapa 4 (publicação confirmada), registrar a resposta correta no Worker de votação:

```bash
# Closes the É IA? poll by registering the correct answer to the Worker
# This enables retroactive score updates and % display in next edition
npx tsx scripts/close-poll.ts --edition {AAMMDD}
```

- `POLL_SECRET` deve estar em `.env`. Se não estiver definido, o script emite warn e encerra graciosamente — não bloqueia o pipeline.
- Logar resultado: se exit 0, `"poll fechado para edição {AAMMDD}"`. Se exit != 0, `warn: "close-poll falhou (POLL_SECRET ausente ou erro de rede) — fechar manualmente via /admin/correct"`.

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

### 4b-3. Modo test/auto_approve

- **Se `test_mode = true`**: **pular auto-reporter aqui** (orchestrator). O Stage final do `/diaria-test` (#519) roda `collect-edition-signals.ts --include-test-warnings` + `auto-reporter` com `test_mode: true` por conta própria, capturando regressões silenciosas que viram issues automáticas com label `from-diaria-test`. Não duplicar o trabalho.
- **Se `auto_approve = true` mas `test_mode = false`** (ex: `/diaria-edicao --no-gates`): pular o auto-reporter inteiramente. Criação automática só é aceitável no fluxo de teste.

### 4b-4. Disparar auto-reporter

Se há sinais e não é test_mode, disparar agent `auto-reporter` via `Agent` com:
- `edition_dir`
- `repo: "vjpixel/diaria-studio"`

Agent faz dedup contra GitHub issues abertas, apresenta gate humano ("aprovar 1,2,3 / skip / edit N"), executa ações aprovadas. Ver `.claude/agents/auto-reporter.md`.

### 4b-5. Logar resultado

Append em `_internal/cost.md` uma linha pro stage final, e gravar resumo:
```
✅ Auto-reporter completo.
   {reported_count}/{signals_total} sinais reportados, {issues_created} novas issues criadas, {issues_commented} issues comentadas.
```

Se o agent retornar `action: "fallback_md"` (GitHub MCP indisponível), mostrar o path do MD gerado e instruir: "GitHub MCP falhou. Abra `{md_path}` e crie as issues manualmente quando tiver tempo."

---

## Resumo final (após auto-reporter)

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
