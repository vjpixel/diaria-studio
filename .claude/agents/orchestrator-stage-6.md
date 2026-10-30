---
name: orchestrator-stage-6
description: Detalhe da Etapa 6 (agendamento — gate humano + Schedule Kit + auto-reporter) do orchestrator diar.ia.br. Lido pelo orchestrator principal durante a execucao — nao e um subagente invocavel diretamente.
---

> Este arquivo e referenciado por `orchestrator.md` via `@see`. Nao executar diretamente.

---

## Etapa 6 — Agendamento (gate humano) — #1694

Stage 6 e o **gate final do pipeline**. Apresenta ao editor a parada única (revisão visual do e-mail de teste + resumo de agendamento — rascunho Kit (ou draft Beehiiv no ramo legado), social agendado, achados do review, avisos de invariantes que persistiram após tentativa de correção automática, #8205), recebe a confirmacao e executa o Schedule do backend (Kit por padrão, #11225; Beehiiv só no ramo legado explícito). Termina com o auto-reporter (sem gate próprio, #8205).

Interacao humana SO neste stage (alem do Stage 4) — e dentro dele, **uma única parada** (§6c), não mais (#8205).

> **Fusao 5+6 (#7983, 11/09/2026).** O caminho NORMAL de chegada aqui e a continuacao direta do `orchestrator-stage-5.md` na MESMA sessao — nao uma invocacao nova. `/diaria-6-agendamento` continua valendo como porta de RETOMADA (a sessao morreu depois do dispatch, o editor saiu e voltou horas depois, ou e retry do agendamento); nos dois casos este playbook e identico, porque tudo que ele consome vem de arquivo. A fronteira que NAO mudou e a do #6171 (pos-gate 4): o Stage 5 continua comecando sempre em sessao nova.

**`{EDITION_DIR}` (#2463/#3025):** diretorio REAL da edicao no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edicao foi criada. Resolver **uma vez**, logo apos ter `{AAMMDD}`, e usar em todo path abaixo — nunca montar `data/editions/` + `{AAMMDD}` a mao:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

### Pre-condicao: sentinel Stage 5

**Rodar SEMPRE, inclusive vindo do Stage 5 na mesma sessao (#7983).** O `assert` le o sentinel do DISCO, nunca a memoria da sessao — quando a fusao encadeou ate aqui, o §5h acabou de escrever o arquivo e o assert sai `0` em milissegundos. Pular o check porque "acabei de rodar o Stage 5" e exatamente o tipo de atalho que a fusao NAO autoriza: e ele que pega dispatch parcial (canal que falhou depois do sentinel) e backend errado (exit `2`, #7963).

**`assertSentinel` compara contra os `outputs` GRAVADOS pelo §5h da Stage 5** (não um path fixo) — então este `assert` já lê o caminho certo automaticamente, seja qual for o backend, DESDE que §5h tenha gravado o output certo (ver "Branch por backend" no §5h da Stage 5, #464 — achado do review PR #6096: antes essa branch não existia e este `assert` FATALizava toda edição com `backend: "kit"`, já que o sentinel gravado apontava sempre pra `05-published.json`, que o Kit nunca escreve). `--outputs` aqui é só o valor a comparar se o sentinel ficar ausente/corrompido (ver exit `2` abaixo) — informar o esperado pro backend ATUAL:

```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 5 \
  --outputs "_internal/05-published.json"
# Backend "kit": --outputs "_internal/newsletter-kit-published.json"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 5 (Publicacao) nao completou (sentinel ausente). Re-rodar `/diaria-5-publicacao {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** artefato do backend atual ausente (`05-published.json` pra Beehiiv, `newsletter-kit-published.json` pra Kit). "Re-rodar Etapa 5." Parar.
- `3` → logar warn, continuar.

### 6a. Pre-requisitos

**Marcar Stage 6 `running` no inicio (#1783):**
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 6 --status running
```

- Logar inicio:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info --message 'etapa 6 agendamento started'
  ```
**Branch por backend (#464).** Ler `publishing.newsletter.backend` de `platform.config.json` (default `"kit"` se ausente, #11225 — Beehiiv é só arquivo histórico; o ramo `"beehiiv"` é legado, só com a chave explícita). Guardar esse valor — decide, mais abaixo, se §6d (Beehiiv) ou §6d-kit roda, e de onde vêm os campos desta lista.

- Backend `"beehiiv"` (legado, só explícito): ler `_internal/05-published.json` → extrair: `draft_url`, `title`, `test_email_sent_at`, `review_completed`, `review_status`, `review_final_issues`.
- Backend `"kit"` (padrão, também com a chave ausente): ler `_internal/newsletter-kit-published.json` → extrair `broadcast_id` (equivalente a `post_id`), `subject` (equivalente a `title`), `status`. Não há `draft_url`/`test_email_sent_at` neste schema — usar `_internal/05-edition-url.txt` (mesmo arquivo, ver §5c-1-kit) no lugar de `draft_url` onde o resumo do gate (§6b) citar um link pro editor conferir. `review_status`/`review_attempts`/`review_reason`/`review_final_issues` vêm de `_internal/05-review-kit.json` (gravado por `record-kit-review.ts` no fim do §5f, #9594). **Arquivo ausente/inválido NÃO é "review ok"** — é o review que não rodou (edição 261005): rodar `npx tsx scripts/check-invariants.ts --stage 5 --rule stage-5-review-completed --edition-dir {EDITION_DIR}/` (sai `0` mesmo com violação — é `warning`) e, se o JSON trouxer a violação, o `{review_status_block}` do gate (§6c) vira `⚠ review automático NÃO rodou na Etapa 5 ({mensagem da violação}) — conferir o e-mail de teste com atenção redobrada`. Nunca rodar o `review-test-email` aqui pra "completar" — a parada única do §6c já pede a revisão visual.
- Ler `_internal/06-social-published.json` → extrair: horarios agendados dos 3 posts LinkedIn e 3 posts Facebook (`scheduled_at` por destaque).
- Ler `_internal/06-verify-dispatch.json` (se existir) → extrair quaisquer warnings de verificacao.
- Só no ramo Beehiiv legado: ler `post_id` de `_internal/05-published.json` (necessario para o Schedule Beehiiv e para verificacao pos-Schedule).
- Ler horario default de agendamento: 06:00 BRT da DATA DA EDIÇÃO (`{AAMMDD}`) — **nunca** "amanhã" pelo relógio de agora (#8207: Etapa 6 rodada depois da meia-noite BRT com "amanhã" contado pelo relógio agendou a edição 260917 um dia atrasado no Kit e na Brevo diária). `scripts/resolve-edition-scheduled-at.ts` é o ÚNICO lugar que faz essa conta — usar o MESMO comando aqui e no ramo `sim HH:MM` do §6c abaixo:
  ```bash
  npx tsx scripts/resolve-edition-scheduled-at.ts --aammdd {AAMMDD}
  ```
  **Exit 2 (#11689): horário já passou ou está a <15 min.** Stdout vazio; stderr traz `next_viable=… next_viable_brt=HH:MM` (30 min de folga) ou `next_viable=none` quando não resta horário no dia da edição (virou a meia-noite BRT ou a edição já passou). Nunca trocar o horário sozinho; tratamento no gate em §6c e no `--no-gates` logo abaixo.
- **Ler `_internal/brevo-diaria-published.json` (#5772), se existir** → extrair `campaign_id`, `status`. Ausente = canal Brevo pulado/falhou na Etapa 5 (`--skip brevo`, config ausente, store ausente) — nada a agendar aqui, pular §6d-brevo abaixo sem erro.

**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

### 6b. Montar resumo de agendamento

Compor o resumo que sera exibido no gate único de §6c — inclui o pedido de revisão visual do e-mail de teste (#8205) mais todo o contexto que antes tinha parada própria:

- **Revisão visual do e-mail de teste (#8205):** `{test_email}` de `publishing.newsletter.test_email` em `platform.config.json`; assunto `[teste] {title}` (Kit, fallback `--send-test`), `{title}` sem prefixo (Kit, teste pela UI — `test_mode: "ui"`, #10395) ou `[TEST] {title}` (Beehiiv).
- **Newsletter Beehiiv:**
  - URL do rascunho: `draft_url` de `05-published.json`.
  - Test email: `test_email_sent_at` formatado em BRT.
  - Status do review: se `review_completed: true` → `✓ review ok`; se `review_status: "inconclusive"` → `⚠ review inconclusivo ({review_reason})` (desde #8902, `review_reason` distingue `mcp_unavailable` — conector Gmail indisponível/renomeado, checagem automática ficou OFF, ver #7279 — de `not_found_timeout`/`truncated_fetch` — Gmail respondeu, email só não foi localizado/veio truncado; `ui_test_not_marked` (#10395, só Kit) → `⚠ teste pela UI não registrado: o e-mail pode nunca ter saído`; ausência de `review_reason` em edições pré-#8902 → mostrar só `⚠ review inconclusivo`); se issues → listar.
- **Social agendado:** horarios LinkedIn + Facebook por destaque (D1/D2/D3).
- **Achados do review-test-email** (se `review_final_issues` nao vazio ou `review_status !== "ok"`) **+ achados dos lints determinísticos `lint-test-email-*`** que o `review-test-email` já roda internamente (link tracking, structure, encoding, image freshness — ver `.claude/agents/review-test-email.md`) **+ `issues[]` de `_internal/lint-size-{AAMMDD}.json`** (gravado no §5f passo 0 do Stage 5 mesmo quando o agente não é despachado — inclui o alarme `delivered_size_near_clip`, e-mail acima de 95 KB, perto do corte de 102 KB do Gmail, #9823).
- **Broadcast real ainda em rascunho depois do teste pela UI (#10465, só backend `"kit"`):** rodar `npx tsx scripts/publish-newsletter-kit.ts {EDITION_DIR}/ --verify-ui-test-draft` ANTES do gate e de qualquer Schedule — só leitura, nunca grava nada; não se aplica sozinho (exit 0, `checked: false`) sem teste pela UI ou com `status: "scheduled"` no estado. Rede de segurança pro caso em que o Stage 5 pulou o `--mark-ui-test-sent` (clique errado na UI) e ninguém releu o broadcast. **Exit 11 → halt banner (`render-halt-banner.ts`, motivo "broadcast Kit {id} saiu do rascunho durante o teste pela UI", ação "conferir no Kit se a edição foi enviada/agendada para a base") e parar a Etapa 6, sem gate nem Schedule**; exit 12 → aviso destacado no gate de §6c ("não deu pra confirmar que o broadcast Kit segue em rascunho — conferir na UI antes do ok"); exit 0 segue.
- **Rascunho Kit defasado (#9428, só backend `"kit"`):** rodar `npx tsx scripts/check-invariants.ts --stage 6 --rule kit-draft-fresh --edition-dir {EDITION_DIR}/` (sai `0` mesmo com violação — é `warning`). Se o JSON trouxer violação `kit-draft-fresh`, o editor mexeu em `02-reviewed.md`/`01-eia.md`/`06-public-images.json` depois do publish e o rascunho/e-mail de teste estão com o conteúdo velho: incluir a mensagem como **aviso destacado** no gate de §6c, com o caminho de correção que a própria mensagem já traz com o path real (#10411): preferido `npx tsx scripts/publish-newsletter-kit.ts {EDITION_DIR}/ --draft-only-for-ui-test` (idempotente — PATCH do mesmo broadcast, sem broadcast de teste) + "Send test email" → "Send preview" na UI do rascunho no Kit (mesma proibição do §5c-1-kit do Stage 5: nunca Send/Schedule/Continue) + `--mark-ui-test-sent --at {ISO capturado antes do clique}`; fallback só sem Chrome: `--send-test` (cria broadcast de teste descartável e troca `test_mode` pra `"broadcast"`). Se a mensagem disser que o broadcast já saiu, só registrar. Não re-publicar sozinho; nunca um 2º gate.
- **Guard de slug do bloco WhatsApp (§6b-slug):** se `SLUG_CHECK_OK === false`, incluir aviso destacado com a instrução de correção manual — nunca um gate próprio.
- **Brevo diária (#5772):** se `_internal/brevo-diaria-published.json` existe, `campaign_id` + status atual ("rascunho pronto pra agendar"). Se ausente, omitir esta linha (canal pulado/falhou na Etapa 5).

### 6b2. Pedidos editoriais registrados — aceitos direto, sem gate (#4966, #8205)

Ler `{EDITION_DIR}/_internal/editor-requests.jsonl` (escrito ao longo da edicao via `npx tsx scripts/log-editor-request.ts`, ver `.claude/agents/orchestrator.md` secao "Pedidos editoriais do editor"). **Se o arquivo nao existir ou estiver vazio, pular esta secao inteira** — nada a revisar.

**Desde #8205 (17/09/2026): aceitar a lista como registrada, sempre, em QUALQUER modo (interativo ou `--no-gates`)** — a revisão visual do e-mail de teste em §6c é a única parada desta skill; um 2º gate só pra confirmar entradas que o próprio editor já registrou ao longo da edição (via `log-editor-request.ts`, tipicamente no gate do Stage 4) não passa em nenhum dos 4 critérios de "Perguntar é exceção" do CLAUDE.md. Logar a origem, mesmo espírito de `_internal/05-publish-consent.json`:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "editor requests aceitos sem gate (#8205)" \
  --details '{"source":"accepted_no_gate","count":{N}}'
```

A lista (resumida a ~80 chars por entrada, `[{stage}] {request_type} · {target} — "{description}" ({resolution})`) entra como contexto informativo dentro do gate único de §6c — não como pergunta separada. Prosseguir para §6c.

### 6b-replies. 2ª passada de §0-replies — respostas chegadas depois do Passo 1b (#9792)

O prazo do concurso "ache o erro" é "antes do envio da edição seguinte", então chegam replies o dia inteiro — e o Passo 1b de `/diaria-edicao` (§0-replies) captura uma vez só, no início da edição. Esta 2ª passada roda aqui, perto do envio, antes do gate de §6c.

**Condição:** mesma do Passo 1b — só com o editor presente (sem `--no-gates`/`auto_approve`) e com Gmail MCP disponível. Fora disso, logar o skip com as mesmas mensagens de `buildRepliesSkipLogArgs()` (`scripts/lib/replies-skip-log.ts` — `"0-replies skipped: Gmail MCP unavailable"` / `"0-replies skipped: headless --no-gates"`), trocando só `--stage 0` por `--stage 6`, e seguir — nunca em silêncio, nunca bloqueia.

Seguir os passos 1-5 de `.claude/agents/orchestrator-stage-0-preflight.md` § "0-replies" com 2 ajustes:

1. Gravar a captura desta passada em `{EDITION_DIR}/_internal/captured-replies-late-pass.json` (sobrescrito a cada execução; nunca sobrescrever `captured-replies.json` do Passo 1b nem o ledger `captured-replies-late.json`).
2. Filtrar (passo 3) excluindo o que o Passo 1b E execuções anteriores deste Stage 6 já processaram (mesma `thread_id` + `date`) — re-executar o Stage 6 (ex.: retomada via `/diaria-6-agendamento`) não pode rascunhar de novo as replies tardias da execução anterior:
   ```bash
   npx tsx scripts/filter-subscriber-replies.ts --in {EDITION_DIR}/_internal/captured-replies-late-pass.json \
     --exclude-captured {EDITION_DIR}/_internal/captured-replies.json,{EDITION_DIR}/_internal/captured-replies-late.json
   ```
   **Só DEPOIS do passo 4 (draft + sorteio) concluído**, registrar a passada no ledger (#9807 — nunca na hora do filtro: se a sessão cair entre o filtro e o draft, a reply constaria como processada e a retomada a perderia em silêncio):
   ```bash
   npx tsx scripts/filter-subscriber-replies.ts --in {EDITION_DIR}/_internal/captured-replies-late-pass.json \
     --record-processed {EDITION_DIR}/_internal/captured-replies-late.json --thread-ids {THREAD_IDS_TRATADOS}
   ```
   `{THREAD_IDS_TRATADOS}` = os `thread_id` cujo passo 4 terminou de fato (draft criado), separados por vírgula — **sempre**, nunca omitido (#9813): sem `--thread-ids` o script grava a passada inteira, e uma reply cujo `create_draft` falhou entraria no ledger e seria pulada em silêncio na retomada. Nenhuma reply tratada → não rodar o comando (lista vazia é erro de uso). A que ficou de fora volta na retomada. Reprocessar gera no máximo um rascunho duplicado (desfazível; a alocação de número é idempotente por ciclo+email+edição), perder a reply não tem desfazer.

Os rascunhos criados (com número do sorteio quando alocado) entram como contexto informativo no gate único de §6c, junto com as linhas agregadas do passo 5 de §0-replies e `result.alreadyProcessedCount` (`{N} thread(s) já processada(s) no Passo 1b`). Nunca um gate próprio.

### 6b-slug. Guard de slug do bloco WhatsApp — roda ANTES do gate, nunca bloqueia sozinho (#4570, não-bloqueante desde #8205)

**Só backend `"beehiiv"`.** Com backend `"kit"`, pular esta seção inteira — problema específico da UI de SEO/URL slug da Beehiiv, sem equivalente no Kit (`public_url` do broadcast já é a URL final).

O bloco encaminhável por WhatsApp (dentro do D1 desde #5152, ver `context/templates/newsletter.md`) já tem a URL `https://diar.ia.br/p/{seoSlug(title)}` BAKED IN no corpo do e-mail desde o pré-render do Stage 4 — se o slug real do post divergir, esse link 404 pra quem abrir o e-mail. **Até #8205 esta checagem rodava DEPOIS do clique em Schedule e travava o Stage 6 com um halt banner pedindo `'corrigido'` — um 2º ponto de parada, além do gate de §6c.** Desde #8205, ela roda AQUI (antes de qualquer gate), a correção automática (permanentemente bloqueada pelo plano, #3449) é tentada do mesmo jeito por completude de log, e se a divergência persistir ela vira **aviso destacado dentro da parada única de §6c** — o editor decide ali, na mesma resposta, nunca um segundo gate.

1. Buscar o slug real do post: `mcp__claude_ai_Beehiiv__get_post({ post_id })` → `web_settings.slug`. **Se `get_post` falhar/erroar** (não apenas retornar slug ausente — timeout, disconnect, erro de API), tratar como falha de MCP (#738) — halt banner (comando abaixo), nunca prosseguir assumindo divergência resolvida ou slug correto. Isto **continua sendo halt de infra**, não o gate editorial que este item reduz:
   ```bash
   npx tsx scripts/render-halt-banner.ts \
     --stage "6 — Agendamento" \
     --reason "mcp__claude_ai_Beehiiv desconectado (get_post falhou ao buscar slug)" \
     --action "reconecte e responda 'retry', ou 'abort' para abortar"
   ```
2. Rodar o guard determinístico (comparação pura, `scripts/lib/whatsapp-slug-guard.ts`), gravando o resultado em `_internal/whatsapp-slug-check.json` (`--out`, #4574 — backstop determinístico consumido por `check-invariants.ts --stage 6` em §6g):
   ```bash
   npx tsx scripts/check-whatsapp-slug-guard.ts \
     --post-id {post_id} \
     --d1-title "{title}" \
     --actual-slug "{slug_atual_do_get_post}" \
     --out {EDITION_DIR}/_internal/whatsapp-slug-check.json
   ```
   (omitir `--actual-slug` se `web_settings.slug` vier ausente/vazio — o guard trata ausência como divergência.) **Exit 2 (args inválidos — `post_id`/`title` ausentes)** é bug do orchestrator, não divergência de slug: investigar antes de repetir, sem tratar como aviso pro editor.
3. **Se divergir (exit 1):** tentar a correção automática por completude — sempre falha no plano atual (#3449, `403 SEND_API_NOT_ENTERPRISE_PLAN`, não transitório), então isto é só registro, não um passo que precisa suceder:
   ```bash
   npx tsx scripts/fix-post-slug.ts --post-id {post_id} --slug {slug_correto} --execute
   # exit 3 esperado (#3449) — stderr traz instrucoes manuais formatadas
   ```
   Guardar a mensagem de `formatManualSlugFixInstructions` (reusada pelo stderr do comando acima) para exibir como o aviso destacado dentro do gate de §6c — **nunca** renderizar halt banner nem esperar resposta aqui.
4. Logar o resultado (ok ou diverge), em qualquer caso:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator \
     --level {info se ok, warn se diverge} \
     --message "whatsapp slug guard: {ok|diverge}" \
     --details '{"ok":{ok},"expectedSlug":"{expected_slug}","actualSlug":"{actual_slug}"}'
   ```

Guardar o resultado (`SLUG_CHECK_OK` booleano + instruções de correção manual se `false`) para usar em §6c. **Segue para §6c em qualquer um dos dois casos** — divergência nunca bloqueia esta seção sozinha.

### 6b-site. Checar o PR da página do site aberto no Stage 5 — roda ANTES do gate (#6202 → #8221 → #10160)

**Desde o #10160 o PR da página é aberto no INÍCIO da Etapa 5 (§5b-site do `orchestrator-stage-5.md`, `--no-wait-merge`)** — o dispatch não espera o merge; CI (~12min) e review andaram enquanto newsletter/social/Brevo saíam. Aqui o Stage 6 só CONFERE o estado e mostra no gate; quem trava o fim da etapa no merge é §6c-site (antes do Schedule) + o invariante `site-page-pr-merged` (no sentinel). Trade-off do #8221 inalterado: a página pode ir ao ar mesmo que o editor responda `abortar` no gate de §6c (o waiter e esta checagem mergeiam com CI verde).

Sem este passo o acervo do site fica congelado e a página `/p/{slug}` — destino do link de WhatsApp do e-mail e de campanha paga (#7575) — dá 404 no envio.

**1. Estado registrado pelo Stage 5.** Ler `_internal/site-page-published.json`. Se `published === true` (PR aberto/mergeado no §5b-site), NÃO republicar — pular pro passo 3 (que manda de volta pro passo 2 se a página estiver defasada, exit `5`).

**2. Fallback — só se o arquivo estiver ausente, com `published !== true`, ou se o passo 3 / §6c-site devolver exit `5`** (edição despachada antes do #10160, §5b-site falhou, ou página DEFASADA — #10190: o D1 ou os insumos da página mudaram depois do §5b-site): publicar aqui, igual ao Stage 5. `--slug`: backend `"beehiiv"` → `{slug_atual_do_get_post}` de §6b-slug (divergência já virou aviso pro gate); backend `"kit"` → `--slug-from-d1` no lugar de `--slug` (`seoSlug` do título do D1, mesmo de `deriveEditionUrl`, #7420). `--sitemap` é obrigatório (#6454 — sem ela sitemap/home ficam congelados). **Republicação com slug novo limpa o slug velho sozinha (#10194):** o script lê o slug/PR anterior do state, grava o PR velho em `_internal/site-page-superseded.json` (o waiter dele desiste do merge), fecha o PR velho se aberto (`gh pr close` sem `--delete-branch`, #8158 — só a branch remota sai, fail-soft), tira a `<loc>` velha do sitemap e, se o PR velho já mergeou, remove `p/{slug-velho}` no mesmo commit do PR novo. Nada a fazer à mão; avisos saem no log:

```bash
npx tsx scripts/publish-edition-site-page.ts \
  --edition-dir {EDITION_DIR} \
  {--slug {slug_atual_do_get_post} | --slug-from-d1 pro Kit} \
  --sitemap workers/site/public/sitemap.xml --no-wait-merge
npx tsx scripts/reconcile-site-sitemap.ts
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level {info se 0/2, warn se 3/4/5} --message "site-page stage6 fallback publish: exit {code}"
```

**A home NÃO passa a mostrar esta edição agora, e isso é o comportamento correto (#7686).** `buildHomeFeed` descarta entrada de sitemap cuja `<lastmod>` (= data de ENVIO) ainda não chegou, em BRT — então o `index.html` regenerado neste commit sai SEM a edição que você acabou de publicar. Quem a faz aparecer é o workflow `.github/workflows/regen-home.yml`, às 06:00 BRT, junto do envio real. Decisão do editor (08/09/2026): a página `/p/{slug}` pode ficar pronta antes, sem problema; só a HOME espera. **Não "corrija" isso** — antes do #7686 a home anunciava a edição ~9h antes de qualquer assinante recebê-la, e a home é destino de campanha paga (#7575). Se a home amanhecer sem a edição do dia, o culpado é o workflow das 06:00 ter falhado, nunca o filtro: checar `gh run list --workflow=regen-home.yml`.

**Mesmo corte, e mesmo motivo, no índice `/archive` — reconciliado no CI pelo #8688.** O `<loc>` da edição entra no `sitemap.xml` neste passo (véspera do envio), mas a LINHA dela no índice paginado (`workers/site/public/archive/*`) só chega no regen das 06:00 BRT — mesma assimetria da home, um passo acima. Até o #8688 isso derrubava o CI do PR aberto por este próprio passo: `test/site-archive-index-8353.test.ts` ("cada edição do sitemap é linkada por exatamente 1 página do índice") reprovava toda edição nesse intervalo. O teste agora ignora, ao checar "faltando", qualquer edição cuja data editorial (BRT) seja posterior a hoje — `checkArchiveIndexLinkConsistency`/`resolveEditorialDate` em `scripts/lib/site-archive-index.ts`/`site-home-page.ts`. Se o CI de um PR de §6b-site vier vermelho nesse teste mesmo assim, o problema é outro (edição com data PASSADA sem link é falha real) — não reverta o teste, investigue a data resolvida da edição.

**`reconcile-site-sitemap.ts` roda SEMPRE, logo depois (#7578)** — aditivo, idempotente, sai `0` quando não há o que fazer. Garante que toda página em `workers/site/public/p/` tenha `<loc>` no `sitemap.xml` e regenera a home. Página fora do sitemap é invisível no buscador **e** em `arquivo.diar.ia.br` (cujo acervo DERIVA do sitemap do apex em request-time, sem fonte própria) — foi assim que 5 edições ficaram órfãs entre 28/08 e 03/09/2026, respondendo 200 sem ninguém chegar nelas.

| exit | significado | ação |
|---|---|---|
| `0` | página escrita e branch `site-publish/{slug}` publicada com PR aberto/reusado/mergeado (`git commit` + `push` da branch + `gh pr create`/reuso, mecanismo detalhado abaixo) — desde o #8158 o script tenta mergear sozinho quando CI fica verde | seguir |
| `2` | edição sem `newsletter-final.html` — arquivo ainda não existe, nada a publicar | seguir, logar info |
| `3` | escrita, commit, push ou `gh pr create` falhou (inclui checkout DIVERGENTE de `origin/master` — #7287: o guard compara COMMIT, não nome de branch; um checkout numa branch de nome qualquer cujo HEAD bata com `origin/master` passa normalmente) | **logar warn e seguir** |
| `4` | artefato PRESENTE mas inválido (html/título vazio, `--slug` ausente e sem `post_url`) — bug num stage anterior. Desde #7420, `--slug` sempre basta (não depende de `05-published.json`) | **logar warn e seguir** (nunca silencioso — não é o mesmo caso benigno do `2`) |
| `5` | GUARD (#6202): `buildArchivePageHtml` recusou por merge tag não resolvida (`UnresolvedMergeTagError`, guard do #6210/#6256) — não é a tag padrão do voto (`{{email}}`, essa é sanitizada antes do guard rodar), é uma tag DESCONHECIDA. Nada escrito/commitado | **logar warn e seguir** (fail-soft; a edição segue normal, só o site não ganha página nova até a tag ser tratada) |

**Fail-soft do SCRIPT, inalterado:** nenhum exit do publicador lança nem interrompe esta seção; no `3` a página costuma ficar escrita localmente. O script grava `_internal/site-page-published.json` (`{ code, slug, published, reason, prUrl, prNumber, status, merged, mergeBlocker, checked_at }`) a CADA chamada (#7283) — a visibilidade não depende de `log-event.ts`. O invariante `site-page-published` (§6g, `severity: error` desde #7578) acusa `published !== true`. Mecanismo de branch+PR, auto-merge (#8158) e waiter em background (#9593, log em `_internal/site-page-merge-waiter.log`): `docs/site-page-publish-mechanism.md`.

**3. Estado vivo do PR — determinístico, nunca prosa (#573).** Mergeia na hora se o CI já estiver verde (regra do #5251), sem esperar:
```bash
npx tsx scripts/check-site-page-pr-gate.ts --edition-dir {EDITION_DIR}
```
Exit: `0` MERGED · `3` CI ainda rodando · `1` CI vermelho/conflito/PR fechado · `2` `gh` falhou (estado desconhecido) · `4` sem PR registrado (o fallback do passo 2 falhou) · `5` página DEFASADA (#10190: `state.slug` ≠ slug do D1 atual, ou `sourceDigest` ≠ insumos atuais — o e-mail linkaria `/p/{slug-novo}` com a página em `/p/{slug-velho}`) → rodar o passo 2 e repetir este passo, uma vez. **`--expected-slug {slug}`** em toda chamada da trava sempre que o passo 2 publicou com `--slug {slug}` explícito (Beehiiv); sem ele o slug esperado é o `seoSlug` do D1 atual. Guardar `SITE_PUBLISH_OK` (`published === true` no state file, relido AGORA — o waiter pode tê-lo reescrito), `SITE_PR_GATE` (o JSON impresso: `kind`, `prNumber`, `reason`) e o `mergeBlocker`/`prUrl` do state para o gate de §6c. **Segue para §6c em qualquer resultado** — nenhum exit bloqueia esta seção; a trava é §6c-site.

### 6c. GATE HUMANO — parada única: revisão do e-mail de teste + agendamento (#8205)

**A revisão visual do e-mail de teste pelo editor é a ÚNICA parada de `/diaria-5-publicacao` (decisão do editor, 17/09/2026, #8205).** Tudo que antes tinha ponto de parada próprio — pedidos editoriais (§6b2), guard de slug (§6b-slug), auto-reporter (§6b abaixo) — entra como CONTEXTO deste gate, nunca como pergunta separada. **O PR da página do site foi aberto no início da Etapa 5 (§5b-site, #10160) e conferido em §6b-site** — não é um ponto de parada; o estado do PR entra como linha do gate, e o merge trava o Schedule logo depois (§6c-site).

**Se `--no-gates` (`auto_approve = true`):** pular o gate, usar o default de §6a (06:00 BRT da data da edição, via `resolve-edition-scheduled-at.ts` — nunca "amanhã" contado a partir do relógio) — mesmo horário serve a newsletter (Kit, ou Beehiiv no legado), a Brevo diária e a Kit diária (#5772, se a campanha existir). Logar:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level warn \
  --message "Stage 6 auto-agendado via --no-gates: {scheduled_at_iso}" \
  --details '{"source":"auto_approve","scheduled_at":"{scheduled_at_iso}"}'
```
**`--no-gates` e exit 2 do resolver (#11689):** sem editor pra escolher outro horário, NÃO agendar nem inventar horário: renderizar halt banner (`render-halt-banner.ts --stage "6 — Agendamento" --reason "scheduled_at já passou ou a <15 min ({next_viable_brt ou 'sem horário viável no dia da edição'})" --action "rodar /diaria-6-agendamento {AAMMDD} com editor presente e responder 'ok HH:MM'"`), `log-event.ts --level error` e encerrar o Stage 6 sem sentinel. Qualquer outro exit ≠ 0 do resolver (exit 1) também halta.

Prosseguir direto para §6c-site (trava do PR do site, #10160) e só então §6d (executar Schedule).

**Post pessoal vjpixel: APOSENTADO (#11398, pedido do editor 27/10/2026).** O 4º post (USE MELHOR, `## um`) não sai mais no LinkedIn PESSOAL do editor — nem automático (`publish-linkedin-personal.ts --arm`, antigo §6d-pessoal) nem por lembrete manual no gate. O Stage 6 **não** roda `resolve-post-pixel.ts` nem `publish-linkedin-personal.ts --check`/`--arm`, e o gate de §6c não tem bloco de lembrete do post pessoal. A página diar.ia.br segue recebendo o 4º post normalmente (Stage 5). Trava: `test/stage6-sem-linkedin-pessoal-11398.test.ts`.

**Marcador de `gate_at` (#8866) — fail-soft, nunca bloqueia.** Imediatamente antes de apresentar o gate único, gravar o timestamp de apresentação (usado por `pipeline_ms` — tempo do pipeline até o gate, excluindo a espera pela resposta do editor):
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 6 --status running --gate-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```
Erro do comando = ignorar e seguir.

**Se modo interativo:** apresentar o gate único. `{test_email}` vem de `publishing.newsletter.test_email` em `platform.config.json`:

```
✉️  REVISE O E-MAIL DE TESTE — Edicao {AAMMDD}

Confira o e-mail de teste na sua caixa ({test_email}, assunto "[teste] {title}"
ou "[TEST] {title}" conforme o backend).

Newsletter (rascunho): {draft_url}
Test email:            {test_email_sent_at} ✓
Review automatico (review-test-email + lint-test-email-*): {review_status_block — "✓ sem achados" | lista de review_final_issues/unfixed_issues}
{"⚠ Slug do bloco WhatsApp diverge — link ficaria quebrado no e-mail já enviado. " + instrucoes de correcao manual, SÓ se SLUG_CHECK_OK === false}
{"⚠ Publicação da página do site falhou (código {code}, motivo {reason}) — a edição não vai pro acervo até re-rodar publish-edition-site-page.ts e mergear o PR. " + prUrl se houver, SÓ se SITE_PUBLISH_OK === false}
{"Site: PR #" + SITE_PR_GATE.prNumber + " " + (kind merged → "MERGED ✓" | pending → "CI rodando — §6c-site espera até 9min antes do Schedule" | blocked/cannot-verify → "⛔ " + reason + " — o Schedule NÃO sai sem o merge (#10160)"), SÓ se o state tiver PR}
{"📋 Pedidos editoriais aceitos: " + resumo de §6b2, SÓ se o arquivo existia}

Social agendado:
  LinkedIn  D1 {hh:mm BRT} · D2 {hh:mm BRT} · D3 {hh:mm BRT} · UM {hh:mm BRT, se o 4º post saiu — #9568}
  Facebook  D1 {hh:mm BRT} · D2 {hh:mm BRT} · D3 {hh:mm BRT} · UM {hh:mm BRT, se o 4º post saiu}

{bloco Brevo diária, SÓ se _internal/brevo-diaria-published.json existir:}
Brevo diária (rascunho, campaign_id {campaign_id}): agenda junto com a newsletter no mesmo horário abaixo (#5772)

  ok           → agenda para 06:00 BRT do dia da edição (default)
  ok HH:MM     → agenda para {horario informado} BRT do dia da edição
  abortar      → nao agenda nada; rascunhos permanecem, sentinel nao escrito
  Qualquer outra entrada → repetir (fail-closed)
```

Aguardar resposta do editor. Interpretar — **`{AAMMDD}` (a data da edição), nunca "amanhã" pelo relógio (#8207)**: os dois ramos usam o MESMO comando de §6a, só variando `--hhmm` — `ok` (sem horario, default 06:00 BRT) → `scheduled_at` = `npx tsx scripts/resolve-edition-scheduled-at.ts --aammdd {AAMMDD}`; `ok HH:MM` (validar HH 0-23, MM 0-59) → `... --aammdd {AAMMDD} --hhmm {HH:MM}`.
  **Horário no passado (#11689):** o resolver sai com exit 2 (stdout vazio, stderr `next_viable=… next_viable_brt=HH:MM`) quando o horário já passou ou está a <15 min. Nunca agendar nem trocar o horário sozinho: exibir o aviso no gate ("{HH:MM} BRT de {AAMMDD} já passou; próximo viável {next_viable_brt} BRT"), oferecer `ok {next_viable_brt}` e repetir o gate. **`next_viable=none`** (não resta horário no dia da edição: passou da meia-noite BRT ou a edição já passou): NÃO oferecer `ok HH:MM`, só `abortar` ou — sob pedido explícito do editor de outro dia — `--allow-other-date`. A defesa final dos 3 agendadores (Kit, Brevo, Kit diária) recusa só `--scheduled-at` de fato passado ou com margem <2 min (exit 6/6/5, sem override), roda também com `--edition-dir` de nome irreconhecível e vem DEPOIS do atalho idempotente (re-rodar um agendamento já feito segue sucesso). A margem do gate é maior (15 min) de propósito: os 3 canais agendam em sequência e um gate raspando o limite deixaria agendamento parcial entre canais. Exit 6/5 por passado nos agendadores: bloqueia, mesmo tratamento da linha de divergência de data abaixo (voltar ao gate, nunca retry cego).
- `abortar` → logar warn, NAO escrever sentinel, encerrar Stage 6. Editor pode re-rodar `/diaria-6-agendamento {AAMMDD}` depois.
- Qualquer outra coisa → exibir o gate novamente (fail-closed).

**Um único `scheduled_at` serve todos os canais (newsletter Kit, ou Beehiiv no legado; Brevo diária; Kit diária)** — decisão do editor: o gate não pergunta o horário mais de uma vez. Se algum canal não existir (`_internal/brevo-diaria-published.json`/`kit-diaria-published.json` ausente), o bloco correspondente nunca aparece e a seção de agendamento daquele canal (abaixo) é pulada sem erro.

Logar resposta:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "gate 6 response: {ok HH:MM|abortar}" \
  --details '{"response":"{resposta}","scheduled_at":"{scheduled_at_iso}","slug_check_ok":{SLUG_CHECK_OK}}'
```

### 6c-site. TRAVA — PR da página do site MERGED antes do Schedule (#10160)

**Roda logo após o `ok`/`ok HH:MM` do gate (ou direto no `--no-gates`), ANTES de qualquer Schedule (§6d/§6d-kit/§6d-brevo).** `abortar` não chega aqui. A Etapa 6 NÃO termina, nem grava `.step-6-done.json`, sem o PR do site mergeado — sem o merge, `/p/{slug}` dá 404 no envio. Checagem determinística (#573), nunca a prosa do agente:
```bash
npx tsx scripts/check-site-page-pr-gate.ts --edition-dir {EDITION_DIR} --wait-ms 540000
```
- `0` (MERGED — já estava, ou o CI ficou verde e o script mergeou com `--squash --match-head-commit` sob o merge lock, regra do #5251) → seguir pro Schedule.
- `3` (CI ainda rodando após 9min) → rodar o MESMO comando de novo (o job `test` leva ~12min); ainda `3` na 3ª vez → halt banner abaixo, motivo "CI do PR do site não convergiu".
- `5` (página DEFASADA, #10190) → re-rodar o fallback do §6b-site passo 2 (republica com o slug/conteúdo atuais; slug novo fecha o PR antigo e limpa o acervo sozinho, #10194) e repetir este comando; ainda `5` depois disso → tratar como `1`.
- `1` (CI vermelho, conflito, PR fechado, merge recusado), `2` (`gh` falhou — desconhecido NUNCA vira mergeado) ou `4` (sem PR registrado: re-rodar o fallback do §6b-site passo 2 e repetir — **exceto** com `code: 5` no state, guard de merge tag desconhecida: o fallback falha igual, ir direto pro halt) → **halt**, sem agendar nada:
```bash
npx tsx scripts/render-halt-banner.ts --stage "6 — Agendamento" --reason "PR da página do site não mergeado: {reason do JSON}" --action "corrija o CI/conflito (gh pr view {prNumber}) e responda 'retry' (re-roda §6c-site), 'bypass {motivo}' (agenda a newsletter sem a página, #10191) ou 'abort'"
```
**Bypass (#10191) — a newsletter não deixa de sair por causa da página.** Resposta `bypass {motivo}` (ex.: CI vermelho alheio à página, flake, guard de merge tag) → rodar a trava com `--bypass-reason "{motivo}"` (+ `--expected-slug` se aplicável), que grava `prGateBypass` no state e sai `0`; seguir pro Schedule e listar no resumo final "página do site NÃO mergeada (bypass: {motivo}) — /p/{slug} pode dar 404 até o merge". Exit ≠ 0 com `--bypass-reason` = o registro falhou: halt de novo, o bypass não valeu. **`--no-gates` (#10191, sem editor pra responder `retry`):** esgotadas as tentativas acima (3× `3`, `5` persistente, `1`/`2`/`4`), NÃO haltar — rodar a trava com `--bypass-reason "--no-gates: {reason do JSON}"`, logar `warn` (`log-event.ts --stage 6 --message "site-page pr gate bypass (--no-gates): {reason}"`) e seguir pro Schedule. Premissa: newsletter não enviada é perda irreversível do dia. **A recuperação automática da página só vale pra `pending`/`blocked` (#10196)** — ali o waiter em background do #9593 segue tentando o merge até as 06:00 e o editor recebe o alerta dele. Com `stale` persistente (exit `5` depois do fallback — causa provável: o post saiu com `--slug` explícito e alguma chamada da trava esqueceu `--expected-slug`), NENHUM processo vai publicar a página certa: o waiter só mergeia o PR do slug que ele conhece. (`no-pr`, exit `4`, segue o caminho comum — log `warn`, sem issue/e-mail: é o veredito do bypass previsto do guard de merge tag.) A trava trata o `stale` à parte sozinha — grava `prGateBypass.unrecoverable: true`, loga `error` e dispara `notifyEditor` urgente (issue P1 + e-mail) dizendo que `/p/{slug-do-email}` não tem página — e o JSON sai com `"unrecoverable": true`; nesse caso o log do playbook é `--level error` (não `warn`) e o resumo final lista "página do site SEM publicação para o link do e-mail (bypass {veredito}) — republicar à mão antes das 06:00".

Backstop mecânico: o invariante `site-page-pr-merged` (`STAGE_6_RULES`, `severity: error`) faz `pipeline-sentinel.ts write --step 6` recusar o sentinel enquanto o PR registrado não estiver MERGED — pular este passo não fecha a etapa. Com `prGateBypass` gravado pela trava, ele e `site-page-published` caem pra `warning` (o bypass já foi a decisão; o sentinel não pede um 2º).

### 6d. Executar Schedule do Beehiiv

**Só roda com backend `"beehiiv"` EXPLÍCITO (legado, ver §6a — o default é `"kit"` desde o #11225).** Com backend `"kit"`, pular esta seção INTEIRA (a checagem de slug do bloco WhatsApp em §6b-slug já pulou por igual motivo — problema específico da UI de SEO/URL slug da Beehiiv sem equivalente no Kit) e seguir direto para **§6d-kit** abaixo.

**Exibir banner pre-Schedule ao editor ANTES de pedir o clique** (evitar Publish acidental, incidente 260611 #2074):

```
Proximo passo: clicar em Schedule → selecionar AMANHA {data_alvo} → {HH:MM} BRT.
NAO clique em "Publish now" — isso dispara envio imediato pra toda a audiencia.
```

Navegar para `draft_url` no Chrome e executar o passo de Schedule do Beehiiv conforme documentado em `context/publishers/beehiiv-playbook.md` §9 (Verificar slug pos-Schedule) e §10 (Verificar estado pos-Schedule).

**Clique AUTOMATIZADO (#6098, decisao do editor 25/08).** O gate humano de §6c continua onde esta — o que deixou de ser manual e o CLIQUE, nao a aprovacao. Depois da aprovacao, executar via `computer.left_click`:

1. botao **Schedule** (pagina Review) → abre o modal "When should this publish?"
2. **opcao de horario correspondente ao `{scheduled_at}` aprovado no gate** — NAO assumir que "Next usual send time" e o alvo
3. botao **Schedule** do modal → toast "Your post is scheduled!"

**Fallback pro manual, sempre:** se qualquer um dos 3 cliques falhar (modal nao abre, nao fecha, elemento nao encontrado), parar e pedir o clique ao editor com o banner pre-Schedule acima. Falha de clique NUNCA vira falha de edicao.

**Verificar estado via `scripts/verify-scheduled-post.ts` (#573, #2074 — obrigatorio):**

```bash
npx tsx scripts/verify-scheduled-post.ts \
  --post-id {post_id} \
  --edition-dir {EDITION_DIR}/ \
  --expect-scheduled-at {scheduled_at_iso}
```

⚠️ **`--expect-scheduled-at` e OBRIGATORIO no caminho automatizado (#6098).** Com clique manual o editor lia a data no modal; automatizado, esta flag e o unico ponto que ve. Sem ela, clicar a opcao errada no passo 2 produz um agendamento perfeitamente valido **no dia errado**, e o exit 0 diz que deu tudo certo.

| Exit | Estado | Acao |
|------|--------|------|
| `0` | `scheduled` no horario esperado | Confirmar ao editor: "Agendado para {scheduled_at} ✓" |
| `1` | `published` — envio imediato detectado | Sequencia de reconciliacao abaixo |
| `2` | `unknown` / `draft` / erro | Alertar editor; verificar manualmente no dashboard Beehiiv |
| `3` | `scheduled` no horario **ERRADO** (#6098) | Opcao errada no modal. O post NAO esta no ar — corrigir o agendamento no painel e re-verificar |

**Sequencia de reconciliacao (exit 1 — publicado imediato):**

O script ja atualiza `05-published.json`. Executar obrigatoriamente:

```bash
# close-poll — finalizar scores de E IA? (se ainda nao rodou)
npx tsx scripts/close-poll.ts --edition {AAMMDD}

# refresh-dedup — regra CLAUDE.md: "publicacao requer refresh-dedup"
npx tsx scripts/refresh-dedup.ts
```

Relatar ao editor:
```
⚠️ ENVIO IMEDIATO DETECTADO — a newsletter foi publicada agora ({published_at}).
O botao clicado foi "Publish" (envio imediato), nao "Schedule".
05-published.json atualizado (status: published).
data/past-editions.md regenerado via refresh-dedup.
```

**Slug do bloco WhatsApp — já conferido em §6b-slug, antes do gate (#8205).** Não roda de novo aqui. Se `_internal/whatsapp-slug-check.json` gravou `ok:false`, o editor já viu o aviso destacado no gate de §6c e decidiu seguir mesmo assim (`ok`/`ok HH:MM`) — nunca um 2º halt aqui. `check-invariants.ts --stage 6` (§6g) confere o arquivo pós-hoc pra auditoria, sem bloquear.

**Guard refresh-dedup apos schedule confirmado:** rodar `/diaria-refresh-dedup` (equivalente a `npx tsx scripts/refresh-dedup.ts`) para manter `data/past-editions.md` atualizado.

### 6d-kit. Executar Schedule do Kit (#464 — só quando backend `"kit"`)

**Exibir o mesmo banner de segurança do §6d antes de agendar** — a diferença
aqui é que não há clique manual: o script faz o PATCH direto. Confirmar o
horário com o editor antes de rodar (mesmo horário default calculado em
§6a: 06:00 BRT do dia da edição).

```bash
npx tsx scripts/schedule-newsletter-kit.ts \
  --edition-dir {EDITION_DIR}/ \
  --scheduled-at {scheduled_at_iso}
```

O script faz PATCH `/broadcasts/{id}` (`send_at`) e só declara sucesso depois de um GET de verificação confirmar o `send_at` de volta — mesmo padrão de `verify-scheduled-post.ts` (Beehiiv, §6d) e `schedule-daily-brevo.ts` (§6d-brevo). Um broadcast Kit `completed` (já disparado) é **imutável** — sem retry automático além do já embutido em `kitFetch`.

Exit codes:
| Exit | Significado | Ação |
|------|-------------|------|
| `0` | Agendado e verificado. | Confirmar ao editor: "Agendado para {scheduled_at} ✓ (broadcast_id {id})". Seguir para §6e. |
| `2` | `publishing.newsletter.backend` != `"kit"` (guard interno do script). | Não deveria acontecer aqui — mesma nota do §5c-1-kit sobre leitura divergente da config; investigar antes de prosseguir. |
| `3` | `_internal/newsletter-kit-published.json` ausente/sem `broadcast_id`. | Etapa 5 não rodou o publisher Kit pra esta edição — voltar pro Stage 5 antes de continuar (não há o que agendar). |
| `4` | PATCH falhou (erro de API). | Logar erro com o `reason` do JSON de stdout; **bloqueia** o Stage 6 (diferente do Brevo em §6d-brevo — aqui é o ÚNICO canal de newsletter, não um secundário) — investigar antes de retry manual. |
| `5` | GET pós-PATCH não confirma o agendamento. | Mesmo tratamento do exit 4 — bloqueia, investigar antes de retry. |
| `6` | `--scheduled-at` diverge da data da edição (#8207) — não deveria acontecer se `{scheduled_at_iso}` veio de `resolve-edition-scheduled-at.ts` (§6a/§6c). | Bloqueia — investigar como `{scheduled_at_iso}` divergiu antes de qualquer retry. Retry manual intencional (editor pediu explicitamente outro dia) usa `--allow-other-date`, nunca por padrão. |
| `7` | Audiência não confirmada (#10437): com `kit.diaria_exclusion_segment` ligado, segmento não resolvido ou o broadcast relido (antes ou depois do PATCH) sem o filtro do segmento; com ele desligado, contatos `kit-sem-abertura:` já movidos pra Brevo. Nada é agendado pra base inteira no lugar. Se o broadcast JÁ estava agendado, o script tenta desagendar (`send_at: null` + releitura). | **Bloqueia sempre** — nunca apresentar o Stage 6 como concluído. **Se o `reason` contiver `DESAGENDE` (o desfazer falhou ou não foi confirmado — o broadcast pode continuar agendado pra audiência errada):** halt banner (`render-halt-banner.ts --stage "6 — Agendamento" --reason "broadcast Kit {id} segue agendado com audiência divergente e o desagendamento automático falhou" --action "DESAGENDAR À MÃO no Kit AGORA (app.kit.com/campaigns/{id}) e responder 'retry' ou 'abort'"`) e aguardar o editor. Sem `DESAGENDE`: halt banner com o `reason` do JSON — conferir o segmento/config antes de qualquer retry, nunca desligar a flag pra destravar. |

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator \
  --level {info se exit 0, error se 3/4/5/6/7} \
  --message "newsletter kit stage6 schedule: exit {code}" \
  --details '{json de saída do script}'
```

**Guard refresh-dedup apos schedule confirmado** — mesmo passo do §6d: rodar `/diaria-refresh-dedup`.

#### §6d-kit-social-retry — backstop de Threads/X (#7405, neutralizado pelo #7420)

**Histórico:** com backend Kit, `{edition_url}` costumava vir do `public_url`
do broadcast (só ganhava slug depois do broadcast sair de `"draft"`),
quebrando Threads/X (únicos 2 canais com o link INLINE no texto) na Etapa 5.
**Corrigido em #7420:** `publish-newsletter-kit.ts` agora grava
`05-edition-url.txt` com `deriveEditionUrl(d1.title)` — URL PRÓPRIA
(`https://diar.ia.br/p/{seoSlug(d1Title)}`, `diar.ia.br` é nosso desde o
cutover #467 — a mesma que o bloco WhatsApp já crava no e-mail), derivada só
do título, sem chamada de rede. **Threads/X já saem certos na Etapa 5**;
este passo virou backstop pra edições legadas.

Rodar mesmo assim (idempotente, sem custo — o script recusa sobrescrever uma
URL própria já resolvida, `reason:"already_own_domain"`):

```bash
npx tsx scripts/kit-refresh-social-edition-url.ts --edition-dir {EDITION_DIR}/
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level {info se ok:true, error se ok:false} --message "kit-refresh-social-edition-url stage6: {resolved/reason}" --details '{json}'
```

`resolved:false` (`already_own_domain` — caminho feliz desde o #7420 —,
`backend_not_kit`/`no_slug_yet`/`already_resolved` — só edições pré-#7420) →
nada a fazer, seguir (sem retry adicional — evita loop). `ok:false` (code 3/4)
→ logar erro, não bloqueia. **Só `resolved:true`** (só alcançável em edição
legada pré-#7420, arquivos regravados) → re-dispatchar os 2 canais:

1. **Threads** (idempotente, `--skip-existing` default só pula
   `draft`/`scheduled`/`published`): `npx tsx scripts/publish-threads.ts
   --edition-dir {EDITION_DIR}/ --schedule`
2. **Twitter/X via Buffer MCP** — mesmo mecanismo do §5c-3b em
   `orchestrator-stage-5.md` (só a sessão do agente alcança): rodar
   `prep-twitter-posts.ts` de novo e, pra cada `posts` ainda sem entrada
   `scheduled`/`published`/`draft` pra `platform:"twitter"` + `destaque`,
   chamar `create_post` como em §5c-3b passo 2 **e gravar via
   `append-twitter-published.ts` (passo 3) logo em seguida** — sem isso o
   dedup não tem o que ler numa 2ª invocação, risco de duplicar post no X.

Fail-soft nos 2 — nunca bloqueia o resto do Stage 6. Seguir pra §6d-brevo/§6e.

### 6d-brevo. Agendar campanha Brevo diária (#5772)

**Roda SÓ se `_internal/brevo-diaria-published.json` existir** (lido em §6a) — canal pulado/falhou na Etapa 5 (`--skip brevo`, config ausente, store ausente) significa nada a agendar aqui; pular esta seção inteira sem erro. Usa o MESMO `scheduled_at` confirmado em §6c para a newsletter principal (Kit, ou Beehiiv no legado, #11225) — decisão do editor, #5772: um único gate, um único horário para todos os canais.

```bash
npx tsx scripts/schedule-daily-brevo.ts \
  --edition-dir {EDITION_DIR}/ \
  --scheduled-at {scheduled_at_iso}
```

O script faz PUT `/emailCampaigns/{id}` (`scheduledAt`) e SÓ declara sucesso depois de um GET de verificação confirmar o `scheduledAt` de volta — mesmo padrão de `schedule-newsletter-kit.ts` (§6d-kit; `verify-scheduled-post.ts` no ramo Beehiiv legado). **Semanal dividida (#11286):** quando a Etapa 5 criou também a campanha de TERÇA (`terca_campaign_id` no estado), o mesmo comando agenda ela 24h depois da de segunda (cota do dia de terça, PUT + GET) e devolve `terca` no JSON; exit 3/4/5 com a segunda já agendada significa que só a de terça falhou — re-rodar o mesmo comando pula a de segunda e tenta só a de terça. Uma campanha Brevo agendada é **imutável** — não há re-tentativa automática além do retry HTTP já embutido em `brevoPut`/`brevoGetCampaign`.

Exit codes:
| Exit | Significado | Ação |
|------|-------------|------|
| `0` | Agendado e verificado. | Confirmar ao editor: "Brevo diária agendado para {scheduled_at} ✓ (campaign_id {id})". Se o JSON trouxer `terca` (semanal dividida segunda/terça, #11286), acrescentar: "+ metade de terça agendada para {terca.scheduledAt} ✓ (campaign_id {terca.campaignId})". |
| `2` | Nenhuma campanha registrada (já esperado se o canal foi pulado/falhou na Etapa 5). | Não é erro — seguir sem mencionar no resumo, ou mencionar como "canal Brevo não participou desta edição" se `_internal/brevo-diaria-published.json` de fato não existia. |
| `3` | PUT falhou (erro de API). | Logar warn com o `reason` do JSON de stdout; **não bloqueia** o resto do Stage 6 (a newsletter do backend — Kit, ou Beehiiv no legado — já agendada é o que importa, #5772 fail-soft) — avisar o editor que o Brevo precisa de retry manual (`npx tsx scripts/schedule-daily-brevo.ts --edition-dir {EDITION_DIR}/ --scheduled-at {scheduled_at_iso}`). |
| `4` | GET pós-PUT não confirma o agendamento. | Mesmo tratamento do exit 3 — warn, não bloqueia, sugerir retry manual. |
| `5` | **Cota da CONTA Brevo insuficiente pro tamanho da campanha (#6146).** O plano free tem 300 e-mails/dia num balde ÚNICO (transacional + marketing) — outro processo pode ter gastado a cota mesmo com a FILA folgada (`daily_send_cap`). Também cobre falha de leitura da cota, que degrada pra "não agenda". | Warn, **não bloqueia** o resto do Stage 6 (mesmo fail-soft dos exits 3/4). **Mas comunicar ao editor com destaque, não como warn de rodapé:** foi exatamente este cenário que derrubou o canal por ~12h em silêncio em 260825 — campanha criada, agendada, e a Brevo marcou `suspended` com `sent: 0`. **NÃO sugerir retry cego** (diferente do 3/4): repetir o comando falha igual enquanto a cota não virar. O guard mede o dia UTC do ENVIO; se o envio é amanhã, a Brevo nem aceita consultar aquele dia (HTTP 400) e o veredito passa de graça — nesse caso o sinal útil é o aviso de TRANSBORDO no stderr. Conferir o consumo antes de qualquer retry (`scripts/lib/brevo-account-quota.ts`). |
| `6` | `--scheduled-at` diverge da data da edição (#8207) — não deveria acontecer se `{scheduled_at_iso}` veio de `resolve-edition-scheduled-at.ts` (§6a/§6c). | Bloqueia (diferente do fail-soft dos exits 3/4/5 — isto é o mesmo bug que atrasou a edição 260917, nunca tratar como falha de API). Investigar como `{scheduled_at_iso}` divergiu antes de qualquer retry. Retry manual intencional (editor pediu explicitamente outro dia) usa `--allow-other-date`, nunca por padrão. |

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator \
  --level {info se exit 0, warn se 3/4/5, error se 6, info se 2} \
  --message "brevo-diaria stage6 schedule: exit {code}" \
  --details '{json de saída do script}'
```

#### §6d-kit-diaria — canal Kit PARALELO (#6048/#6126)

**Só quando `kit_diaria.enabled === true`.** Roda ao lado da newsletter principal (Kit, §6d-kit; Beehiiv só no ramo legado, #11225) e da Brevo diária, pra audiência própria (`kit_diaria.audience_tag`). **Não é o §6d-kit**, que agenda o backend EXCLUSIVO do switchover (#6114) — coexistem enquanto a partição por origem de cadastro durar. Mesmo `scheduled_at` da newsletter principal, confirmado no gate de §6c, sem pergunta separada.

```bash
npx tsx scripts/schedule-kit-diaria.ts --edition-dir {EDITION_DIR}/ --scheduled-at {scheduled_at_iso}
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level {info se 0/2, warn se 3/4, error se 5} --message "kit-diaria stage6 schedule: exit {code}"
```

| Exit | Ação |
|------|------|
| `0` | Confirmar: "Kit diária agendado para {scheduled_at} ✓ (broadcast_id {id})". |
| `2` | Canal desligado ou estado ausente — **não é erro**, não participou desta edição; omitir do resumo. |
| `3` | PATCH falhou / config-estado ilegível. Warn, **não bloqueia** (fail-soft do Brevo), sugerir retry. |
| `4` | GET pós-PATCH não confirma `send_at`. Warn, não bloqueia. **Nunca reportar como agendado** — pode ter ficado rascunho. |
| `5` | `--scheduled-at` diverge da data da edição (#8207) — não deveria acontecer se `{scheduled_at_iso}` veio de `resolve-edition-scheduled-at.ts` (§6a/§6c). Bloqueia — investigar antes de retry; `--allow-other-date` só sob pedido explícito do editor. |


**Falha aqui NUNCA desfaz o Schedule da newsletter (Kit, ou Beehiiv no legado) já confirmado** — os dois canais são independentes; o Brevo é sempre o secundário/extra (segmento Pending, reativação).

**Publicação da página do site: PR aberto no início da Etapa 5 (§5b-site, #10160), conferido em §6b-site e mergeado na trava §6c-site, antes do Schedule.** Não roda de novo aqui.

### 6d-pessoal. (aposentado, #11398)

Não arma mais nada. O post pessoal do LinkedIn (4º post no perfil vjpixel, #9568) foi desligado a pedido do editor em 27/10/2026 — ver a nota antes do gate de §6c. Intenção já armada por edição anterior (`_internal/06-linkedin-personal.json`) não é disparada: a task `Diaria-LinkedIn-Personal` não roda mais o `--fire-due` e a `-Catchup` está `enabled: false` em `scripts/lib/scheduled-tasks.ts`.

### 6e. Atualizar `05-published.json` com scheduled_at

**Só backend `"beehiiv"`.** Com backend `"kit"`, pular esta seção — `schedule-newsletter-kit.ts` (§6d-kit) já grava `scheduled_at`/`status: "scheduled"` em `_internal/newsletter-kit-published.json` internamente, só depois de confirmar via GET (mesma garantia que este passo busca aqui pro caminho Beehiiv).

Apos schedule confirmado (exit 0 do verify-scheduled-post ou reconciliacao de envio imediato), atualizar `05-published.json`:

```bash
node -e "
  const fs = require('fs');
  const path = '{EDITION_DIR}/_internal/05-published.json';
  const pub = JSON.parse(fs.readFileSync(path, 'utf8'));
  pub.scheduled_at = '{scheduled_at_iso}';
  pub.status = 'scheduled';
  fs.writeFileSync(path, JSON.stringify(pub, null, 2));
"
```

**Derivar pedidos editoriais do diff (#5731).** No gate de agendamento, derivar pedidos comparando snapshots vs estado atual (captura mudanças pós-Stage 4, se houver):
```bash
npx tsx scripts/derive-editor-requests.ts derive-stage6 --edition {AAMMDD}
```
Exit code handling: `0` = derivação concluída (contagem no stdout); `!=0` = logar warn, não bloquear.

### 6f. Escrever sentinel de conclusao

**Backend-aware (#464, mesmo motivo do §5h/Stage 5 e da Pre-condicao acima).** **Desde #7963, mesmo gate mecânico do §5h** — `write --step 6` também recusa (exit 1, sem bypass) `--outputs` com o artefato de newsletter do backend errado. Backend `"beehiiv"` (legado, só explícito):

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 6 \
  --outputs "_internal/05-published.json"
```

Backend `"kit"`:

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 6 \
  --outputs "_internal/newsletter-kit-published.json"
```

Sentinel ausente = Stage 6 incompleto para fins de resume. Falha → logar warn, nao bloquear auto-reporter. **O `write` NAO exige `_internal/edition-report.html` (#9822)** — a regra `edition-report-exists` e `postDispatchOnly` (o report so nasce em 6b-6, depois deste passo); quem exige o report e o `--status done` de 6b-7.

**NAO marcar Stage 6 `done` aqui (#2800).** `blockReasonForMarkingStageDone` (stage 6) exige
`_internal/edition-report.html`, que so e gerado no passo 6b-6 (Etapa 6b — Auto-reporter,
ABAIXO neste arquivo). Chamar `update-stage-status --stage 6 --status done` neste ponto
sempre bloqueia (exit 1, doc nao gravado) porque o report ainda nao existe — a causa-raiz
do bug em que a barra de status ficava presa em `running` apos a edicao ja ter concluido
de fato. O `--status done` correto fica no passo **6b-7**, apos o report ser escrito.

### 6g. Check invariants Stage 6

```bash
npx tsx scripts/check-invariants.ts --stage 6 --phase pre-dispatch --edition-dir {EDITION_DIR}/
```

`--phase pre-dispatch` pula so `edition-report-exists` (#9822 — o report ainda nao existe aqui; 6b-7 o exige). Exit 1 = logar warn (nao bloquear auto-reporter). Sempre pós-hoc, nunca interativo (#8205 — a parada única do pipeline é §6c, nenhuma regra aqui espera resposta do editor): `whatsapp-slug-guard-ok` (#4574) confirma que `_internal/whatsapp-slug-check.json` existe com `ok:true` — se divergiu, já apareceu como aviso destacado no gate de §6c (§6b-slug) e o editor seguiu ciente; esta checagem só audita que o arquivo foi de fato gravado (agente não pulou §6b-slug por engano). `site-page-published` (#7283) lê `_internal/site-page-published.json` e acusa `severity: error` quando `published !== true` — se falhou, já apareceu como aviso destacado no gate de §6c (§6b-site, #8221) e o editor seguiu ciente; `severity: error` marca a falha como digna de destaque no relatório/dashboard (usado por `docs/editorial-invariants.md`/Studio) além disso, mas **não é um 2º gate**: a regra irmã `site-sitemap-no-orphans` (#7578) segue o mesmo padrão, acusando página em `workers/site/public/p/` sem entrada no `sitemap.xml` (órfã, invisível no buscador e em `arquivo.diar.ia.br`).

### 6h. Purga automatica de votos do editor no leaderboard (#3032)

Apos o Schedule confirmado (§6d), purgar do leaderboard do "É IA?" os votos das 2
contas do editor (`pixel@memelab.com.br` + `vjpixel@gmail.com`) — ele vota durante a
curadoria/teste pra setar/conferir o gabarito, e esses votos NAO devem competir no
ranking publico. Reusa a mesma logica de `/diaria-remover-votos-pixel`
(`scripts/purge-leaderboard.ts`), agora automatico e sem gate: acao determinística e
hardcoded (2 emails fixos → blast radius baixo), idempotente (re-rodar numa conta ja
limpa e no-op).

**Escopo:** so votos `diaria` (default do script, sem `--brand`). O mensal (Clarice)
usa `--brand clarice` e fica FORA deste auto-run diario — nao tocar.

**Checar a auth do KV antes de rodar (#11253).** `purge-leaderboard.ts` tem dois backends e escolhe sozinho:
wrangler logado via OAuth (Neo; `check-wrangler-auth.ts`, env sanitizado, #6900/#2265) ou, sem esse login, a
API REST do KV com `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (servidor `300`, que nao tem navegador
pra `wrangler login`). O pre-check usa a MESMA escolha que a purga vai usar — nunca `npx wrangler whoami`
cru (valida identidade errada, #6900) nem `check-wrangler-auth.ts` sozinho (reprova o `300`, que tem o caminho REST):
```bash
npx tsx scripts/purge-leaderboard.ts --check-auth --edition-dir {EDITION_DIR}/ --expect-emails pixel@memelab.com.br,vjpixel@gmail.com
```
- **Exit 0** (imprime `[purge] kv backend: wrangler|rest — {motivo}`; o probe leu E gravou no namespace e
  `ADMIN_SECRET` existe) → prosseguir com a purga abaixo (o `{backend}` ja fica no arquivo de estado, #11311).
- **Exit != 0, OU timeout** (sem backend, probe de leitura/escrita falhou, ou falta `ADMIN_SECRET`) → **degradar
  pra warn e SEGUIR sem a purga:** nao chamar `--execute` (nem tentar de novo), logar o warn abaixo e passar pra 6b
  (o motivo — 1a linha `[purge]` do stderr — ja fica no arquivo de estado). §6d NAO e reaberto. Nao tentar `wrangler login` nem pedir credencial.
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level warn \
    --message "purga de votos do editor pulada: pre-check --check-auth falhou" \
    --details '{"reason":"purge_precheck_failed","detail":"{1a linha [purge] do stderr do --check-auth}"}'
  ```

**Se autenticado, rodar a purga (execute direto — mesma justificativa de
`/diaria-remover-votos-pixel`: sem gate, sem dry-run previo):**
```bash
npx tsx scripts/purge-leaderboard.ts --email pixel@memelab.com.br --execute --edition-dir {EDITION_DIR}/
npx tsx scripts/purge-leaderboard.ts --email vjpixel@gmail.com --execute --edition-dir {EDITION_DIR}/
```

**Estado em arquivo, não em memória (#11311).** Com `--edition-dir` (nunca omitir), o próprio script grava em `{EDITION_DIR}/_internal/leaderboard-purge.json` o pré-check (zera a rodada) e cada `--execute` (`{status: ok|pendente, backend, motivo, at, keys_deleted, check_auth, emails}`), com "não concluiu" gravado antes de começar — timeout/kill no meio fica PENDENTE. O Resumo final lê esse arquivo.

Cada execucao imprime `[purge] done — {N} keys apagadas, {M} snapshots invalidados.`
(ou `[purge] nada pra apagar` se a conta ja estava limpa — trate como `{N}=0`). Somar
o `{N}` das 2 chamadas e logar a contagem total pra auditoria:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "purga de votos do editor concluida: {total_keys} keys apagadas" \
  --details '{"emails":["pixel@memelab.com.br","vjpixel@gmail.com"],"keys_deleted":{total_keys}}'
```

Falha de um dos 2 comandos (exit != 0 — erro de rede/KV, ou o `[purge] ERRO` da purga do DO ScoreCounter) → logar warn com o motivo e seguir (e-mail e motivo já ficam no arquivo de estado); nunca bloquear o restante do Stage 6 por causa desta purga.

---

## Etapa 6b — Auto-reporter (#57 / #79)

Auto-reporter roda **no Stage 6** (move do Stage 5). Reflete o estado final agendado da edicao.

### 6b-0. Validar social published (#272)

```bash
npx tsx scripts/validate-social-published.ts {EDITION_DIR}/
```
Se exit != 0, incluir no relatorio do gate antes de seguir. Nao bloqueia o pipeline.

### 6b-1. Coletar sinais

```bash
npx tsx scripts/collect-edition-signals.ts --edition-dir {EDITION_DIR}/
```
Script grava `{edition_dir}/_internal/issues-draft.json`. Inclui o handoff da 1ª sessão (`_internal/session-1-handoff.json`, #9374) como signal `session1_handoff` — é o único caminho pelo qual problemas das Etapas 1–4 (halts, MCP caindo, reclamações do editor no gate 4) chegam ao auto-reporter desta sessão.

- **Se `{EDITION_DIR}/error.md` existir (#507):** incluir o conteudo como contexto adicional ao disparar o `auto-reporter`.

### 6b-2. Avaliar output

Se `signals_count === 0`, logar info e pular auto-reporter.

### 6b-3. Sempre rodar, sem gate (#1502, #8205)

Auto-reporter roda em **todos os modos** (interativo, `auto_approve`) e **sempre sem gate** — cria/comenta issues diretamente (ver `.claude/agents/auto-reporter.md`, atualizado no #8205). E o unico mecanismo de observabilidade pos-edicao; nunca a 2ª parada do Stage 6 — a única parada é §6c.

### 6b-4. Disparar auto-reporter

Se ha sinais, disparar agent `auto-reporter` via `Agent` com `edition_dir` e `repo: "vjpixel/diaria-studio"`.

### 6b-5. Logar resultado

```
✓ Auto-reporter completo.
   {reported_count}/{signals_total} sinais reportados, {issues_created} novas issues criadas, {issues_commented} issues comentadas.
```

### 6b-6. Gerar report HTML — pre-requisito pra fechar o Stage 6 (#1510)

**Nao e o ultimo passo do pipeline (#3457)** — esta geracao existe so pra satisfazer
`blockReasonForMarkingStageDone` (stage 6), que exige `_internal/edition-report.html`
presente antes de aceitar `--status done` (ver 6b-7). Como o Stage 6 ainda esta `running`
neste ponto, a linha do stage 6 na propria tabela do report sai sem duracao medida — este
arquivo e descartavel, nao e o rascunho final. **`--no-email` (#4478) continua aceita
aqui por historico, mas virou no-op desde o #7960 (item 4 da #7957)** — `registerReport`
(chamado de dentro de `writeReportFile`) nunca mais dispara e-mail de notificacao por
default (relatorio de edicao e "Studio /relatorios, sem e-mail" na tabela de severidade
do editor); antes disso a flag suprimia o disparo so nesta chamada "descartavel" pra nao
duplicar o aviso que 6b-8 mandava no fim do pipeline. O registro em `index.jsonl`
continua acontecendo normalmente, com ou sem a flag:

```bash
npx tsx scripts/send-edition-report.ts \
  --edition {AAMMDD} \
  --edition-dir {EDITION_DIR}/ \
  --out {EDITION_DIR}/_internal/edition-report.html \
  --no-email
```

### 6b-7. Marcar Stage 6 `done` (#2800) — fecha o timer da edicao

So agora `_internal/edition-report.html` existe (escrito em 6b-6) —
`blockReasonForMarkingStageDone` para o stage 6 exige esse arquivo (+ `scheduled_at` em
`05-published.json`, ja setado em 6e) — entao rodar o `--status done` AQUI (e nao em 6f)
e a transicao tem sucesso. **Isto fecha o timer da edicao (#3457)** — o `end` e
auto-carimbado agora, ANTES de qualquer trabalho de montar/enviar o rascunho de e-mail
(6b-8), pra que o tempo desse envio nao va pra dentro da duracao do Stage 6:

```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 6 --status done
```

**Capturar custo/tokens reais (#3441):**
```bash
npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 6
# #9594 — backstop do Stage 5 (mesma sessão em /diaria-5-publicacao): só
# captura se a row do Stage 5 ainda está sem custo; senão imprime
# {"source":"skipped","reason":"already_captured"} e não toca nada.
npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 5 --if-missing
```

Falha (exit != 0) → logar warn com o motivo impresso pelo script; nao bloquear o resto do
fluxo (relatorio ainda vai ser enviado em 6b-8). Se isso acontecer, a barra de status pode
ficar presa em `running` ate reconciliacao (ver `reconcileZombieRunningRows` em
`scripts/overnight-statusline.ts`, que detecta `.step-6-done.json` presente + row `running`
e corrige a exibicao sem escrita).

`capture-stage-usage.ts` sai com exit 0 mesmo quando nao capturou nada — ler o JSON de
stdout: se `"source":"unavailable"`, logar warn (mesmo padrao do sentinel acima — #5475):
`npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level warn --message 'stage_usage_capture_unavailable' --details '{"reason":"<reason do stdout>"}'`.
Nao bloquear.

### 6b-8. Regenerar o report + registrar na superfície do Studio (#1510, #3457, #3714) — ULTIMO passo do pipeline

Com o Stage 6 ja `done` (timer fechado em 6b-7), regenerar `edition-report.html`: a linha do Stage 6 na tabela tem `end`/duracao carimbados, entao a duracao total reflete o processamento real (Schedule Beehiiv, verificacao, purga de leaderboard, auto-reporter) em vez de ficar subcontada (#3457 — o report antigo era gerado ANTES do timer fechar). Ultima acao do pipeline inteiro:

```bash
npx tsx scripts/send-edition-report.ts \
  --edition {AAMMDD} \
  --edition-dir {EDITION_DIR}/ \
  --out {EDITION_DIR}/_internal/edition-report.html
```

**#3714 (decisão do editor, 260720 — substitui o antigo draft de Gmail, não soma a ele):**
o comando acima já registra o relatório na superfície de Relatórios do Studio
(`scripts/studio-ui/studio-reports.ts::registerReport`, chamado de dentro de
`writeReportFile` — file-based, fail-soft, nunca depende do `npm run studio` estar no ar) e
imprime o summary JSON em stderr com o campo `studio_report_url`. Ler esse campo do JSON e
usar essa URL no "Resumo final" (abaixo) como o link do relatório — **NÃO criar mais draft
via `mcp__claude_ai_Gmail__create_draft` aqui** (o invariante #1579 antigo — enviar
`edition-report.html` LITERAL via Gmail — foi removido junto com o call site; o arquivo
REGENERADO nesta etapa agora só alimenta o registro no Studio, não o antigo draft narrativo
de e-mail — ver a nota #4478 logo abaixo sobre o novo aviso leve de notificação, #4475).

**Sem `--no-email` aqui — irrelevante desde o #7960 (item 4 da #7957).** Ate o #7960 esta
era a chamada final do pipeline e a UNICA que devia notificar o editor por e-mail (#4475);
desde entao `registerReport` nunca mais dispara esse e-mail por default (relatorio de
edicao virou "Studio /relatorios, sem e-mail" na tabela de severidade do editor) — a
ausencia da flag aqui deixou de ter efeito distinto de tê-la.

**Falha nao bloqueia** — logar warn e seguir (o registro no Studio já é fail-soft por
construção; esta nota cobre falha do próprio `send-edition-report.ts`, ex: edition-dir
inacessível).

### 6b-9. Checagem de staleness dos hubs temáticos (#4924 item 5)

Informacional, **nunca bloqueia** (após 6b-8): `npx tsx scripts/hub-staleness-check.ts`.

Audita `data/beehiiv-cache/posts/*.json` contra `scripts/lib/hubs/*-sources.generated.json`: edição confirmada que casa `HUB_KEYWORD_PATTERNS` fora do dataset → imprime lista + comandos de regen. **Fail-soft** (`local`, #2643) — sem cache (cloud): stdout vazio, exit 0.

Stdout vazio → omitir do resumo. Não-vazio → colar o bloco literal sob `⚠ Hubs temáticos defasados` — informacional, editor decide (regen nunca é automático, #4924 item 2; **nunca rodar os comandos automaticamente**).

---

## Resumo final (apos auto-reporter + relatorio)

Apos auto-reporter, apresentar resumo consolidado da edicao. **Nao enumerar as issues do auto-reporter (#1825)** — so a contagem. Parte pulada → bloco de retomada explicito.

**#9374:** incluir a linha impressa por `npx tsx scripts/session-handoff.ts summary --edition-dir {EDITION_DIR}/` (o que a 1ª sessão registrou das Etapas 1–4 — ou que ela não registrou nada). Esta sessão não tem outra fonte sobre o que deu errado antes do gate 4.

**#3714:** incluir `Relatório: {studio_report_url}` (summary JSON de 6b-8; é o link primário do relatório). Se vier `null` (fail-soft), reportar `Relatório: só local (_internal/edition-report.html) — registro no Studio falhou, ver warn acima` em vez de omitir.

**#4924:** 6b-9 imprimiu algo → incluir `⚠ Hubs temáticos defasados` após a linha do Relatório. Stdout vazio → omitir (sem afirmar "hubs em dia").

**#11253/#11311:** incluir SEMPRE, literal, a linha impressa por `npx tsx scripts/lib/leaderboard-purge-state.ts --edition-dir {EDITION_DIR}/ --summary` — lê `_internal/leaderboard-purge.json` (gravado pelo §6h) e devolve `Purga de votos do editor: {N} keys apagadas ({backend})` ou `⚠ Purga de votos do editor: PENDENTE — {motivo} (rodar /diaria-remover-votos-pixel)`; arquivo ausente (o §6h nem rodou) ou ilegível também sai PENDENTE. Nunca substituir pela memória da sessão nem só pelo warn do run-log (os votos seguem no ranking público).

**#5772:** `_internal/brevo-diaria-published.json` existia em §6a → incluir `Brevo diária: agendado para {scheduled_at} ✓` (exit 0) ou `Brevo diária: agendamento falhou — {reason}, ver run-log` (exit 3/4/5; no 5, o `reason` já indica cota esgotada, #6146). Arquivo nunca existiu (canal pulado/falhou na Etapa 5) → omitir a linha por completo — não afirmar "Brevo diária: pulado".

Se nenhum stage foi pulado, omitir esse bloco — so listar outputs e metricas finais.
