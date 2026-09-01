---
name: orchestrator-stage-6
description: Detalhe da Etapa 6 (agendamento — gate humano + Schedule Beehiiv + auto-reporter) do orchestrator diar.ia.br. Lido pelo orchestrator principal durante a execucao — nao e um subagente invocavel diretamente.
---

> Este arquivo e referenciado por `orchestrator.md` via `@see`. Nao executar diretamente.

---

## Etapa 6 — Agendamento (gate humano) — #1694

Stage 6 e o **gate final do pipeline**. Apresenta ao editor o resumo completo de agendamento (draft Beehiiv, social agendado, achados do review), recebe a confirmacao e executa o Schedule do Beehiiv. Termina com o auto-reporter.

Interacao humana SO neste stage (alem do Stage 4).

**`{EDITION_DIR}` (#2463/#3025):** diretorio REAL da edicao no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edicao foi criada. Resolver **uma vez**, logo apos ter `{AAMMDD}`, e usar em todo path abaixo — nunca montar `data/editions/` + `{AAMMDD}` a mao:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

### Pre-condicao: sentinel Stage 5

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
- Ler horario default de agendamento: amanha 06:00 BRT = `{edition_date}` as 09:00 UTC.
  ```bash
  node -e "const s='{AAMMDD}';const d=new Date('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6)+'T09:00:00Z');process.stdout.write(d.toISOString())"
  ```
- **Ler `_internal/brevo-diaria-published.json` (#5772), se existir** → extrair `campaign_id`, `status`. Ausente = canal Brevo pulado/falhou na Etapa 5 (`--skip brevo`, config ausente, store ausente) — nada a agendar aqui, pular §6d-brevo abaixo sem erro.

**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

### 6b. Montar resumo de agendamento

Compor o resumo que sera exibido no gate:

- **Newsletter Beehiiv:**
  - URL do rascunho: `draft_url` de `05-published.json`.
  - Test email: `test_email_sent_at` formatado em BRT.
  - Status do review: se `review_completed: true` → `✓ review ok`; se `review_status: "inconclusive"` → `⚠ review inconclusivo`; se issues → listar.
- **Social agendado:** horarios LinkedIn + Facebook por destaque (D1/D2/D3).
- **Achados do review-test-email** (se `review_final_issues` nao vazio ou `review_status !== "ok"`).
- **Brevo diária (#5772):** se `_internal/brevo-diaria-published.json` existe, `campaign_id` + status atual ("rascunho pronto pra agendar"). Se ausente, omitir esta linha (canal pulado/falhou na Etapa 5).

### 6b2. Revisao de pedidos editoriais registrados (#4966)

Ler `{EDITION_DIR}/_internal/editor-requests.jsonl` (escrito ao longo da edicao via `npx tsx scripts/log-editor-request.ts`, ver `.claude/agents/orchestrator.md` secao "Pedidos editoriais do editor"). **Se o arquivo nao existir ou estiver vazio, pular esta secao inteira** — nada a revisar.

**Se `--no-gates` (`auto_approve = true`):** aceitar a lista como registrada, sem perguntar (nao ha editor presente pra revisar). Logar a origem, mesmo espirito de `_internal/05-publish-consent.json`:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "editor requests aceitos sem revisao via --no-gates" \
  --details '{"source":"auto_approve_default","count":{N}}'
```
Prosseguir para §6c sem exibir o bloco abaixo.

**Se modo interativo:** apresentar a lista antes do gate de Schedule (pode ser no mesmo turno, acima do bloco `📅 AGENDAMENTO`):

```
📋 PEDIDOS EDITORIAIS DESTA EDICAO — {AAMMDD}

1. [{stage}] {request_type} · {target} — "{description resumida a ~80 chars}" ({resolution})
2. [{stage}] {request_type} · {target} — "{description resumida a ~80 chars}" ({resolution})
...

Confirmar tudo, corrigir uma entrada, ou descartar alguma?

  confirmar         → aceita a lista como esta
  corrigir N campo=valor → reescreve o campo (request_type|target|resolution|description) da entrada N
  descartar N       → remove a entrada N (registrada indevidamente)
  Qualquer outra entrada → repetir a lista (fail-closed)
```

Aguardar resposta. `corrigir`/`descartar` reescrevem `_internal/editor-requests.jsonl` inteiro (regravar todas as linhas com a entrada N alterada/removida) e voltam a exibir a lista atualizada — repetir ate o editor responder `confirmar`. `corrigir` com `request_type`/`target`/`resolution` fora da taxonomia valida de `scripts/log-editor-request.ts` e rejeitado, mostrando os valores aceitos, sem aplicar a mudanca.

Ao confirmar, logar a origem:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "editor requests confirmados no gate 6" \
  --details '{"source":"editor_confirmed","count":{N},"corrections":{M}}'
```

### 6c. GATE HUMANO — Schedule Beehiiv

**Se `--no-gates` (`auto_approve = true`):** pular o gate, usar default (amanha 06:00 BRT) — mesmo horário serve Beehiiv e Brevo diária (#5772, se a campanha existir). Logar:
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

**Se modo interativo:** apresentar gate:

```
📅 AGENDAMENTO — Edicao {AAMMDD}

Newsletter (rascunho): {draft_url}
Test email:            {test_email_sent_at} ✓
{review_status_block se houver issues}

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

Agendar envio da newsletter no Beehiiv{ + " e a campanha Brevo diária" se o bloco acima apareceu}?

  sim          → agenda para amanha 06:00 BRT (default)
  sim HH:MM    → agenda para amanha {horario informado} BRT
  abortar      → nao agenda nenhum dos dois; rascunhos permanecem, sentinel nao escrito
  Qualquer outra entrada → repetir (fail-closed)
```

Aguardar resposta do editor. Interpretar:
- `sim` (sem horario) → `scheduled_at` = amanha 06:00 BRT.
- `sim HH:MM` → `scheduled_at` = amanha `HH:MM` BRT; validar HH 0-23, MM 0-59.
- `abortar` → logar warn, NAO escrever sentinel, encerrar Stage 6. Editor pode re-rodar `/diaria-6-agendamento {AAMMDD}` depois.
- Qualquer outra coisa → exibir o gate novamente (fail-closed).

**Um único `scheduled_at` serve os dois canais (#5772)** — decisão do editor: o gate não pergunta o horário 2×. Se a campanha Brevo não existir (`_internal/brevo-diaria-published.json` ausente), o bloco acima nunca aparece e §6d-brevo (abaixo) é pulado sem erro — a resposta do editor vale só pro Beehiiv nesse caso.

Logar resposta:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "gate 6 response: {sim HH:MM|abortar}" \
  --details '{"response":"{resposta}","scheduled_at":"{scheduled_at_iso}"}'
```

### 6d. Executar Schedule do Beehiiv

**Só roda com backend `"beehiiv"` (default, ver §6a).** Com backend `"kit"`, pular esta seção INTEIRA (incluindo a checagem de slug do bloco WhatsApp — ela existe pra um problema específico da UI de SEO/URL slug da Beehiiv que não tem equivalente no Kit: `public_url` do broadcast já é a URL final, sem etapa manual de slug que possa divergir dela) e seguir direto para **§6d-kit** abaixo.

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

**Verificar e corrigir slug pos-Schedule (#2011, #3449) — GATE-BLOCKING desde #4570:**

O bloco encaminhavel por WhatsApp (dentro do D1 desde #5152, ver `context/templates/newsletter.md`)
ja tem a URL `https://diar.ia.br/p/{seoSlug(title)}` BAKED IN no corpo do
e-mail desde o pre-render do Stage 4 — se o slug real do post divergir, esse
link ja enviado 404 pra quem abrir o e-mail. Por isso esta checagem deixou de
ser so-corrija-se-puder (#2011) e passou a **bloquear o Stage 6** ate o slug
bater (#4570).

1. Buscar o slug real do post: `mcp__claude_ai_Beehiiv__get_post({ post_id })`
   → `web_settings.slug`. **Se `get_post` falhar/erroar** (não apenas
   retornar slug ausente — timeout, disconnect, erro de API), tratar como
   falha de MCP (#738) — halt banner (comando exato abaixo), nunca
   prosseguir assumindo divergência resolvida ou slug correto.
2. Rodar o guard determinístico (comparação pura, `scripts/lib/whatsapp-slug-guard.ts`),
   gravando o resultado em `_internal/whatsapp-slug-check.json` (`--out`,
   #4574 — backstop determinístico consumido por `check-invariants.ts --stage 6`
   em §6g; sem esse arquivo, ou com `ok:false` nele, o Stage 6 nunca é aceito
   como íntegro, independente do que este passo faça):
   ```bash
   npx tsx scripts/check-whatsapp-slug-guard.ts \
     --post-id {post_id} \
     --d1-title "{title}" \
     --actual-slug "{slug_atual_do_get_post}" \
     --out {EDITION_DIR}/_internal/whatsapp-slug-check.json
   ```
   (omitir `--actual-slug` se `web_settings.slug` vier ausente/vazio — o guard
   trata ausência como divergência.)
3. Logar o resultado (mesmo padrão de todo outro ponto de decisão deste
   arquivo — início do stage, resposta do gate, purga de leaderboard):
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator \
     --level {info se ok, error se não} \
     --message "whatsapp slug guard: {ok|diverge}" \
     --details '{"ok":{ok},"expectedSlug":"{expected_slug}","actualSlug":"{actual_slug}"}'
   ```

| Exit | Significado | Ação |
|------|-------------|------|
| `0` | Slug bate com `seoSlug(title)` — o link do bloco WhatsApp é válido. | Continuar para §6e. |
| `1` | **GATE-BLOCKING.** Slug diverge (mangling PT-BR, #1989, ou nunca setado). | Ver abaixo — **não prosseguir para §6e/§6f/§6g/§6h/auto-reporter** enquanto não sair `0`. |
| `2` | Args inválidos (bug do orchestrator — `post_id`/`title` ausentes). | Investigar antes de repetir. |

**No exit 1:** a correção via API está **permanentemente bloqueada** no plano
atual (#3449, confirmado 260714 — `403 SEND_API_NOT_ENTERPRISE_PLAN`, não
transitório). Ir direto pra correção manual — o stderr do guard já traz a
mensagem formatada (reusa `formatManualSlugFixInstructions`, #3449): aba
visível → campo `#text-input-slug` em Settings → SEO/URL slug → digitar o
slug correto via teclado real (mesmo passo documentado em
`context/publishers/beehiiv-playbook.md` §9). Não vale gastar uma chamada de
`fix-post-slug.ts --execute` esperando sucesso — ela vai retornar `exit 3`
(plan-gated) e só serve pra reconfirmar/logar o estado, se necessário:

```bash
npx tsx scripts/fix-post-slug.ts \
  --post-id {post_id} \
  --slug {slug_correto} \
  --execute
# exit 3 esperado (#3449) — stderr traz instrucoes manuais formatadas
```

Renderizar halt banner (mesmo padrão do #738), comando exato:

```bash
npx tsx scripts/render-halt-banner.ts \
  --stage "6 — Agendamento" \
  --reason "slug do post diverge do link já enviado no bloco WhatsApp" \
  --action "corrigir manualmente em Settings → SEO/URL slug, depois responder 'corrigido'"
```

Ao receber confirmação do editor, re-buscar o slug via `get_post` e re-rodar
o guard (passo 2 acima, mesmo `--out`) — repetir até sair `0`. Só então
prosseguir para §6e.

**Guard refresh-dedup apos schedule confirmado:** rodar `/diaria-refresh-dedup` (equivalente a `npx tsx scripts/refresh-dedup.ts`) para manter `data/past-editions.md` atualizado.

### 6d-kit. Executar Schedule do Kit (#464 — só quando backend `"kit"`)

**Exibir o mesmo banner de segurança do §6d antes de agendar** — a diferença
aqui é que não há clique manual: o script faz o PATCH direto. Confirmar o
horário com o editor antes de rodar (mesmo horário default calculado em
§6a: amanhã 06:00 BRT).

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

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator \
  --level {info se exit 0, error se 3/4/5} \
  --message "newsletter kit stage6 schedule: exit {code}" \
  --details '{json de saída do script}'
```

**Guard refresh-dedup apos schedule confirmado** — mesmo passo do §6d: rodar `/diaria-refresh-dedup`.

Ao concluir §6d-kit com sucesso, seguir para §6d-brevo (se aplicável) e §6e normalmente — o resto do Stage 6 (auto-reporter, sentinel, invariants) não depende de qual backend de newsletter rodou.

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

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator \
  --level {info se exit 0, warn se 3/4/5, info se 2} \
  --message "brevo-diaria stage6 schedule: exit {code}" \
  --details '{json de saída do script}'
```

#### §6d-kit-diaria — canal Kit PARALELO (#6048/#6126)

**Só quando `kit_diaria.enabled === true`.** Roda ao lado do Beehiiv/Brevo, pra audiência própria (`kit_diaria.audience_tag`). **Não é o §6d-kit**, que agenda o backend EXCLUSIVO do switchover (#6114) — coexistem enquanto a partição por origem de cadastro durar. Mesmo `scheduled_at` do Beehiiv, sob o MESMO gate, sem pergunta separada.

```bash
npx tsx scripts/schedule-kit-diaria.ts --edition-dir {EDITION_DIR}/ --scheduled-at {scheduled_at_iso}
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level {info se 0/2, warn se 3/4} --message "kit-diaria stage6 schedule: exit {code}"
```

| Exit | Ação |
|------|------|
| `0` | Confirmar: "Kit diária agendado para {scheduled_at} ✓ (broadcast_id {id})". |
| `2` | Canal desligado ou estado ausente — **não é erro**, não participou desta edição; omitir do resumo. |
| `3` | PATCH falhou / config-estado ilegível. Warn, **não bloqueia** (fail-soft do Brevo), sugerir retry. |
| `4` | GET pós-PATCH não confirma `send_at`. Warn, não bloqueia. **Nunca reportar como agendado** — pode ter ficado rascunho. |


**Falha aqui NUNCA desfaz o Schedule do Beehiiv já confirmado** — os dois canais são independentes; o Brevo é sempre o secundário/extra (segmento Pending, reativação).

### 6d-site. Publicar a página da edição no Worker `diaria-site` (#6202)

Roda **depois** do agendamento confirmado, nos dois backends. Sem este passo o acervo do site fica congelado nos 253 posts já gerados e não cresce — e é ele que destrava a janela de cutover do #467 (greenlight do editor, 26/08).

**`--slug` é obrigatório aqui, mesmo backend `"beehiiv"`.** `_internal/05-published.json`
nunca tem `post_url` populado neste ponto do pipeline (só `refresh-dedup.ts` grava isso,
no dia seguinte) — sem `--slug` o passo sempre cai em "nada a publicar" (`code: 4`, ver
tabela abaixo). Passar o MESMO `{slug_atual_do_get_post}` já obtido em §6d (o valor que o
guard do bloco WhatsApp comparou e confirmou bater):

```bash
npx tsx scripts/publish-edition-site-page.ts \
  --edition-dir {EDITION_DIR} \
  --slug {slug_atual_do_get_post}
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level {info se 0/2, warn se 3/4/5} --message "site-page stage6 publish: exit {code}"
```

| exit | significado | ação |
|---|---|---|
| `0` | página escrita e branch `site-publish/{slug}` publicada com PR aberto/reusado (`git commit` + `push` da branch + `gh pr create`/reuso, ver mecanismo abaixo) — **o deploy real só acontece quando o PR for mergeado** | seguir |
| `2` | edição sem `newsletter-final.html`/`05-published.json` — arquivo ainda não existe, nada a publicar | seguir, logar info |
| `3` | escrita, commit, push ou `gh pr create` falhou (inclui checkout fora de `master` — o script recusa criar a branch de publicação a partir de outra branch) | **logar warn e seguir** |
| `4` | artefato PRESENTE mas inválido (html/título vazio, slug não-extraível, `--slug` ausente e sem `post_url`, **ou backend `"kit"` sem `--slug`** — ainda sem fonte de slug própria, #464 não ligou o dispatch Kit ainda) — sintoma de bug num stage anterior (ou lacuna de wiring conhecida no caso Kit) | **logar warn e seguir** (nunca silencioso — não é o mesmo caso benigno do `2`) |
| `5` | GUARD (#6202): `buildArchivePageHtml` recusou por merge tag não resolvida (`UnresolvedMergeTagError`, guard do #6210/#6256) — não é a tag padrão do voto (`{{email}}`, essa é sanitizada antes do guard rodar), é uma tag DESCONHECIDA. Nada escrito/commitado | **logar warn e seguir** (fail-soft; a edição segue normal, só o site não ganha página nova até a tag ser tratada) |

**Fail-soft absoluto:** publicar no site é acessório ao envio. Nenhum exit pode bloquear §6e nem o auto-reporter. No `3`, a página costuma ficar escrita (e, se só o `push`/`gh pr create` falhou, já commitada na branch) localmente — a próxima rodada/push manual a leva junto.

**Mecanismo: branch dedicada + PR, nunca push direto em `master` (#6598).** Até 260828 este passo fazia `git commit` + `push` DIRETO em `master` — `.github/workflows/deploy-site.yml` documenta que `workers/site/public/p/**` é COMMITADO e o deploy real dispara por push a master, e publicar via `wrangler deploy` local deixaria o worker em produção divergente do repo, sem sinal (isso não mudou: continua descartado). O que mudou é o `master` em si: uma regra de proteção de branch (`GH013`) foi ativada nesse dia e passou a rejeitar todo push direto — o `push` que este passo fazia começou a falhar (`remote rejected`, exit `3` fail-soft, sem derrubar a edição, mas o acervo do site parava de crescer). Correção: o script agora recria `site-publish/{slug}` a partir do `master` local a cada chamada (`git checkout -B`), commita/empurra pra essa branch (`--force-with-lease`, seguro porque a branch é de propriedade exclusiva do script), e abre um PR via `gh pr create` — reusando um PR já aberto pra essa branch, se `gh pr list` encontrar um, em vez de duplicar. **O script NUNCA mergeia o PR** (decisão do editor, #6598): mergear automaticamente foge do padrão branch→CI→merge já estabelecido pra esta linha de skills, e como Stage 6 já é gate humano, um PR extra pendente não atrasa a edição — o merge (manual, ou pela próxima rodada overnight/develop) é o que falta pro deploy real acontecer.

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

**Backend-aware (#464, mesmo motivo do §5h/Stage 5 e da Pre-condicao acima).** Backend `"beehiiv"` (default):

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

Exit 1 = logar warn (nao bloquear auto-reporter). Inclui a regra
`whatsapp-slug-guard-ok` (#4574) — backstop determinístico que confirma que
`_internal/whatsapp-slug-check.json` existe com `ok:true`; se §6d de fato
loopou até sair `0` antes de prosseguir, esta regra já passa por
construção. Ela existe pra pegar o caso em que o agente pulou/ignorou a
prosa de §6d — aqui é só confirmação pós-hoc (warn), o bloqueio real já
aconteceu em §6d.

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

### 6b-3. Sempre rodar (#1502)

Auto-reporter roda em **todos os modos** (interativo, `auto_approve`). E o unico mecanismo de observabilidade pos-edicao.

- **`auto_approve = true`**: gate do auto-reporter e auto-aprovado.
- **Modo interativo**: gate normal.

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
arquivo e descartavel, **nao e o que vai pro rascunho de e-mail** (isso so acontece em
6b-8, depois do timer fechar). **`--no-email` (#4478) e obrigatorio aqui** — sem essa
flag, `registerReport` (chamado de dentro de `writeReportFile`) dispara o e-mail de
notificacao (#4475) tambem nesta chamada "descartavel", duplicando o aviso que 6b-8 ja
manda no fim do pipeline (2 e-mails por edicao, todo dia). A flag so suprime o disparo de
e-mail — o registro em `index.jsonl` acontece normalmente:

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

**Sem `--no-email` aqui, de proposito (#4478).** Esta e a chamada final do pipeline — o
comando SEM a flag dispara o e-mail de notificacao (#4475) normalmente, avisando o editor
que o relatorio da edicao esta pronto. So a chamada "descartavel" de 6b-6 suprime (ver
nota la).

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
