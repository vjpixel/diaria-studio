---
name: orchestrator-stage-0-preflight
description: Stage 0 do orchestrator Diar.ia — setup, parâmetros, checks pré-edição, refreshes (dedup, CTR, audience) e auto-reporter prep. Lido pelo orchestrator principal. @see orchestrator-stage-1-research.md (Stage 1).
---

> Este arquivo é referenciado por `orchestrator.md` via `@see`. Não executar diretamente.

---

## Stage 0 — Setup e checks pré-edição

**MCP disconnect logging (#759):** Quando detectar `<system-reminder>` de MCP disconnect (Beehiiv, Gmail, etc.), logar: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn --message "mcp_disconnect: {server}" --details '{"server":"{server}","kind":"mcp_disconnect"}'`. Ao reconectar: mesmo comando com `--level info --message "mcp_reconnect: {server}"`. Persiste em `data/run-log.jsonl` para `collect-edition-signals.ts` (#759). **Sempre acompanhar** com halt banner pra alertar o editor: `npx tsx scripts/render-halt-banner.ts --stage "0 — Preflight" --reason "mcp__{server} desconectado" --action "reconecte e responda 'retry', ou 'abort' para abortar"` (#737).
**Timestamps (#716):** Timestamps apresentados ao editor usam BRT (America/Sao_Paulo, UTC-3) — formato `HH:MM (BRT)`. ISO UTC apenas em logs/JSON internos.

### 0a. Parâmetros de entrada

- `edition_date` recebido no formato `AAMMDD` (ex: `260423`). Usar como diretório: `data/editions/{edition_date}/`.
- Converter para ISO quando precisar de Date math:
  ```bash
  Bash("node -e \"const s='{edition_date}';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))\"")
  ```
  Armazenar como `edition_iso` (ex: `2026-04-23`).
- **Calcular `anchor_iso` e `cutoff_iso` (#560).** A janela de pesquisa é ancorada em "agora" (data de execução), não na publication date. Edições agendadas pra publicar dias à frente (test_mode, ou /diaria-edicao chamado com data futura) **continuam pesquisando o que foi publicado nos últimos `window_days` dias do ponto de vista de quem está rodando**, não a janela futura entre `today` e `edition_date`.
  ```bash
  Bash("node -e \"process.stdout.write(new Date().toISOString().slice(0,10))\"")
  ```
  Armazenar como `anchor_iso` (ex: `2026-05-04`). Calcular também `cutoff_iso = anchor_iso - window_days`:
  ```bash
  Bash("node -e \"const a=new Date('{anchor_iso}T00:00:00Z');a.setUTCDate(a.getUTCDate()-{window_days});process.stdout.write(a.toISOString().slice(0,10))\"")
  ```
  Esses dois valores **substituem** `edition_iso` em qualquer prompt de agente de pesquisa (1f) e qualquer chamada a `filter-date-window.ts` (1o). `edition_iso` permanece só como identificador da edição.
- Criar o diretório e subdiretório interno se não existirem: `Bash("mkdir -p data/editions/{edition_date}/_internal")`.
- **Receber `window_days` como parâmetro de entrada.** A skill que disparou este orchestrator já perguntou e confirmou a janela com o usuário antes de disparar. **Se não receber** (retrocompat), usar default: segunda/terça = 4, quarta-sexta = 3 — calcular via Bash node. Armazenar `window_days` — usado em Stage 1.
- **Receber `test_mode` (opcional, default `false`).** Se `true`: auto-aprovar todos os gates, desabilitar Drive sync, copiar `_internal/01-categorized.json` → `_internal/01-approved.json` diretamente.
- **Receber `with_publish` (opcional, default `false`, #568).** Só relevante quando `test_mode = true`. Controla se a Etapa 4 (publicação) roda no `/diaria-test`:
  - `with_publish = false` (default): Stage 0c força `CHROME_MCP = false`, fazendo Etapa 4 pular com `status: "skipped"`. Comportamento histórico do `/diaria-test` — fluxo de publicação fica fora do teste.
  - `with_publish = true`: Stage 0c roda o probe normal de Chrome MCP. Se sucesso, Etapa 4 dispatcha publish-newsletter / publish-facebook / publish-linkedin com `schedule_day_offset = 10`. Editor é responsável por deletar manualmente os artefatos gerados (rascunho Beehiiv, posts agendados FB/LinkedIn).
- **Receber `auto_approve` (opcional, default `false`).** Se `true`: auto-aprovar todos os gates, manter Drive sync ativo, manter social scheduling normal, copiar categorized → approved diretamente.
  - Em resumo: `auto_approve` é "sem gates, resto normal"; `test_mode` é "sem gates + sem Drive + social 10 dias à frente".
- **Receber `schedule_day_offset` (opcional).** Se presente, usar como `day_offset` para todos os agendamentos sociais na Etapa 4. Usado pelo `/diaria-test` para agendar 10 dias à frente.

### 0b. Resume-aware

Antes de iniciar qualquer etapa, listar arquivos em `data/editions/{AAMMDD}/`. **Pipeline principal** (verificar de baixo para cima — parar na primeira condição verdadeira):

- Se `06-social-published.json` existe **e** `posts[]` tem 6 entries com `status` ∈ `"draft"`, `"scheduled"`, `"pending_manual"` → Etapa 4 completa. Pipeline finalizado. (Entries `pending_manual` são LinkedIn posts aguardando retomada com Chrome MCP — tratados como "já tratados" para fins de resume.)
- Se `06-social-published.json` existe mas com **menos de 6 entries** ou alguma `status: "failed"` → Etapa 4 parcial; re-disparar publicação Facebook e LinkedIn — ambos são resume-aware.
- Se `05-published.json` existe **e** `status === "skipped"` (Chrome MCP estava indisponível) → **re-probar Chrome MCP** (`mcp__claude-in-chrome__tabs_context_mcp`). Se probe suceder: deletar o arquivo marcador e tratar como se Etapa 4 não tivesse rodado. Se probe falhar: pular para auto-reporter com `CHROME_MCP = false`.
- Se `05-published.json` existe **e** `review_completed === true` **e** `template_used` === valor de `publishing.newsletter.template` em `platform.config.json` (mas não `06-social-published.json`) → pular para auto-reporter (Etapa 4b).
- Se `05-published.json` existe mas `template_used` !== template esperado → instruir o usuário a deletar o rascunho no Beehiiv e re-rodar Etapa 4 do zero. **Verificar template ANTES de review** — não faz sentido revisar email de um rascunho com template errado.
- Se `05-published.json` existe mas `review_completed` é `false` ou ausente → Etapa 4 incompleta (newsletter parcial): pular publish-newsletter, rodar só o **loop de review-test-email** a partir do `draft_url` e `title`. Após completar, gravar `review_completed: true`. Em paralelo (se ainda não rodaram), disparar `publish-facebook` + `publish-linkedin`. Re-apresentar gate único.
- Se `04-d1-2x1.jpg` + `04-d1-1x1.jpg` + `04-d2-1x1.jpg` + `04-d3-1x1.jpg` existem (mas não `05-published.json`) → pular para Etapa 4.
- Se `02-reviewed.md` + `03-social.md` existem (mas não `04-d1-2x1.jpg`) → pular para Etapa 3 (Imagens).
- Se `02-reviewed.md` existe mas **não** `03-social.md` → Etapa 2 parcial (newsletter ok, social não rodou); re-rodar Etapa 2 com `[social]`.
- Se `_internal/01-approved.json` existe (mas não `02-reviewed.md`) → pular para Etapa 2.
- Se `_internal/01-categorized.json` existe mas não `_internal/01-approved.json` → Etapa 1 foi interrompida no gate humano; reapresentar o gate.
- Caso contrário → começar do Stage 0 normalmente.

**É IA? (paralelo)** — verificar em qualquer ponto de resume:
- Se `01-eia.md` já existe → não disparar eia-composer.
- Se `01-eia.md` **não** existe e o resume está no Stage 1 ou acima → disparar `eia-composer` em background.
- **Pré-requisito da Etapa 4:** `01-eia.md` + imagens devem existir antes de publicar. Se o eia-composer ainda não completou quando a Etapa 4 for atingida, **bloquear e aguardar** o Agent.

Se o usuário responder "sim, refazer do zero", **pedir confirmação adicional digitando o nome da edição** (`AAMMDD`) antes de prosseguir — `sim`/`yes`/`confirmar` não valem, só o literal da edição (#101). Em seguida, **renomear** (não deletar) a pasta para `{AAMMDD}-backup-{timestamp}/` antes de começar.

### 0c. Inicialização de log e cost.md

- **Log de início:** `Bash("npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level info --message 'edition run started'")`.
- **Ler flag de Drive sync.** Ler `platform.config.json` e armazenar `DRIVE_SYNC = platform.config.drive_sync` (default `true` se ausente). Se `DRIVE_SYNC = false`, informar ao usuário. Todos os blocos de sync verificam esta flag — se `false`, pular silenciosamente.
- **Pre-flight health check Drive (#121).** Se `DRIVE_SYNC = true` E não está em `test_mode`, rodar:
  ```bash
  npx tsx scripts/drive-sync.ts --health-check
  ```
  Output JSON: `{ ok: true, latency_ms }` (exit 0) ou `{ ok: false, error, remediation }` (exit 2). Se `ok: false`, alertar editor antes de prosseguir:
  > 🔐 Drive sync auth quebrada antes de iniciar a edição: {error}
  > {remediation}
  >
  > Continuar mesmo assim (sem Drive sync esta sessão) [y] ou abortar pra fix [n]?

  Se editor responder `n`, abortar. Se `y`, setar `DRIVE_SYNC = false` em sessão pra resto do pipeline.
- **Pre-flight Claude in Chrome MCP (#143, #568).** Se `test_mode = true` E `with_publish !== true`, setar `CHROME_MCP = false` diretamente (sem probe). Caso contrário (incluindo `test_mode = true` com `with_publish = true`), tentar `mcp__claude-in-chrome__tabs_context_mcp`. Setar `CHROME_MCP = true` se sucesso, `CHROME_MCP = false` se erro.
  - Se `CHROME_MCP = false`, logar warn. **Em modo interativo** (não `auto_approve` e não `test_mode`), alertar editor e aguardar `[y/n]`. **Em `auto_approve` ou `test_mode` SEM `with_publish`**, prosseguir silenciosamente.
  - **Caso especial `test_mode = true` E `with_publish = true` E `CHROME_MCP = false` (#568):** warn LOUD — imprimir bloco visível no terminal (não silenciar) e logar `level: warn` com `agent: orchestrator`, `message: "with_publish=true mas Chrome MCP indisponível — Etapa 4 vai pular"`. Editor pediu publicação explícita; merece saber que não vai acontecer. Pipeline continua mas sem Etapa 4.
  - **Na Etapa 4**: checar `CHROME_MCP`. Se `false`, gravar `05-published.json` com `status: "skipped"` e LinkedIn entries com `status: "pending_manual"`. Não falhar.
- **Inicializar `_internal/cost.md`.** Se não existe, obter timestamp via Bash e gravar:
  ```markdown
  # Cost — Edição {AAMMDD}

  Orchestrator: claude-opus-4-7
  Início: {ISO}
  Fim: —
  Total de chamadas: 0

  | Stage | Início | Fim | Chamadas | Haiku | Sonnet |
  |-------|--------|-----|----------|-------|--------|
  ```
  Se já existe (resume), não sobrescrever — manter `Início` e linhas de stages anteriores intactos.
- **Inicializar `stage-status.md` (#960).** Doc unificado de tempo + custo, atualizado incrementalmente durante o pipeline e visível no Drive. Editor abre durante runs longos pra ver progresso ao invés de esperar fim. Rodar:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ --init
  ```
  Idempotente — se já existe (resume), apenas reabre o estado anterior; não zera. Push ao Drive logo após init:
  ```bash
  npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 0 --files stage-status.md
  ```
  Falha não bloqueia (`stage-status.md` é observabilidade, não estado canônico).

  **Atualização incremental durante o pipeline:** ao **começar** cada stage (1-4), chamar:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ \
    --stage N --status running --start "{ISO_now}"
  ```
  Ao **terminar** cada stage:
  ```bash
  npx tsx scripts/update-stage-status.ts --edition-dir data/editions/{AAMMDD}/ \
    --stage N --status done --end "{ISO_now}" --duration-ms {ms} \
    [--cost-usd X] [--tokens-in N] [--tokens-out N] [--models "haiku-4-5,opus-4-7"]
  ```
  E re-push do `stage-status.md` ao Drive depois de cada update. Cost/tokens/models opcionais — campos vazios viram `-` no MD.

### 0d. Refresh automático de dedup (#895)

Rodar `scripts/refresh-dedup.ts` via Bash. O script:
- Usa a Beehiiv REST API direto (token em `BEEHIIV_API_KEY`); sem dependência de MCP ou subagente (#895 — o agent legado `refresh-dedup-runner` apontava pra UUID antigo de MCP que não existe mais; rodar inline no top-level pulava a regen do MD, regredindo #162).
- Detecta bootstrap (raw não existe) vs incremental (raw existe → busca só edições mais novas que `max(published_at)` do raw).
- **Sempre regenera `context/past-editions.md`** — mesmo com 0 novos posts (cobre o caso de `git pull` ter resetado o tracked file enquanto o raw, gitignored, ficou intacto; #162).
- Popula `links[]` resolvendo tracking URLs do Beehiiv (#234) e lendo `_internal/01-approved.json` local quando disponível (#238).
- Respeita `dedupEditionCount` do `platform.config.json`.
- Retorna JSON `{ mode, new_posts, total_in_base, most_recent_date, skipped: false, md_regenerated: true }`.
- **Se falhar (exit != 0)**, propagar o erro ao usuário e parar — não prossiga com dedup stale.

```bash
npx tsx scripts/refresh-dedup.ts
```

**Summary do dedup refresh (#314).** Após retornar, imprimir via Bash node snippet que lê `context/past-editions.md` e lista as 5 edições mais recentes (`## YYYY-MM-DD` sections). Se `new_posts > 0`, indicar `+{new_posts} nova(s)`. Como `skipped` agora é sempre `false` e o MD é sempre regenerado, indicar `no-op (MD regenerado)` quando `new_posts === 0`.

**Publicação manual (sem Stage 4 automático):** quando o editor publica diretamente no Beehiiv sem passar pela Etapa 4 do pipeline, `context/past-editions.md` não é atualizado automaticamente. Após qualquer publicação manual, rodar `/diaria-refresh-dedup` para sincronizar.

### 0e–0h. Refreshes paralelos pós-dedup (#717 hipótese 6)

Os passos **0e** (merge-local-pending), **0f** (sync-eia-used), **0g** (check-dedup-freshness) e **0h** (build-link-ctr) são todos independentes entre si — alguns dependem do output do `refresh-dedup` (passo 0d) e outros de nada — mas **nenhum depende dos outros 3**. Dispará-los como uma batelada paralela: **uma única mensagem com 4 Bash calls** (não 4 mensagens sequenciais).

Top-level Claude pode disparar múltiplas chamadas Bash em paralelo na mesma mensagem — usar isso aqui corta ~1-2min do Stage 0 sem mudar nada de comportamento. Cada um dos 4 passos abaixo retorna independentemente; processar resultados conforme retornam.

`update-audience` (passo **0i**) **DEPENDE** do output de `build-link-ctr` (data/link-ctr-table.csv). Mantém-se sequencial após 0h.

---

### 0e. Merge de edições locais pending-publish (#325)

Para evitar que URLs de edições aprovadas localmente mas ainda não publicadas no Beehiiv vazem pra edição atual:
```bash
npx tsx scripts/merge-local-pending.ts \
  --current {AAMMDD} \
  --anchor-iso {anchor_iso} \
  --editions-dir data/editions/ \
  --window-days 5 \
  --past-raw data/past-editions-raw.json
```
O script:
1. Escaneia `data/editions/*/` em busca de edições dos últimos 5 dias **a partir do `anchor_iso` (today)** que tenham `_internal/01-approved.json` mas **não** tenham `05-published.json` com `status: "published"`.
2. Extrai todas as URLs dessas edições e injeta em `context/past-editions.md` com flag `pending_publish: true`.
3. Se encontrar edições pending há > 2 dias **a partir de today**, alertar com mensagem `🟡 Edição {N} aprovada local há {D} dia(s) mas ainda draft no Beehiiv — URLs dela bloqueadas no dedup de hoje`.

**`--anchor-iso` (#863)**: A janela de pending detection é ancorada em "hoje" (data de execução), não em `edition_date`. Crítico para test mode com edição agendada no futuro — sem isso, pending legítimos da última semana saem da janela. Se omitido, default é `Date.now()` UTC.

Se o script não existir ainda (`ENOENT`) ou falhar com exit != 0 (#693): pular, mas **logar warn** explicitamente:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
  --informational \
  --message "merge-local-pending falhou ou não existe — URLs de edições pendentes podem não ter sido bloqueadas no dedup"
```

### 0f. Sync É IA? usado (#369)

Roda em paralelo com 0e/0g/0h (per nota da seção 0e–0h acima). Independente dos outros — só lê `data/editions/*/_internal/01-eia-meta.json`:
```bash
npx tsx scripts/sync-eia-used.ts --editions-dir data/editions/
```
Retorna JSON `{ scanned, added, already_present, skipped_no_meta }`. Se `added > 0`, logar `info`. Falha → logar `warn`, nunca bloqueia pipeline.

### 0g. Pre-flight de freshness do dedup (#230)

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

### 0h. Link CTR refresh

Roda em paralelo com 0e/0f/0g (per nota da seção 0e–0h acima):
```bash
npx tsx scripts/build-link-ctr.ts
```
Regenera `data/link-ctr-table.csv` com CTR por link de todas as edições publicadas há mais de 7 dias. Resultado silencioso — logar apenas se falhar (`level: warn`, não aborta pipeline).

### 0i. Audience profile refresh

Sequencial — **depende de 0h** (consome `data/link-ctr-table.csv`). Aguardar 0h completar antes de disparar:
```bash
npx tsx scripts/update-audience.ts
```
Regenera `context/audience-profile.md` combinando CTR comportamental (`data/link-ctr-table.csv`, primário) e survey declarativo (`data/audience-raw.json`, secundário). Resultado silencioso — logar apenas se falhar (`level: warn`, não aborta pipeline). Survey data é atualizada manualmente via `/diaria-atualiza-audiencia`.

### 0j. Pending issue drafts (#90)

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

### 0k. Verify FB posts da edição anterior (#78)

Sempre roda, silencioso. Reconcilia posts Facebook agendados da edição anterior (status `scheduled` → `published`/`failed` via Graph API):
```bash
PREV=$(npx tsx scripts/find-last-edition-with-fb.ts --current {AAMMDD})
if [ -n "$PREV" ] && [ -f "data/.fb-credentials.json" ]; then
  npx tsx scripts/verify-facebook-posts.ts --edition-dir "$PREV/" || echo "verify-fb failed (non-fatal)"
fi
```
Não bloqueia — se credenciais FB não existem ou nenhuma edição anterior tem `06-social-published.json`, logar `warn` e seguir.

### 0l. Verificação pré-edição de posts da edição anterior (#366)

Sempre roda, após Verify FB. Busca `06-social-published.json` da edição mais recente (Glob `data/editions/*/06-social-published.json`; pegar o mais recente por nome de pasta sort alfanumérico desc):
```bash
PREV_SOCIAL=$(node -e "
  const fs=require('fs');
  const dirs=fs.readdirSync('data/editions').filter(d=>/^\d{6}$/.test(d)).sort().reverse();
  const found=dirs.find(d=>fs.existsSync('data/editions/'+d+'/06-social-published.json'));
  process.stdout.write(found?'data/editions/'+found+'/06-social-published.json':'');
")
```
Se o arquivo existir:
1. Posts com `status === "scheduled"` e `scheduled_at < now` (prazo passou): alertar editor com a lista.
2. Posts com `status === "failed"`: alertar editor com a lista.
3. Tudo ok ou arquivo não existe: silencioso.
Não bloqueia — alertas são informativos para o editor resolver antes de começar a nova edição.

**Importante (#565):** ao logar esses alertas via `scripts/log-event.ts`, **incluir flag `--informational`** pra evitar que o auto-reporter promova esses warns a issues GitHub falsas. Exemplo:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn \
  --informational \
  --message "edição anterior {PREV} tem N posts FB com status=failed" \
  --details '{"prev_edition":"{PREV}","failed_count":N}'
```
A flag injeta `informational: true` em `details` — `collect-edition-signals.ts` filtra por essa flag estruturada em vez do tag textual `(informativo)` no message (que era frágil).

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

### 0p. Sorteio — drain + gate batch (#929)

Drena respostas pendentes do concurso "ache o erro, ganhe um número" antes de Stage 1. Roda toda invocação de `/diaria-edicao` ou `/diaria-1-pesquisa`. Sem isso, respostas ficam dependentes da disciplina manual (`/diaria-sorteio` standalone — fácil de esquecer).

**Falha em qualquer step = warning, NUNCA bloqueia Stage 1.** Sorteio é nice-to-have. Edição prossegue mesmo se Gmail offline ou classifier falhar.

**Skip silencioso** se `mcp__claude_ai_Gmail` está offline (sintoma: `0n` puxou skip por mesmo motivo) ou se `auto_approve = true` (sem editor pra confirmar gate batch). Logar `info "0p skipped: {reason}"`.

#### Etapa 1 — Buscar threads pendentes via Gmail MCP

Cutoff = data de publicação da **primeira edição do mês corrente** (BRT). Se ainda não há edição publicada no mês, fallback pra primeiro dia do mês. Use o script:

```bash
CUTOFF=$(npx tsx scripts/sorteio-cutoff.ts)  # ex: "2026/05/04"
```

Output formato `YYYY/MM/DD`. Idempotência via `findByThreadId` em `data/contest-entries.jsonl` cobre threads já processadas — não precisa cutoff incremental.

Por que essa janela: respostas de leitores ao sorteio do mês N+1 chegam ao longo do mês N (após cada edição publicada). Cutoff fixo no início do mês garante que threads não escapem por race entre processamento e publicação. Idempotência via thread_id evita reprocessar.

Usar `mcp__claude_ai_Gmail__search_threads` com query `"diaria@mail.beehiiv.com" -from:vjpixel after:{cutoff_yyyy_mm_dd}`. Limit 20 threads. Se Gmail retornar erro: skip silencioso (logar warn).

**Por que essa query** (lição da #852, validada 2026-05-07): respostas de leitores ao sorteio chegam direto em `vjpixel@gmail.com` (Beehiiv usa Reply-To pra editor pessoal), **sem label nenhum**. A query antiga `label:Diar.ia` retornava 0 threads silenciosamente. A query nova procura threads onde a edição da Beehiiv (`diaria@mail.beehiiv.com`) aparece e exclui mensagens enviadas pelo próprio editor, pegando apenas replies de leitores.

Pra cada thread, chamar `mcp__claude_ai_Gmail__get_thread` (formato `FULL_CONTENT`). Filtrar threads onde a única mensagem é do `diaria@mail.beehiiv.com` (a newsletter original, sem reply de leitor) — pular silenciosamente. Para threads com reply real: extrair `thread_id`, `sender_email`, `sender_name`, `subject`, `body` (concatenar messages do leitor — não da resposta nem da newsletter original), `received_iso`. Montar JSON array `RawThread[]` (ver schema em `scripts/sorteio-classify.ts`).

#### Etapa 2 — Classificar via helper TS

```bash
echo '<RAW_THREADS_JSON>' | npx tsx scripts/sorteio-classify.ts \
  --output data/editions/{AAMMDD}/_internal/sorteio-pending.json
```

Output JSON: `{ generated_at, total_input, already_processed, skipped_invalid, candidates[] }`. Cada candidate tem `recommendation` ∈ `APPROVE` | `REJECT` | `REVIEW` + `reason`.

Se `candidates.length === 0`: skip silencioso (todas processadas ou input vazio). Logar `info`.

**Observabilidade do guard (#951)**: se `skipped_invalid > 0`, logar warn pra auto-reporter pegar (sinaliza que o guard `isValidRawThread` filtrou threads — pode indicar regressão no filtro upstream do orchestrator):

```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent sorteio-classify --level warn \
  --message "sorteio_classify_skipped_invalid" \
  --details '{"skipped_invalid":N,"total_input":M}'
```

Se `skipped_invalid === 0`, não logar nada (caminho normal).

#### Etapa 3 — Apresentar gate batch ao editor

```
🎯 Sorteio — N respostas pendentes:

  [1] {sender_name} <{sender_email}>
      Edição: {edition_guessed} (relativa: "ontem"/"anteontem"/...)
      Match: {hit/miss/unclear emoji} "{body_excerpt}"
      Recommendation: {APPROVE/REJECT/REVIEW} ({reason})

  [2] ...

Default: APPROVE para [1], REJECT para [2], SKIP para [3].
Editor confirma com:
  - Enter: aplica defaults
  - "all approve" / "all skip" / "all reject"
  - "1,3 approve; 2 reject"
  - "skip all"
```

Aguardar resposta. **Defaults** vêm do `recommendation` do classifier — APPROVE → approve, REJECT → reject, REVIEW → skip (humano valida ações sociais — regra #573, e ambíguo merece segunda chance na próxima rodada).

#### Etapa 4 — Aplicar decisões em batch

Construir `decisions.json` no formato:
```json
[
  {
    "thread_id": "...",
    "action": "approve",
    "month": "2026-06",
    "email": "...",
    "name": "...",
    "edition": "260507",
    "error_type": "version_inconsistency",
    "detail": "..."
  },
  { "thread_id": "...", "action": "reject" }
]
```

Para `month` (mês do sorteio): default = mês seguinte ao `received_iso` da thread (sorteio mensal). Em caso de dúvida, perguntar ao editor.

```bash
npx tsx scripts/sorteio-process.ts batch-add \
  --decisions data/editions/{AAMMDD}/_internal/sorteio-decisions.json \
  --output data/editions/{AAMMDD}/_internal/sorteio-results.json
```

Output: `{ summary, results[] }`. Pra cada `result.status === "approved"` com `reply_text`, criar draft no Gmail:

```
mcp__claude_ai_Gmail__create_draft({
  thread_id: result.thread_id,
  body: result.reply_text,
  subject: "Re: {subject_original}"
})
```

Sumário ao editor:
```
Sorteio: {summary.approved} aprovada(s) (#a, #b, ...), {summary.rejected} rejeitada(s), {summary.skipped} skipada(s). Drafts criados: {N}.
```

Logar via `scripts/log-event.ts` com `level: info` + `details: summary`.

### 0m. Auto-reporter — preparado pra rodar no final

Após a Etapa 4 (publicação paralela) completar, orchestrator deve disparar `collect-edition-signals.ts` + `auto-reporter` agent pra transformar sinais da edição em issues GitHub acionáveis. Detalhes completos no arquivo `orchestrator-stage-4.md` (seção "Etapa 4b — Auto-reporter").

### 0z. Pre-flight invariants (#1007 Fase 1)

Última verificação antes de gastar tokens na pesquisa. Valida env vars críticas (BEEHIIV_API_KEY, Drive credentials, past-editions-raw shape):

```bash
npx tsx scripts/check-invariants.ts --stage 0
```

Exit 1 = abort imediato com violations no stderr. Editor corrige (env, credentials) e re-roda. Esses checks são baratos (<1s) e evitam falhas tardias caras (Stage 4 sem `LINKEDIN_WORKER_URL`, etc — verificado novamente lá).

---

## Stage 1 — Research

