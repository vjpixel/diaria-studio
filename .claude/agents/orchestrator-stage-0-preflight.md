---
name: orchestrator-stage-0-preflight
description: Stage 0 do orchestrator diar.ia.br — setup, parâmetros, checks pré-edição, refreshes (dedup, CTR, audience) e auto-reporter prep. Roda via `scripts/stage-0-run.ts` (#5415); este arquivo tem o caminho do runner e os passos fora dele, e a prosa de fallback está em orchestrator-stage-0-fallback.md (#14030). Lido pelo orchestrator principal. @see orchestrator-stage-1-research.md (Stage 1).
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 0 — Setup e checks pré-edição

**MCP disconnect logging:** ver `orchestrator.md` § "MCP disconnect — logging + halt banner" (#759/#737). Nesta etapa: `--stage 0`, banner `--stage "0 — Preflight"`.

### Runner determinístico (`scripts/stage-0-run.ts`, #5415) — CAMINHO PRINCIPAL

**Rodar `0b` (resume-aware) primeiro, como sempre** — decide se a edição já passou
do Stage 0 e deve pular direto para outro stage. `0b` opera sobre `{EDITION_DIR}`,
que resolve com a mesma chamada barata e idempotente que o runner usa internamente
em `0a` (`npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD}`) — rodá-la
uma vez aqui, antes de decidir se o Stage 0 sequer começa, não duplica trabalho: a
fase `preflight` do runner (passo 1 abaixo) chama o mesmo comando de novo e é
seguro repetir (leitura pura, sem escrita). Só quando o resume aponta "começar
do Stage 0" é que o runner abaixo entra em cena.

A partir daí, os passos **0a, 0b-bis, 0c (só os 3 checks HTTPS/token — locks,
Cloudflare, Clarice REST; os 2 pings MCP (Chrome, Gmail) continuam manuais, ver passo 2 abaixo),
0d, 0d.bis, 0e-0h, 0i, 0j (a detecção; a decisão humana s/n/d continua sendo do
editor), 0k, 0l, 0o e 0z** são executados por `npx tsx scripts/stage-0-run.ts` num
único fluxo de 2 chamadas, em vez de serem interpretados turno a turno em Bash
sequencial. **A prosa detalhada dessas subseções vive em
`.claude/agents/orchestrator-stage-0-fallback.md` (#14030)** — é o que o
script faz e por quê, e o **fallback** se o script não existir ou falhar de
forma inesperada (ver passo 4). No caminho normal esse arquivo não é lido.

Design de 2 fases (o script é um processo Node puro — não alcança MCP):

1. **Fase `preflight`** (reconnaissance, zero escrita em disco):
   ```bash
   npx tsx scripts/stage-0-run.ts --phase preflight --edition {AAMMDD} \
     [--window-days {window_days}] [--auto-approve] [--pre-gate]
   ```
   Devolve JSON com `editionDir`, `editionIso`, `anchorIso`, `cutoffIso`,
   `windowDays`, `clariceRest`, `clariceMcp` (#11312), `cloudflareTokenOk` e `needsMcpProbes`
   (descrição dos 2 pings que só o orchestrator consegue fazer).

2. **Fazer os 2 pings MCP** — ver "§0c (pings MCP)" abaixo pro racional de cada um:
   `mcp__claude-in-chrome__tabs_context_mcp`, `mcp__claude_ai_Gmail__list_labels`.
   Sucesso/erro de cada um vira `true`/`false`. **A Beehiiv NÃO é sondada (#11225):**
   só arquivo histórico — conector fora do ar nunca bloqueia nem pausa a edição.

3. **Fase `continue`** (execução real — persiste tudo, roda 0d → 0z):
   ```bash
   npx tsx scripts/stage-0-run.ts --phase continue --edition {AAMMDD} \
     --mcp-chrome {true|false} --mcp-gmail {true|false} \
     [--window-days {window_days}] [--auto-approve] [--pre-gate]
   ```

**Interpretar o JSON de saída (campo `code` + resto):**
- `code: 0` → Stage 0 concluído. Usar `editionDir`/`editionIso`/`anchorIso`/
  `cutoffIso`/`windowDays` do JSON como `{EDITION_DIR}`/`edition_iso`/
  `anchor_iso`/`cutoff_iso`/`window_days` no resto do pipeline (Stage 1+).
- `code: 1` → erro duro (sub-script obrigatório falhou) — parar e reportar
  ao editor com `notes[]` (mesma disciplina do #738/#3938: nunca prosseguir
  silenciosamente sobre uma falha não tratada).
- `code: 2` → HALT obrigatório (`haltRequired`, banner já renderizado pelo
  próprio script) — parar mesmo com `auto_approve`, mesma regra do 0d.bis
  original (nunca bypassa; racional e ação do editor em
  `orchestrator-stage-0-fallback.md` §0d.bis).
- `pendingAgentDispatch[]` (`0h.4`) → `0h.4` (#10710): `Agent(subagent_type: "beehiiv-exit-history-drain", prompt: "retome do manifest")`, fail-soft (warn); some quando o manifest fica `complete` — conferir no disco (#573). **Leitura opcional do arquivo histórico da Beehiiv (#11225):** se o conector Beehiiv não responder, o agent falha, loga warn e o Stage 0 segue — nunca halt, nunca pergunta. (O `0h.2`, dispatch do `beehiiv-clicks-enricher`, foi aposentado no #11225.)
- `pendingHumanDecision[]` (hoje `0g` freshness stale, `0j` drafts
  pendentes e `0p` mês do sorteio desatualizado na 1ª edição do mês, #11896)
  → apresentar `detail`/`prompt`/`options` ao editor exatamente
  como as subseções correspondentes abaixo descrevem, e agir conforme a
  resposta (inclusive o dispatch do agent `auto-reporter` no caso `s` do 0j).
  No `0p`, com o dia informado, gravar `platform.config.json` →
  `raffle.sorteio_do_mes` `{ "mes": "{AAAA-MM}", "dia": N }` (Edit cirúrgico)
  antes do Stage 3; com `--no-gates`/sem resposta, seguir — o Stage 3 para no
  `inject-champions-callout.ts` como antes (#4583, nunca publicar o dia velho).
- `delegatedSteps[]` — lista informativa dos passos que o script nunca
  tenta (0n, 0-replies) — rodar essas seções normalmente, como sempre (0n
  abaixo; 0-replies em `.claude/agents/orchestrator-stage-0-replies.md`, ver
  o ponteiro "§0-replies" abaixo).

4. **Fallback**: se `scripts/stage-0-run.ts` não existir, ou falhar de um
   jeito não coberto pelos `code`s acima (erro de spawn, exceção fora do
   `try/catch` do script), ler `.claude/agents/orchestrator-stage-0-fallback.md`
   e seguir a prosa detalhada de 0a-0z de lá turno a turno, exatamente como
   antes do #5415 (as seções que ficam neste arquivo — 0b, pings de 0c, 0g,
   0j, 0n, 0-replies, 0m — seguem valendo).

Seções `0m` (auto-reporter — só roda depois do Stage 4, é só uma nota de
preparação aqui) e `0n`/`0-replies` (100% MCP/interativo) **nunca** passam
pelo runner — seguem executadas em prosa, como sempre.

@see scripts/stage-0-run.ts (docstring no topo do arquivo tem o mapeamento
completo seção-a-seção do que está coberto vs. delegado)

---

### 0b. Resume-aware

Antes de iniciar qualquer etapa, listar arquivos em `{EDITION_DIR}/`. **Pipeline principal** (verificar de baixo para cima — parar na primeira condição verdadeira):

- Se `_internal/.step-6-done.json` existe → **Pipeline finalizado** (Stage 6 Agendamento concluído). **Nota sobre edições históricas (pré-Stage-6):** edições publicadas antes de #1694 (split Stage 5→6) têm `_internal/05-published.json` com `scheduled_at` ou `status: "published"` mas NÃO têm `.step-6-done.json`. Detectar pela presença de `scheduled_at` OU `status: "published"` em `_internal/05-published.json` junto com `_internal/06-social-published.json` populado — tratar como concluídas. NÃO re-agendar edições históricas.
- Se `_internal/06-social-published.json` existe **e** `posts[]` tem 6 entries com `status` ∈ `"draft"`, `"scheduled"`, `"pending_manual"` **e** (`_internal/05-published.json` tem `scheduled_at` OU `status: "published"`) → Pipeline finalizado. (Compat com edições históricas pré-Stage-6.)
- Se `_internal/06-social-published.json` existe **e** sentinel `.step-5-done.json` existe **mas não** `.step-6-done.json` → Etapa 5 completa; pular para **Etapa 6 (Agendamento)**. (Verifique que `_internal/05-published.json` não tem `scheduled_at` para confirmar que Stage 6 ainda não correu.)
- Se `_internal/06-social-published.json` existe mas com **menos de 6 entries** ou alguma `status: "failed"` → Etapa 5 parcial; re-disparar publicação Facebook e LinkedIn — ambos são resume-aware.
- Se `_internal/.step-5-done.json` existe (mas não `_internal/06-social-published.json`) → Etapa 5 em progresso (social dispatch falhou ou não completou); re-disparar `publish-facebook` + `publish-linkedin`.
- Se `_internal/05-published.json` existe **e** `status === "skipped"` (Chrome MCP estava indisponível) → **re-probar Chrome MCP** (`mcp__claude-in-chrome__tabs_context_mcp`). Se probe suceder: **gravar `npx tsx scripts/lib/preflight-state.ts --edition-dir {EDITION_DIR} --chrome-mcp true`** (#5434 — sem isso o `chrome_mcp: false` gravado quando `_internal/05-published.json` virou `skipped` continua no disco, e a Etapa 5 volta a pular a publicação mesmo com o Chrome já confirmado), então deletar o arquivo marcador e tratar como se Etapa 5 não tivesse rodado. Se probe falhar: pular para auto-reporter com `npx tsx scripts/lib/preflight-state.ts --edition-dir {EDITION_DIR} --chrome-mcp false` gravado (estado já deve estar `false` no disco, mas grave de novo por segurança — não confiar em variável de sessão, #5414).
- Se `_internal/05-published.json` existe **e** `review_completed === true` **e** `template_used` === valor de `publishing.newsletter.template` em `platform.config.json` (mas não `_internal/06-social-published.json`) → pular para Etapa 5b (social dispatch).
- Se `_internal/05-published.json` existe mas `template_used` !== template esperado → instruir o usuário a deletar o rascunho no Beehiiv e re-rodar Etapa 5 do zero. **Verificar template ANTES de review.**
- Se `_internal/05-published.json` existe mas `review_completed` é `false` ou ausente → Etapa 5 incompleta (newsletter parcial): pular publish-newsletter, rodar só o **loop de review-test-email** a partir do `draft_url` e `title`. Após completar, gravar `review_completed: true`. Em paralelo (se ainda não rodaram), disparar `publish-facebook` + `publish-linkedin`. Re-apresentar gate único.
- Se `04-d1-2x1.jpg` + `04-d2-2x1.jpg` + `04-d3-2x1.jpg` existem (o 1:1 deixou de ser gerado no #12226) (mas não `_internal/05-published.json`) → verificar se sentinel Step 4 (`_internal/.step-4-done.json`) existe. Se existe → Revisão (Stage 4) completa, pular para Etapa 5 (Publicação). Se não existe → pular para Etapa 4 (Revisão).
- Se `02-reviewed.md` + `03-social.md` existem (mas não `04-d1-2x1.jpg`) → pular para Etapa 3 (Imagens).
- Se `02-reviewed.md` existe mas **não** `03-social.md` → Etapa 2 parcial (newsletter ok, social não rodou); re-rodar Etapa 2 com `[social]`.
- Se `_internal/01-approved.json` existe (mas não `02-reviewed.md`) → pular para Etapa 2.
- Se `_internal/01-categorized.json` existe mas não `_internal/01-approved.json` → Etapa 1 foi interrompida no gate humano; reapresentar o gate.
- Caso contrário → começar do Stage 0 normalmente.

**É IA? (paralelo, #1111)** — verificar em qualquer ponto de resume:
- Se `01-eia.md` já existe → não disparar `eia-compose`.
- Se `01-eia.md` **não** existe e o resume está no Stage 1 ou acima → disparar `Bash(npx tsx scripts/eia-compose.ts --edition {AAMMDD} --out-dir {EDITION_DIR}/, run_in_background=true)` (era Agent dispatch antes de #1111).
- **Pré-requisito da Etapa 5:** `01-eia.md` + imagens devem existir antes de publicar. Se o background bash ainda não completou quando a Etapa 5 for atingida, **bloquear e aguardar** via file-presence check.

Se o usuário responder "sim, refazer do zero", **pedir confirmação adicional digitando o nome da edição** (`AAMMDD`) antes de prosseguir — `sim`/`yes`/`confirmar` não valem, só o literal da edição (#101). Em seguida, **renomear** (não deletar) `{EDITION_DIR}` para `{EDITION_DIR}-backup-{timestamp}/` (sibling, mesmo parent — funciona igual em flat ou nested) antes de começar.

### 0c (pings MCP). Chrome e Gmail — passo 2 do runner, sempre manuais

Os 3 checks HTTPS/token de §0c rodam no `stage-0-run.ts` (prosa em `orchestrator-stage-0-fallback.md` §0c). Os pings abaixo só o orchestrator consegue fazer; o resultado vai para `--mcp-chrome`/`--mcp-gmail` da fase `continue`, que persiste os sinais em `_internal/preflight-state.json`.

- **Pre-flight Claude in Chrome MCP (#143).** Tentar `mcp__claude-in-chrome__tabs_context_mcp`. Setar `CHROME_MCP = true` se sucesso, `CHROME_MCP = false` se erro.
  - Se `CHROME_MCP = false`, logar warn e seguir, com uma linha de banner ao editor no modo interativo (`⚠️ Claude in Chrome indisponível: na Etapa 5 o e-mail de teste sai pelo --send-test.`). Não perguntar `[y/n]` em nenhum modo (#14108, #5321): sem Chrome nenhum canal da diária deixa de sair.
  - **Na Etapa 5**: `CHROME_MCP = false` só troca o teste pela UI do Kit pelo fallback `--send-test` (§5c-1-kit de `orchestrator-stage-5.md`). Nenhum canal vira `pending_manual` por isso: LinkedIn, Facebook, Instagram, Threads, X, Brevo e o rascunho Kit saem por script/Worker, sem Chrome (#971).
- **Pre-flight Gmail MCP (#3451, espelha #143).** Tentar `mcp__claude_ai_Gmail__list_labels` (leitura barata, sem side-effect). Setar `GMAIL_MCP = true` se sucesso; se erro, `GMAIL_MCP = false` e logar `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn --message "mcp_disconnect: claude_ai_Gmail" --details '{"server":"claude_ai_Gmail","kind":"mcp_disconnect"}'` (mesmo evento estruturado que `collect-edition-signals.ts` já pareia com `mcp_reconnect:` pra medir duração, #766 — nada novo a instrumentar aqui). **Em modo interativo**, alertar editor e aguardar `[y/n]`; **em `auto_approve`**, prosseguir silenciosamente. Cobre só os passos que usam o MCP claude.ai Gmail (0n CI-failures, 0-replies) — 0b-bis (auto-capture de newsletters) usa a Gmail REST API direto via OAuth (`data/.credentials.json`), caminho de auth separado, não depende deste flag. 0n e 0-replies já tratam Gmail MCP indisponível como skip fail-soft individualmente — este preflight só antecipa o aviso pro editor antes de gastar tokens em pesquisa, não muda o comportamento de skip já existente.
- **Sem pre-flight Beehiiv MCP (#11225, removido; era #3451).** Decisão do editor (27/10/2026): a Beehiiv é só arquivo histórico — não envia desde #7388, `read_backend`/`subscriber_backend` são `"kit"` — e o conector fora do ar nunca pode bloquear nem pausar a edição. Nada de `get_current_user`, nada de `[y/n]`. Os passos que ainda leem o histórico pelo MCP (0h.4 exit-history, fallback remoto de 0-replies) tentam direto e são fail-soft individualmente; o dedup refresh (0d) lê do Kit (`read_backend`).

### 0g. Pre-flight de freshness do dedup (#230) (→ detecção coberta por `stage-0-run.ts`, que devolve isto em `pendingHumanDecision`; a decisão [c/a] continua sendo do editor; referência/fallback)

Roda em paralelo com 0e/0f/0h (per nota da seção 0e–0h acima):
```bash
npx tsx scripts/check-dedup-freshness.ts
```
Lê `data/past-editions-raw.json` e compara `max(published_at)` com `Date.now() - 48h`. Se fora da janela, **falha loud** (exit 1). Threshold = 48h (#236): tolera D-1 (atraso normal de fuso/processamento da Beehiiv) e fins de semana onde a newsletter não publica. Alarme dispara a partir de D-2, indicando provável falha real.

Se o script falhar:
1. Apresentar o JSON completo de output ao editor.
2. Pedir confirmação: `[c] continuar mesmo assim (override) | [a] abortar`. Default = `a`.
3. Se `c`, logar `level: warn` com `{ event: "dedup_freshness_override", most_recent, age_hours }` e prosseguir.

Saída fresh é silenciosa (logar `level: info` com `most_recent` + `age_hours`).

### 0j. Pending issue drafts (#90) (→ detecção coberta por `stage-0-run.ts`, que devolve isto em `pendingHumanDecision`; a decisão s/n/d continua sendo do editor; referência/fallback)

Check drafts do `auto-reporter` órfãos de edições anteriores:
```bash
PENDING=$(npx tsx scripts/find-pending-issue-drafts.ts --current {AAMMDD} --window 3)
```
Se vazio (`[]`), skip silencioso. Se tiver entries, apresentar ao editor:
```
⚠️ N edições anteriores têm issues-draft não-processados:
  - 260423: 3 signals (1 source_streak, 2 chrome_disconnects)
  - 260422: 1 signal (1 unfixed_issue)

Processar agora? [s/n/d]
  s = disparar auto-reporter com as edições acima (multi-edition mode)
  n = pular, manter drafts pra próxima sessão
  d = dismiss (marcar como processados sem criar issues)
```
- Se `s`: invocar subagent `auto-reporter` via Agent com `{ edition_dirs, multi_edition: true, repo: "vjpixel/diaria-studio" }`.
- Se `n`: logar `info "deferred {count} pending drafts"`.
- Se `d`: gravar `_internal/issues-reported.json` com `dismissed: true` + array vazio cobrindo todos signals para cada edição pendente.

### 0n. Detecção de falhas de CI via Gmail (#740)

Fechar o loop de observabilidade: o GitHub envia notificações de CI falhou para o email do owner do repositório. Checar o inbox antes de iniciar a edição evita rodar o pipeline sobre código quebrado.

**Sempre roda, silencioso se sem falhas.** Usar Gmail MCP (`mcp__claude_ai_Gmail__search_threads`) para buscar:

```
from:notifications@github.com subject:("failed" OR "CI") newer_than:2d
```

Se não encontrar resultados: prosseguir silenciosamente.

Se encontrar threads:
1. Para cada thread, ler o conteúdo via `mcp__claude_ai_Gmail__get_thread` (messageFormat: `"FULL_CONTENT"`).
2. Extrair os campos:
   - `workflow`: nome do workflow (do subject, ex: "CI - feat(X): …")
   - `branch`: nome do branch (do subject ou corpo do email)
   - `run_url`: URL do run de CI (link "View workflow run" no corpo)
   - `failed_at`: timestamp do email
   - `summary`: motivo sumário (ex: "All jobs have failed", job name que falhou)
3. Persistir no arquivo append-only `data/ci-failures.jsonl` — uma entrada JSON por linha:
   ```json
   {"workflow":"CI","branch":"feat/x","run_url":"https://github.com/vjpixel/diaria-studio/actions/runs/…","failed_at":"2026-05-06T01:06:00Z","summary":"CI / test — Failed in 1 minute and 3 seconds"}
   ```
   Dedup por `run_url` — não adicionar se run_url já existir no arquivo.
4. Logar via `scripts/log-event.ts` (flag `--informational` pra não virar issue):
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
     --informational \
     --message "CI failures detectados: N falha(s) recentes" \
     --details '{"count":N,"branches":["feat/x"]}'
   ```
5. Exibir no terminal:
   ```
   ⚠️ CI failures detectados nas últimas 48h:
     • [feat/x] CI — All jobs have failed — 2026-05-06 01:06 BRT
       🔗 https://github.com/vjpixel/diaria-studio/actions/runs/…

   Esses failures podem indicar regressões no código atual.
   Continuar mesmo assim? [y/n] (default: y)
   ```
   Se editor responder `n`: abortar a edição.

Se Gmail MCP estiver indisponível (disconnect): pular `0n` silenciosamente (não bloqueia — CI check é informativo). Logar `info "0n skipped: Gmail MCP unavailable"`.

### 0-replies. Rascunhar respostas a assinantes (#1797, #2288) — SÓ com gates ativos

Passos em `.claude/agents/orchestrator-stage-0-replies.md` (#14030). Ler esse arquivo só quando a seção for rodar: `pre_gate === true`, Gmail MCP disponível e fora do Stage 1 spawnado (#7166: no `/diaria-edicao` ela roda no top-level, Passo 1b do SKILL.md; o Stage 6 repete em §6b-replies). Fora disso, logar o skip com `buildRepliesSkipLogArgs(reason, edition)` (`scripts/lib/replies-skip-log.ts`: `0-replies skipped: Gmail MCP unavailable` ou `0-replies skipped: headless --no-gates`) e seguir. Nunca pular em silêncio, nunca bloquear a edição.

### 0m. Auto-reporter — preparado pra rodar no final

Após a Etapa 4 (publicação paralela) completar, orchestrator deve disparar `collect-edition-signals.ts` + `auto-reporter` agent pra transformar sinais da edição em issues GitHub acionáveis. Detalhes completos no arquivo `orchestrator-stage-4.md` (seção "Etapa 4b — Auto-reporter").

---

## Invariante de sentinel de Stage 1 (#6827)

O Stage 1 termina SEMPRE escrevendo `_internal/.step-1-done.json`
(`pipeline-sentinel.ts write --step 1`), nunca opcional — sem isso o runner
(`scripts/lib/edition-stage-runner.ts`) não detecta conclusão (#6827: sessão
headless completou o trabalho e saiu sem escrever, edição ficou sem
checkpoint). Mecanismo completo e o bug original vivem em
`orchestrator-stage-1-research.md` §1y — é onde o passo de fato executa.

## Stage 1 — Research

