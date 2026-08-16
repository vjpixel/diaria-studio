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

```bash
npx tsx scripts/pipeline-sentinel.ts assert \
  --edition {AAMMDD} --step 5 \
  --outputs "_internal/05-published.json"
```

Exit code handling:
- `0` → continuar.
- `1` → **FATAL:** "Etapa 5 (Publicacao) nao completou (sentinel ausente). Re-rodar `/diaria-5-publicacao {AAMMDD}` antes de continuar." Parar.
- `2` → **FATAL:** "05-published.json ausente. Re-rodar Etapa 5." Parar.
- `3` → logar warn, continuar.

### Pre-condicao: estado do preflight (#5414)

Este stage pode rodar em **contexto proprio** (`/diaria-6-agendamento {AAMMDD}` numa sessao limpa) — o preflight esta no disco, nao na conversa:

```bash
npx tsx scripts/lib/preflight-state.ts --edition-dir {EDITION_DIR}/ --get beehiiv_mcp
npx tsx scripts/lib/preflight-state.ts --edition-dir {EDITION_DIR}/ --get chrome_mcp
```

`beehiiv_mcp` cobre a correcao de slug; `chrome_mcp`, o Schedule na UI. `false` → warn e seguir (o passo dependente falha adiante, coberto pelo halt banner do #738). **`unknown` → re-probar e GRAVAR** (`mcp__claude_ai_Beehiiv__get_current_user` / `mcp__claude-in-chrome__tabs_context_mcp`, depois `--set {chave}={true|false}`) — sem gravar, um resume deste stage volta a ler `unknown`. **Nunca tratar `unknown` como `false`.**

### 6a. Pre-requisitos

**Marcar Stage 6 `running` no inicio (#1783):**
```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 6 --status running
```

- Logar inicio:
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info --message 'etapa 6 agendamento started'
  ```
- Ler `_internal/05-published.json` → extrair: `draft_url`, `title`, `test_email_sent_at`, `review_completed`, `review_status`, `review_final_issues`.
- Ler `_internal/06-social-published.json` → extrair: horarios agendados dos 3 posts LinkedIn e 3 posts Facebook (`scheduled_at` por destaque).
- Ler `_internal/06-verify-dispatch.json` (se existir) → extrair quaisquer warnings de verificacao.
- Ler `post_id` de `_internal/05-published.json` (necessario para o Schedule Beehiiv e para verificacao pos-Schedule).
- Ler horario default de agendamento: amanha 06:00 BRT = `{edition_date}` as 09:00 UTC.
  ```bash
  node -e "const s='{AAMMDD}';const d=new Date('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6)+'T09:00:00Z');process.stdout.write(d.toISOString())"
  ```

**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

### 6b. Montar resumo de agendamento

Compor o resumo que sera exibido no gate:

- **Newsletter Beehiiv:**
  - URL do rascunho: `draft_url` de `05-published.json`.
  - Test email: `test_email_sent_at` formatado em BRT.
  - Status do review: se `review_completed: true` → `✓ review ok`; se `review_status: "inconclusive"` → `⚠ review inconclusivo`; se issues → listar.
- **Social agendado:** horarios LinkedIn + Facebook por destaque (D1/D2/D3).
- **Achados do review-test-email** (se `review_final_issues` nao vazio ou `review_status !== "ok"`).

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

**Se `--no-gates` (`auto_approve = true`):** pular o gate, usar default (amanha 06:00 BRT). Logar:
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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📣 LEMBRETE (nao bloqueia) — post pessoal vjpixel
Poste manualmente no LinkedIn PESSOAL (nao a pagina Diar.ia):
  Imagem: {EDITION_DIR}/04-d1-1x1.jpg

{POST_PIXEL_TEXT}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Agendar envio da newsletter no Beehiiv?

  sim          → agenda para amanha 06:00 BRT (default)
  sim HH:MM    → agenda para amanha {horario informado} BRT
  abortar      → nao agenda; rascunho permanece, sentinel nao escrito
  Qualquer outra entrada → repetir (fail-closed)
```

Aguardar resposta do editor. Interpretar:
- `sim` (sem horario) → `scheduled_at` = amanha 06:00 BRT.
- `sim HH:MM` → `scheduled_at` = amanha `HH:MM` BRT; validar HH 0-23, MM 0-59.
- `abortar` → logar warn, NAO escrever sentinel, encerrar Stage 6. Editor pode re-rodar `/diaria-6-agendamento {AAMMDD}` depois.
- Qualquer outra coisa → exibir o gate novamente (fail-closed).

Logar resposta:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level info \
  --message "gate 6 response: {sim HH:MM|abortar}" \
  --details '{"response":"{resposta}","scheduled_at":"{scheduled_at_iso}"}'
```

### 6d. Executar Schedule do Beehiiv

**Exibir banner pre-Schedule ao editor ANTES de pedir o clique** (evitar Publish acidental, incidente 260611 #2074):

```
Proximo passo: clicar em Schedule → selecionar AMANHA {data_alvo} → {HH:MM} BRT.
NAO clique em "Publish now" — isso dispara envio imediato pra toda a audiencia.
```

Navegar para `draft_url` no Chrome e executar o passo de Schedule do Beehiiv conforme documentado em `context/publishers/beehiiv-playbook.md` §9 (Verificar slug pos-Schedule) e §10 (Verificar estado pos-Schedule).

**Ao receber confirmacao do editor que agendou ("agendado", "ok", "pronto" ou equivalente):**

**Verificar estado via `scripts/verify-scheduled-post.ts` (#573, #2074 — obrigatorio):**

```bash
npx tsx scripts/verify-scheduled-post.ts \
  --post-id {post_id} \
  --edition-dir {EDITION_DIR}/
```

| Exit | Estado | Acao |
|------|--------|------|
| `0` | `scheduled` — agendado corretamente | Confirmar horario ao editor: "Agendado para {scheduled_at} ✓" |
| `1` | `published` — envio imediato detectado | Sequencia de reconciliacao abaixo |
| `2` | `unknown` / `draft` / erro | Alertar editor; verificar manualmente no dashboard Beehiiv |

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

### 6e. Atualizar `05-published.json` com scheduled_at

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

### 6f. Escrever sentinel de conclusao

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 6 \
  --outputs "_internal/05-published.json"
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

**Checar auth wrangler antes de rodar (label `local`, #2643).** Rodar com um timeout
curto explicito (ex: 15000ms via o parametro de timeout da tool de Bash) — `wrangler
whoami` so le config local e nao deveria abrir browser, mas o proprio
`check-cloudflare-token.ts` evita esse comando justamente por risco de side-effect de
login interativo; o timeout e a rede de seguranca contra qualquer stall:
```bash
npx wrangler whoami
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

### 6b-8. Regenerar o report + registrar na superfície do Studio (#1510, #3457, #3714) — ULTIMO passo do pipeline

Com o Stage 6 ja `done` (timer fechado em 6b-7), regenerar `edition-report.html`: agora a
linha do Stage 6 na tabela tem `end`/duracao carimbados, entao a duracao total do relatorio
reflete o processamento real do stage (Schedule Beehiiv, verificacao, purga de leaderboard,
auto-reporter) em vez de ficar subcontada por excluir esse tempo (causa-raiz #3457 — o
report antigo era gerado, e o e-mail montado a partir dele, ANTES do Stage 6 fechar o
timer). So depois disso, o comando abaixo — a ultima acao do pipeline inteiro:

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

Informacional, **nunca bloqueia** — roda após 6b-8: `npx tsx scripts/hub-staleness-check.ts`.

Audita `data/beehiiv-cache/posts/*.json` contra `scripts/lib/hubs/*-sources.generated.json` e
imprime, se alguma edição confirmada casar `HUB_KEYWORD_PATTERNS` sem estar no dataset do hub,
a lista + comandos de regen sugeridos. **Fail-soft** (label `local`, #2643) — sem
`data/beehiiv-cache/posts` (cloud), stdout vazio, exit 0.

Stdout vazio → omitir do resumo. Não-vazio → colar o bloco literal sob `⚠ Hubs temáticos
defasados` — informacional, editor decide se roda os comandos (regen nunca é automático,
#4924 item 2). **Nunca rodar os comandos sugeridos automaticamente.**

---

## Resumo final (apos auto-reporter + relatorio)

Apos auto-reporter, apresentar resumo consolidado da edicao. **Nao enumerar as issues criadas pelo auto-reporter (#1825)** — reportar so a contagem. Se alguma parte foi pulada, incluir bloco de retomada explicito.

**#3714:** incluir a linha `Relatório: {studio_report_url}` (valor lido do summary JSON de 6b-8) — é o link primário do relatório desta edição agora que o draft de Gmail foi removido. Se `studio_report_url` vier `null` (registro falhou, fail-soft), reportar `Relatório: só local (_internal/edition-report.html) — registro no Studio falhou, ver warn acima` em vez de omitir a linha.

**#4924:** se 6b-9 imprimiu algo, incluir `⚠ Hubs temáticos defasados` no resumo, após a linha do Relatório. Stdout vazio → omitir a seção (sem afirmar "hubs em dia").

Se nenhum stage foi pulado, omitir esse bloco — so listar outputs e metricas finais.
