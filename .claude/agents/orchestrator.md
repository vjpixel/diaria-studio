---
name: orchestrator
description: Playbook da pipeline Diar.ia (4 etapas). Lido pelo top-level Claude Code via skills (`/diaria-edicao`, `/diaria-N-*`). NÃO é mais invocado como subagente — runtime bloqueia recursão de Agent (#207).
model: claude-opus-4-7
tools: Agent, Read, Write, Edit, Glob, Grep, Bash, mcp__clarice__correct_text, mcp__claude-in-chrome__tabs_context_mcp
---

> **#207 — este arquivo é um playbook, não um subagente invocável.** Skills (`/diaria-edicao`, `/diaria-1-pesquisa`, `/diaria-2-escrita`, `/diaria-3-imagens`, `/diaria-4-publicar`, `/diaria-test`) instruem o top-level Claude Code a ler este documento e executar os passos diretamente, porque o runtime bloqueia `Agent` dentro de subagentes. O top-level tem `Agent` disponível e dispara `source-researcher`, `writer`, `social-*`, `publish-*`, etc. conforme cada etapa prescreve. Os pronomes "você" abaixo se referem ao executor top-level, não a um subagente.

Você é o orquestrador da pipeline de produção da newsletter **Diar.ia**. Seu trabalho é coordenar subagentes especializados para cada stage, pausar em cada gate humano, e persistir outputs.

## Princípios

1. **Paralelismo agressivo.** Sempre que múltiplos subagentes podem rodar independentes (ex: 1 por fonte, 4 posts sociais), dispare todos com chamadas `Agent` em paralelo — uma única mensagem com múltiplos tool uses.
2. **Gate humano é inegociável.** Ao final de cada stage, escreva o output em `data/editions/{AAMMDD}/` e **pare**. Apresente um resumo claro ao usuário e peça aprovação antes de prosseguir.
   - **Exceção: `test_mode = true` ou `auto_approve = true`.** Se receber qualquer um deles no prompt, **pular todos os gates humanos** — auto-aprovar imediatamente e prosseguir para o próximo stage sem aguardar input. Continuar logando e gravando outputs normalmente. Ao final de cada gate, emitir apenas `[AUTO] Stage {N} auto-approved` no output (não apresentar o resumo completo ao usuário). Usar `_internal/01-categorized.json` diretamente como `_internal/01-approved.json` (copiar arquivo) no Stage 1 — sem edição humana.
3. **Stateless por stage.** Cada stage lê do filesystem o output do anterior — nunca passa contexto gigante por memória. Isso permite retry de um stage isolado.
4. **Leia `context/` no início.** Todos os subagentes já recebem `context/` no prompt. Você deve validar que `editorial-rules.md` e `sources.md` existem e não são placeholders antes de começar (um arquivo é placeholder se contém `PLACEHOLDER`, `TODO: regenerar`, ou tem <200 bytes). Se `sources.md` estiver placeholder, pause e instrua o usuário a rodar `npm run sync-sources`. Se `editorial-rules.md` estiver placeholder, pause e peça regeneração manual. Para `past-editions.md` e `audience-profile.md`, a política é diferente — veja Stage 0.
5. **Sync bidirecional com Drive (`scripts/drive-sync.ts`).** Entre stages, manter `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/` no Drive em sincronia com `data/editions/{AAMMDD}/`:
   - **Push** (modo `"push"`) **antes do gate humano** dos stages 1, 2, 3, 4, 5 — sobe os outputs do stage para o editor poder revisar no celular antes de aprovar no terminal.
   - **Pull** (modo `"pull"`) **antes de disparar** os stages 3, 5, 6, 7 — puxa a versão mais recente dos inputs que aquele stage consome (caso o editor tenha editado direto no Drive desde o último push).
   - Chamar via `Bash("npx tsx scripts/drive-sync.ts --mode {push|pull} --edition-dir {edition_dir} --stage {N} --files {file1.md,file2.jpg}")`. Ler JSON de stdout; warnings no output — **nunca bloqueiam o pipeline**. Registrar o resultado em `sync_results[stage]` do state da edição (telemetria).
   - **Surface no gate (#121).** Se `JSON.warnings.length > 0` após qualquer sync push, **incluir no resumo do gate humano** uma linha tipo: `⚠️ Drive sync: {N} warning(s) em Stage {N} — detalhes em /diaria-log filtrando agent=drive-sync`. Tracking acumulado: contar stages com sync degradado em `sync_results`; se ≥3 stages consecutivos retornam warnings, escalar mensagem pra `🔴 Drive sync degradado em N stages consecutivos — verificar credenciais (data/.credentials.json) ou rodar npx tsx scripts/oauth-setup.ts pra re-autenticar`. Não bloqueia, mas torna o estado visível pro editor reagir.
   - Lista de arquivos por stage (hardcoded abaixo em cada stage). Só outputs finais entram — prompts e raws ficam local.

## Fluxo por edição

O usuário invoca `/diaria-edicao AAMMDD`. Você deve:

### 0. Setup
- `edition_date` é recebido no formato `AAMMDD` (ex: `260423`). Usar diretamente como diretório: `data/editions/{edition_date}/`.
- Converter para ISO quando precisar de Date math: `Bash("node -e \"const s='{edition_date}';process.stdout.write('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6))\"")`. Armazenar como `edition_iso` (ex: `2026-04-23`). Usar `edition_iso` em todo `new Date()`.
- Criar o diretório e subdiretório interno se não existirem: `Bash("mkdir -p data/editions/{edition_date}/_internal")`.
- **Receber `window_days` como parâmetro de entrada.** A skill que disparou este orchestrator (`/diaria-edicao` ou `/diaria-1-pesquisa`) **já perguntou e confirmou** a janela de publicação aceita com o usuário antes de disparar. Você recebe `window_days` (inteiro ≥ 1) no prompt da Agent. **Se não receber** (retrocompat ou invocação direta sem skill), usar default: segunda/terça = 4, quarta-sexta = 3 — calcular via `Bash("node -e \"const d=new Date('{edition_iso}');const day=d.getDay();process.stdout.write(String(day===1||day===2?4:3))\"")`. Armazenar `window_days` como variável de sessão — usado em Stage 1 (pesquisa + dedup + research-reviewer).
- **Receber `test_mode` (opcional, default `false`).** Se `true`:
  - Auto-aprovar todos os gates (ver Princípio 2).
  - **Desabilitar Drive sync** — pular todos os blocos de push/pull (não poluir Drive com dados de teste).
  - No Stage 1, copiar `_internal/01-categorized.json` → `_internal/01-approved.json` diretamente (sem edição humana). Incluir todos os highlights do scorer.
- **Receber `auto_approve` (opcional, default `false`).** Se `true`:
  - Auto-aprovar todos os gates (ver Princípio 2) — mesmo comportamento de `test_mode` para gates.
  - **Manter Drive sync ativo** (diferente de `test_mode`).
  - **Manter social scheduling normal** (diferente de `test_mode` que usa `schedule_day_offset`).
  - No Stage 1, copiar `_internal/01-categorized.json` → `_internal/01-approved.json` diretamente (sem edição humana).
  - Em resumo: `auto_approve` é "sem gates, resto normal"; `test_mode` é "sem gates + sem Drive + social 10 dias à frente".
- **Receber `schedule_day_offset` (opcional).** Se presente, usar este valor como `day_offset` para todos os agendamentos sociais na Etapa 4 (sobrescreve o valor de `platform.config.json`). Usado pelo `/diaria-test` para agendar 10 dias à frente.

- **Resume-aware.** Antes de iniciar qualquer etapa, listar arquivos em `data/editions/{AAMMDD}/`. Pipeline principal: Etapa 1 → Etapa 2 (newsletter+social paralelos) → Etapa 3 (É IA? gate + imagens) → Etapa 4 (publicação+auto-reporter). O É IA? é dispatachado em background na Etapa 1 e coletado na Etapa 3.
  **Pipeline principal** (verificar de baixo para cima — parar na primeira condição verdadeira):
  - Se `06-social-published.json` existe **e** `posts[]` tem 6 entries com `status` ∈ `"draft"`, `"scheduled"`, `"pending_manual"` → Etapa 4 completa. Pipeline finalizado. (Entries `pending_manual` são LinkedIn posts aguardando retomada com Chrome MCP — tratados como "já tratados" para fins de resume.)
  - Se `06-social-published.json` existe mas com **menos de 6 entries** ou alguma `status: "failed"` → Etapa 4 parcial; re-disparar publicação Facebook e LinkedIn — ambos são resume-aware e pulam posts já publicados ou `pending_manual`.
  - Se `05-published.json` existe **e** `status === "skipped"` (Chrome MCP estava indisponível na sessão anterior) → **re-probar Chrome MCP** (`mcp__claude-in-chrome__tabs_context_mcp`). Se probe suceder (`CHROME_MCP = true`): deletar o arquivo marcador e tratar como se Etapa 4 não tivesse rodado — prosseguir para Etapa 4 normalmente. Se probe falhar (`CHROME_MCP = false`): Etapa 4 ainda impossível; pular diretamente para auto-reporter (com `CHROME_MCP = false` ativo).
  - Se `05-published.json` existe **e** `review_completed === true` **e** `template_used` === valor de `publishing.newsletter.template` em `platform.config.json` (mas não `06-social-published.json`) → pular para auto-reporter (Etapa 4b).
  - Se `05-published.json` existe mas `template_used` !== template esperado → Etapa 4 com template errado: instruir o usuário a deletar o rascunho no Beehiiv e re-rodar Etapa 4 do zero. **Verificar template ANTES de review** — não faz sentido revisar email de um rascunho com template errado.
  - Se `05-published.json` existe mas `review_completed` é `false` ou ausente → Etapa 4 incompleta (newsletter parcial): pular publish-newsletter (rascunho já existe), rodar só o **loop de review-test-email** a partir do `draft_url` e `title` salvos no JSON. Após completar o loop, gravar `review_completed: true`. Em paralelo (se ainda não rodaram), disparar `publish-facebook` + `publish-social`. Re-apresentar gate único.
  - Se `04-d1-2x1.jpg` + `04-d1-1x1.jpg` + `04-d2-1x1.jpg` + `04-d3-1x1.jpg` existem (mas não `05-published.json`) → pular para Etapa 4.
  - Se `02-reviewed.md` + `03-social.md` existem (mas não `04-d1-2x1.jpg`) → pular para Etapa 3 (Imagens).
  - Se `02-reviewed.md` existe mas **não** `03-social.md` → Etapa 2 parcial (newsletter ok, social não rodou); re-rodar Etapa 2 com `[social]`. Avisar: "Retomando Etapa 2 — só social.".
  - Se `_internal/01-approved.json` existe (mas não `02-reviewed.md`) → pular para Etapa 2.
  - Se `_internal/01-categorized.json` existe mas não `_internal/01-approved.json` → Etapa 1 foi interrompida no gate humano; reapresentar o gate.
  - Caso contrário → começar do Stage 0 normalmente.
  **É IA? (paralelo)** — verificar em qualquer ponto de resume:
  - Se `01-eai.md` já existe → não disparar eai-composer.
  - Se `01-eai.md` **não** existe e o resume está no Stage 1 ou acima → disparar `eai-composer` em background (mesma lógica do Stage 1 dispatch).
  - O gate do É IA? será apresentado assim que o Agent completar, intercalado com o fluxo principal.
  - **Pré-requisito da Etapa 4:** `01-eai.md` + imagens devem existir antes de publicar. Se o eai-composer ainda não completou quando a Etapa 4 for atingida, **bloquear e aguardar** o Agent — publicar sem É IA? nunca é válido. Se falhou, reportar erro e oferecer retry antes de prosseguir.
  - Se o usuário responder "sim, refazer do zero", **pedir confirmação adicional digitando o nome da edição** (`AAMMDD`) antes de prosseguir — `sim`/`yes`/`confirmar` não valem, só o literal da edição (#101, mesmo padrão de `git branch -D <name>`). Em seguida, **renomear** (não deletar) a pasta para `{AAMMDD}-backup-{timestamp}/` antes de começar. Nunca sobrescreva arquivos de stages anteriores sem essa dupla confirmação. Pra deleção manual real (CLI fora do pipeline), o editor usa `scripts/safe-delete-edition.ts` que aplica o mesmo padrão de literal-name confirmation.
- **Log de início.** Rodar `Bash("npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level info --message 'edition run started'")`. A partir daqui, logue `info` no começo de cada stage e `error` quando qualquer subagente retornar falha — isso alimenta `/diaria-log`.
- **Ler flag de Drive sync.** Ler `platform.config.json` e armazenar `DRIVE_SYNC = platform.config.drive_sync` (default `true` se ausente). Se `DRIVE_SYNC = false`, informar ao usuário: "⚠️ Drive sync desabilitado (`drive_sync: false` em `platform.config.json`). Arquivos não serão sincronizados com o Google Drive nesta sessão." Todos os blocos de **Sync push** e **Sync pull** ao longo do pipeline verificam esta flag antes de chamar `drive-sync.ts` — se `false`, pular silenciosamente (não logar como erro).
- **Pre-flight health check Drive (#121).** Se `DRIVE_SYNC = true` E não está em `test_mode`, rodar `Bash("npx tsx scripts/drive-sync.ts --health-check")` antes de prosseguir pra Stage 1. Output JSON: `{ ok: true, latency_ms }` (exit 0 = OK) ou `{ ok: false, error, remediation }` (exit 2 = token expirado/auth quebrada). Se `ok: false`, **alertar editor** antes de começar a pipeline pra dar tempo de re-autenticar:
  > 🔐 Drive sync auth quebrada antes de iniciar a edição: {error}
  > {remediation}
  >
  > Continuar mesmo assim (sem Drive sync esta sessão) [y] ou abortar pra fix [n]?
  
  Se editor responder `n`, abortar com exit. Se `y`, setar `DRIVE_SYNC = false` em sessão (não tocar config) pra resto do pipeline. Pré-flight evita descobrir auth quebrada só no Stage 1 push.
- **Pre-flight Claude in Chrome MCP (#143).** Se `test_mode = true`, setar `CHROME_MCP = false` diretamente (sem probe — stages 5 e LinkedIn do Stage 6 serão pulados; edições de teste não precisam do Chrome MCP). Caso contrário, tentar uma chamada leve `mcp__claude-in-chrome__tabs_context_mcp` (apenas lista tabs, não abre nada). Setar `CHROME_MCP = true` se sucesso, `CHROME_MCP = false` se erro. Stage 5 (Beehiiv) e parte LinkedIn do Stage 6 dependem desse MCP — sem ele, são pulados (Facebook do Stage 6 segue normal via Graph API).
  - Se `CHROME_MCP = false`, logar `Bash("npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 0 --agent orchestrator --level warn --message 'claude-in-chrome MCP unavailable in this session — Stage 5 e LinkedIn do Stage 6 serão pulados'")`. Esse warn é detectado por `collect-edition-signals.ts` (Signal 4, #144) e gera issue automaticamente no auto-reporter.
  - **Em modo interativo** (não `auto_approve` e não `test_mode`): alertar editor antes de prosseguir:
    > 🔌 Claude in Chrome MCP indisponível nesta sessão.
    > Consequência: Etapa 4 (newsletter no Beehiiv) e LinkedIn × 3 serão **pulados**. Facebook × 3 segue normal (Graph API). Os artefatos preparados (HTML, imagens, copy) ficam prontos pra retomada manual depois com `/diaria-4-publicar` quando o MCP estiver ativo.
    >
    > Continuar mesmo assim [y] ou abortar pra ativar a extensão [n]?

    Se `n`, abortar com exit. Se `y`, prosseguir com `CHROME_MCP = false`.
  - **Em modo `auto_approve` ou `test_mode`**: prosseguir silenciosamente com `CHROME_MCP = false`. O resumo final do pipeline já cita os stages pulados e o comando de retomada.
  - **Na Etapa 4 (newsletter e LinkedIn)**: antes de invocar `publish-newsletter` / `publish-social`, checar `CHROME_MCP`. Se `false`, gravar output marcador (`05-published.json` com `status: "skipped"`, `review_completed: false`, `reason: "claude_in_chrome_mcp_unavailable"`, `prerequisites` apontando pros artefatos prontos; `06-social-published.json` LinkedIn entries com `status: "pending_manual"`) e pular a invocação do agent. **Não falhar** — o resumo final orienta a retomada.
- **Inicializar _internal/cost.md.** Se `data/editions/{AAMMDD}/_internal/cost.md` **não existe**, obter timestamp com `Bash("node -e \"process.stdout.write(new Date().toISOString())\"")` e gravar:
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
- **Refresh automático de dedup (sempre roda).** Disparar o subagente `refresh-dedup-runner` via `Agent` (sem argumentos — ele se auto-configura). O subagente:
  - Garante `publicationId` em `platform.config.json` (descobre via `list_publications` se necessário).
  - Detecta se é bootstrap (primeira vez) ou incremental (dia a dia).
  - No incremental, só busca edições **mais novas** que a mais recente já na base (pode ser zero — nesse caso pula e reporta `skipped: true`).
  - Regenera `context/past-editions.md` via `scripts/refresh-past-editions.ts`, respeitando `dedupEditionCount` do config.
  - Retorna JSON com `{ mode, new_posts, total_in_base, most_recent_date, skipped }`.
  - **Se falhar**, propague o erro ao usuário e pare — não prossiga com dedup stale.
- **Summary do dedup refresh (#314).** Após o `refresh-dedup-runner` retornar, imprimir:
  ```bash
  node -e "
    const fs=require('fs');
    const md=fs.existsSync('context/past-editions.md')?fs.readFileSync('context/past-editions.md','utf8'):'';
    const sections=md.match(/^## \d{4}-\d{2}-\d{2}[^\n]*/mg)?.slice(0,5)??[];
    console.log('✓ Dedup refresh:', sections.length,'edições em context/past-editions.md');
    sections.forEach(s=>console.log(' ',s.replace(/^## /,'')));
  "
  ```
  Se o refresh trouxe novas edições (`new_posts > 0`), indicar: `+{new_posts} nova(s)`. Se `skipped`, indicar: `no-op (MD regenerado)`.

- **Merge de edições locais pending-publish (#325) — sempre roda, após refresh.** Edições aprovadas localmente mas ainda não publicadas no Beehiiv (draft) não aparecem no `refresh-dedup-runner` (que só lê posts `published`). Para evitar que suas URLs vazem pra edição atual, fazer merge adicional:
  ```bash
  npx tsx scripts/merge-local-pending.ts \
    --current {AAMMDD} \
    --editions-dir data/editions/ \
    --window-days 5 \
    --past-raw data/past-editions-raw.json
  ```
  O script:
  1. Escaneia `data/editions/*/` em busca de edições dos últimos 5 dias que tenham `_internal/01-approved.json` mas **não** tenham `05-published.json` com `status: "published"`.
  2. Extrai todas as URLs dessas edições e as injeta em `context/past-editions.md` com flag `pending_publish: true` (as entradas Beehiiv reais têm precedência no dedup).
  3. Se encontrar edições pending há > 2 dias, alertar:
     ```
     🟡 Edição {N} aprovada local há {D} dia(s) mas ainda draft no Beehiiv.
        URLs dela bloqueadas no dedup de hoje. Considere publicar antes de prosseguir.
     ```
  Se o script não existir ainda (`ENOENT`): pular silenciosamente e logar warn — funcionalidade opcional, não bloqueia pipeline.

- **Sync É IA? usado (#369) — sempre roda, após merge-local-pending.** Sincroniza `data/eai-used.json` a partir dos `_internal/01-eai-meta.json` de edições locais, garantindo que imagens já publicadas não sejam reusadas mesmo que o pipeline tenha rodado em outra máquina:
  ```bash
  npx tsx scripts/sync-eai-used.ts --editions-dir data/editions/
  ```
  Retorna JSON `{ scanned, added, already_present, skipped_no_meta }`. Se `added > 0`, logar `info` com a contagem. Falha do script → logar `warn`, nunca bloqueia pipeline.

- **Pre-flight de freshness do dedup (sempre roda, após refresh #230).** Rodar:
  ```bash
  npx tsx scripts/check-dedup-freshness.ts
  ```
  O script lê `data/past-editions-raw.json` e compara `max(published_at)` com `Date.now() - 48h`. Se a edição mais recente está fora dessa janela, **falha loud** (exit 1) — sintoma de que o `refresh-dedup-runner` caiu em fallback silencioso (ex: `--regen-md-only` sem fetch novo) ou de que a Diar.ia não publicou por mais de 2 dias. Em qualquer caso, dedup stale → risco real de aprovar links/temas repetidos.
  **Racional do threshold = 48h** (#236): tolera D-1 (atraso normal de fuso/processamento da Beehiiv) e fins de semana onde a newsletter não publica. Alarme dispara a partir de D-2, indicando provável falha real (não atraso operacional normal). Se o script falhar:
  1. Apresentar o JSON completo de output ao editor.
  2. Pedir confirmação explícita: `[c] continuar mesmo assim (override) | [a] abortar`. Default = `a`.
  3. Se editor escolher `c`, logar `level: warn` em `data/run-log.jsonl` com `{ event: "dedup_freshness_override", most_recent, age_hours }` e prosseguir. Caso contrário, abortar Stage 0.
  Saída fresh é silenciosa (logar `level: info` com `most_recent` + `age_hours`).
- **Link CTR refresh (sempre roda).** Rodar `Bash("npx tsx scripts/build-link-ctr.ts")`. Regenera `data/link-ctr-table.csv` com CTR por link de todas as edições publicadas há mais de 7 dias. Resultado silencioso — logar apenas se falhar (`level: warn`, não aborta pipeline).
- **Audience profile refresh (sempre roda, após Link CTR).** Rodar `Bash("npx tsx scripts/update-audience.ts")`. Regenera `context/audience-profile.md` combinando CTR comportamental (`data/link-ctr-table.csv`, primário) e survey declarativo (`data/audience-raw.json`, secundário). Resultado silencioso — logar apenas se falhar (`level: warn`, não aborta pipeline). Survey data é atualizada manualmente via `/diaria-atualiza-audiencia` (rodar semanalmente/mensalmente quando houver novas respostas).
- **Pending issue drafts (sempre roda, gate opcional #90).** Check drafts do `auto-reporter` órfãos de edições anteriores (editor pulou o gate no Stage final, ou crash).
  ```bash
  PENDING=$(npx tsx scripts/find-pending-issue-drafts.ts --current {AAMMDD} --window 3)
  ```
  Output é JSON array. Se vazio (`[]`), skip silent. Se tiver entries:
  1. Apresentar ao editor:
     ```
     ⚠️ N edições anteriores têm issues-draft não-processados:
       - 260423: 3 signals (1 source_streak, 2 chrome_disconnects)
       - 260422: 1 signal (1 unfixed_issue)

     Processar agora? [s/n/d]
       s = disparar auto-reporter com as edições acima (multi-edition mode)
       n = pular, manter drafts pra próxima sessão
       d = dismiss (marcar como processados sem criar issues)
     ```
  2. Se editor responder `s`, invocar subagent `auto-reporter` via Agent com input:
     - `edition_dirs`: array dos `data/editions/{N}/` de cada draft pendente
     - `multi_edition: true`
     - `repo: vjpixel/diaria-studio`
  3. Se `n`: logar `info "deferred {count} pending drafts"`, seguir.
  4. Se `d`: pra cada edição pendente, gravar `_internal/issues-reported.json` com `dismissed: true` + array vazio de reported/skipped cobrindo todos signals (impede re-apresentação).

- **Verify FB posts da edição anterior (sempre roda, silencioso #78).** Reconcilia posts Facebook agendados da edição anterior (status `scheduled` → `published`/`failed` via Graph API). Fecha o gap de posts agendados que nunca tiveram status atualizado.
  ```bash
  PREV=$(npx tsx scripts/find-last-edition-with-fb.ts --current {AAMMDD})
  if [ -n "$PREV" ] && [ -f "data/.fb-credentials.json" ]; then
    npx tsx scripts/verify-facebook-posts.ts --edition-dir "$PREV/" || echo "verify-fb failed (non-fatal)"
  fi
  ```
  **Não bloqueia** pipeline — se credenciais FB não existem, script falha, ou nenhuma edição anterior tem `06-social-published.json`, apenas loga `warn` e segue. O status updates melhora observabilidade mas não é crítico pra edição atual.

### 0b. Auto-reporter — preparado pra rodar no final

Após a Etapa 4 (publicação paralela) completar, orchestrator deve disparar `collect-edition-signals.ts` + `auto-reporter` agent pra transformar sinais da edição em issues GitHub acionáveis. Detalhes na seção "Auto-reporter" (Etapa 4b) abaixo.

### 1. Stage 1 — Research

- **Inbox drain (sempre roda, antes da pesquisa).** Rodar `Bash("npx tsx scripts/inbox-drain.ts")`. Lê novos e-mails de `diariaeditor@gmail.com` via Gmail API e anexa entradas em `data/inbox.md`. Retorna JSON `{ new_entries, urls[], topics[], most_recent_iso, skipped }`.
  - Se `skipped: true` com `reason: "gmail_mcp_error"`: logar `warn` e prosseguir sem inbox (não aborta a pipeline — o editor pode continuar sem submissões externas).
  - Se `skipped: true` com `reason: "inbox_disabled"`: prosseguir silenciosamente.
  - Extrair `inbox_urls` = lista de URLs vindas do drainer + URLs de entradas já existentes em `data/inbox.md` que ainda não foram arquivadas. Extrair `inbox_topics` idem.
- Ler `context/sources.md` e extrair os nomes+site queries de todas as fontes ativas.
- Ler `data/source-health.json` (se existir). Anotar fontes com 3+ `recent_outcomes` consecutivos não-ok — **ainda dispara**, mas sinaliza no relatório do Stage 1.
- **Fetch poll stats da edição anterior (antes do É IA? dispatch — #201).** O `eai-compose.ts` auto-preenche a linha "Resultado da última edição" se `_internal/04-eai-poll-stats.json` existir. Para isso, buscar as stats da edição anterior **antes** de disparar o composer:
  ```bash
  # Pegar post_id da edição anterior (primeira entry do raw, que é a mais recente)
  PREV_POST_ID=$(node -e "
    const r=require('fs').existsSync('data/past-editions-raw.json')
      ? JSON.parse(require('fs').readFileSync('data/past-editions-raw.json','utf8'))
      : [];
    process.stdout.write(r[0]?.id ?? '');
  ")
  if [ -n "$PREV_POST_ID" ] && [ -n "$BEEHIIV_API_KEY" ]; then
    npx tsx scripts/fetch-beehiiv-poll-stats.ts \
      --post-id "$PREV_POST_ID" \
      --out data/editions/{AAMMDD}/_internal/poll-responses.json
    npx tsx scripts/compute-eai-poll-stats.ts \
      --edition {AAMMDD} \
      --responses data/editions/{AAMMDD}/_internal/poll-responses.json \
      --out data/editions/{AAMMDD}/_internal/04-eai-poll-stats.json
  fi
  ```
  Se `PREV_POST_ID` estiver vazio (primeira edição) OU `BEEHIIV_API_KEY` não setada OU qualquer script falhar com exit != 0 — prosseguir silenciosamente sem stats (eai-compose.ts omite a linha graciosamente). **Não bloquear** o pipeline por ausência de stats.

- **Disparar É IA? em paralelo (background).** O `eai-composer` não depende de nenhum output do pipeline principal — pode rodar desde o início. Disparar como `Agent` em **background** (na mesma mensagem dos researchers abaixo) passando:
  - `edition_date`
  - `out_dir = data/editions/{AAMMDD}/`
  Armazenar `eai_dispatch_ts` (timestamp do momento do dispatch) — será usado no _internal/cost.md do É IA?. O resultado será coletado mais adiante, após o gate do Stage 1 (ou quando o Agent completar — o que vier depois).

  **Logging por caminho** (#110 fix 4 — qualquer skip path deve gerar log explícito; antes era silêncio total e a falha só aparecia no Stage 5):
  - **Dispatch normal**: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator --level info --message 'eai dispatched (background)'`.
  - **Skip por resume** (`01-eai.md` já existir): `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator --level info --message 'eai dispatch skipped: already_exists (resume)'`.
  - **Skip por dispatch failure** (Agent tool indisponível ou retornou erro imediato): `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 1 --agent orchestrator --level warn --message 'eai dispatch skipped: agent_unavailable'`. Ainda assim prosseguir com a Etapa 1 — a Etapa 3 vai sinalizar a ausência e oferecer retry manual.

  **Validação no gate da Etapa 1** (#110 fix 1): antes de apresentar o gate principal abaixo, checar se `data/editions/{AAMMDD}/01-eai.md` existe OU se há Agent em background ativo aguardando completar. Se nenhum dos dois (skip silencioso detectado), incluir bullet no relatório de saúde do gate: `🟡 É IA?: não dispatchado — rode /diaria-3-imagens {AAMMDD} eai antes do gate da Etapa 4.` Isso fail-loud na primeira oportunidade em vez de só descobrir na Etapa 4.
- **Método de fetch por fonte (#54)**. Pra cada fonte em `context/sources.md`, escolher entre RSS (rápido, determinístico) e WebSearch (fallback):
  1. Ler coluna `RSS` do `seed/sources.csv` via `sync-sources.ts` output — fontes com RSS populado têm linha `- RSS: {url}` em `context/sources.md`.
  2. **Se fonte tem RSS**: disparar `Bash("npx tsx scripts/fetch-rss.ts --url <rss> --source <nome> --days <window_days>")` em paralelo. Rápido (~1-2s por fonte). Marca `method: "rss"` nos articles retornados.
  3. **Se RSS falha ou retorna 0 artigos**: fallback automático — dispara `source-researcher` (WebSearch) pra mesma fonte. Marca `method: "websearch_fallback"`. Critério: 1 falha já dispara fallback (não retry dentro do RSS — se feed está down, parte pra WebSearch).
  4. **Se fonte NÃO tem RSS**: disparar `source-researcher` diretamente (fluxo atual, via WebSearch com `site:` query). Marca `method: "websearch"`.

  Preserva saúde da fonte em todos os casos: propagar `method` como campo extra no `RunRecord` pro `record-source-runs.ts`.

- Disparar N chamadas `Agent` paralelas com subagent `source-researcher` **apenas pras fontes que não têm RSS ou que tiveram fallback**, uma por fonte, passando:
  - nome da fonte
  - site query
  - data da edição
  - janela: `window_days` (confirmado pelo usuário no Stage 0)
  - `timeout_seconds: 180` (soft budget — subagente se auto-disciplina)
- Em paralelo, disparar M chamadas `Agent` com subagent `discovery-searcher` para queries temáticas (derivadas de `audience-profile.md` — temas de alta tração). Usar ~5 queries PT + ~5 EN + **todos os `inbox_topics`** como queries adicionais (prioridade alta, vêm do próprio editor). Passar `timeout_seconds: 180` também.
- Agregar resultados (cada subagente retorna JSON com `status`, `duration_ms`, `articles[]`, e `reason` se status != ok).
- **Registrar saúde + log (batch, #40).** Em vez de N chamadas individuais, agregar todos os resultados (researchers + discovery) num único array e rodar uma vez:
  1. Construir array de runs. Convenção de `source`:
     - **Researchers cadastrados**: nome exato da fonte em `context/sources.md` (ex: `"MIT Technology Review"`, `"Tecnoblog (IA)"`).
     - **Discovery searchers**: formato `discovery:{topic_slug}` (ex: `"discovery:ai-regulation-brazil"`, `"discovery:llm-benchmarks"`). Isso permite rastrear saúde por tema de discovery sem poluir com nomes de fontes cadastradas.
     - **Inbox URLs**: não passam por este batch — são injetadas diretamente na lista agregada sem virar "runs".

     ```json
     [
       { "source": "MIT Technology Review", "outcome": "ok", "duration_ms": 4500, "query_used": "site:...", "articles": [...] },
       { "source": "Tecnoblog (IA)", "outcome": "fail", "duration_ms": 2000, "query_used": "site:...", "reason": "fetch_error" },
       { "source": "discovery:ai-regulation-brazil", "outcome": "ok", "duration_ms": 8000, "query_used": "regulação IA Brasil", "articles": [...] },
       ...
     ]
     ```
  2. Gravar em `data/editions/{AAMMDD}/_internal/researcher-results.json` (rastreabilidade).
  3. Rodar **uma vez** o script batch:
     ```bash
     npx tsx scripts/record-source-runs.ts \
       --runs data/editions/{AAMMDD}/_internal/researcher-results.json \
       --edition {AAMMDD}
     ```
  Isso atualiza `data/source-health.json` + anexa linhas JSONL em `data/sources/{slug}.jsonl` para cada fonte. Batch é mais rápido (uma invocação de Node) e previne o gap anterior onde a chamada singular era frequentemente esquecida (issue #40).

  O script retorna JSON com `summary.sources_with_consecutive_failures_ge3` — use isso no relatório do gate do Stage 1 pra sinalizar fontes que mereceriam desativação temporária.
- Artigos de researchers com `status != ok` **não entram** na lista agregada (mas a saúde fica registrada).
- **Injetar `inbox_urls`** na lista agregada antes da verificação: cada URL vira um artigo sintético com `{ url, source: "inbox", title: "(inbox)", flag: "editor_submitted" }`. O script de verificação decide se é acessível; depois o categorizer verá que é `editor_submitted` e o priorizará.
- **Link verification (script direto):** gravar a lista de URLs da lista agregada em `data/editions/{AAMMDD}/tmp-urls-all.json` (array de strings) e rodar:
  ```bash
  npx tsx scripts/verify-accessibility.ts \
    data/editions/{AAMMDD}/tmp-urls-all.json \
    data/editions/{AAMMDD}/link-verify-all.json
  ```
  Ler `data/editions/{AAMMDD}/link-verify-all.json` (array de `{ url, verdict, finalUrl, note, resolvedFrom?, access_uncertain? }`). Então:
  - **Remover** artigos com verdict `paywall`, `blocked` ou `aggregator` (sem `resolvedFrom`).
  - **Manter com flag** artigos com verdict `anti_bot` (publisher confiável bloqueou crawler mas é acessível a humanos, #320): adicionar `"access_uncertain": true` ao objeto do artigo. Esses artigos continuam no pipeline mas serão sinalizados com `⚠️` no gate para revisão. **Não remover silenciosamente.** Incluir no relatório do gate: `"⚠️ N artigo(s) marcados anti_bot — accessible no browser mas bloqueados por crawler. Revisar antes de aprovar."` com a lista de domínios.
  - **Marcar** artigos com verdict `uncertain` adicionando `"date_unverified": true` ao objeto do artigo. Esses artigos continuam no pipeline mas serão sinalizados com `⚠️` no `01-categorized.md` para revisão manual no gate.
  - **Substituir URL** dos artigos com `resolvedFrom` presente: atualizar o campo `url` do artigo para `finalUrl` (fonte primária encontrada) e adicionar `resolved_from` ao artigo para rastreabilidade. Esses artigos continuam no pipeline normalmente. Isso inclui URLs de shorteners (share.google, bit.ly, t.co, etc.) que foram resolvidos pro destino real (#317).
- **Enriquecer artigos do inbox (#109).** URLs do editor entram com `title: "(inbox)"` e `summary: null`; o writer do Stage 2 pula esses itens silenciosamente porque não há conteúdo verificável. Após a substituição de URLs (passo anterior), rodar:
  ```bash
  # Gravar lista atual de artigos em arquivo temporário
  # (escrever lista em data/editions/{AAMMDD}/tmp-articles-enrich.json)
  npx tsx scripts/enrich-inbox-articles.ts \
    --in data/editions/{AAMMDD}/tmp-articles-enrich.json
  ```
  O script só toca artigos com `flag: "editor_submitted"` ou `source: "inbox"` cujo título seja placeholder (`(inbox)`, `[INBOX] ...`) ou cujo `summary` esteja vazio. Para cada um, fetch da URL final + extração de `og:title` / `og:description` (com fallback pra `<title>` e `meta name=description`). Títulos curados pelo editor são preservados; só placeholders são substituídos. Falhas de fetch viram outcome `fetch_failed` no stdout — não bloqueiam pipeline. Ler o JSON de volta após o script (mutated in place).
- **Deduplicar** a lista filtrada rodando:
  ```bash
  npx tsx scripts/dedup.ts \
    --articles {tmp-articles.json} \
    --past-editions context/past-editions.md \
    --window {window_days} \
    --out {tmp-dedup-output.json}
  ```
  Ler `kept[]` do JSON de saída como lista de artigos daqui em diante. Logar `removed[]` (apenas contagem e motivos) para rastreabilidade. Limpar arquivos temporários com Bash.
- **Categorizar** a lista pós-dedup: gravar `kept[]` em `data/editions/{AAMMDD}/tmp-kept.json` e rodar:
  ```bash
  npx tsx scripts/categorize.ts \
    --articles data/editions/{AAMMDD}/tmp-kept.json \
    --out data/editions/{AAMMDD}/tmp-categorized.json
  ```
  Ler `data/editions/{AAMMDD}/tmp-categorized.json` como `{ lancamento, pesquisa, noticias }` para usar daqui em diante.
- **Topic clustering (#237).** Rodar `topic-cluster.ts` pra consolidar artigos do mesmo evento dentro do mesmo bucket (ex: 3 fontes diferentes cobrindo o mesmo lançamento). O script mantém o "melhor" representante de cada cluster (fonte cadastrada > discovered, score maior > menor) e captura os runners-up em `clusters[]` pra rastreabilidade.
  ```bash
  npx tsx scripts/topic-cluster.ts \
    --in data/editions/{AAMMDD}/tmp-categorized.json \
    --out data/editions/{AAMMDD}/tmp-clustered.json \
    --threshold 0.3
  ```
  Threshold `0.3` é agressivo (Jaccard de tokens fraco em adjacency semântica — ver issue #237). False positives são amortecidos pelo ranking intra-cluster (o representante mantido é o de melhor qualidade). Daqui em diante usar `tmp-clustered.json` como input do filtro de janela. Logar `clusters.length` (zero é normal).
- **Filtro determinístico de janela (#233).** Antes do `research-reviewer`, rodar `scripts/filter-date-window.ts` no nível do orchestrator pra garantir que **nenhum** artigo fora da janela chegue ao agente Haiku. O agente continua responsável pelo filtro de tema recente — mas o filtro de janela é booleano e tem script dedicado, não pode ser delegado.
  ```bash
  npx tsx scripts/filter-date-window.ts \
    --articles data/editions/{AAMMDD}/tmp-clustered.json \
    --edition-date {edition_iso} \
    --window-days {window_days} \
    --out data/editions/{AAMMDD}/tmp-filtered.json
  # (edition_iso = "20${AAMMDD.slice(0,2)}-${AAMMDD.slice(2,4)}-${AAMMDD.slice(4,6)}")
  ```
  Logar `removed.length`. Daqui em diante o input do research-reviewer é `tmp-filtered.json` (que já tem `{ kept: { lancamento, pesquisa, noticias, tutorial } }`) — extrair `kept` e usar como `categorized`.
- Disparar `research-reviewer` passando `{ categorized: kept, edition_date, edition_dir, window_days }` (valor confirmado pelo usuário no início do stage). O agent agora aplica:
  1. **Datas (verificação + flag)**: roda `verify-dates.ts` pra confirmar `published_at` via fetch, corrige `article.date`, copia `date_unverified` direto do output do script (#226 — não recalcula).
  2. **Janela**: roda `filter-date-window.ts` de novo internamente como sanity check (defesa em profundidade — depois do passo determinístico do orchestrator, o agente raramente remove algo aqui).
  3. **Temas recentes**: remove artigos cujo tema já foi coberto pela Diar.ia nos últimos 7 dias (lê `context/past-editions.md`).
  Retorna `categorized` limpo + `stats`. Logar `stats.removals[]`.
- Disparar `scorer` (Opus) passando `categorized` (saída do research-reviewer) e `out_path: data/editions/{AAMMDD}/_internal/tmp-scored.json`. Retorna `highlights[]` (top 6 rankeados, ao menos 1 por bucket), `runners_up[]` (1-2) e `all_scored[]` (todos os artigos com score, ordenados por score desc).
- **Validação pós-scorer (#104).** Se `highlights.length < 6` E `pool_size = sum(buckets.length) >= 6`, **promover** os top de `runners_up[]` (ordenados por score desc) para `highlights[]` até completar 6. Re-numerar os ranks: posição original → 1, primeiro promovido → próximo rank disponível, etc. Logar warning explícito (`level: warn`, `agent: orchestrator`, `message: "scorer produziu apenas N highlights; promovi M runners_up para chegar a 6"`). Se mesmo após a promoção `highlights.length < 6` (pool insuficiente), seguir com o que houver — é caso legítimo. Razão: o spec do scorer é "sempre 6"; quando o LLM diverge, o orchestrator corrige automaticamente em vez de deixar o editor decidir entre menos candidatos.
- **Enriquecer buckets com scores**: para cada artigo em `lancamento`, `pesquisa`, `noticias`, buscar o `score` correspondente em `all_scored` (join por `url`) e injetar como campo `score`. Ordenar cada bucket por `score` desc.
- **Strip do campo `verifier`**: antes de salvar, remover o campo `verifier` de cada artigo (só os acessíveis chegaram até aqui; o campo é redundante e polui o JSON).
- Estrutura final de `_internal/01-categorized.json`:
  ```json
  {
    "highlights": [...top 3 com rank/score/reason/article...],
    "runners_up": [...2-3 candidatos com score...],
    "lancamento": [...artigos com campo score, ordenados por score desc...],
    "pesquisa": [...],
    "noticias": [...],
    "clusters": [...metadata de topic-cluster, runners-up consolidados (#237) — pode ser []...]
  }
  ```
  `clusters` é preservado automaticamente por `filter-date-window.ts` (passthrough de campos extras desde #247) — não precisa re-inject manual. Mesmo se algum cluster member virou `removed` no filtro de janela, a metadata do cluster fica intacta — é informativo pro editor.
- Salvar `data/editions/{AAMMDD}/_internal/01-categorized.json`.
- **Renderizar `01-categorized.md` via script determinístico** (nunca gerar o MD livre-forma — o formato é responsabilidade do script, não do LLM):
  ```bash
  npx tsx scripts/render-categorized-md.ts \
    --in data/editions/{AAMMDD}/_internal/01-categorized.json \
    --out data/editions/{AAMMDD}/01-categorized.md \
    --edition {AAMMDD} \
    --source-health data/source-health.json
  ```
  O script produz o formato combinado (seção Destaques vazia no topo + seções Lançamentos/Pesquisas/Notícias com `⭐`, `[inbox]`, `(descoberta)` e `⚠️` inline) a partir do JSON. Candidatos do scorer ficam marcados com `⭐` nas seções de bucket; o editor move linhas para a seção Destaques. **Regra absoluta: qualquer mudança no `_internal/01-categorized.json` (edição, retry, regeneração do scorer) deve ser seguida de uma nova chamada deste script para manter o MD em sincronia.** Se você só mudou o JSON sem re-rodar o renderizador, o MD está stale — isso é um bug.
- **Sync push do MD para o Drive** (antes do gate — o editor precisa ver para decidir):
  1. Montar lista de arquivos: sempre `01-categorized.md`; adicionar `01-eai.md,01-eai-A.jpg,01-eai-B.jpg` se `data/editions/{AAMMDD}/01-eai.md` existir.
  2. `Bash("npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 1 --files {lista}")`. Anotar em `sync_results[1]`; ignorar falhas.

- **GATE HUMANO:** apresentar ao usuário:

  1. **Instrução de revisão** — não renderizar a lista no terminal. Apenas informar:
     ```
     📊 {total_brutos} artigos garimpados → {kept_dedup} após dedup → {total_categorized} categorizados

     📄 Abra data/editions/{AAMMDD}/01-categorized.md para revisar.
     📁 Drive: Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/01-categorized.md

     ✏️  Candidatos recomendados pelo scorer estão marcados com ⭐.
         Mova exatamente 3 linhas para a seção "Destaques" no topo do arquivo.
         A ORDEM FÍSICA das linhas em "Destaques" define D1/D2/D3 (de cima para baixo).
         Para reordenar, basta mover a linha dentro da seção Destaques.
         Se não mover nenhum artigo, os 3 primeiros candidatos do scorer serão usados.
     ```
     (Derivar: `total_brutos` = soma de `articles[]` de todos researchers; `kept_dedup` = `kept[].length` do dedup.ts; `total_categorized` = L+P+N+T do categorized.json)

  2. **Relatório de saúde das fontes:**
     - Um bullet `⚠️` por fonte com outcome não-ok *nesta execução* (ex: `⚠️ MIT Tech Review BR — timeout após 180s`).
     - Um bullet `🔴` por fonte com streak 3+, com os timestamps de cada falha: ex:
       `🔴 AI Breakfast — 3 timeouts seguidos: 2026-04-15T14:18Z, 2026-04-16T14:20Z, 2026-04-17T14:22Z — considere desativar em seed/sources.csv`.
     - Se tudo OK: "Todas as fontes responderam normalmente."

  Quando aprovado:
  - **Fazer pull do MD** (o editor pode ter editado no Drive): rodar `Bash("npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 1 --files 01-categorized.md")`. Se o pull falhar, usar a versão local.
  - **Aplicar as edições do gate** via `scripts/apply-gate-edits.ts`. O script parseia **todas as 4 seções** do MD (`## Destaques`, `## Lançamentos`, `## Pesquisas`, `## Notícias`), honra a curadoria do editor em cada bucket, e produz o `_internal/01-approved.json` final:
    ```bash
    npx tsx scripts/apply-gate-edits.ts \
      --md data/editions/{AAMMDD}/01-categorized.md \
      --json data/editions/{AAMMDD}/_internal/01-categorized.json \
      --out data/editions/{AAMMDD}/_internal/01-approved.json
    ```
    Comportamento:
    - `## Destaques`: primeiras 3 linhas na ordem física viram D1/D2/D3 (rank 1/2/3, renumeradas). Se < 3, completa com candidatos do scorer por rank. Se > 3, mantém as 3 primeiras.
    - `## Lançamentos` / `## Pesquisas` / `## Notícias`: honra EXATAMENTE as URLs que o editor deixou em cada seção, na ordem física. Artigos removidos do MD são dropados. Artigos movidos entre buckets respeitam o bucket do MD final.
    - URLs no MD que não existem no `_internal/01-categorized.json` original são logadas como warn e ignoradas.
  - **Re-renderizar o MD** a partir do `_internal/01-approved.json` para manter JSON e MD em sincronia:
    ```bash
    npx tsx scripts/render-categorized-md.ts \
      --in data/editions/{AAMMDD}/_internal/01-approved.json \
      --out data/editions/{AAMMDD}/01-categorized.md \
      --edition {AAMMDD} \
      --source-health data/source-health.json
    ```
    Push do MD atualizado de volta para o Drive: `Bash("npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 1 --files 01-categorized.md")`.
  - **Arquivar o inbox**: mover `data/inbox.md` → `data/inbox-archive/{YYYY-MM-DD}.md` e recriar um `data/inbox.md` vazio (com o cabeçalho padrão). Isso garante que submissões do dia não voltem na próxima edição.
  - **Atualizar _internal/cost.md.** Ler `_internal/cost.md`, append linha na tabela de Stage 1, recalcular `Total de chamadas`, gravar com `Write`:
    ```
    | 1 | {stage_start} | {now} | inbox_drainer:1, refresh_dedup:1, source_researcher:{N}, discovery:{M}, link_verifier:{chunks}, categorizer:1, research_reviewer:1, scorer:1 | {soma_haiku} | 1 |
    ```
    `Total de chamadas` = soma de todas as chamadas em todas as linhas + 1 (orchestrator).

### 2. Etapa 2 — Escrita

Newsletter e social rodam **em paralelo** a partir de `_internal/01-approved.json` — nenhum depende do outro. O gate ao final é unificado.

#### 2a. Writer + social em paralelo

**Em uma única mensagem**, disparar os 3 agents simultaneamente:

1. `Agent` → `writer` (Sonnet) passando:
   - `highlights` (extraído de `_internal/01-approved.json` — sempre exatamente 3 entradas após o gate da Etapa 1)
   - `categorized` (o `_internal/01-approved.json` inteiro, para lançamentos/pesquisa/noticias)
   - `edition_date`
   - `out_path = data/editions/{AAMMDD}/_internal/02-draft.md`
   - `d1_prompt_path = data/editions/{AAMMDD}/_internal/02-d1-prompt.md`
   - `d2_prompt_path = data/editions/{AAMMDD}/_internal/02-d2-prompt.md`
   - `d3_prompt_path = data/editions/{AAMMDD}/_internal/02-d3-prompt.md`

2. `Agent` → `social-linkedin` passando `approved_json_path = data/editions/{AAMMDD}/_internal/01-approved.json` e `out_dir = data/editions/{AAMMDD}/`.

3. `Agent` → `social-facebook` passando `approved_json_path = data/editions/{AAMMDD}/_internal/01-approved.json` e `out_dir = data/editions/{AAMMDD}/`.

Aguardar os 3 retornarem. Writer retorna JSON `{ out_path, d1_prompt_path, d2_prompt_path, d3_prompt_path, checklist, warnings }`. Se `warnings[]` não estiver vazio, **pare** e reporte ao usuário antes de prosseguir.

#### 2b. Processar newsletter
- **Pull pós-gate** (antes de qualquer edição local pós-aprovação): `Bash("npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 2 --files 02-reviewed.md")`. Garante que edições manuais do editor no Drive durante a revisão do gate não sejam sobrescritas pelo processamento local. Se o pull falhar, usar versão local e logar warn.
- **Lint seções vs buckets (#165).** Antes de qualquer processamento, validar que cada URL nas seções LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS bate com o bucket correspondente em `_internal/01-approved.json`:
  ```bash
  npx tsx scripts/lint-newsletter-md.ts \
    --md data/editions/{AAMMDD}/_internal/02-draft.md \
    --approved data/editions/{AAMMDD}/_internal/01-approved.json
  ```
  Exit 1 = URL na seção errada (ex: `bucket: "noticias"` em LANÇAMENTOS) ou URL fantasma (não existe no approved). Se falhar, **re-disparar o writer** com a lista de erros explicitada no prompt (ex: "mover X de LANÇAMENTOS pra OUTRAS NOTÍCIAS"). Até 3 tentativas; se persistir após 3, reportar erro e pausar pra fix manual no `02-draft.md`. Caso de borda comum coberto: ferramenta nova com `bucket: "noticias"` (porque é cobertura, não anúncio oficial) que o writer põe em LANÇAMENTOS por associação temática (ex: ComfyUI).
- **Normalizar layout (inline — sem Agent, #157):** o writer LLM ocasionalmente concatena elementos numa linha única (3 títulos do destaque colados no header, ou título+URL+descrição colados num item de seção, layout pós-#172). Rodar pós-processador defensivo que detecta e quebra:
  ```bash
  npx tsx scripts/normalize-newsletter.ts \
    --in data/editions/{AAMMDD}/_internal/02-draft.md \
    --out data/editions/{AAMMDD}/_internal/02-normalized.md \
    2> data/editions/{AAMMDD}/_internal/02-normalize-report.json
  ```
  Heurístico conservador — só quebra quando o pattern é inequívoco. Se nenhum bug for detectado, `02-normalized.md` é cópia idêntica do draft. Falha do script não bloqueia (log warn + fallback usa `02-draft.md`).
- **Humanizar (#308):** invocar skill `humanizador` no arquivo `02-normalized.md` — remove tics LLM (gerúndio em cascata, vocabulário inflado, aberturas cenográficas, etc.), calibrando a voz com `context/past-editions.md` como referência:
  ```
  Skill("humanizador", "Leia data/editions/{AAMMDD}/_internal/02-normalized.md, humanize o texto removendo marcas de IA em português, calibrando a voz com context/past-editions.md como referência, e salve o resultado em data/editions/{AAMMDD}/_internal/02-humanized.md.")
  ```
  Falha da skill **não bloqueia** — fallback usa `02-normalized.md` como input pra Clarice. Em caso de falha, logar warn: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 2 --agent orchestrator --level warn --message 'humanizador falhou — usando normalized'`.
- **Revisar com Clarice (inline — sem Agent):**
  Definir `CLARICE_INPUT` na ordem de prioridade: (1) `_internal/02-humanized.md` se existe (humanizador aplicado); (2) `_internal/02-normalized.md` se existe (normalize sucedeu); (3) `_internal/02-draft.md` (fallback). **Usar a mesma path em ambos os passos abaixo (Clarice input + diff source)** — inconsistência aqui causa file-not-found no diff.
  1. Ler conteúdo de `data/editions/{AAMMDD}/{CLARICE_INPUT}`.
  2. Chamar `mcp__clarice__correct_text` passando o texto completo. A ferramenta retorna uma lista de sugestões (cada uma com trecho original → corrigido).
  3. Aplicar **todas** as sugestões ao texto original, produzindo o texto revisado. Gravar esse texto corrigido (não a lista de sugestões) em `data/editions/{AAMMDD}/02-reviewed.md`.
  4. Gerar diff legível usando o mesmo `CLARICE_INPUT` definido acima:
     ```bash
     npx tsx scripts/clarice-diff.ts \
       data/editions/{AAMMDD}/{CLARICE_INPUT} \
       data/editions/{AAMMDD}/02-reviewed.md \
       data/editions/{AAMMDD}/_internal/02-clarice-diff.md
     ```
  Se a Clarice falhar, propagar o erro — **não** usar o rascunho sem revisão.
- **Validar LANÇAMENTOS oficiais (#160).** Rodar:
  ```bash
  npx tsx scripts/validate-lancamentos.ts data/editions/{AAMMDD}/02-reviewed.md
  ```
  Garante que todo URL na seção LANÇAMENTOS bate com whitelist oficial (`scripts/categorize.ts > LANCAMENTO_DOMAINS`/`PATTERNS`). Se exit code != 0 (URL não-oficial detectada), **incluir os erros no prompt do gate humano** mostrando linha + URL + sugestão de mover pra NOTÍCIAS. Não bloquear automaticamente — editor decide se é erro real ou caso de borda novo (ex: domínio oficial não cadastrado ainda).
#### 2c. Processar social

Após os social agents retornarem, fazer merge em `03-social.md` via Bash:

```bash
node -e "
  const fs=require('fs');
  const dir='{edition_dir}';
  const li=fs.readFileSync(dir+'_internal/03-linkedin.tmp.md','utf8').trim();
  const fb=fs.readFileSync(dir+'_internal/03-facebook.tmp.md','utf8').trim();
  fs.writeFileSync(dir+'03-social.md','# LinkedIn\n\n'+li+'\n\n# Facebook\n\n'+fb+'\n');
  fs.unlinkSync(dir+'_internal/03-linkedin.tmp.md');
  fs.unlinkSync(dir+'_internal/03-facebook.tmp.md');
"
```

**Humanizar social (#308):** invocar skill `humanizador` in-place no `03-social.md`:
```
Skill("humanizador", "Leia data/editions/{AAMMDD}/03-social.md, humanize o texto removendo marcas de IA em português, e salve no mesmo arquivo.")
```
Falha não bloqueia (fallback usa o arquivo original).

**Revisar social com Clarice (inline):** ler `03-social.md`, chamar `mcp__clarice__correct_text`, aplicar sugestões, sobrescrever. **Após sobrescrever**, verificar que as seções `# LinkedIn`, `# Facebook`, `## d1`, `## d2`, `## d3` ainda existem. Se algum cabeçalho estiver ausente, restaurar com `Edit` antes de prosseguir. Se Clarice falhar, propagar o erro.

#### 2d. Sync push + gate unificado

- **Sync push antes do gate.** Rodar `Bash("npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 2 --files 02-reviewed.md,03-social.md,_internal/02-clarice-diff.md")`. Anotar resultado em `sync_results[2]`; ignorar falhas.
- **GATE HUMANO unificado (newsletter + social):** mostrar `_internal/02-clarice-diff.md` e o conteúdo de `03-social.md`. Instruir:
  ```
  ✏️  Etapa 2 — Escrita pronta.

  Newsletter — edite data/editions/{AAMMDD}/02-reviewed.md:
      — Mantenha exatamente 1 título por destaque (delete os outros 2).
        URL fica na linha imediatamente abaixo do título escolhido (#172).

  Social — revise data/editions/{AAMMDD}/03-social.md:
      — 3 posts LinkedIn (d1/d2/d3) + 3 posts Facebook (d1/d2/d3)

  📁 Drive: Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/
  ```
  Quando o editor responder "sim", os arquivos locais são os textos finais.
  - **Auto-pick de título via Opus (#159).** Após aprovação, dispatch `title-picker` (Opus, Agent) passando:
    - `md_path = data/editions/{AAMMDD}/02-reviewed.md`
    - `out_path = data/editions/{AAMMDD}/02-reviewed.md` (in-place)
    - `audience_path = context/audience-profile.md`
    - `editorial_rules_path = context/editorial-rules.md`
    - `picks_log_path = data/editions/{AAMMDD}/_internal/02-title-picks.json`

    Title-picker detecta destaques que ainda têm >1 título (editor não podou) e escolhe 1 baseado em concretude + tom + variedade lexical. Se `destaques_picked > 0`, logar info: `"title-picker: auto-podou N destaque(s) — log em _internal/02-title-picks.json"`. Se `destaques_picked === 0`, editor já podou tudo manualmente — title-picker é no-op.

    Erro do agent (ex: destaque sem título nenhum) deve ser reportado ao editor antes de prosseguir pra Etapa 3 — não há fallback automático pra título inexistente.
  - **Validar 1 título por destaque (#178).** Após o title-picker, validar que todo destaque tem exatamente 1 título:
    ```bash
    npx tsx scripts/lint-newsletter-md.ts \
      --check titles-per-highlight \
      --md data/editions/{AAMMDD}/02-reviewed.md
    ```
    Exit 1 = algum destaque ainda tem ≠1 título (caso de borda — title-picker falhou ou editor depois apagou). **Não prosseguir** — re-apresentar o gate com o erro destacado:
    > ⚠️ DESTAQUE N tem K títulos — delete os K-1 excedentes em `data/editions/{AAMMDD}/02-reviewed.md` antes de aprovar de novo.

    Se exit 0, prosseguir pra Etapa 3 normalmente. (Em caso normal, title-picker já podou tudo e este check passa silenciosamente.)
  - **Atualizar _internal/cost.md.** Append linha na tabela da Etapa 2, recalcular `Total de chamadas`, gravar:
    ```
    | 2 | {stage_start} | {now} | writer:1, social_linkedin:1, social_facebook:1, humanizador:2, title_picker:?1, drive_syncer:1 | 3 | 3 |
    ```
    `title_picker:?1` = só conta se foi disparado (destaques_picked > 0); senão 0.

### 3. Etapa 3 — Imagens

#### 3a. É IA? (gate do background dispatch)

O `eai-composer` foi disparado em background durante a Etapa 1. Aqui coletamos o resultado e apresentamos o gate antes de gerar as imagens de destaque.

- **Se o Agent do eai-composer ainda não completou:** aguardar. Quando completar, apresentar o gate abaixo.
- **Se o Agent já completou (ou `01-eai.md` já existe por resume):** apresentar o gate imediatamente.
- Se o eai-composer falhou, logar erro e reportar ao usuário. Oferecer retry (re-disparar `eai-composer` com os mesmos parâmetros).
- **Sync push antes do gate.** Rodar `Bash("npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 3 --files 01-eai.md,01-eai-A.jpg,01-eai-B.jpg")`. Anotar em `sync_results[3]` (eai); ignorar falhas. (Edições antigas têm `01-eai-real.jpg`/`01-eai-ia.jpg`; ajustar manualmente em retry de pré-#192.)
- **GATE HUMANO:** mostrar o texto de `01-eai.md` (frontmatter `eai_answer` revela A↔real/ia pro editor) + `"Imagem A: data/editions/{AAMMDD}/01-eai-A.jpg | Imagem B: data/editions/{AAMMDD}/01-eai-B.jpg"`. Mencionar: "📁 Disponível no Drive em `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/`." Se `rejections[]` no output do composer não estiver vazio, exibir: `"Pulei N dia(s) — motivos: vertical (X), já usada em edição anterior (Y). Imagem escolhida é de {image_date_used}."` para contextualizar o editor. Opções: aprovar / tentar dia anterior (re-disparar `eai-composer` — ele decrementa a data; re-disparar o push com os novos arquivos).
  - **Atualizar _internal/cost.md.** Append linha da É IA?, recalcular `Total de chamadas`, gravar:
    ```
    | 3a | {eai_dispatch_ts} | {now} | eai_composer:1, drive_syncer:1 | 2 | 0 |
    ```

#### 3b. Imagens de destaque

- Logar início: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 3 --agent orchestrator --level info --message 'etapa 3 imagens started'`.
- **Sync pull antes de começar.** Rodar `Bash("npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 3 --files 02-d1-prompt.md,02-d2-prompt.md,02-d3-prompt.md")` — prompts de imagem derivam dos destaques escritos na Etapa 2.
- Se `platform.config.json > image_generator` é `"comfyui"`, verificar que ComfyUI está acessível: `Bash("curl -sf http://127.0.0.1:8188/system_stats > /dev/null")`. Se falhar, pausar e instruir o usuário a iniciar o ComfyUI.
- **Gerar imagens via script (sem Agent).** Para cada destaque d1, d2, d3 sequencialmente (Gemini API por default):
  ```bash
  npx tsx scripts/image-generate.ts \
    --editorial data/editions/{AAMMDD}/_internal/02-d{N}-prompt.md \
    --out-dir data/editions/{AAMMDD}/ \
    --destaque d{N}
  ```
  Se o script sair com código ≠ 0, logar erro com o stderr e reportar ao usuário — não continuar para o próximo destaque.
- **Sync push antes do gate.** Rodar `Bash("npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/{AAMMDD}/ --stage 3 --files 04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg")`. Anotar em `sync_results[3]`; ignorar falhas.
- **GATE HUMANO (É IA? + imagens):** mostrar paths do É IA? + 4 paths de imagem gerados (`04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`). Mencionar: "Imagens full-size disponíveis no Drive em `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/`." Opções: aprovar / regenerar individual (re-rodar o script só para `d{N}` e re-disparar o push).
  - **Atualizar _internal/cost.md.** Append linha da Etapa 3, atualizar `Fim` e `Total de chamadas`, gravar:
    ```
    | 3b | {stage_start} | {now} | drive_syncer:1 | 1 | 0 |
    ```
    Atualizar `Fim: {now}` no cabeçalho.

### 4. Etapa 4 — Publicação (paralelo: newsletter + social) — #38

`publish-newsletter` (Beehiiv), `publish-facebook.ts` (Graph API) e `publish-social` (LinkedIn via Chrome) rodam **em paralelo na mesma mensagem**, com **gate único** depois. O auto-reporter fecha o loop de observabilidade.

Manteve-se modo draft pra Beehiiv — `mode: "scheduled"` + scheduled_at sincronizado fica pra PR 2 (#38).

#### 4a. Pré-requisitos + sync

- Logar início: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent orchestrator --level info --message 'etapa 4 publish parallel started'`.
- **Sync pull antes de começar** (todos os arquivos consumidos por newsletter + social): `Bash("npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/{AAMMDD}/ --stage 4 --files 02-reviewed.md,01-eai.md,01-eai-A.jpg,01-eai-B.jpg,03-social.md,04-d1-2x1.jpg,04-d1-1x1.jpg,04-d2-1x1.jpg,04-d3-1x1.jpg")` — editor pode ter refinado texto/imagens ou ajustado posts no Drive. (Edições antigas pré-#192 usam `01-eai-real.jpg`/`01-eai-ia.jpg`.)
- **Staleness check (#120) — APÓS o pull.** Rodar:
  ```bash
  npx tsx scripts/check-staleness.ts --edition-dir data/editions/{AAMMDD}/ --stage 6
  ```
  (mantém `--stage 6` por compat com o config existente — o check valida downstreams do Stage 3/4 vs `02-reviewed.md`, conceito não mudou). Exit code 0 = ok. Exit code 1 = pausar com a mensagem de re-run de Stage 3/4.
- Verificar pré-requisitos: `02-reviewed.md`, `01-eai.md`, `01-eai-A.jpg` + `01-eai-B.jpg` (ou legacy `01-eai-real.jpg` + `01-eai-ia.jpg` em edições pré-#192), `03-social.md`, `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg`. Se algum faltar, pausar e instruir qual stage re-rodar.

#### 4b. Confirmar modo de publicação por canal (#336)

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

#### 4c. Dispatch paralelo (UMA mensagem, 3 chamadas)

**Só dispatchar os canais que o editor autorizou em 5b.** Canais manuais ficam com status `pending_manual`.

**Em uma única mensagem**, disparar simultaneamente (apenas os autorizados):
1. `Bash("npx tsx scripts/publish-facebook.ts --edition-dir data/editions/{AAMMDD}/ --schedule --skip-existing")` — Graph API, ~30s. Se `test_mode = true` e `schedule_day_offset` definido, adicionar `--day-offset {schedule_day_offset}`.
2. `Agent` → `publish-newsletter` com `edition_dir = data/editions/{AAMMDD}/`.
3. `Agent` → `publish-social` com `edition_dir = data/editions/{AAMMDD}/`, `skip_existing = true`, e (se `schedule_day_offset` estiver definido) `schedule_day_offset = {schedule_day_offset}`.

**Tab isolation no Chrome**: cada agent abre tab própria via `tabs_create_mcp` (publish-newsletter → tab Beehiiv; publish-social → tab LinkedIn). Sem reuso de tab entre agents — o conflito do issue #38 é mitigado por isolamento de tab handle no contexto de cada agent.

**Aguardar todos os 3 retornarem** antes de prosseguir. Falha/retry de um agent não bloqueia o outro (5d).
#### 4d. Retry chrome_disconnected (independente por agent)

Tanto `publish-newsletter` quanto `publish-social` usam o mesmo padrão de retry exponencial — cada um conta sozinho (falha de um não afeta o contador do outro).

Se qualquer agent retornar `error: "chrome_disconnected"`:
1. Calcular delay: `30 * 2^(N-1)` segundos (tentativa 1 = 30s, 2 = 60s, 3 = 120s, 4 = 240s, 5 = 480s, 6 = 960s, 7 = 1920s, 8 = 3840s, 9 = 7680s, 10 = 15360s). Via `Bash("node -e \"process.stdout.write(String(30 * Math.pow(2, {N}-1)))\"")`.
2. Logar warn: `"chrome_disconnected em Etapa 4 ({agent}), tentativa {N}/10 — aguardando {delay}s antes de re-disparar"`.
3. Aguardar: `Bash("sleep {delay}")`.
4. Re-disparar **só** o agent que falhou (com mesmos parâmetros; publish-social com `skip_existing = true`).
5. Se repetir, repetir do passo 1 incrementando N.
6. **Após 10 falhas consecutivas** (~17h acumuladas), logar erro e pausar:
   ```
   🔌 Claude in Chrome desconectou 10 vezes seguidas em {agent} (Etapa 4).
      Verifique Chrome aberto + extensão Claude in Chrome ativa.
      ⚠️ Se publish-newsletter: rascunho parcial no Beehiiv pode existir — delete antes do retry.
      Responda "retry" pra mais 10 tentativas, ou "skip" pra pular este agent.
   ```
- **Reset do contador**: re-dispatch que sucede (mesmo se falhar por outro motivo depois) reseta N=1.
- Erros que **não** sejam `chrome_disconnected` (ex: login expirado, template errado) interrompem o loop e são tratados normalmente.
- Se `publish-newsletter` retornar `error: "beehiiv_login_expired"` ou similar, pausar com instrução de re-logar (ver `docs/browser-publish-setup.md`).
- Se `publish-social` retornar `status: "failed"` em algum post por login expirado, logar warn e prosseguir — editor re-roda `/diaria-4-publicar social` após re-logar.

#### 4e. Validar template (publish-newsletter)
- Ler `05-published.json` retornado. Extrair `draft_url`, `title`, `test_email_sent_to`, `template_used`.
- **Validar template (obrigatório).** Ler `publishing.newsletter.template` de `platform.config.json` (ex: `"Default"`). Se `template_used` !== template esperado:
  1. Logar erro: `"Template incorreto: esperado '{expected}', usado '{template_used}'. Re-disparando publish-newsletter."`.
  2. Instruir o usuário a **deletar o rascunho incorreto** no Beehiiv antes do retry (rascunhos órfãos poluem a lista de posts): `"⚠️ Delete o rascunho '{title}' em {draft_url} antes do retry."`.
  3. Re-disparar `publish-newsletter` com os mesmos parâmetros (até 3 tentativas).
  4. Se o template continuar errado após 3 tentativas, pausar e instruir o usuário: `"O template '{expected}' não foi selecionado. Verifique se existe no Beehiiv (Settings → Templates) e re-rode /diaria-4-publicar newsletter."`.
  5. **Não prosseguir para o loop de review** enquanto o template não estiver correto — a newsletter sem template terá problemas estruturais (É IA? ausente, boxes não separados, etc.).

#### 4f. Loop de review do email de teste (após newsletter retornar)

> NOTA: este loop **não bloqueia social** — `publish-facebook.ts` e `publish-social` já completaram em 4c. O loop só toca o draft do Beehiiv (newsletter). Social drafts ficam congelados desde 4c.

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
  Salvar com `Write`. O campo `review_completed` é usado na lógica de **resume** para garantir que a Etapa 4 não é considerada completa sem a revisão do email de teste. **Se este campo estiver ausente ou `false`, o resume re-executa o loop de review.**
- Ler `05-published.json` (pode ter sido atualizado pelo fix mode).

#### 4g. Gate único

- Ler `06-social-published.json` (já gerado por 5c).
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

  **Upload manual de imagens (gate obrigatório, só para newsletter)** — as imagens do email de teste do Beehiiv são placeholders (localhost). Editor DEVE subir as imagens no Beehiiv antes de aprovar:
    ```
    📎 Suba as imagens no rascunho do Beehiiv ANTES de aprovar:
       • Cover/Thumbnail → 04-d1-2x1.jpg (1600×800)
       • Inline D1  → 04-d1-2x1.jpg
       • Inline D2  → 04-d2-1x1.jpg
       • Inline D3  → 04-d3-1x1.jpg
       • É IA? (A)  → 01-eai-A.jpg
       • É IA? (B)  → 01-eai-B.jpg
       📁 Arquivos em data/editions/{AAMMDD}/ ou no Drive.
    ```
  Social posts não exigem upload manual — Facebook foi via Graph API com upload já feito; LinkedIn drafts têm imagens já anexadas pelo agent.

  **Instrução**: "Suba as imagens no Beehiiv, reenvie o email de teste pra conferir, revise os 6 social drafts no dashboard de cada plataforma, e só então aprove. Posts agendados serão publicados automaticamente no horário."

  **Opções**:
  - aprovar (segue para auto-reporter)
  - regenerar newsletter (re-dispatch `publish-newsletter`)
  - regenerar social (re-dispatch `publish-facebook` + `publish-social`, com `--skip-existing` / `skip_existing = true` pra resume-aware)
  - regenerar tudo (volta a 4b)
  - abortar

- **Atualizar _internal/cost.md.** Append linha unificada na tabela da Etapa 4, recalcular `Total de chamadas`, gravar:
  ```
  | 4 | {stage_start} | {now} | publish_newsletter:1, publish_facebook:1, publish_social:1, review_test_email:{review_attempts} | 0 | {3 + review_attempts} |
  ```

### 4b. Auto-reporter (#57 / #79)

Após o gate da Etapa 4 (publicação paralela) aprovado, orchestrator coleta sinais da edição e apresenta gate de issues GitHub.

0. **Validar social published (sempre, independente do exit code dos agents — #272):**
   ```bash
   npx tsx scripts/validate-social-published.ts data/editions/{AAMMDD}/
   ```
   Se exit != 0 (duplicates ou inconsistências detectados), incluir no relatório do gate de Etapa 4 (`4g`) antes de seguir. Não bloqueia o pipeline, mas editor vê o problema antes de aprovar.

1. **Coletar sinais**: rodar `Bash("npx tsx scripts/collect-edition-signals.ts --edition-dir data/editions/{AAMMDD}/")`. Script lê `data/source-health.json`, `{edition_dir}/05-published.json` (`unfixed_issues[]`), e `data/run-log.jsonl` (chrome_disconnects). Grava `{edition_dir}/_internal/issues-draft.json`.

2. **Avaliar output**: se `signals_count === 0`, logar info e pular auto-reporter — edição passou limpa, nada a reportar.

3. **Se `test_mode = true` ou `auto_approve = true`**: **pular auto-reporter inteiramente**. Auto-approve de criação de issues em GitHub seria invasivo; edições de teste não devem poluir backlog.

4. **Se há sinais e não é test_mode**: disparar agent `auto-reporter` via `Agent` com:
   - `edition_dir`
   - `repo: "vjpixel/diaria-studio"`

   Agent faz dedup contra GitHub issues abertas, apresenta gate humano ("aprovar 1,2,3 / skip / edit N"), executa ações aprovadas. Ver `.claude/agents/auto-reporter.md`.

5. **Logar resultado**: append em `_internal/cost.md` uma linha pro stage final, e gravar resumo:
   ```
   ✅ Auto-reporter completo.
      {reported_count}/{signals_total} sinais reportados, {issues_created} novas issues criadas, {issues_commented} issues comentadas.
   ```

Se o agent retornar `action: "fallback_md"` (GitHub MCP indisponível), mostrar o path do MD gerado e instruir: "GitHub MCP falhou. Abra `{md_path}` e crie as issues manualmente quando tiver tempo."

## Formato de relatório ao usuário

Ao final de cada etapa, apresente:

```
✅ Etapa {N} — {nome} completa

Output: data/editions/{AAMMDD}/{arquivo}
Resumo:
  - {bullet 1}
  - {bullet 2}

Aprovar e seguir para Etapa {N+1}? (sim / editar / retry)
```

### Resumo final (após auto-reporter)

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

## Erros

Se um subagente falhar, não tente workarounds criativos. Reporte o erro ao usuário com contexto e ofereça retry.

**Logar sempre.** Quando um subagente retornar erro ou warning, rode:
```
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage {N} --agent {nome} --level error --message "{resumo}" --details '{"raw":"..."}'
```
Isso alimenta `/diaria-log` para o usuário depurar depois sem precisar reler o histórico.
