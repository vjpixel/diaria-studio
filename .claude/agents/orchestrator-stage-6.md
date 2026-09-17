---
name: orchestrator-stage-6
description: Detalhe da Etapa 6 (agendamento — gate humano + Schedule Beehiiv + auto-reporter) do orchestrator diar.ia.br. Lido pelo orchestrator principal durante a execucao — nao e um subagente invocavel diretamente.
---

> Este arquivo e referenciado por `orchestrator.md` via `@see`. Nao executar diretamente.

---

## Etapa 6 — Agendamento (gate humano) — #1694

Stage 6 e o **gate final do pipeline**. Apresenta ao editor a parada única (revisão visual do e-mail de teste + resumo de agendamento — draft Beehiiv, social agendado, achados do review, avisos de invariantes que persistiram após tentativa de correção automática, #8205), recebe a confirmacao e executa o Schedule do Beehiiv. Termina com o auto-reporter (sem gate próprio, #8205).

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
**Branch por backend (#464).** Ler `publishing.newsletter.backend` de `platform.config.json` (default `"beehiiv"`). Guardar esse valor — decide, mais abaixo, se §6d (Beehiiv) ou §6d-kit roda, e de onde vêm os campos desta lista.

- Backend `"beehiiv"` (default): ler `_internal/05-published.json` → extrair: `draft_url`, `title`, `test_email_sent_at`, `review_completed`, `review_status`, `review_final_issues`.
- Backend `"kit"`: ler `_internal/newsletter-kit-published.json` → extrair `broadcast_id` (equivalente a `post_id`), `subject` (equivalente a `title`), `status`. Não há `draft_url`/`test_email_sent_at` neste schema — usar `_internal/05-edition-url.txt` (mesmo arquivo, ver §5c-1-kit) no lugar de `draft_url` onde o resumo do gate (§6b) citar um link pro editor conferir. `review_completed`/`review_status`/`review_final_issues` vêm de `data/run-log.jsonl` (ver nota no §5f do Stage 5 sobre por que este backend não os grava no arquivo por edição) — mencionar no resumo apenas se o Stage 5 tiver logado um `review_status` != implícito-ok.
- Ler `_internal/06-social-published.json` → extrair: horarios agendados dos 3 posts LinkedIn e 3 posts Facebook (`scheduled_at` por destaque).
- Ler `_internal/06-verify-dispatch.json` (se existir) → extrair quaisquer warnings de verificacao.
- Ler `post_id` de `_internal/05-published.json` (necessario para o Schedule Beehiiv e para verificacao pos-Schedule).
- Ler horario default de agendamento: 06:00 BRT da DATA DA EDIÇÃO (`{AAMMDD}`) — **nunca** "amanhã" pelo relógio de agora (#8207: Etapa 6 rodada depois da meia-noite BRT com "amanhã" contado pelo relógio agendou a edição 260917 um dia atrasado no Kit e na Brevo diária). `scripts/resolve-edition-scheduled-at.ts` é o ÚNICO lugar que faz essa conta — usar o MESMO comando aqui e no ramo `sim HH:MM` do §6c abaixo:
  ```bash
  npx tsx scripts/resolve-edition-scheduled-at.ts --aammdd {AAMMDD}
  ```
- **Ler `_internal/brevo-diaria-published.json` (#5772), se existir** → extrair `campaign_id`, `status`. Ausente = canal Brevo pulado/falhou na Etapa 5 (`--skip brevo`, config ausente, store ausente) — nada a agendar aqui, pular §6d-brevo abaixo sem erro.

**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

### 6b. Montar resumo de agendamento

Compor o resumo que sera exibido no gate único de §6c — inclui o pedido de revisão visual do e-mail de teste (#8205) mais todo o contexto que antes tinha parada própria:

- **Revisão visual do e-mail de teste (#8205):** `{test_email}` de `publishing.newsletter.test_email` em `platform.config.json`; assunto `[teste] {title}` (Kit) ou `[TEST] {title}` (Beehiiv).
- **Newsletter Beehiiv:**
  - URL do rascunho: `draft_url` de `05-published.json`.
  - Test email: `test_email_sent_at` formatado em BRT.
  - Status do review: se `review_completed: true` → `✓ review ok`; se `review_status: "inconclusive"` → `⚠ review inconclusivo`; se issues → listar.
- **Social agendado:** horarios LinkedIn + Facebook por destaque (D1/D2/D3).
- **Achados do review-test-email** (se `review_final_issues` nao vazio ou `review_status !== "ok"`) **+ achados dos lints determinísticos `lint-test-email-*`** que o `review-test-email` já roda internamente (link tracking, structure, encoding, image freshness — ver `.claude/agents/review-test-email.md`).
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
   (omitir `--actual-slug` se `web_settings.slug` vier ausente/vazio — o guard trata ausência como divergência.)
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

### 6c. GATE HUMANO — parada única: revisão do e-mail de teste + agendamento (#8205)

**A revisão visual do e-mail de teste pelo editor é a ÚNICA parada de `/diaria-5-publicacao` (decisão do editor, 17/09/2026, #8205).** Tudo que antes tinha ponto de parada próprio — pedidos editoriais (§6b2), guard de slug (§6b-slug), auto-reporter (§6b abaixo) — entra como CONTEXTO deste gate, nunca como pergunta separada.

**Se `--no-gates` (`auto_approve = true`):** pular o gate, usar o default de §6a (06:00 BRT da data da edição, via `resolve-edition-scheduled-at.ts` — nunca "amanhã" contado a partir do relógio) — mesmo horário serve Beehiiv e Brevo diária (#5772, se a campanha existir). Logar:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level warn \
  --message "Stage 6 auto-agendado via --no-gates: {scheduled_at_iso}" \
  --details '{"source":"auto_approve","scheduled_at":"{scheduled_at_iso}"}'
```
Prosseguir direto para §6d (executar Schedule).

**Pré-gate: ler post_pixel para o lembrete (#2153).** Extrair seção `## post_pixel` de `03-social.md` — `post_pixel` nunca passa pelo dispatch de `publish-linkedin.ts` (postagem 100% manual, #1690), então Stage 6 é o ponto de resolução equivalente **quando o texto ainda contém `{outros_count}`/`{edition_url}` literais**. **#3052 revertido (260814):** post_pixel normalmente não abre mais com esses placeholders (writer não os emite) — o passo abaixo vira no-op na maioria das edições, mas segue rodado por backward-compat (edições pré-260814 reprocessadas, ou qualquer texto que ainda os contenha):

```bash
npx tsx scripts/resolve-post-pixel.ts --edition-dir {EDITION_DIR}/
```

Exit code:
- `0` → texto resolvido normalmente.
- `1` → estrutura ausente (03-social.md ou seção post_pixel não encontrada) — mostrar `(nao encontrado)` no lembrete, não bloqueia o gate.
- `2` → `outros_count` não pôde ser resolvido — o stdout ainda traz o texto (com `{outros_count}` literal); acrescentar `⚠ outros_count não resolvido — preencher manualmente antes de postar` ao lembrete. **Não bloqueia o gate** (mesma regra de #2153 — post_pixel é amplificação opcional).

Guardar stdout em `POST_PIXEL_TEXT`.

**Se modo interativo:** apresentar o gate único. `{test_email}` vem de `publishing.newsletter.test_email` em `platform.config.json`:

```
✉️  REVISE O E-MAIL DE TESTE — Edicao {AAMMDD}

Confira o e-mail de teste na sua caixa ({test_email}, assunto "[teste] {title}"
ou "[TEST] {title}" conforme o backend).

Newsletter (rascunho): {draft_url}
Test email:            {test_email_sent_at} ✓
Review automatico (review-test-email + lint-test-email-*): {review_status_block — "✓ sem achados" | lista de review_final_issues/unfixed_issues}
{"⚠ Slug do bloco WhatsApp diverge — link ficaria quebrado no e-mail já enviado. " + instrucoes de correcao manual, SÓ se SLUG_CHECK_OK === false}
{"📋 Pedidos editoriais aceitos: " + resumo de §6b2, SÓ se o arquivo existia}

Social agendado:
  LinkedIn  D1 {hh:mm BRT} · D2 {hh:mm BRT} · D3 {hh:mm BRT}
  Facebook  D1 {hh:mm BRT} · D2 {hh:mm BRT} · D3 {hh:mm BRT}

{bloco Brevo diária, SÓ se _internal/brevo-diaria-published.json existir:}
Brevo diária (rascunho, campaign_id {campaign_id}): agenda junto com o Beehiiv no mesmo horário abaixo (#5772)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📣 LEMBRETE (nao bloqueia) — post pessoal vjpixel
Poste manualmente no LinkedIn PESSOAL (nao a pagina Diar.ia):
  Imagem: {EDITION_DIR}/04-d1-1x1.jpg

{POST_PIXEL_TEXT}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ok           → agenda para 06:00 BRT do dia da edição (default)
  ok HH:MM     → agenda para {horario informado} BRT do dia da edição
  abortar      → nao agenda nada; rascunhos permanecem, sentinel nao escrito
  Qualquer outra entrada → repetir (fail-closed)
```

Aguardar resposta do editor. Interpretar — **`{AAMMDD}` (a data da edição), nunca "amanhã" pelo relógio (#8207)**: os dois ramos usam o MESMO comando de §6a, só variando `--hhmm` — `ok` (sem horario, default 06:00 BRT) → `scheduled_at` = `npx tsx scripts/resolve-edition-scheduled-at.ts --aammdd {AAMMDD}`; `ok HH:MM` (validar HH 0-23, MM 0-59) → `... --aammdd {AAMMDD} --hhmm {HH:MM}`.
- `abortar` → logar warn, NAO escrever sentinel, encerrar Stage 6. Editor pode re-rodar `/diaria-6-agendamento {AAMMDD}` depois.
- Qualquer outra coisa → exibir o gate novamente (fail-closed).

**Um único `scheduled_at` serve todos os canais (Beehiiv/Kit, Brevo diária, Kit diária)** — decisão do editor: o gate não pergunta o horário mais de uma vez. Se algum canal não existir (`_internal/brevo-diaria-published.json`/`kit-diaria-published.json` ausente), o bloco correspondente nunca aparece e a seção de agendamento daquele canal (abaixo) é pulada sem erro.

Logar resposta:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "gate 6 response: {ok HH:MM|abortar}" \
  --details '{"response":"{resposta}","scheduled_at":"{scheduled_at_iso}","slug_check_ok":{SLUG_CHECK_OK}}'
```

### 6d. Executar Schedule do Beehiiv

**Só roda com backend `"beehiiv"` (default, ver §6a).** Com backend `"kit"`, pular esta seção INTEIRA (a checagem de slug do bloco WhatsApp em §6b-slug já pulou por igual motivo — problema específico da UI de SEO/URL slug da Beehiiv sem equivalente no Kit) e seguir direto para **§6d-kit** abaixo.

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

O script faz PATCH `/broadcasts/{id}` (`send_at`) e só declara sucesso
depois de um GET de verificação confirmar o `send_at` de volta — mesmo
padrão de `verify-scheduled-post.ts` (Beehiiv, §6d) e `schedule-daily-brevo.ts`
(§6d-brevo). Um broadcast Kit `completed` (já disparado) é **imutável** —
sem retry automático além do já embutido em `kitFetch`.

Exit codes:
| Exit | Significado | Ação |
|------|-------------|------|
| `0` | Agendado e verificado. | Confirmar ao editor: "Agendado para {scheduled_at} ✓ (broadcast_id {id})". Seguir para §6e. |
| `2` | `publishing.newsletter.backend` != `"kit"` (guard interno do script). | Não deveria acontecer aqui — mesma nota do §5c-1-kit sobre leitura divergente da config; investigar antes de prosseguir. |
| `3` | `_internal/newsletter-kit-published.json` ausente/sem `broadcast_id`. | Etapa 5 não rodou o publisher Kit pra esta edição — voltar pro Stage 5 antes de continuar (não há o que agendar). |
| `4` | PATCH falhou (erro de API). | Logar erro com o `reason` do JSON de stdout; **bloqueia** o Stage 6 (diferente do Brevo em §6d-brevo — aqui é o ÚNICO canal de newsletter, não um secundário) — investigar antes de retry manual. |
| `5` | GET pós-PATCH não confirma o agendamento. | Mesmo tratamento do exit 4 — bloqueia, investigar antes de retry. |
| `6` | `--scheduled-at` diverge da data da edição (#8207) — não deveria acontecer se `{scheduled_at_iso}` veio de `resolve-edition-scheduled-at.ts` (§6a/§6c). | Bloqueia — investigar como `{scheduled_at_iso}` divergiu antes de qualquer retry. Retry manual intencional (editor pediu explicitamente outro dia) usa `--allow-other-date`, nunca por padrão. |

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator \
  --level {info se exit 0, error se 3/4/5/6} \
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

**Roda SÓ se `_internal/brevo-diaria-published.json` existir** (lido em §6a) — canal pulado/falhou na Etapa 5 (`--skip brevo`, config ausente, store ausente) significa nada a agendar aqui; pular esta seção inteira sem erro. Usa o MESMO `scheduled_at` confirmado em §6c (Beehiiv) — decisão do editor, #5772: um único gate, um único horário pros dois canais.

```bash
npx tsx scripts/schedule-daily-brevo.ts \
  --edition-dir {EDITION_DIR}/ \
  --scheduled-at {scheduled_at_iso}
```

O script faz PUT `/emailCampaigns/{id}` (`scheduledAt`) e SÓ declara sucesso depois de um GET de verificação confirmar o `scheduledAt` de volta — mesmo padrão de `verify-scheduled-post.ts` pro Beehiiv. Uma campanha Brevo agendada é **imutável** — não há re-tentativa automática além do retry HTTP já embutido em `brevoPut`/`brevoGetCampaign`.

Exit codes:
| Exit | Significado | Ação |
|------|-------------|------|
| `0` | Agendado e verificado. | Confirmar ao editor: "Brevo diária agendado para {scheduled_at} ✓ (campaign_id {id})". |
| `2` | Nenhuma campanha registrada (já esperado se o canal foi pulado/falhou na Etapa 5). | Não é erro — seguir sem mencionar no resumo, ou mencionar como "canal Brevo não participou desta edição" se `_internal/brevo-diaria-published.json` de fato não existia. |
| `3` | PUT falhou (erro de API). | Logar warn com o `reason` do JSON de stdout; **não bloqueia** o resto do Stage 6 (Beehiiv já agendado é o que importa, #5772 fail-soft) — avisar o editor que o Brevo precisa de retry manual (`npx tsx scripts/schedule-daily-brevo.ts --edition-dir {EDITION_DIR}/ --scheduled-at {scheduled_at_iso}`). |
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

**Só quando `kit_diaria.enabled === true`.** Roda ao lado do Beehiiv/Brevo, pra audiência própria (`kit_diaria.audience_tag`). **Não é o §6d-kit**, que agenda o backend EXCLUSIVO do switchover (#6114) — coexistem enquanto a partição por origem de cadastro durar. Mesmo `scheduled_at` do Beehiiv, sob o MESMO gate, sem pergunta separada.

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


**Falha aqui NUNCA desfaz o Schedule do Beehiiv já confirmado** — os dois canais são independentes; o Brevo é sempre o secundário/extra (segmento Pending, reativação).

### 6d-site. Publicar a página da edição no Worker `diaria-site` (#6202)

Roda **depois** do agendamento confirmado, nos dois backends. Sem este passo o acervo do site fica congelado nos 253 posts já gerados e não cresce — e é ele que destrava a janela de cutover do #467 (greenlight do editor, 26/08).

**`--slug` é obrigatório aqui, em qualquer backend.** `_internal/05-published.json`
nunca tem `post_url` populado neste ponto do pipeline (só `refresh-dedup.ts` grava isso,
no dia seguinte). Backend `"beehiiv"`: passar `{slug_atual_do_get_post}` já obtido em §6b-slug
(o valor que o guard do bloco WhatsApp confirmou/apurou). Backend `"kit"` (#7420, fecha a
lacuna do #464/#6202): passar `seoSlug(d1.title)` — mesmo algoritmo de `deriveEditionUrl`,
já usado por `publish-newsletter-kit.ts` pra gravar `05-edition-url.txt` na Etapa 5, sem
chamada de rede. Sem `--slug` o passo sempre cai em "nada a publicar" (`code: 4`, ver
tabela abaixo).

**`--sitemap` é obrigatório também (#6454)** — sem ela, `sitemap.xml`/`index.html`
(a home) ficam congelados mesmo com `/p/{slug}` publicado certo (foi essa lacuna
que travou `https://diar.ia.br/` ~10 dias numa edição antiga, 04/09/2026). Com a
flag o script atualiza o sitemap e regenera a home no mesmo commit/push da página:

```bash
npx tsx scripts/publish-edition-site-page.ts \
  --edition-dir {EDITION_DIR} \
  --slug {slug_atual_do_get_post ou seoSlug(d1.title) pro Kit} \
  --sitemap workers/site/public/sitemap.xml
npx tsx scripts/reconcile-site-sitemap.ts
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level {info se 0/2, warn se 3/4/5} --message "site-page stage6 publish: exit {code}"
```

**A home NÃO passa a mostrar esta edição agora, e isso é o comportamento correto (#7686).** `buildHomeFeed` descarta entrada de sitemap cuja `<lastmod>` (= data de ENVIO) ainda não chegou, em BRT — então o `index.html` regenerado neste commit sai SEM a edição que você acabou de publicar. Quem a faz aparecer é o workflow `.github/workflows/regen-home.yml`, às 06:00 BRT, junto do envio real. Decisão do editor (08/09/2026): a página `/p/{slug}` pode ficar pronta antes, sem problema; só a HOME espera. **Não "corrija" isso** — antes do #7686 a home anunciava a edição ~9h antes de qualquer assinante recebê-la, e a home é destino de campanha paga (#7575). Se a home amanhecer sem a edição do dia, o culpado é o workflow das 06:00 ter falhado, nunca o filtro: checar `gh run list --workflow=regen-home.yml`.

**`reconcile-site-sitemap.ts` roda SEMPRE, logo depois (#7578)** — aditivo, idempotente, sai `0` quando não há o que fazer. Garante que toda página em `workers/site/public/p/` tenha `<loc>` no `sitemap.xml` e regenera a home. Página fora do sitemap é invisível no buscador **e** em `arquivo.diar.ia.br` (cujo acervo DERIVA do sitemap do apex em request-time, sem fonte própria) — foi assim que 5 edições ficaram órfãs entre 28/08 e 03/09/2026, respondendo 200 sem ninguém chegar nelas.

| exit | significado | ação |
|---|---|---|
| `0` | página escrita e branch `site-publish/{slug}` publicada com PR aberto/reusado (`git commit` + `push` da branch + `gh pr create`/reuso, ver mecanismo abaixo) — **o deploy real só acontece quando o PR for mergeado** | seguir |
| `2` | edição sem `newsletter-final.html` — arquivo ainda não existe, nada a publicar | seguir, logar info |
| `3` | escrita, commit, push ou `gh pr create` falhou (inclui checkout DIVERGENTE de `origin/master` — #7287: o guard compara COMMIT, não nome de branch; um checkout numa branch de nome qualquer cujo HEAD bata com `origin/master` passa normalmente) | **logar warn e seguir** |
| `4` | artefato PRESENTE mas inválido (html/título vazio, `--slug` ausente e sem `post_url`) — bug num stage anterior. Desde #7420, `--slug` sempre basta (não depende de `05-published.json`) | **logar warn e seguir** (nunca silencioso — não é o mesmo caso benigno do `2`) |
| `5` | GUARD (#6202): `buildArchivePageHtml` recusou por merge tag não resolvida (`UnresolvedMergeTagError`, guard do #6210/#6256) — não é a tag padrão do voto (`{{email}}`, essa é sanitizada antes do guard rodar), é uma tag DESCONHECIDA. Nada escrito/commitado | **logar warn e seguir** (fail-soft; a edição segue normal, só o site não ganha página nova até a tag ser tratada) |

**Fail-soft do SCRIPT, inalterado:** nenhum exit lança nem interrompe §6d-site; no `3` a página costuma ficar escrita localmente. **O invariante `site-page-published` (§6g) marca a falha como `severity: error` desde #7578 (decisão do editor 07/09/2026)** — era `warning`, e o warning provou duas vezes que ninguém o lê (4 edições silenciosas em 31/08–03/09, mais 12 dias de acervo parado depois disso). A premissa de "site é acessório" também caiu: hoje ele é destino de campanha paga (#7575) e a superfície mais indexável do domínio (#7576). **Desde #8205: isto não é um 2º gate** — a falha entra no relatório/resumo final da edição (§6h em diante) como aviso destacado, não como uma pausa nova pedindo confirmação; o pipeline segue até o fim e o editor resolve depois (re-rodar o comando acima e mergear o PR).

**A visibilidade da falha NÃO depende mais só deste `log-event.ts` (#7283).** O próprio script grava `_internal/site-page-published.json` (`{ code, slug, published, reason, prUrl, checked_at }`) a CADA chamada, determinístico — não depende de o agente lembrar de logar certo. `check-invariants.ts --stage 6` (§6g abaixo) lê esse arquivo e acusa (`severity: error`) quando `published !== true`, sem bloquear. Foi a ausência desse mecanismo que deixou 4 edições consecutivas (31/08–03/09/2026) sem página no acervo sem NENHUM sinal em código — só a prosa deste passo, que ninguém verificava ter sido seguida.

**Mecanismo: branch dedicada + PR, nunca push direto em `master` (#6598).** Script recria `site-publish/{slug}` do `master` local, commita/empurra (`--force-with-lease`) e abre/reusa PR via `gh pr create` — nunca mergeia sozinho (decisão do editor). Detalhes/histórico do incidente que motivou (`GH013`, 260828): `docs/site-page-publish-mechanism.md`.

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

**Backend-aware (#464, mesmo motivo do §5h/Stage 5 e da Pre-condicao acima).** **Desde #7963, mesmo gate mecânico do §5h** — `write --step 6` também recusa (exit 1, sem bypass) `--outputs` com o artefato de newsletter do backend errado. Backend `"beehiiv"` (default):

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

Sentinel ausente = Stage 6 incompleto para fins de resume. Falha → logar warn, nao bloquear auto-reporter.

**NAO marcar Stage 6 `done` aqui (#2800).** `blockReasonForMarkingStageDone` (stage 6) exige
`_internal/edition-report.html`, que so e gerado no passo 6b-6 (Etapa 6b — Auto-reporter,
ABAIXO neste arquivo). Chamar `update-stage-status --stage 6 --status done` neste ponto
sempre bloqueia (exit 1, doc nao gravado) porque o report ainda nao existe — a causa-raiz
do bug em que a barra de status ficava presa em `running` apos a edicao ja ter concluido
de fato. O `--status done` correto fica no passo **6b-7**, apos o report ser escrito.

### 6g. Check invariants Stage 6

```bash
npx tsx scripts/check-invariants.ts --stage 6 --edition-dir {EDITION_DIR}/
```

Exit 1 = logar warn (nao bloquear auto-reporter). Sempre pós-hoc, nunca interativo (#8205 — a parada única do pipeline é §6c, nenhuma regra aqui espera resposta do editor): `whatsapp-slug-guard-ok` (#4574) confirma que `_internal/whatsapp-slug-check.json` existe com `ok:true` — se divergiu, já apareceu como aviso destacado no gate de §6c (§6b-slug) e o editor seguiu ciente; esta checagem só audita que o arquivo foi de fato gravado (agente não pulou §6b-slug por engano). `site-page-published` (#7283) lê `_internal/site-page-published.json` e acusa `severity: error` quando `published !== true` — `severity: error` marca a falha como digna de destaque no relatório/dashboard (usado por `docs/editorial-invariants.md`/Studio), mas **não é um 2º gate**: a regra irmã `site-sitemap-no-orphans` (#7578) segue o mesmo padrão, acusando página em `workers/site/public/p/` sem entrada no `sitemap.xml` (órfã, invisível no buscador e em `arquivo.diar.ia.br`).

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

**Checar auth wrangler antes de rodar (label `local`, #2643).** Usar `scripts/check-wrangler-auth.ts` (#6900) —
NUNCA `npx wrangler whoami` cru: valida identidade ERRADA (env normal, com token), não a de `purge-leaderboard.ts`
(env sem token, sessao OAuth — #2265; falso-positivo ja ao vivo em 260901, guard cru passou com OAuth expirada e a
purga falhou com `Authentication error [code: 10000]`). Roda `wrangler whoami` com o env sanitizado (`scripts/lib/cloudflare-oauth-env.ts`):
```bash
npx tsx scripts/check-wrangler-auth.ts
```
- **Exit 0** (lista a conta logada) → prosseguir com a purga abaixo.
- **Exit != 0, OU o comando estourar o timeout** (nao logado — tipico de sessao cloud
  sem OAuth persistido) → **degradar pra warn e SEGUIR sem rodar a purga.** "Degradar
  pra warn" aqui significa concretamente: nao chamar `purge-leaderboard.ts` (nem
  tentar de novo), logar o warn abaixo, e passar direto pra Etapa 6b (Auto-reporter)
  como se este passo nao existisse — o agendamento ja foi confirmado em §6d e NAO deve
  ser reaberto ou revertido por causa disto. Nao tentar `wrangler login` nem pedir
  credencial ao editor (Stage 6 nao bloqueia agendamento por causa de auth do KV do
  leaderboard).
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level warn \
    --message "purga de votos do editor pulada: wrangler nao autenticado" \
    --details '{"reason":"wrangler_not_authenticated"}'
  ```

**Se autenticado, rodar a purga (execute direto — mesma justificativa de
`/diaria-remover-votos-pixel`: sem gate, sem dry-run previo):**
```bash
npx tsx scripts/purge-leaderboard.ts --email pixel@memelab.com.br --execute
npx tsx scripts/purge-leaderboard.ts --email vjpixel@gmail.com --execute
```

Cada execucao imprime `[purge] done — {N} keys apagadas, {M} snapshots invalidados.`
(ou `[purge] nada pra apagar` se a conta ja estava limpa — trate como `{N}=0`). Somar
o `{N}` das 2 chamadas e logar a contagem total pra auditoria:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "purga de votos do editor concluida: {total_keys} keys apagadas" \
  --details '{"emails":["pixel@memelab.com.br","vjpixel@gmail.com"],"keys_deleted":{total_keys}}'
```

Falha inesperada de um dos 2 comandos (nao relacionada a auth — ex: erro de
rede/KV) → logar warn com o motivo e seguir; nunca bloquear o restante do Stage 6 por
causa desta purga.

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
Script grava `{edition_dir}/_internal/issues-draft.json`.

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

**#3714:** incluir `Relatório: {studio_report_url}` (summary JSON de 6b-8; é o link primário do relatório). Se vier `null` (fail-soft), reportar `Relatório: só local (_internal/edition-report.html) — registro no Studio falhou, ver warn acima` em vez de omitir.

**#4924:** 6b-9 imprimiu algo → incluir `⚠ Hubs temáticos defasados` após a linha do Relatório. Stdout vazio → omitir (sem afirmar "hubs em dia").

**#5772:** `_internal/brevo-diaria-published.json` existia em §6a → incluir `Brevo diária: agendado para {scheduled_at} ✓` (exit 0) ou `Brevo diária: agendamento falhou — {reason}, ver run-log` (exit 3/4/5; no 5, o `reason` já indica cota esgotada, #6146). Arquivo nunca existiu (canal pulado/falhou na Etapa 5) → omitir a linha por completo — não afirmar "Brevo diária: pulado".

Se nenhum stage foi pulado, omitir esse bloco — so listar outputs e metricas finais.
