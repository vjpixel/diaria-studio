---
name: orchestrator-stage-5
description: Detalhe da Etapa 5 (publicacao auto — rascunho Kit + social agendado) do orchestrator diar.ia.br. ZERO interacao humana. Lido pelo orchestrator principal durante a execucao — nao e um subagente invocavel diretamente.
---

> Este arquivo e referenciado por `orchestrator.md` via `@see`. Nao executar diretamente.

---

## Etapa 5 — Publicacao (auto, ZERO interacao) — #38 / #1694

Stage 5 e **dispatch puro** — sem gate proprio. O gate de revisao editorial esta no Stage 4; o gate de agendamento esta no Stage 6 (Agendamento).

> **Fusao 5+6 (#7983, 11/09/2026).** Desde esta issue o Stage 5 e o Stage 6 rodam numa INVOCACAO SO: ao terminar este playbook, continue lendo `orchestrator-stage-6.md` na mesma sessao (ver §"Resumo apos Stage 5" no fim deste arquivo). Os dois stages seguem SEPARADOS em tudo que e estado — numeracao, sentinels, invariants, `find-current-edition --stage 5|6`, statusline, Studio; o que foi fundido e so o ponto de entrada. `/diaria-6-agendamento` continua existindo como porta de RETOMADA (sessao morreu depois do dispatch, ou retry do agendamento).

Primeiro abre o PR da pagina do site (§5b-site, #10160 — sem esperar o merge). Depois, quatro acoes em paralelo: (1) criar o rascunho da newsletter no Kit + enviar test email + rodar loop review; (2) LinkedIn agendado; (3) **Facebook AGENDADO** (`--schedule`); (4) **canal Brevo diária** (`brevo_diaria`) — cria a campanha como RASCUNHO (#5772), agendamento fica pro Stage 6, mesma divisão da newsletter.

**Beehiiv = só arquivo histórico (#11225, decisão do editor 27/10/2026).** A conta segue ativa (posts, site, estatísticas, assinantes arquivados), mas não envia nada desde #7388 e o pipeline não depende dela: conector Beehiiv fora do ar nunca bloqueia este stage. O ramo `publishing.newsletter.backend = "beehiiv"` (Passo 5c-1 abaixo) é legado, só alcançável com a chave EXPLICITAMENTE em `"beehiiv"` — chave ausente é `"kit"` — e sai do playbook numa limpeza dedicada.

**PARA antes do Schedule da newsletter** — ela fica como RASCUNHO com test email enviado e o loop review concluido. O Schedule NAO acontece no Stage 5 — e responsabilidade do Stage 6.

Output: `newsletter-kit-published.json` (broadcast_id + test_sent_at + status; `05-published.json` só no ramo Beehiiv legado) + `06-social-published.json` (social dispatched). Sentinel `.step-5-done.json`.

LinkedIn nao usa Chrome — Cloudflare Worker enfileira em KV e dispara Make webhook no horario agendado (#971).

**`{EDITION_DIR}` (#2463/#3025):** diretorio REAL da edicao no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edicao foi criada. Resolver **uma vez**, logo apos ter `{AAMMDD}`, e usar em todo path abaixo — nunca montar `data/editions/` + `{AAMMDD}` a mao:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

**`CHROME_MCP` (#5414):** ler o sinal de saude do Claude in Chrome MCP apurado pelo Stage 0, do disco em vez de memoria de sessao (este stage roda com frequencia como sessao nova via `/diaria-5-publicacao`):
```bash
npx tsx scripts/lib/preflight-state.ts --edition-dir {EDITION_DIR} --read
```
Extrair `chromeMcp` do JSON retornado. **Com backend Kit (o default) a newsletter nao depende do Chrome** — `chromeMcp === false` so troca o teste pela UI do Kit pelo fallback `--send-test` (§5c-1-kit); o resto deste paragrafo vale so pro ramo Beehiiv legado. Se `chromeMcp === false`: **re-probar** (`mcp__claude-in-chrome__tabs_context_mcp`) antes de decidir — o preflight pode ter rodado ha horas (edicao retomada). Se o probe atual falhar tambem: pular o Passo 5c-1 (Newsletter Beehiiv) direto, gravar `_internal/05-published.json` com `status: "skipped"` e LinkedIn entries com `status: "pending_manual"` — nao falhar o stage inteiro por causa disso. Se o probe atual suceder (preflight estava desatualizado): prosseguir normal e regravar o sinal (`--chrome-mcp true`) para refletir o estado atual. `null` (arquivo ausente — edicao pre-#5414) tem a mesma semantica permissiva de sempre: probar direto, sem pre-warn.

### Pre-condicao: sentinel Stage 4

<!-- outputs must match the `write` call at the end of orchestrator-stage-4.md §Escrever sentinel de conclusao do Stage 4 -->
```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 4 \
  --outputs "02-reviewed.md,03-social.md"
```

Exit code handling:
- `0` → continuar.
- `1` → **ANTES do FATAL (#11690):** rodar `npx tsx scripts/stale-edition-guard.ts check --edition-dir {EDITION_DIR} --step 4`; exit 4 (outra máquina à frente, data/ defasado) → halt banner "data/ possivelmente defasado, aguardar o sync do OneDrive" (saída se a outra sessão morreu ou sentinel/outputs foram removidos de propósito: o editor confirma e re-roda o guard com `--force`) e NÃO mandar re-rodar `/diaria-4-revisao`. Qualquer outro exit ≠ 0 (2, crash) = mesmo halt. Exit 0 → **FATAL:** "Etapa 4 (Revisao) nao completou (sentinel ausente). Re-rodar `/diaria-4-revisao {AAMMDD}` antes de continuar." Parar.
- `2` → **ANTES do FATAL (#11690):** rodar `npx tsx scripts/stale-edition-guard.ts check --edition-dir {EDITION_DIR} --step 4 --outputs-missing`; exit 4 → halt banner "data/ possivelmente defasado, aguardar o sync do OneDrive" (saída: editor confirma e re-roda o guard com `--force`) e NÃO recomendar re-rodar Stage 4. Qualquer outro exit ≠ 0 (2, crash) = mesmo halt. Exit 0 → **FATAL:** "Outputs do Stage 4 ausentes. Re-rodar Etapa 4." Parar.
- `3` → logar warn (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level warn --message "stage4_sentinel_missing_legacy"`), continuar.

### 5a. Pre-requisitos + sync

**Marcar Stage 5 `running` no inicio (#1783).** Garante o `start` pra que o `done` do §5h feche a duracao no relatorio. Sem `--start` — auto-carimbo (#1789) preserva o original em resume:
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 5 --status running
```

**⚠️ MCP fail-fast (#738):** Durante qualquer passo desta etapa, se um `<system-reminder>` do runtime indicar que claude-in-chrome ou gmail MCP ficou offline, **parar imediatamente** (a Beehiiv nao entra, #11225: so arquivo historico — desconexao dela e warn, nunca halt), logar via:
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
Nunca aguardar passivamente. Este stage depende de gmail (review-test-email) e, so quando o teste do Kit vai pela UI ou no ramo Beehiiv legado, de claude-in-chrome. Disconnect de qualquer um exige acao explicita do editor. Os logs persistem em `data/run-log.jsonl` para auditoria pelo `collect-edition-signals.ts` (#759).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

- Logar inicio:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level info --message 'etapa 5 publicacao started'
  ```
- (Edicoes antigas pre-#192 usam `01-eia-real.jpg`/`01-eia-ia.jpg`.)
- **Staleness check (#120):**
  ```bash
  npx tsx scripts/check-staleness.ts --edition-dir {EDITION_DIR}/ --stage 6
  ```
  (mantem `--stage 6` por compat com o config existente — o check valida downstreams do Stage 3/4 vs `02-reviewed.md`). Exit code 0 = ok. Exit code 1 = pausar com a mensagem de re-run de Stage 3/4.
- Verificar pre-requisitos: `02-reviewed.md`, `01-eia.md`, `01-eia-A.jpg` + `01-eia-B.jpg` (ou legacy `01-eia-real.jpg` + `01-eia-ia.jpg` em edicoes pre-#192), `03-social.md`, `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`. Se algum faltar, pausar e instruir qual stage re-rodar.
- **Pre-dispatch invariants (#1007 Fase 1).** Validar que `06-public-images.json` esta populado e env vars criticas (`DIARIA_LINKEDIN_CRON_URL`, `DIARIA_LINKEDIN_CRON_TOKEN`, `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN`) estao setadas. `INSTAGRAM_BUSINESS_ACCOUNT_ID` + `INSTAGRAM_ACCESS_TOKEN` sao checadas como **warning** (#49 — ausencia pula Instagram, nao bloqueia os demais canais). Falha (error) = abort imediato — evita DLQ recurrence (histórico: `docs/orchestrator-stage-narrative-history.md#stage-5-dlq-incident`). **`--phase pre-dispatch` obrigatorio aqui (#4516)** — sem essa flag, `social-published-complete`/`step-5-sentinel-exists` (regras `postDispatchOnly`, so podem passar DEPOIS que o dispatch ja rodou) retornam `error` SEMPRE neste ponto, mesmo com env vars/imagens 100% corretas, e travariam a Etapa 5 na 1a tentativa se lidas ao pe da letra ("error = abort imediato"):
  ```bash
  npx tsx scripts/check-invariants.ts --stage 5 --phase pre-dispatch --edition-dir {EDITION_DIR}/
  ```
  Exit 1 = pausar com violations no stderr. Editor corrige (rodar `upload-images-public.ts` se imagens faltam, configurar env vars) e re-roda.

  **`pending-research-unresolved` (#4990) — WARNING explícito, nunca pausa.** Se a lista de violations incluir essa regra, é o sinal de que o editor pediu pesquisa nova (USE MELHOR ou outro bucket) no gate do Stage 4 e ela ainda não foi integrada — ver marker `_internal/pending-research.json` (`scripts/lib/pending-research.ts`, escrito por `orchestrator-stage-4.md` §4d.1 passo 0). Diferente das demais violations desta seção (que o editor corrige e re-roda), esta é sempre logada e sempre segue no dispatch — o objetivo é só garantir que a lacuna NUNCA fique silenciosa (histórico: `docs/orchestrator-stage-narrative-history.md#stage-5-pending-research-incident`). Ação obrigatória quando aparecer:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level warn \
    --message "pending-research-unresolved: pesquisa pedida no gate Stage 4 ainda nao integrada" \
    --details '{"kind":"pending_research_unresolved"}'
  ```
  Incluir a mesma mensagem (bucket + pedido original, do texto da violation) como linha explícita no resumo final "Publicação dispatchada" (§ "Resumo apos Stage 5" no fim deste arquivo) — ex: `⚠️ Pesquisa pendente: {bucket} — "{pedido}" (pedida {timestamp}) — seção pode ter saído incompleta.`

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
  --details '{"channels":["newsletter","linkedin","facebook","instagram","threads","brevo"]}'
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
  --details '{"source":"default_auto","channels":["newsletter","linkedin","facebook","instagram","threads","brevo"]}'
```

**#1238 trade-off atualizado em #1380**: O user-activation guard do Beehiiv **so atinge o click de Schedule** — nao o "Send test email". Validado em 260519 (4x test emails enviados consecutivamente via Chrome MCP). O trigger correto pra Send test email e o **chevron dropdown** ao lado do botao Preview:

1. Achar popover `.hidden.absolute` que contem o button "Send test email"
2. Achar sibling `.relative.z-0` com 2 buttons (`Preview` + chevron sem texto)
3. Clicar o chevron — popover abre
4. Clicar "Send test email" — toast `Test email sent` aparece

**Schedule continua sendo do Stage 6** (gate humano + automacao).

### 5b-site. PR da pagina do site — PRIMEIRA acao do dispatch, sem esperar o merge (#10160)

**Antes de qualquer publisher (newsletter, social, Brevo/Kit) e independente de `--skip`** — o site nao e canal de consent. Era §6b-site; subiu pra ca porque e o passo mais lento (abre o PR, CI de ~12min, merge) e no fim travava a sessao. Agora ele so ABRE o PR (worktree isolado, `site-publish/{slug}`, mecanismo em `docs/site-page-publish-mechanism.md`) e devolve na hora: com `--no-wait-merge` o script faz 1 poll e, CI pendente, entrega o merge ao waiter em background (#9593). O resto da Etapa 5 roda enquanto CI e review andam. O slug sai de `--slug-from-d1` (`seoSlug` do titulo do D1, o mesmo link de WhatsApp que o pre-render do Stage 4 ja cravou no e-mail; no Beehiiv, §6b-slug confere depois). So depende de `_internal/newsletter-final.html` (Stage 4):
```bash
npx tsx scripts/publish-edition-site-page.ts --edition-dir {EDITION_DIR} --slug-from-d1 --sitemap workers/site/public/sitemap.xml --no-wait-merge
npx tsx scripts/reconcile-site-sitemap.ts
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level {info se 0/2, warn se 3/4/5} --message "site-page stage5 PR: exit {code}"
```
O script grava em `_internal/site-page-published.json` o registro que o Stage 6 le: `prNumber`, `prUrl`, `status` (`open` | `merged` | `none`), `published`, `code`. **Nada aqui espera o merge e nenhum exit para a Etapa 5** (tabela de exits em `orchestrator-stage-6.md` §6b-site) — falha vira warn e segue; o Stage 6 re-roda a publicacao como fallback e TRAVA o fim da Etapa 6 no merge (§6c-site + invariante `site-page-pr-merged`).

### 5b-youtube. Video horizontal do dia: Drive para YouTube, fail-soft (#10659)

**Antes do dispatch social (5c-3)**, em TODA execucao da Etapa 5 (no-op barato quando o video ja subiu). **Gate:** so com escopo `all` (default) ou `social` — nunca em `/diaria-5-publicacao newsletter` — E `consent.youtube` em `_internal/05-publish-consent.json` igual a `"auto"` ou ausente (ausente = auto). `"manual"` (`--skip youtube`) e `"skipped"` (`none`) desligam. Mesma regra de `youtubeUploadEnabled` em `scripts/lib/publish-consent.ts`. **Nunca para a Etapa 5**: qualquer falha vira warn e o dispatch segue.
- **Ja publicado** (`_internal/05-youtube-published.json` existe com `videoId`, o editor rodou `/diaria-publica-video` ou um resume): o fetch detecta sozinho (`action: "already-published"`, sem tocar no Drive) e o `stage5-youtube.ts` registra `outcome: "already-published"` sem upload.
- **Link colado pelo editor** (#11222, fluxo real desde 261027: o editor sobe pelo Studio e o `/diaria-publica-video` grava `_internal/05-video-url.txt` com `link-video-d1.ts --save`): o `stage5-youtube.ts` ve o arquivo e registra `outcome: "already-published"` com o `video_url`, sem buscar no Drive nem subir (senao subiria um 2o video a partir do `_Youtube_` da pasta `Final/`). O conteudo passa pelo `parseD1VideoUrlFile` (#11297): arquivo presente que nao e link do YouTube vira `outcome: "needs-editor"`, sem buscar nem subir.
- **Video em `Final/` sem o link colado** (#11297): o `_Youtube_` de `Final/` sobe pelo Studio, nunca sozinho daqui. O `stage5-youtube.ts` consulta o fetch em `--dry-run` (nada baixado) e, se o arquivo escolhido esta em `Final/`, registra `outcome: "awaiting-link"` sem upload; o resumo diz "YouTube: aguardando o link do Studio → `link-video-d1.ts {AAMMDD} --save`". Subir pela API a partir de `Final/` so com `--upload-from-final` no comando, e so quando o editor pedir. Edicao sem `Final/` (subpasta ou raiz com "final" no nome) segue o upload automatico.
- **Ja no canal sem registro** (#11080, editor subiu a mao no Studio): o `--upload` confere os uploads recentes do canal antes de abrir a sessao; se a edicao ja tem video la (AAMMDD/`utm_campaign` na descricao, titulo do D1, ou `publishAt`/`publishedAt` no dia BRT da edicao — titulo e dia nao valem se a descricao traz `utm_campaign` de OUTRA edicao, e video com `uploadStatus` falho nunca conta, #11103), NAO envia, grava `05-youtube-published.json` com `source: "already-on-channel"` + o link do D1, exit 0 (`skipped: true`), e o resumo diz "YouTube: ja no canal (`url`)". **Reconhecido SO pelo dia (#11132)** — sem AAMMDD, `utm_campaign` nem o titulo do D1 (pode ser live ou video avulso): exit 1 sem enviar e sem gravar registro nem link (warn); o resumo leva a `url` do log e as duas saidas do editor, `--accept-period-match` (e o video da edicao: registra + link no D1) ou `--force` (nao e: sobe) — nunca passar nenhuma das duas daqui. Falha ao conferir o canal = exit 1 sem enviar (warn). `--force` pula a conferencia.
```bash
npx tsx scripts/stage5-youtube.ts {AAMMDD} --edition-dir {EDITION_DIR}   # Bash timeout: 600000
```
**Um comando so (#10659, 261026: o passo em dois comandos foi pulado sem ninguem notar).** `stage5-youtube.ts` aplica o gate de consent acima (`youtubeUploadEnabled`), roda `fetch-drive-video.ts --orientation horizontal` (antes em `--dry-run`, sem `--upload-from-final`, #11297) e, com `downloaded`/`exists`, `publish-youtube.ts --upload`; grava SEMPRE `_internal/05-youtube-step.json` (`outcome`: `consent-off`, `already-published`, `no-video`, `needs-editor`, `awaiting-link`, `fetch-error`, `uploaded`, `upload-error`, mais `video_url`/`state` relido e `d1_link`) e o `log-event` do passo, e sai 0 em todo desfecho (o motivo vem no JSON do stdout; os detalhes de cada script, no stderr). A invariante `youtube-step-ran` (§5i) acusa a edicao com consent auto sem esse registro. Rodar SEMPRE, mesmo quando parece no-op. A chamada leva `timeout: 600000` explicito no Bash (download e upload de video passam do default de 2 min). **Timeout do Bash = warn, sem upload** (o `.part` do fetch nao vira arquivo final; um upload interrompido deixa o sentinel `in_progress` e o `publish-youtube.ts` recusa repetir sem `--force` — levar ao resumo, nunca `--force` daqui).
- **fetch** (pasta `publishing.youtube.drive_folder_id`; com `.mp4` em `{AAMMDD}/Final/` so ela conta e vale o `_Youtube_` do nome, #11222; sem `Final/`, criterio do editor 25/10/2026: `.mp4` com "final" como PALAVRA no nome, proporcao horizontal; subpasta `{AAMMDD}/` presente → so ela, sem janela; ausente → solto na raiz nas ultimas 36h): exit 0 `downloaded`/`exists` → upload; exit 0 `already-published` → sem upload; exit 0 `none` → sem upload, resumo "YouTube: sem video no Drive (`reason`), rodar `/diaria-publica-video {AAMMDD}` quando subir"; exit 3 `needs-editor` → **nao escolher**, sem upload, levar ao resumo id + nome + `modifiedTime` de cada item de `candidates`/`files` (2+ "final" horizontais, ou "final" sem proporcao) ou os ids de `folders` (2+ subpastas `{AAMMDD}`); exit 1 (pasta inacessivel pela conta OAuth, rede, OAuth `oauth-setup.ts`) / exit 2 (config) → sem upload, warn com o `error`.
- **upload** ENVIA `publishAt` 06:00 BRT (agendado; ja passou → publica na hora, com `[premissa]`). Medido em 23/10/2026: o `1cmrW1Z7r5s` ficou publico sozinho no horario. Sem `04-youtube-thumb.jpg` (capa aprovada no `/diaria-publica-video` Passo A2) sai com a capa automatica do YouTube: dizer no resumo. Exit 1 → warn com a mensagem do script.
- **Link do D1 (#10960, #11104):** o `publish-youtube.ts` grava `_internal/05-video-url.txt` depois de todo upload aceito, **inclusive** com o video ainda privado, agendado para depois do D1 ou `unknown` — nesses casos so loga `[aviso] video ainda pode nao abrir para o leitor: ... O link sera incluido no D1 mesmo assim (#10960)`. Nao grava so quando o YouTube marcou `failed`/`rejected`/`deleted` (exit 1) ou quando o arquivo ja aponta pra outra URL posta a mao (mantida). Conferir o arquivo e o log depois do upload: existe → o 5c-3 poe o link no D1 de X, Threads e Facebook; se o log trouxe esse `[aviso]`, o resumo diz que o link JA esta no D1 e que o editor precisa publicar o video no Studio antes do horario do D1 (senao o leitor cai num video que nao abre). Ausente → o D1 sai sem link, e o resumo aponta `npx tsx scripts/link-video-d1.ts {AAMMDD} --save`.
- **Resumo** (autoridade sobre o link do D1): uma linha "YouTube:" com o caso — `already-published`, enviado agendado (`url` + `state` RELIDO do JSON do `--upload`, #573), enviado publicado, `none`, `needs-editor`, erro — e "link no D1: gravado" (com "publicar no Studio antes do D1" quando o upload avisou que o video ainda nao abre) ou "nao gravado → `link-video-d1.ts`". O `log-event` do passo ja sai do `stage5-youtube.ts` (nao logar de novo). O vertical segue no `/diaria-publica-video` Parte B (`fetch-drive-video.ts --orientation vertical` so imprime o `next_command`, sem baixar).

### 5c-pre. Upload de imagens publicas (#999 fix — pre-requisito do dispatch)

**ANTES** do dispatch paralelo, se LinkedIn ou Facebook automatico foram autorizados em 5b, rodar upload-images-public.ts pra popular o cache `06-public-images.json` com URLs Cloudflare KV (d1/d2/d3 vao pro KV desde #2147):

```bash
npx tsx scripts/upload-images-public.ts --edition-dir {EDITION_DIR}/ --mode social
```

**Carrossel do 4º post defasado é regerado aqui (#10834).** Se o `## um` mudou depois do Stage 3, o proprio upload regera o carrossel (`refreshStaleUseMelhorCarousel` em `gen-carousel-cards.ts`) antes de subir os slides — nao rodar `gen-carousel-cards.ts` a mao. O JSON de saida traz `use_melhor_carousel.status`: `regenerated` → seguir; `skipped`/`failed` → o 4º post vai ser pulado no LinkedIn/Instagram/Facebook — levar o `reason` pra linha "4º post" do resumo abaixo (nunca silencioso). Com `use_melhor_carousel.cause: "font_missing"` (#10879 — Georgia ausente nesta maquina, caso do servidor 300) a linha diz isso com todas as letras e leva o conserto do warning (regerar numa maquina com Georgia + re-subir), nunca so "falhou". Nao e halt: o 4º post e fail-soft; o gate do Stage 4 ja acusa o caso pela invariante `use-melhor-carousel-stale`.

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

**ORDEM OBRIGATORIA (#2454): newsletter ANTES do social.** `{edition_url}` e gravada em `_internal/05-edition-url.txt` pelo passo da newsletter — com backend Kit, `publish-newsletter-kit.ts` grava `https://diar.ia.br/p/{seoSlug(titulo do D1)}` (#7420, a pagina propria do site, publicada por `publish-edition-site-page.ts` no §5b-site; nunca o `public_url` do broadcast Kit; backstop `resolve-edition-url.ts` no 5c-2). Na era Beehiiv ela vinha do slug do draft — por isso a ordem nasceu. O passo 5c-2 (abaixo) reescreve `03-social.md` inteiro substituindo `{edition_url}` — inclusive dentro do `## post_pixel`. **#3646:** o dispatch de Stage 5 (`publish-linkedin.ts`/`publish-facebook.ts`) em si nao consome mais `{edition_url}` pra nada — o main post do LinkedIn nao carrega URL (#595) e o `comment_diaria` que antes precisava dela foi aposentado (#3627). Os consumidores reais de `05-edition-url.txt` sao o `# Curto` (X/Threads, inclusive o `## um` do 4º post, #9568) e o `## post_pixel` de edicoes ANTIGAS (aposentado na #9568; o post pessoal inteiro saiu do Stage 6 na #11398). Disparo em paralelo causava fallback silencioso pra `https://diar.ia.br` (raiz) quando `05-edition-url.txt` ainda nao existia. A partir de #2454, o fluxo e sequencial: rascunho da newsletter → resolve URL → dispatch social.

**Branch por backend (#464).** Ler `publishing.newsletter.backend` de `platform.config.json` (default `"kit"` se ausente, #11225 — mesmo de `parseNewsletterBackend` em `scripts/lib/newsletter-backend.ts`). Se `"kit"` ou ausente → pular **todo** o Passo 5c-1 abaixo (Beehiiv, legado) e seguir o **Passo 5c-1-kit** logo em seguida; só com `"beehiiv"` EXPLÍCITO → seguir o Passo 5c-1 e pular o 5c-1-kit. Em qualquer um dos dois casos, o Passo 5c-2 (guard anti-placeholder) roda igual depois — ele só depende de `_internal/05-edition-url.txt` existir, não de quem o escreveu.

**Passo 5c-1: Newsletter Beehiiv (LEGADO — só com `backend: "beehiiv"` explícito; a conta é arquivo histórico desde #11225, este passo sai numa limpeza dedicada).**

**Newsletter Beehiiv (#1054 / #207 / #1114 / #1327)**: voce (top-level) **le `context/publishers/beehiiv-playbook.md` como playbook e executa direto** — Bash + Read + `mcp__claude-in-chrome__*` (incluindo `javascript_tool`). Seguir o playbook **criando o rascunho e enviando o test email** — **NAO executar o passo de Schedule do Beehiiv** (§9-10 do playbook). O draft fica como rascunho com test email enviado. **Nao tente dispatchar via `Agent`** — `javascript_tool` e restrito ao top-level. **Estado da Fase 3 (fetch in-page do Worker): `context/publishers/beehiiv-playbook.md` §Fase 3 é a fonte única de verdade — não duplicar o diagnóstico aqui (#4196).** Resumo operacional: desde #4196 o fetch roda com timeout explícito (`AbortController`, 25s) e qualquer falha — HTTP não-2xx, timeout/abort, exceção de rede — aciona o fallback chunked base64 automaticamente via `classifyInsertResult`, sem seleção manual; o corpo inserido também é verificado quanto a tamanho plausível pós-paste (`verifyBodySizePlausible`) antes de declarar sucesso. Editor finaliza metadata na UI. Ver `context/publishers/beehiiv-playbook.md` para instruções detalhadas. Output: `_internal/05-published.json`.

Playbook ja grava `_internal/05-edition-url.txt` (ver §"Gravar 05-edition-url.txt" no beehiiv-playbook.md). Se por qualquer razao o playbook nao gravou, gravar manualmente:

```bash
npx tsx scripts/resolve-edition-url.ts \
  --edition-dir {EDITION_DIR}/ \
  --title "{titulo_d1}"
# Usa seoSlug(titulo) — mesmo algoritmo de 4a-bis do beehiiv-playbook (§"Setar slug SEO").
# Se o titulo nao estiver disponivel, usar --slug {slug_correto} ou --edition-url {url_literal}.
```

**Tab isolation no Chrome**: publish-newsletter e o unico agent Chrome em Etapa 5 — abre tab Beehiiv propria via `tabs_create_mcp`. LinkedIn e Facebook sao scripts shell sem browser.

**Passo 5c-1-kit: Newsletter Kit (#464 — o caminho padrão: `publishing.newsletter.backend` `"kit"` ou ausente, #11225).**

`scripts/publish-newsletter-kit.ts` cria/atualiza o draft via Kit broadcasts API. O e-mail de teste tem dois caminhos (#10395, avaliação dos 5 caminhos na #10307):

- **Preferido — "Send test email" da UI do Kit (Claude in Chrome disponível, máquina do editor).** Testa o PRÓPRIO broadcast real, ainda rascunho, sem broadcast descartável (que vira `completed` e não se apaga mais). (1) `npx tsx scripts/publish-newsletter-kit.ts {EDITION_DIR}/ --draft-only-for-ui-test` — o estado ganha `test_mode: "ui"` e `ui_test_url` (`https://app.kit.com/campaigns/{broadcast_id}/draft`); (2) capturar o horário ANTES do clique: `node -e "console.log(new Date().toISOString())"` (nunca `date` com `TZ` no Git Bash); (3) no Claude in Chrome, abrir `ui_test_url` → ícone de olho (Preview) → **Send test email** → **Send preview** para o e-mail do editor (`publishing.newsletter.test_email`). **PROIBIDO neste passo (#10410): clicar em Send, Schedule, Continue, Publish ou qualquer botão de envio/agendamento do broadcast.** `ui_test_url` é o broadcast REAL da edição, já com o `subscriber_filter` de produção (base inteira, ou o segmento `kit.diaria_exclusion_segment.segment_id` quando ele está ligado — #10437) e `public: true` — um desses botões manda (ou agenda) a edição pra todo mundo, irreversível. Só os 3 cliques acima (Preview → Send test email → Send preview); se a UI mostrar qualquer outro caminho, tela inesperada ou o botão não for inequivocamente o de teste, parar sem clicar e cair no fallback `--send-test` abaixo; (4) só com o envio confirmado na UI, `npx tsx scripts/publish-newsletter-kit.ts {EDITION_DIR}/ --mark-ui-test-sent --at {ISO do passo 2}` (grava `status: "test_sent"` + `test_sent_at`, a âncora do `--sent-after` do §5f). Antes de gravar, ele RELÊ o broadcast no Kit (`GET /v4/broadcasts/{id}`, só leitura, #10410) e recusa marcar se ele não estiver em rascunho (`status` != `draft`, `send_at` ou `published_at` preenchidos) — **exit 11 = a edição pode ter sido enviada/agendada pela UI: halt banner (`render-halt-banner.ts`, motivo "broadcast Kit {id} saiu do rascunho durante o teste pela UI", ação "conferir no Kit se a edição foi enviada/agendada para a base") e parar o Stage 5, nunca seguir pro §5f nem pro Stage 6**; exit 12 = a releitura falhou (rede/credencial) — conferir na UI do Kit que o broadcast segue em rascunho e re-rodar o `--mark-ui-test-sent` (nada foi gravado). (5) **Sempre que o passo 1 rodou, com ou sem o passo 4 (#10465)** — inclusive se o clique falhou, a UI foi abandonada no meio ou o agente pulou o `--mark-ui-test-sent` — `npx tsx scripts/publish-newsletter-kit.ts {EDITION_DIR}/ --verify-ui-test-draft` (SÓ LEITURA: relê o broadcast real com a mesma checagem do passo 4, sem `--at` e sem gravar nada; resumo JSON no stdout): exit 0 segue (`checked: false` = não se aplica); **exit 11 = mesmo halt banner do passo 4, parar o Stage 5**; vale também depois do fallback `--send-test` (#10538: o `ui_test_url` gravado no passo 1 sobrevive ao fallback e mantém a releitura ligada — é justamente o cenário de "tela inesperada", em que um clique errado pode ter atingido o broadcast real); exit 12 = conferir na UI do Kit que o broadcast segue em rascunho antes de seguir pro §5f. O e-mail chega SEM o prefixo `[teste]` — o `fetch-test-email.ts` acha pela query sem prefixo. Volume 1-2/dia na conta logada do editor: dentro da política de ToS do CLAUDE.md.
- **Fallback — `npx tsx scripts/publish-newsletter-kit.ts {EDITION_DIR}/ --send-test`** (Chrome indisponível, ex.: servidor `300`, ou falha na UI antes do passo 4; re-rodar depois do `--draft-only-for-ui-test` é seguro, mesmo `broadcast_id`). Cria um broadcast descartável na tag `diaria-test-email`, com `[teste]` no assunto — consumidores de `list_broadcasts` o reconhecem por `isKitTestBroadcast()` (`scripts/lib/shared/kit-test-broadcast.ts`).

O script já grava `_internal/newsletter-kit-published.json` (idempotente — reusa o mesmo `broadcast_id` numa 2ª invocação) e `_internal/05-edition-url.txt` (`https://diar.ia.br/p/{slug do título do D1}`, derivado do título do D1 desde #7420 — nunca do `public_url` do broadcast Kit; mesmo artefato que o playbook Beehiiv produz, consumido pelo dispatch social no Passo 5c-3 e pelo `post_pixel` do Stage 6). Exit codes: `1` uso/erro genérico; `2` backend `"beehiiv"` explícito (não deveria acontecer aqui, já que este passo só roda quando o branch acima resolveu `"kit"` — se acontecer, é sinal de leitura divergente da config entre este passo e o branch, investigar); `7` assunto vazio (`content.title` ausente em `02-reviewed.md`); `8` o HTML Kit ainda menciona a Beehiiv (crédito de plataforma não substituído, #6195) — corrigir o render e re-rodar; `10` o PATCH do draft zerou o `send_at` de um broadcast já agendado e o reagendamento de defesa também falhou (#8208) — **intervenção manual: conferir no Kit o agendamento do broadcast real antes de qualquer outra coisa**; `11`/`12` só nos modos de teste pela UI (ver acima); `13` audiência não confirmada (#10437) — com `kit.diaria_exclusion_segment` ligado, o segmento não foi achado na conta ou a releitura do broadcast não mostrou o filtro do segmento (draft novo é apagado; broadcast já agendado é DESAGENDADO); com ele desligado, o store da Brevo tem contatos `kit-sem-abertura:` movidos. **Bloqueante:** halt banner com o `reason` do stdout — nada foi pra base inteira no lugar, e a saída é conferir o segmento/config, nunca desligar a flag pra destravar.

Se o script sair com código != 0, tratar como falha do dispatch newsletter
(mesmo peso que uma falha do playbook Beehiiv) — não prosseguir pro
Schedule (Stage 6) sem investigar; **não** existe modo "fix" automático
pra este caminho (ver nota no Passo 5f abaixo) — qualquer problema de
conteúdo precisa ser corrigido em `02-reviewed.md` e o script re-rodado
(idempotente, `updateBroadcast` no mesmo `broadcast_id`).

**Nenhum dos dois caminhos de teste (Send test da UI ou `--send-test`) é o review — eles só ENVIAM o e-mail (#9594, #10395).** O loop do §5f (`review-test-email` com `platform: "kit"`) roda TAMBÉM neste backend, depois do dispatch social, e termina SEMPRE em `npx tsx scripts/record-kit-review.ts` (ver §5f). Na edição 261005 o §5f foi pulado no Kit e nada acusou; desde o #9594 o invariante `stage-5-review-completed` (§5i) dá warning sem `_internal/05-review-kit.json`, e o gate do Stage 6 avisa o editor.

**Passo 5c-2: Guard anti-placeholder (#2454, nao-fatal desde #3277).**

**SO APOS o draft (Beehiiv ou Kit) retornar** (passo 5c-1/5c-1-kit completo), verificar que `05-edition-url.txt` existe. Se o arquivo foi gravado pelo playbook (§6.1 do beehiiv-playbook.md) ou pelo script Kit (§5c-1-kit), apenas rodar o guard de validacao — sem re-escrever o arquivo:

```bash
# #7420 (era condicional a backend "beehiiv" — corrigido): se ausente, gravar
# agora em QUALQUER backend. deriveEditionUrl(title) = https://diar.ia.br/p/{seoSlug(title)}
# é URL PRÓPRIA (diar.ia.br é nosso desde o cutover #467, não domínio de
# terceiro) — a mesma que publish-newsletter-kit.ts (Kit) e o playbook
# Beehiiv já gravam no caminho feliz, e a mesma que buildWhatsappEditionUrl
# já crava no corpo do e-mail independente do backend. Este bloco só existe
# como backstop pro caso raro do arquivo não ter sido gravado no passo
# anterior (5c-1/5c-1-kit) — não é mais um fallback "errado pro Kit".
if [ ! -f {EDITION_DIR}/_internal/05-edition-url.txt ]; then
  npx tsx scripts/resolve-edition-url.ts --edition-dir {EDITION_DIR}/ --title "{titulo_d1}"
fi
```

Prosseguir pro guard anti-placeholder abaixo de qualquer forma (ele já tolera `{edition_url}` sobrevivendo como placeholder — é WARNING não-bloqueante, ver comentário do script).

```bash
# Guard anti-placeholder (write-then-validate, #3223; nao-fatal, #3277): reescreve
# 03-social.md substituindo {edition_url} pela URL real e SO ENTAO valida — se sobrar
# algum placeholder {snake_case} nao-resolvido (que nao seja deferred), AVISA
# (stderr + data/run-log.jsonl nivel warn) mas NAO bloqueia o dispatch.
# Nota: {outros_count} e DEFERRED (resolvido por publish-linkedin no dispatch) — nao rejeitado aqui.
EDITION_URL="$(cat {EDITION_DIR}/_internal/05-edition-url.txt)"
npx tsx scripts/resolve-edition-url.ts --edition-dir {EDITION_DIR}/ --edition-url "${EDITION_URL}" --validate-social
```

Exit code do guard:
- `0` → **sempre** (#3277 — o guard nao bloqueia mais o dispatch). `{edition_url}` resolvido e ja substituido em 03-social.md (o script reescreve o arquivo); prosseguir pro dispatch do social em qualquer caso.
- Se o guard imprimir `AVISO (#3277 guard anti-placeholder — não-fatal)` no stdout/stderr, um placeholder `{snake_case}` diferente de `{edition_url}`/`{outros_count}` sobreviveu a substituicao — **isso NAO bloqueia o dispatch** (prosseguir normalmente pro passo 5c-3). O caso e ambiguo (pode ser bug real do writer/stitch, pode ser prosa legitima citando um exemplo entre chaves) — mencionar o aviso no resumo pro editor (ex: no relatorio da edicao) para revisao humana posterior; o evento tambem fica persistido em `data/run-log.jsonl` (nivel warn, agent `resolve-edition-url`) e pode ser inspecionado depois via `/diaria-log {edicao} warn`.

**Passo 5c-3: Dispatch social — APOS a URL estar resolvida.**

**Precondicao defensiva (#3388) — header de plataforma unico.** Antes de dispatchar, rodar (barato, backstop mesmo se a variante do fluxo mudar e pular o lint do fim do Stage 2):
```bash
npx tsx scripts/lint-social-md.ts --check platform-headers-unicos --md {EDITION_DIR}/03-social.md
```
Exit 1 = `# Social` (#3991 — ou, em edicao legado, `# LinkedIn`/`# Facebook`) aparece mais de 1 vez em `03-social.md` — **halt** Stage 5 (nao dispatchar `publish-linkedin.ts`/`publish-facebook.ts`/`publish-instagram.ts`, que vao falhar com "Destaque nao encontrado" pros 3 destaques):
```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "5 — Publicacao" \
  --reason "03-social.md tem header de plataforma duplicado (# Social, ou # LinkedIn/# Facebook em edicao legado, aparece >1x) — os publishers vao parsear so ate o 2o header e reportar destaque nao encontrado" \
  --action "remova o header duplicado em {EDITION_DIR}/03-social.md (ver linhas no output do lint) e rode novamente"
```

**Em uma unica mensagem, disparar simultaneamente** (so apos o guard acima E o passo 5c-2 retornarem exit 0):

1. `Bash("npx tsx scripts/publish-facebook.ts --edition-dir {EDITION_DIR}/ --schedule")` — passa `--schedule` para **agendar** (NAO imediato). Usa mesmos horarios do LinkedIn via `compute-social-schedule.ts`. **Multi-pagina (#10458):** publica em cada pagina HABILITADA de `publishing.social.facebook.pages` (hoje so `diaria`; `memelab` desligada). O JSON de saida traz `pages: [{slug, status: "dispatched"|"missing_credentials"|"disabled", missing?, scheduled?, draft?, failed?}]` — ler DALI pro resumo do Stage 5 (nao parsear stderr): toda pagina com `status: "missing_credentials"` vira **WARNING** no resumo, nomeando a pagina e as env vars de `missing` (`⚠️ Facebook[{slug}]: pagina habilitada sem credencial (faltam: {missing})`) — as outras paginas seguem, nao bloqueia o canal; `disabled` nao aparece (pulada sem ruido). Exit 1 so quando NENHUMA pagina habilitada tem credencial.
2. `Bash("npx tsx scripts/publish-linkedin.ts --edition-dir {EDITION_DIR}/ --schedule")` — Worker queue + Make webhook x 3. Le `_internal/05-edition-url.txt` para substituir `{edition_url}` (ja existe do passo 5c-1).
3. `Bash("npx tsx scripts/publish-instagram.ts --edition-dir {EDITION_DIR}/ --schedule")` — passa `--schedule` para **agendar** (NAO imediato, #3944 Parte A — antes deste fix o Instagram publicava tudo junto no instante do dispatch). Enfileira no MESMO Worker `diaria-linkedin-cron` do LinkedIn (`channel: "instagram"`, #3817/#3818), que dispara nos mesmos horarios (d1 09:45/d2 12:15/d3 17:15 BRT via `compute-social-schedule.ts`) rodando os 2 passos da Graph API (container → media_publish) no MOMENTO do disparo. **Requer `INSTAGRAM_ACCESS_TOKEN` + `INSTAGRAM_BUSINESS_ACCOUNT_ID` como secrets do Worker** (nao mais consumidos localmente pelo script pra publicar — a Graph API roda dentro do Worker no momento do disparo) e `_internal/06-public-images.json` populado (gerado no 5c-pre). **Carrossel de 5 slides (#6005 Parte B):** quando os 5 slides do destaque estao no cache (`resolveCarouselImageUrls`), o script manda `image_urls` (capa→p1→p2→p3→cta) em vez de `image_url` unico — o Worker ja despacha pro caminho carrossel (`fireInstagramCarousel`, #4153, antes usado so pelo semanal). Qualquer slide faltando cai pro post single-image de sempre, sem bloquear o canal. Dois modos de falha distintos: (a) se `DIARIA_LINKEDIN_CRON_URL`/`DIARIA_LINKEDIN_CRON_TOKEN` (Worker) nao estiverem setados no env local, o script **aborta com exit 2** (`--schedule` nao tem fallback de fire-now — sem Worker nao ha como agendar); (b) se as env vars locais `INSTAGRAM_BUSINESS_ACCOUNT_ID`/`INSTAGRAM_ACCESS_TOKEN` nao estiverem setadas (checadas incondicionalmente pelo script, mesmo em modo `--schedule`), o script **encerra com exit 0** (skip gracioso) — nao bloqueia os outros canais nem mascara violations de consent de LinkedIn/Facebook (#2486).
4. `Bash("npx tsx scripts/publish-threads.ts --edition-dir {EDITION_DIR}/ --schedule")` — passa `--schedule` para **agendar** (NAO imediato, #3944 Parte B — antes deste fix o Threads publicava na hora do dispatch). Enfileira no MESMO Worker `diaria-linkedin-cron` do LinkedIn/Instagram (`channel: "threads"`, #3944 Parte B), que dispara nos mesmos horarios (d1 09:45/d2 12:15/d3 17:15 BRT via `compute-social-schedule.ts`) rodando os 2 passos da Threads API (container → threads_publish) no MOMENTO do disparo. **Suporta so posts de 1 chunk (≤500 chars)** — chunking agendado (thread multi-post via reply_to_id) nao e implementado no Worker (risco de duplicar posts em retry automatico); textos maiores falham no enqueue com `status: "failed"` e motivo claro, sem abortar os demais destaques — publique esse destaque manualmente sem `--schedule` ou encurte o texto. **Requer `THREADS_ACCESS_TOKEN` + `THREADS_USER_ID` como secrets do Worker** (nao mais consumidos localmente pelo script pra publicar — a Threads API roda dentro do Worker no momento do disparo). Dois modos de falha distintos: (a) se `DIARIA_LINKEDIN_CRON_URL`/`DIARIA_LINKEDIN_CRON_TOKEN` (Worker) nao estiverem setados no env local, o script **aborta com exit 2** (`--schedule` nao tem fallback de fire-now — sem Worker nao ha como agendar); (b) se as env vars locais `THREADS_ACCESS_TOKEN`/`THREADS_USER_ID` nao estiverem setadas (checadas incondicionalmente pelo script, mesmo em modo `--schedule`), o script **encerra com exit 0** (skip gracioso) — nao bloqueia os outros canais nem mascara violations de consent de LinkedIn/Facebook (#2486, mesmo padrao do Instagram).
5. **So se `consent.brevo === "auto"`** (#5772): `Bash("npx tsx scripts/brevo-diaria-stage5-dispatch.ts --edition-dir {EDITION_DIR}/")` — canal Brevo diária (segmento Pending, reativação); NAO depende de `{edition_url}`, so agrupado aqui por conveniência. **Desde #6793 "Faixa A" item 7 (30/08/2026, freio de volume removido): NÃO passa mais `--max-add` a `brevo-diaria-run.ts` — o backfill preenche todos os candidatos elegíveis da rodada, sem teto diário.** `stage5_target_total`/a fórmula antiga (`N = max(0, stage5_target_total - total_atual)`) seguem computados só pra log/observabilidade. Cria **só o RASCUNHO** (Passos 1-7 de `/diaria-brevo-diaria`, SEM Passo 8/agendamento — isso é Stage 6, §6d-brevo). Imprime JSON `{status: "ok"|"already_done"|"skipped"|"failed", ...}` em stdout — **fail-soft: qualquer status ≠ `"ok"`/`"already_done"` é WARNING** (`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level warn --message "brevo-diaria stage5 dispatch: {status}" --details '{json de saída}'`), nunca aborta os demais canais; `"already_done"` é caminho feliz de resume, logar `info`. **Pool Kit inactive (#8192):** `status: "ok"` com `warnings` não-vazio significa que a campanha saiu mas o pool "inactive do Kit há ≥72h" falhou nesta rodada (Kit fora do ar, MV) — logar `warn` com os `warnings` no `--details`, sem bloquear nada.
6. **So se `consent.kit === "auto"` E `kit_diaria.enabled === true`** (#6126/#6048/#6162 — gate DUPLO: `--skip kit` pula so esta edicao, a flag desliga o canal pra todas): `Bash("npx tsx scripts/kit-diaria-stage5-dispatch.ts {EDITION_DIR}/")` — canal **Kit PARALELO**, roda AO LADO da Beehiiv na mesma edicao, cada um para sua audiencia (particao por origem de cadastro: Beehiiv = base legada congelada; Kit = quem se cadastrou DEPOIS do corte, tag `kit_diaria.audience_tag`). **NAO confundir com `publishing.newsletter.backend === "kit"`**, que e o ramo EXCLUSIVO do switchover final (#6114, passo 5c-1-kit acima) — os dois coexistem de proposito enquanto a particao estiver em uso. NAO depende de `{edition_url}`. Cria **so o RASCUNHO** (`send_at: null`); o agendamento e Stage 6, §6d-kit-diaria. Imprime JSON `{status: "ok"|"already_done"|"skipped"|"failed", ...}` em stdout — fail-soft SO em relacao aos OUTROS canais (nunca aborta Beehiiv/LinkedIn/Facebook/Brevo por causa do Kit); `"already_done"` e caminho feliz de resume, logar `info`. **ATENCAO (#6582, 28/08/2026): `"skipped"`/`"failed"` DEIXOU DE SER estado normal.** Ate a migracao das ondas 0/1 (#6504) a tag `kit_diaria.audience_tag` era um canal ADITIVO (quem estava nela tambem recebia pela Beehiiv) e um dispatch pulado nao custava nada. Desde a migracao, as pessoas da tag (11 da onda 0, nunca ativas na Beehiiv; 81 da onda 1, desativadas na Beehiiv na mesma sessao) tem o Kit como UNICO canal — `"skipped"`/`"failed"` aqui significa que essas pessoas NAO recebem a edicao, sem nada mais acusar. Por isso, com `kit_diaria.enabled === true`: (a) logar `error`, nao `warn` (`--level error` no `log-event.ts` acima); (b) o invariant `kit-diaria-exclusive-audience-dispatched` (STAGE_5_RULES, `postDispatchOnly`) BLOQUEIA o gate 6 quando `_internal/kit-diaria-published.json` estiver ausente ou sem `broadcast_id` — nao prosseguir pro Stage 6 so porque o restante da Etapa 5 concluiu; resolver o motivo do skip/failed (tag sem membros — guard `checkAudienceTagHasMembers`/`countTagMembers` no proprio dispatch — ou erro de rede) e re-rodar `kit-diaria-stage5-dispatch.ts` antes de aceitar o gate.

Aguardar todos retornarem antes de prosseguir.

**Lembrete (#5514): qualquer link `diar.ia.br` montado à mão (fora dos scripts automatizados acima, ex: copy de campanha ad-hoc) precisa de `utm_source`+`utm_campaign` — ver o cabeçalho de `scripts/lib/shared/utm-registry.ts` e rodar `npx tsx scripts/check-utm-coverage.ts --text "..."` antes de publicar. Os posts automatizados desta etapa (destaque → artigo original) não são afetados — o link que carrega UTM de marca é o de inscrição/campanha, não o do artigo fonte.**

**Passo 5c-3b: Twitter/X via Buffer MCP (#3994, revisado 260726, revertido em #4103 260727).** A X deixou de ter free tier proprio (pay-per-usage direto, ~$0.20/post com link) — a publicacao passou a ir via **Buffer** (plano Free, $0), alcancavel so de dentro da sessao de agente (MCP `claude_ai_Buffer`), nao de um script Bash puro. Por isso este passo NAO entra no dispatch paralelo acima — e conduzido pelo orchestrator diretamente:

1. `Bash("npx tsx scripts/prep-twitter-posts.ts --edition-dir {EDITION_DIR}/")` — le `publishing.social.twitter` de `platform.config.json` (gate `enabled`) e a secao `# Curto` de `03-social.md` (texto unico compartilhado com Threads, #3992) — **sem fallback**: destaque ausente na secao ou texto >280 chars entra em `skipped`, nunca improvisa texto nem trunca em silencio. Retorna JSON `{enabled, published_path, posts: [{destaque, text, dueAt, imageUrl, altText, images}], skipped, skipped_image}` — `dueAt` (#4103) ja vem calculado pelo MESMO `compute-social-schedule.ts` usado por `publish-facebook.ts`/`publish-linkedin.ts`/`publish-instagram.ts`/`publish-threads.ts` (fallback_schedule/timezone unico de `platform.config.json`), nunca recalculado a parte. **`images` (#8056) e a lista preferencial pro dispatch** — ate 4 imagens (`TWITTER_IMAGE_LIMIT`): quando o carrossel de 5 slides do destaque esta completo em `06-public-images.json`, sao a CAPA + os 3 slides de PARAGRAFO, nessa ordem (so o CTA e descartado, #8202 — o #8056 descartava tambem a capa); sem carrossel completo, cai pro fallback de 1 imagem so (hero `d{N}_4x5`/`2x1`). `imageUrl`/`altText` (singular, #4264) continuam preenchidos com a 1a entry de `images`, mantidos so por compatibilidade — usar `images`, nao eles, no passo 2. Quando `images` vem vazio, o motivo entra em `skipped_image` (post continua saindo, so texto — X sem imagem e pior que X nenhum, nunca vira um `skipped` de verdade). Se `enabled: false` ou `posts` vazio, **pular os passos 2-3** (nada a publicar).
2. **Para cada item de `posts`**, chamar `mcp__claude_ai_Buffer__create_post` (#11564, 261029: o conector Buffer atual expoe `create_post`, `edit_post`, `get_post`, `list_posts`, `delete_post`, `list_channels`, `get_channel`, `get_account` — NAO expoe `execute_mutation`/`execute_query`; o schema de `create_post` tipa `assets` como array e aceitou 4 imagens por post na edicao 261029). O `execute_mutation` que o #8056 (260912) mandava usar so vale num conector que ainda o exponha: se o ToolSearch nao o encontrar, ele nao existe nesta sessao. Campos: `channelId` = `publishing.social.twitter.buffer_channel_id` de `platform.config.json`, `text` = o texto extraido, `mode: "customScheduled"`, `dueAt` = `posts[i].dueAt` (ja calculado no passo 1), `schedulingType: "automatic"`. **Quando `posts[i].images` nao esta vazio**, incluir `assets: [...]` com 1 entry `{ image: { url, metadata: { altText } } }` por imagem de `images` (1 a 4 entries, NUNCA só a 1a) — mesma arte que Facebook/Instagram/LinkedIn levam para esse destaque, so que possivelmente varias. Quando `images` esta vazio (ver `skipped_image` do passo 1), omitir `assets` e postar so texto, sem abortar o destaque. **Nao usar `addToQueue`** (decisao do editor #4103 — reverte tentativa anterior; caso real que motivou a reversão: `docs/orchestrator-stage-narrative-history.md#stage-5-buffer-queue-caso-real`). **Nao usar `shareNow`** tambem — o agendamento explicito via `dueAt` e o unico dono do cronograma. Se `create_post` rejeitar o array (`expected array, received string`, a armadilha do #8056) e o conector expuser `execute_mutation`, repetir a MESMA chamada como mutation GraphQL `createPost` por ele; sem `execute_mutation`, ou se ele tambem falhar, NAO repostar so-texto como fallback silencioso — registrar `failed` (passo 3) com o erro real e seguir pros demais destaques.
3. **Apos cada chamada**, gravar o resultado com `Bash("npx tsx scripts/append-twitter-published.ts --published-path {published_path} --destaque {d} --status {published|scheduled|draft|failed} [--url {url}] --buffer-post-id {id} --scheduled-at {dueAt}")` (usar `--reason` em vez de `--url`/`--buffer-post-id`/`--scheduled-at` se a chamada retornar erro) — `{published_path}` vem do output do passo 1, `{dueAt}` e o mesmo valor de `posts[i].dueAt` passado no passo 2. **`--url` so quando o Buffer devolveu a URL real do tweet (#11692):** `create_post` em `customScheduled` devolve so o `id` — omitir `--url` (grava `url: null`, `verify-twitter-posts.ts` preenche com o `externalLink` apos o envio); o script recusa placeholder.

Erro na chamada para um destaque nao aborta os demais — best-effort, mesmo padrao dos outros canais social (#2486).

**Passo 5c-3c: 4º post — item USE MELHOR (`## um`, #9568).** Nao e um passo a parte: os MESMOS comandos de 5c-3 (`publish-linkedin.ts`, `publish-facebook.ts`, `publish-instagram.ts`, `publish-threads.ts`) e o `prep-twitter-posts.ts` de 5c-3b ja despacham o 4º post depois de D1/D2/D3, quando `publishing.social.use_melhor_time` esta definido (07:45 BRT, decisao do editor 05/10/2026 — 15min antes da hora cheia). Plano unico em `scripts/lib/use-melhor-dispatch.ts` (`planUseMelhorDispatch`): item selecionado no Stage 2 (`_internal/use-melhor-post.json`) e re-conferido contra o `02-reviewed.md` final; agendado por `computeScheduledAt({ destaque: "um" })` no mesmo slot nas 5 redes; entries gravadas em `06-social-published.json` com `destaque: "um"`.
- **Texto:** `## um` de `# Social` (LinkedIn pagina/Facebook/Instagram, com a linha de CTA de cada canal) e `## um` de `# Curto` (X/Threads). Todo link do projeto (link da edicao, CTA do Facebook) ganha `utm_content=usemelhor` por cima do UTM do canal (`applyUseMelhorUtmToText`).
- **Imagens:** carrossel tipografico de N slides (capa → p1..pN → CTA, `04-um-carousel-*-4x5.jpg`, chaves `um_carousel_{slot}` em `06-public-images.json` — o `upload-images-public.ts --mode social` de 5c-pre ja sobe, mas SO os slots de carimbo do Stage 3 em dia com o texto atual de `## um`). **Carimbo defasado/ausente = nem a capa vale** (a arte pode ser de outro texto/item). Por canal, com carimbo em dia: Instagram/Facebook/Threads mandam o carrossel inteiro quando TODOS os slides subiram; faltando slide → Instagram e Facebook caem pra capa unica, Threads pra so-texto. X leva capa + slides de paragrafo (ate 4, sem o CTA) ou so a capa. LinkedIn pagina leva so a capa (mesmo formato single-image dos destaques). **Capa ausente/defasada:** pula o 4º post so na LinkedIn pagina e no Instagram; Facebook so pula se faltar TAMBEM o carrossel (com carimbo defasado, pula); Threads e X saem so com texto.
- **Fail-soft (tudo-ou-nada POR REDE):** slot desligado, item ausente/mudou no gate, `02-reviewed.md`/JSON aprovado ilegiveis (re-verificacao impossivel → falha FECHADA), `## um` ausente/vazio na secao do canal, imagem obrigatoria do canal ausente → o 4º post e PULADO naquele canal, sem gravar `failed` e sem tocar D1/D2/D3. Saida degradada (carrossel incompleto/defasado → capa/so-texto) sai com `WARN .../um: 4º post (USE MELHOR) degradado — {motivo}`. Niveis de log: `WARN ... pulado` (stderr + `data/run-log.jsonl`) pra pulo inesperado; linha `info` so no stdout (sem run-log) pra feature desligada (`off`) ou `_internal/use-melhor-post.json` ausente (o gate do Stage 4 ja avisou). Erro de AGENDAMENTO (`schedule_error`) e de dispatch (rede/Worker) gravam `failed`, igual aos destaques.
- **Resumo por canal:** o JSON de saida de `publish-linkedin.ts`/`publish-facebook.ts`/`publish-instagram.ts`/`publish-threads.ts` e o de `prep-twitter-posts.ts` trazem `use_melhor: { status: "ready"|"skip"|"off", reason? }`. Ler DALI pro resumo abaixo e pro gate do Stage 6 (nao re-derivar). No X, o plano `off`/`skip` aparece so em `use_melhor` (nunca em `skipped`); pulo por texto/limite/schedule aparece em `skipped` E em `use_melhor`.
- **Re-execucao (resume):** entry `um` ja `scheduled`/`draft`/`published` em `06-social-published.json` nao e despachada de novo; `failed` e retentada. `publish-facebook.ts --reschedule` NAO re-alinha o `um` (mantem o agendamento original, linha `SKIP facebook/um (reschedule)`).
- **Worker `linkedin-cron`:** aceita `destaque: "um"` desde este PR (`QUEUE_DESTAQUE_RE`) — o DEPLOY do Worker e manual e precisa ter rodado antes da 1ª edicao com o 4º post ligado; sem ele LinkedIn/Instagram/Threads recebem 400 no enqueue do `um` (vira `failed` naquele canal, D1-D3 intactos).

**Passo 5c-3d: teste rotativo de horarios (#10305).** Os horarios citados acima (07:45/09:45/12:15/17:15) sao os FIXOS. Enquanto `publishing.social.rotation.enabled` for `true` e a data de publicacao cair em `[start_date, end_date]` (dia util), `computeScheduledAt` troca o horario de cada post (`um`/`d1`/`d2`/`d3`) pelo candidato do dia (`scripts/lib/social-schedule-rotation.ts`) — o MESMO nas 5 redes, sem passo extra nem flag nos publicadores (cada um loga `[compute-schedule] rotação #10305: ...` no stderr). A ordem do dia pode inverter (D3 antes do D1): e o desenho do teste, nao bug. O registro do dia em `data/social-schedule-rotation.jsonl` e gravado pelos proprios publicadores em `--schedule` (`recordDailyRotationFailSoft`, idempotente, nunca lanca). Rede de seguranca, se nenhum publicador rodou ate o fim: `Bash("npx tsx scripts/social-schedule-rotation.ts --record --date {AAMMDD} --kind weekday")` (idempotente; falha aqui e warning, nunca aborta o stage). O horario REAL de cada canal continua sendo o `scheduled_at` de `06-social-published.json`: se o Stage 5 rodar tarde, o past-slot guard desloca o post pro espacamento fixo (+15/+25/+35/+45 min) e o stderr loga `[rotação #10305] WARN: célula perdida` — o post sai da medicao, nao e erro a corrigir.
- **LinkedIn PESSOAL (vjpixel): não sai mais (#11398, 27/10/2026).** O 4º post (`## um`) vai só para a página diar.ia.br; nem automático nem lembrete manual no Stage 6.

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

> NOTA: este loop **nao bloqueia social** — `publish-facebook.ts` e `publish-linkedin.ts` ja completaram em 5c. O loop so toca o draft do Beehiiv/Kit (newsletter).

**Branch Kit (#464): passar `platform: "kit"` pro `review-test-email` quando `publishing.newsletter.backend === "kit"`** (Processo Kit da seção "Roteamento por plataforma" do agente — mesma checklist do Beehiiv, delta documentado lá). **Diferença de tratamento no passo 5 abaixo:** `publish-newsletter-kit.ts` não tem modo `fix` (não há automação de browser pra reaplicar issues via DOM — o conteúdo vem inteiramente de `02-reviewed.md`). Se `kept` não estiver vazio na tentativa 1, **não disparar re-fix automático** — logar warn `"review-test-email (kit) encontrou {N} problemas — sem fix automático neste backend (#464), seguindo pro Schedule"` e sair do loop direto com `review_status: "issues_unfixable"` (mesma semântica do caminho Beehiiv, só que sem a tentativa 2). O filtro de falso-positivos (4.5) roda igual. **`_internal/newsletter-kit-published.json` não tem os campos `review_completed`/`review_status`/`review_attempts`/`review_final_issues`** (schema `KitNewsletterPublished` não os inclui) — registrar o resultado da revisão via `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level {info se ok, warn se inconclusive/issues_unfixable} --message "review-test-email (kit): {review_status}" --details '{"attempts":N,"issues":[...]}'` em vez disso e, **OBRIGATORIAMENTE (#9594), gravar o resultado por edição:** `npx tsx scripts/record-kit-review.ts --edition-dir {EDITION_DIR}/ --status {ok|inconclusive|issues_unfixable} --attempts {N} [--reason {mcp_unavailable|not_found_timeout|truncated_fetch|ui_test_not_marked}] [--issues-json '[...]'] --email-file {EDITION_DIR}/_internal/.email-body.tmp` (#10243: confere em TS que o `wrong_value` do erro intencional está no e-mail entregue; `--status ok` com `missing` é recusado — o agente alucinou o texto correto na 261015; grava `_internal/05-review-kit.json` — o equivalente Kit dos campos `review_*` do `05-published.json`). Vale para TODA saída do loop, inclusive `inconclusive` sem despachar o agente (passo 0) — aí com `--attempts 0` (#9885; o script só aceita 0 com `--status inconclusive`). É desse arquivo que o invariante `stage-5-review-completed` (§5i) e o gate do Stage 6 (§6b) leem — sem ele os dois acusam "review automático NÃO rodou" (o run-log sozinho não bastava: na edição 261005 o loop foi pulado e o gate mostrou "review automático" sem dado).

- **Verificacao e correcao — NAO-BLOQUEANTE (#3839, decisao do editor 260721):**
  > **O botao "Send test email" do Beehiiv e um controle de UI que pode falhar em disparar (nao envia nenhuma chamada de rede) independente do conteudo — nao e um problema corrigivel via retry.** Por isso este loop tenta **no maximo 1 tentativa de verificacao + 1 tentativa de fix** (nunca 10). Se o test email nao confirmar, **loga warning e segue pro Schedule** (Stage 6) em vez de travar a Etapa 5. O caminho feliz (Gmail confirma recebimento de primeira) continua identico a antes.

  ```typescript
  // #2047 / #2061: declarar UMA vez ANTES do loop — evita re-fetch do mesmo URL
  const linkCheckCache = new Map<string, boolean>();
  ```

  Para `attempt` de 1 a 2 (attempt 1 = verificacao inicial; attempt 2 so ocorre se attempt 1 achou issues corrigiveis e o fix-mode rodou):

  0. **Pré-buscar o e-mail de teste no top-level (#9000).** **Caminho preferido (#9886) — sem o corpo passar pelo contexto:** `npx tsx scripts/fetch-test-email.ts --edition-dir {EDITION_DIR}/ --platform {kit|beehiiv} --title "{edition_title}" --sent-after {ISO}` (só Kit: `{ISO}` = `test_sent_at` de `_internal/newsletter-kit-published.json`, omitir se ausente — sem ele, reexecução no mesmo dia lê o teste anterior, #9901; desde o #10411 o script já usa esse `test_sent_at` como default quando a flag é omitida no Kit, e com `test_mode: "ui"` tenta a query sem prefixo primeiro — passar a flag continua valendo e vence o default; gravado tanto pelo `--send-test` quanto pelo `--mark-ui-test-sent --at` do caminho da UI (#10395), cujo `--at` é capturado ANTES do clique — o e-mail da UI chega SEM `[teste]` e é achado pela query sem prefixo; **Beehiiv nunca passa `--sent-after`**: `test_email_sent_at` é gravado DEPOIS do clique em Send test e o corte descartaria o teste atual, #9905; Gmail REST com `data/.credentials.json`, sem MCP; já espera 20s/15s, busca com as queries abaixo, grava `_internal/.email-body.tmp` e `_internal/lint-size-{AAMMDD}.json`, devolve só um resumo JSON). Exit 0 → passar `email_file`/`email_subject` do JSON ao agente no passo 1 e pular (a)-(e); exit 3 → `inconclusive` com `reason: "not_found_timeout"` (agente não despachado); exit 5 (só Kit, #10395: estado com `test_mode: "ui"` sem `test_sent_at` — o `--mark-ui-test-sent` não rodou) → antes de qualquer outra coisa, `npx tsx scripts/publish-newsletter-kit.ts {EDITION_DIR}/ --verify-ui-test-draft` (só leitura, #10465 — o passo 4 do §5c-1-kit foi pulado, então nada releu o broadcast real): **exit 11 → halt banner do §5c-1-kit e parar o Stage 5**; exit 0/12 → `inconclusive` com `reason: "ui_test_not_marked"`, agente não despachado, e o gate do Stage 6 mostra "teste pela UI não registrado: o e-mail pode nunca ter saído"; exit 4 (Gmail REST indisponível) → seguir o caminho MCP abaixo. O conector Gmail pode estar exposto sob prefixo UUID (`mcp__<uuid>__search_threads`), fora da allowlist `tools:` do `review-test-email` — só o top-level enxerga o prefixo real. **Resolver o prefixo de forma determinística (#9823), nunca "de olho":** `ToolSearch` com query `search_threads get_thread list_labels create_label` (max_results 20), colar TODOS os nomes devolvidos em `npx tsx scripts/resolve-mcp-connector.ts --connector gmail --tools "{nomes}"` — exit 0 → usar `tools.search_threads`/`tools.get_thread` do JSON (carregar com `ToolSearch` no `select` impresso); exit 1/3 → é o caso `mcp_unavailable` abaixo. Fazer AQUI: (a) `Bash("sleep 15")` (Kit: 20); (b) `search_threads` com a query do agente — Beehiiv `subject:"[TEST] {edition_title}" from:beehiiv.com newer_than:1d` (fallback sem `[TEST] `), Kit `subject:"[teste] {edition_title}" from:news.diar.ia.br newer_than:1d` (fallback sem `[teste] `; com `test_mode: "ui"` a ordem inverte — sem prefixo primeiro — e mensagens com `internalDate` anterior a `test_sent_at` são descartadas, #10395); (c) `get_thread` com `messageFormat: "FULL_CONTENT"`, preferir a parte `text/html`; (d) gravar o corpo em `{edition_dir}/_internal/.email-body.tmp` (Write) e guardar o assunto da thread; (e) rodar JÁ AQUI `npx tsx scripts/lint-test-email-size.ts --size-estimate {sizeEstimate} --email-file {edition_dir}/_internal/.email-body.tmp --out {edition_dir}/_internal/lint-size-{AAMMDD}.json` (+ `--html-bytes` se a parte `text/html` expuser o tamanho) — o alarme `delivered_size_near_clip` (>95 KB, #9823) sai no gate 6 mesmo se o agente não for despachado. Se achar: passar `email_file` (esse path) e `email_subject` ao agente no passo 1. Se nenhuma tool Gmail existir sob qualquer prefixo, ou a busca não achar em 30s: NÃO despachar o agente — tratar como `inconclusive` no passo 3 (`reason: "mcp_unavailable"` se as tools não existem, `"not_found_timeout"` se não achou).
  1. **Verificar email de teste.** Disparar `review-test-email` passando `test_email`, `edition_title`, `edition_dir`, `attempt`, `email_file` e `email_subject` (do passo 0).
  2. Se retornar `error: "chrome_disconnected"`, aplicar o mesmo backoff exponencial descrito acima (isso e reconexao de Chrome, nao conta como nova tentativa do loop — re-executar o mesmo `attempt` apos reconectar).
  3. **Se retornar `status: "inconclusive"` (#1212 — fail-closed, causas possíveis distinguidas pelo campo `reason` desde o #8902: `"mcp_unavailable"` = conector Gmail desconectado/exposto sob outro prefixo, tools nunca chamadas; `"not_found_timeout"`/`"truncated_fetch"` = Gmail respondeu mas o email não foi localizado/veio truncado em 30s; `"ui_test_not_marked"` = só Kit, teste pela UI sem `--mark-ui-test-sent`, #10395)**: logar warn incluindo o `reason` explicitamente — `"test email nao confirmado na tentativa {attempt} (reason: {reason}) — nao bloqueando Stage 5 (#3839). Editor deve verificar visualmente ou usar Schedule direto (workaround conhecido)."` Se `reason === "mcp_unavailable"`, acrescentar ao log `"conector Gmail parece renomeado/desconectado — ver #7279; a checagem automatica ficou OFF, nao e so ausencia de email"` (é o sinal que faltava no achado do #8902: sem isso, "inconclusive" por MCP indisponível e por email-que-não-chegou eram indistinguíveis no log). **Sair do loop imediatamente** (nunca retry). Gravar `review_status: "inconclusive"` e `review_reason: {reason}`. NAO marcar `review_completed: true`. **Fallback determinístico (#8635):** rodar `npx tsx scripts/lint-local-newsletter-html.ts --edition-dir {EDITION_DIR}/ --platform {kit|beehiiv}` (lints de estrutura/encoding sobre o HTML final LOCAL — nunca bloqueia) e levar os issues ao resumo do gate do Stage 6 rotulados "HTML local, não o e-mail entregue".
  4. Se `issues` estiver vazio E `status: "ok"`: **sair do loop** (caminho feliz — sem mudanca).
  4.5. **Filtrar falso-positivos (#1421, #2013, #2047)**:
     ```typescript
     import { filterAgentIssues } from "scripts/lib/agent-issue-validator.ts";
     const htmlLocal = readFileSync(`{edition_dir}/_internal/newsletter-final.html`, "utf8");
     const { kept, dropped } = await filterAgentIssues(issues, htmlLocal, edition_date, fetch, linkCheckCache);
     for (const d of dropped) logar info `"dropped FP: ${d.issue} — ${d.reason}"`;
     ```
     Se `kept.length === 0` E `dropped.length > 0`: todos eram FPs — **sair do loop** sem fix-mode.
  5. Se `kept` nao estiver vazio E `attempt === 1`:
     - Logar: `"review-test-email encontrou {N} problemas na tentativa 1/2"`.
     - Disparar `publish-newsletter` em **modo fix** com `edition_dir`, `mode: "fix"`, `draft_url`, `issues: kept`.
     - Se `unfixable_issues[]` nao vazio, logar warn `"publish-newsletter reportou unfixable_issues — nao bloqueando (#3839)"` e sair do loop com `review_status: "issues_unfixable"`.
     - Caso contrario, prosseguir pra `attempt` 2 (re-verificacao unica pos-fix).
  6. Se `kept` nao estiver vazio E `attempt === 2` (ou seja, o fix de tentativa 1 nao resolveu tudo): logar warn `"review-test-email ainda reporta {N} problemas apos 1 fix — nao bloqueando Stage 5 (#3839, decisao editor 260721: loop deixou de ser gate duro). Seguindo pro Schedule."` Gravar `review_status: "issues_unfixable"`. **Sair do loop** (nunca uma 3a tentativa).

  **Nunca mais de 2 tentativas.** O loop pre-#3839 permitia ate 10 iteracoes bloqueando a Etapa 5; essa contagem foi reduzida porque o unico cenario onde repetir ajudava (issue de conteudo corrigivel) se resolve em no maximo 1 fix-mode dispatch — repetir alem disso so reflete o botao Send test email quebrado (nao corrigivel por retry) e travava a publicacao sem necessidade.

- **Gravar resultado da revisao em `05-published.json` (obrigatorio).** Campos: `review_completed`, `review_status`, `review_attempts`, `review_final_issues`, e desde o #8902 `review_reason` quando `review_status === "inconclusive"` (`"mcp_unavailable"` | `"not_found_timeout"` | `"truncated_fetch"`).
  O resumo para o Stage 6 deve incluir AMBOS `review_final_issues` e `unfixed_issues` (#1212): se `review_final_issues` nao vazio OU `unfixed_issues` nao vazio, listar ambos no bloco de status passado para o gate do Stage 6.
  **`review_completed: false` NUNCA bloqueia o Stage 5** (#3839) — `review_status` terminal (`"inconclusive"` ou `"issues_unfixable"`) e um resultado valido e esperado, nao um erro do orchestrator. O gate humano do Stage 6 (`orchestrator-stage-6.md`) ja trata ambos os status como warning nao-bloqueante (`⚠ review inconclusivo` / issues listados) — nao precisa de mudanca adicional la.

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

Re-upload pro Worker Cloudflare (#3420 — Worker-hosted, revertido de Claude Artifacts/#3214: CSP do Artifact bloqueava imagem remota, mesmo problema do Stage 4 §4b step 3) — reflete qualquer resolução de URL que só existe pós-dispatch (ex: `{edition_url}`):

```bash
npx tsx scripts/upload-html-public.ts --edition {AAMMDD}-social \
  --html {EDITION_DIR}/_internal/social-preview.html --persist-to {EDITION_DIR}/_internal/05-social-preview.json --field social_preview_url
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

**Backend-aware (#464, achado do review — sem isso o Stage 6 nunca roda com `backend: "kit"`):** `--outputs` referencia o artefato que o passo 5c-1/5c-1-kit de fato escreveu — `assertSentinel` (Stage 6, pré-condição) checa exatamente os paths gravados aqui, não um path fixo. **Desde #7963 isto também é um gate MECÂNICO, não só prosa:** `pipeline-sentinel.ts write --step 5` recusa (exit 1, SEM `--bypass-reason`) gravar o sentinel se `--outputs` citar o artefato do backend OPOSTO ao ativo em `platform.config.json` (ex: `05-published.json` sob backend `"kit"`) — mesmo assim, seguir o branch certo abaixo evita o erro de largada. Backend `"beehiiv"` (default):

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 5 \
  --outputs "_internal/05-published.json"
```

Backend `"kit"`:

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 5 \
  --outputs "_internal/newsletter-kit-published.json"
```

**Marcar Stage 5 `done` AQUI (#1783).** Este e o mark-done canônico do Stage 5 é o §5i — acontece **antes** do Stage 6. Auto-carimbo de `end` via #1789:

```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 5 --status done
```

**Capturar custo/tokens reais (#3441):**
```bash
npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 5
```

- Sentinel ausente faz Stage 0 da proxima edicao re-investigar publicacao via Beehiiv API.
- Falha do sentinel → logar warn. Nao bloquear.
- Ler o JSON de stdout do `capture-stage-usage.ts` acima: se `"source":"unavailable"`, logar warn (mesmo padrão do sentinel — #5475): `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 5 --agent orchestrator --level warn --message 'stage_usage_capture_unavailable' --details '{"reason":"<reason do stdout>"}'`. Nao bloquear. **Rodar o `capture-stage-usage.ts --stage 5` acima SEMPRE, inclusive no backend Kit (#9594)** — na edição 261005 ele não rodou e o `stage-usage-captured` acusou no §5i. Backstop: o §6b-7 do Stage 6 re-captura o Stage 5 quando ele ainda está sem custo (mesma sessão, `/diaria-5-publicacao` cobre 5+6).

### 5i. Pos-publicacao invariants (#1007 Fase 1)

Antes de prosseguir pro Stage 6, validar que (a) sentinel `_internal/.step-5-done.json` foi escrito, (b) `_internal/06-social-published.json` tem `posts[]` nao-vazio sem entries `failed`. **SEM `--phase pre-dispatch` aqui (#4516)** — diferente de §5a, este passo roda DEPOIS do dispatch completo, entao o conjunto completo de 16 regras (incluindo `social-published-complete`/`step-5-sentinel-exists`) e o que se quer validar:

```bash
npx tsx scripts/check-invariants.ts --stage 5 --edition-dir {EDITION_DIR}/
```

Exit 1 = logar warn (nao bloquear Stage 6).

---

## Resumo apos Stage 5 (entrada do Stage 6 — MESMA sessao)

Apresentar resumo para o editor saber que dispatch completou e que o gate de agendamento vem a seguir:

```
Publicacao dispatchada — edicao {AAMMDD}
  Site: PR {prUrl} aberto ({status} — merge trava o fim do Stage 6, #10160) (ou "falhou — {reason}, Stage 6 re-roda")
  Newsletter: rascunho criado + test email enviado — review {status}
  LinkedIn: agendado x 3 (+1 do 4º post USE MELHOR, #9568 — `use_melhor` da saida: "ready" → horario da entry um; "skip"/"off" → "4º post pulado — {reason}")
  Facebook: agendado x 3 (+1 do 4º post, idem)
  Instagram: agendado x 3 (+1 carrossel do 4º post) (ou "env vars ausentes — pular" se nao configurado)
  4º post (USE MELHOR): saiu em {canais com use_melhor "ready"}; pulado em {canal}: {reason} (#10834 — uma linha por canal pulado, incluindo X; carrossel nao regerado no 5c-pre entra aqui com o `use_melhor_carousel.reason`. Omitir a linha so com o 4º post "off")
  Threads: agendado x N (ou "env vars ausentes — pular" se nao configurado; destaques >500 chars ficam de fora, ver failed em 06-social-published.json)
  Brevo diária: rascunho criado (campaign_id {N}, addedActual {N} — #6793: sem teto de max-add desde o item 7) — agendamento no Stage 6 (ou "pulado — {motivo}" se status skipped/failed, #5772)

Proximo passo (MESMA sessao) → gate de agendamento
(agendamento newsletter + Brevo diária + auto-reporter)
```

**CONTINUE nesta mesma sessao: leia `orchestrator-stage-6.md` e execute o Stage 6 em seguida (#7983).** Esta e a unica transicao de stage do pipeline diario que encadeia sozinha — o Stage 5 e o Stage 6 foram fundidos numa invocacao so por decisao do editor (11/09/2026). Nao imprima "rode /diaria-6-agendamento" como se fosse o proximo passo do editor: o proximo passo e SEU, agora, e o unico ponto de parada e o gate humano de §6c.

**O que NAO mudou:** o gate de §6c continua onde estava (e um dos dois gates de projeto do CLAUDE.md, criterio 1 — irreversivel pra terceiros); os dois sentinels (`.step-5-done.json` e `.step-6-done.json`) continuam separados, cada um escrito no fim do seu stage; os invariants de Stage 5 e de Stage 6 continuam rodando separados; e a fronteira de contexto pos-gate 4 (#6171, `orchestrator-stage-4.md` §"Fluxo pos-gate") continua intacta — este playbook segue sendo SEMPRE lido a partir de uma sessao nova, nunca como continuacao do Stage 4.

**Se a sessao morrer entre o dispatch e o gate** (ou o editor sair e voltar horas depois — aconteceu em 5 das 18 edicoes medidas antes da fusao): `/diaria-6-agendamento {AAMMDD}` continua existindo exatamente pra isso, como porta de RETOMADA. O sentinel `.step-5-done.json` ja esta escrito, entao ela retoma direto no gate.

Se alguma parte foi pulada (ex: `chromeMcp === false`, lido do `preflight-state.json` no inicio deste stage — ver acima), incluir bloco de retomada explicito:

```
Retomada manual pendente

Etapa 5 (newsletter no Beehiiv): pulado (claude-in-chrome MCP indisponivel)
LinkedIn x 3: agendado normal via Worker ✓
Facebook x 3: agendado normal via Graph API ✓
Instagram x 3: agendado normal via Worker ✓
Threads: agendado normal via Worker ✓

Quando o MCP estiver ativo, rodar:
  /diaria-5-publicacao newsletter {AAMMDD}   # cria rascunho Beehiiv + email teste
```

Se nenhum stage foi pulado, omitir esse bloco — so listar outputs e status do dispatch.

**#4990 — se `pending-research-unresolved` apareceu em §5a, incluir SEMPRE esta linha** (nunca omitir por brevidade — é justamente o aviso que faltava no incidente original):

```
⚠️ Pesquisa pendente: {bucket} — "{pedido}" (pedida {timestamp})
   Secao pode ter publicado incompleta/ausente. Ver _internal/pending-research.json.
```
