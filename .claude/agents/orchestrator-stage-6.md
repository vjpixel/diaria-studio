---
name: orchestrator-stage-6
description: Detalhe da Etapa 6 (agendamento — gate humano + Schedule Beehiiv + auto-reporter) do orchestrator Diar.ia. Lido pelo orchestrator principal durante a execucao — nao e um subagente invocavel diretamente.
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

### 6c. GATE HUMANO — Schedule Beehiiv

**Se `--no-gates` (`auto_approve = true`):** pular o gate, usar default (amanha 06:00 BRT). Logar:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 6 --agent orchestrator --level warn \
  --message "Stage 6 auto-agendado via --no-gates: {scheduled_at_iso}" \
  --details '{"source":"auto_approve","scheduled_at":"{scheduled_at_iso}"}'
```
Prosseguir direto para §6d (executar Schedule).

**Pré-gate: ler post_pixel para o lembrete (#2153).** Extrair seção `## post_pixel` de `03-social.md` **com `{outros_count}`/`{edition_url}` já resolvidos (#3052)** — `post_pixel` nunca passa pelo dispatch de `publish-linkedin.ts` (postagem 100% manual, #1690), então Stage 6 é o ponto de resolução equivalente:

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

**Verificar e corrigir slug pos-Schedule (#2011, #3449):**

```bash
npx tsx -e "
  import { seoSlug } from './scripts/lib/slug.ts';
  console.log(seoSlug('{title}'));
"
```

Se o slug atual (via `mcp__claude_ai_Beehiiv__get_post`) divergir do correto, a
correcao via API esta **permanentemente bloqueada** no plano atual (#3449,
confirmado 260714 — `403 SEND_API_NOT_ENTERPRISE_PLAN`, nao transitorio). Ir
direto pra correcao manual documentada em `context/publishers/beehiiv-playbook.md`
§9 (aba visivel → campo `#text-input-slug` em Settings → SEO/URL slug →
digitar o slug correto via teclado real). Nao vale gastar uma chamada de
`fix-post-slug.ts --execute` esperando sucesso — ela vai retornar `exit 3`
(plan-gated) e so serve pra reconfirmar/logar o estado, se necessario:

```bash
npx tsx scripts/fix-post-slug.ts \
  --post-id {post_id} \
  --slug {slug_correto} \
  --execute
# exit 3 esperado (#3449) — stderr traz instrucoes manuais formatadas
```

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

Exit 1 = logar warn (nao bloquear auto-reporter).

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

### 6b-6. Enviar relatorio por email (#1510)

Ultimo passo do pipeline:

```bash
npx tsx scripts/send-edition-report.ts \
  --edition {AAMMDD} \
  --edition-dir {EDITION_DIR}/ \
  --out {EDITION_DIR}/_internal/edition-report.html
```

**INVARIANTE (#1579):** Enviar via Gmail MCP `create_draft` (to: `vjpixel@gmail.com`, subject: `Diar.ia {AAMMDD} — relatorio de edicao`, htmlBody: `readFileSync('_internal/edition-report.html', 'utf8')` LITERAL). **NUNCA construir htmlBody programaticamente.**

**Falha nao bloqueia** — logar warn e seguir.

### 6b-7. Marcar Stage 6 `done` (#2800)

Ultimo passo do pipeline. So agora `_internal/edition-report.html` existe (escrito em 6b-6) —
`blockReasonForMarkingStageDone` para o stage 6 exige esse arquivo (+ `scheduled_at` em
`05-published.json`, ja setado em 6e) — entao rodar o `--status done` AQUI (e nao em 6f)
e a transicao tem sucesso:

```bash
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 6 --status done
```

**Capturar custo/tokens reais (#3441):**
```bash
npx tsx scripts/capture-stage-usage.ts --edition-dir {EDITION_DIR}/ --stage 6
```

Falha (exit != 0) → logar warn com o motivo impresso pelo script; nao bloquear o resto do
fluxo (relatorio ja foi enviado). Se isso acontecer, a barra de status pode ficar presa em
`running` ate reconciliacao (ver `reconcileZombieRunningRows` em `scripts/overnight-statusline.ts`,
que detecta `.step-6-done.json` presente + row `running` e corrige a exibicao sem escrita).

---

## Resumo final (apos auto-reporter + relatorio)

Apos auto-reporter, apresentar resumo consolidado da edicao. **Nao enumerar as issues criadas pelo auto-reporter (#1825)** — reportar so a contagem. Se alguma parte foi pulada, incluir bloco de retomada explicito.

Se nenhum stage foi pulado, omitir esse bloco — so listar outputs e metricas finais.
