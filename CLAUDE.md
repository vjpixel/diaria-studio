# Diar.ia Studio

Projeto Claude Code fim-a-fim para produção da newsletter **Diar.ia** (diar.ia.br).

O fluxo editorial é modelado como 6 etapas com gate humano em 2 delas (Stage 4: revisão; Stage 6: agendamento). A execução acontece via skills (`/diaria-edicao`, `/diaria-1-pesquisa`, etc.) que disparam um orquestrador; o orquestrador distribui trabalho para subagentes especializados em paralelo quando possível.

---

## Como usar

**Setup (1x):**
1. Exportar `CLARICE_API_KEY` no ambiente do shell (necessário para o MCP Clarice local). No Windows (persistente, requer reabrir o terminal):
   ```powershell
   [Environment]::SetEnvironmentVariable("CLARICE_API_KEY", "SEU_TOKEN_AQUI", "User")
   ```
   Use o mesmo token do `claude_desktop_config.json`. Veja `.env.example`.
2. `npm install` no diretório.
2a. `npm run setup-hooks` — instala hook que regenera `context/sources.md` automaticamente ao editar `seed/sources.csv`.
2b. **`data/` mora no OneDrive, não no repo.** A pasta `data/` é uma *directory junction* local apontando para `~/OneDrive/Documentos/diaria-studio-data` (sync entre máquinas, business-sensitive não vai pro GH). Criar 1x por máquina, **antes de rodar qualquer skill** (`data/` não existe num clone fresco — scripts que tentarem escrever ali vão falhar):
   ```powershell
   # Windows + OneDrive PT-BR (default desta máquina):
   New-Item -ItemType Junction -Path "data" -Target "$env:USERPROFILE\OneDrive\Documentos\diaria-studio-data"
   ```
   **Ajustar o target ao OneDrive local** — varia por OS/idioma:
   - Windows EN: `$env:USERPROFILE\OneDrive\Documents\diaria-studio-data`
   - macOS: `ln -s ~/Library/CloudStorage/OneDrive-Personal/Documents/diaria-studio-data data` (ou path equivalente do app instalado)
   - Linux (rclone/onedriver): `ln -s <mount-point>/Documents/diaria-studio-data data`

   A pasta-alvo no OneDrive precisa existir antes (criar manualmente na 1ª máquina; nas demais, o OneDrive já sincronizou). Toda `data/` está em `.gitignore` blanket — nada lá dentro vai pro repo.
3. `npm run sync-sources` para gerar `context/sources.md`.
4. Abrir Claude Code neste diretório: `cd diaria-studio && claude`.
5. Confirmar que os MCPs estão ativos: `/mcp` deve listar `clarice` (local), `claude.ai Beehiiv` e `claude.ai Gmail` (conectores nativos). Para Fase 2 (imagens), instalar ComfyUI local (ver `docs/comfyui-setup.md`). Para Fase 3 (publicação), instalar e logar a extensão `Claude in Chrome` em Beehiiv/LinkedIn/Facebook (ver `docs/browser-publish-setup.md`).
6. **Inbox editorial** (`diariaeditor@gmail.com`): seguir `docs/gmail-inbox-setup.md` (forward + label). Isso permite enviar links/temas durante o dia que são considerados na próxima edição automaticamente.
7. Rodar `/diaria-atualiza-audiencia` para importar respostas de survey do Beehiiv em `data/audience-raw.json` (re-rodar semanalmente ou quando quiser recalibrar). O `context/audience-profile.md` é regenerado automaticamente no Stage 0, combinando CTR comportamental (primário) e survey (secundário).

**Para cada nova edição:**
1. `/diaria-edicao AAMMDD [--no-gates]` — roda todos os stages em sequência. O próprio orchestrator regenera `data/past-editions.md` (Stage 0) e drena o inbox editorial (`diariaeditor@gmail.com`, Stage 1) automaticamente. Com `--no-gates`, auto-aprova todos os gates humanos mas mantém Drive sync e social scheduling normais.
2. Alternativamente, rodar etapas isoladas:
   - **Etapa 1** (pesquisa): `/diaria-1-pesquisa` (também refresca dedup + drena inbox).
   - **Etapa 2** (escrita): `/diaria-2-escrita [newsletter|social]` (newsletter + social em paralelo a partir de `01-approved.json`).
   - **Etapa 3** (imagens): `/diaria-3-imagens [eia|d1|d2|d3]` (É IA? + imagens de destaque).
   - **Etapa 4** (revisão editorial): `/diaria-4-revisao` (pré-render + resumo consolidado + gate humano).
   - **Etapa 5** (publicação): `/diaria-5-publicacao [all|newsletter|social]`.
   - **Etapa 6** (agendamento): `/diaria-6-agendamento [AAMMDD]` (gate humano: Schedule Beehiiv + auto-reporter).
3. Skills auxiliares (debug, raramente usadas):
   - `/diaria-refresh-dedup` — testa conexão com Beehiiv MCP.
   - `/diaria-inbox` — drena manualmente o Gmail pra ver submissões antes de iniciar a edição.
   - `/diaria-log [edition] [level]` — lê `data/run-log.jsonl`; use quando algo der errado e quiser que eu investigue. Ex: `/diaria-log 260418 error`.
   - `/diaria-source-health [fonte]` — visão geral ou auditoria individual da saúde das fontes (successes, failures, timeouts, duração, últimas execuções). `data/sources/{slug}.jsonl` é o log append-only por fonte.
**Fim do dia:** `/diaria-overnight [--dry-run]` — fora do fluxo de edição. Varre as issues abertas, faz briefing interativo com o editor antes dele sair, e resolve a fila autonomamente até esgotá-la (PR → CI → auto-merge, 1 unidade por vez). Ao final, code-review consolidado do diff da noite + rascunho de relatório no Gmail + resumo no terminal (#2021).

**Watchdog de stall overnight (#2688):** `scripts/overnight-watchdog.ts` — roda via Task Scheduler a cada 10 min e detecta stall por tempo mesmo quando o coordenador está completamente parado (caso não coberto pelo #2379, que é event-driven). Arme local one-time: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\overnight\setup-watchdog-schedule.ps1`. Ver `docs/overnight-watchdog-setup.md`.

**Sync incremental diário do store Clarice (#2932):** `scripts/clarice-sync-brevo.ts --incremental` roda via Task Scheduler às 03:40 — sincroniza só os contatos MUDADOS desde o último sync (`modifiedSince` da Brevo, #2928), barato o suficiente pra diário (vs o full de ~44k chamadas). Mantém `send_eligible`/opt-outs/engajamento frescos pra dashboard + planejamento de audiência. Arme local one-time: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-clarice-sync-schedule.ps1`. Log em `data/clarice-subscribers/.brevo-sync-daily.log`. `local` (precisa do junction `data/` + `BREVO_CLARICE_API_KEY`).

**Sessão supervisionada:** `/diaria-develop [AAMMDD] [--issues N,M] [--only A-E] [--dry-run] [--no-implement] [--serial]` — o **espelho invertido do overnight** (#2636). Roda **com o editor presente** e ataca justamente o backlog **BLOQUEADO** (o que o overnight pula): credencial-runtime, conta-externa, decisão-produto, supervisão-blast-radius, plataforma-sem-fix (cat. A–E). O editor desbloqueia ao vivo (cola token, confirma conta, decide trade-off, autoriza blast-radius), a skill valida deterministicamente (#573) e leva ao merge reusando a maquinaria do overnight, **paralelizando tudo que for seguro** (worktrees concorrentes sem colisão de arquivo; teto 6, #2754; `--serial` desliga). Diferente do overnight, perguntar é permitido e central; nunca continua sem o editor.

**Retomar edição interrompida:** se você sair do Claude no meio de uma edição, basta rodar `/diaria-edicao {mesmo-AAMMDD}` de novo. O orchestrator detecta quais stages já completaram (via arquivos em `data/editions/{AAMMDD}/`) e retoma de onde parou. Se um stage foi interrompido no meio (antes de gravar seu output), ele só re-executa aquele stage, não o pipeline inteiro.

Outputs ficam em `data/editions/{AAMMDD}/` (ex: edição `260418/`) com sufixos numéricos por stage (`01-*`, `02-*`, etc.).

---

## Pipeline

**Todas as etapas implementadas:**

| # | Etapa | Subagentes / Scripts | Output |
|---|---|---|---|
| 1 | Pesquisa | N× `source-researcher` + M× `discovery-searcher` + `eia-composer` (em paralelo, É IA? em background) → `scripts/verify-accessibility.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `research-reviewer` → `scorer` → `scripts/render-categorized-md.ts` | `01-categorized.md` → `_internal/01-approved.json` |
| 2 | Escrita | **`writer-destaque` × 3** (paralelo, #1158/#1451) + `social-linkedin` + `social-facebook` em paralelo, todos a partir de `_internal/01-approved.json` → stitch + merge → humanizador × 2 → Clarice × 2 | `02-reviewed.md` + `03-social.md` |
| 3 | Imagens | É IA? gate (coleta `eia-composer` do background) + `scripts/image-generate.ts` × 3 destaques (Gemini/ComfyUI via `platform.config.json`) | `01-eia.md` + `01-eia-A/B.jpg` + `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` |
| 4 | Revisão (#1694) | pré-render técnico (HTML + imagens + upload Worker + close-poll) → resumo consolidado (destaques, títulos, lints, preview) → **gate humano pré-publicação** | `_internal/.step-4-done.json` + `_internal/newsletter-final.html` |
| 5 | Publicação (#1694) | `publish-newsletter` (Chrome → Beehiiv draft) + `scripts/publish-facebook.ts` (Graph API × 3, `--schedule`) + `scripts/publish-linkedin.ts` (Worker queue + Make webhook × 3) **em paralelo** → `review-test-email` (loop até 10×) | `_internal/05-published.json` + `_internal/06-social-published.json` |
| 6 | Agendamento (#1694) | resumo de agendamento → **gate humano** → Schedule Beehiiv → `verify-scheduled-post.ts` → auto-reporter → `send-edition-report.ts` | `_internal/05-published.json` (com `scheduled_at`) + `_internal/edition-report.html` |

**Sync com Google Drive (entre etapas):** **antes de cada gate** (etapas 1–4), `scripts/drive-sync.ts` sobe os outputs da etapa para `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/` — assim o editor pode revisar no celular antes de aprovar no terminal. **Antes de cada etapa** que consome inputs que podem ter sido editados no Drive (2, 3, 4, 5), um pull traz a versão mais recente para o local. Retry cria `.v2`, `.v3` (versões contadas via `push_count` no cache). Falha de sync vira warning, nunca bloqueia. Cache em `data/drive-cache.json` (gitignored). Credenciais OAuth em `data/.credentials.json` — gerado com `npx tsx scripts/oauth-setup.ts` (setup único; requer `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`).

**Reports Drive sync (fora do fluxo de edição):** `scripts/upload-report-to-drive.ts` cria novo Google Doc em `Work/Startups/diar.ia/relatorios/` (create-only — `--force` pra overwrite destrutivo). `scripts/sync-report.ts` faz 3-way merge entre local + snapshot + Drive Doc preservando edições do editor; salva snapshots em `.snapshots/{basename}.snapshot.md` ao lado do arquivo local. Usar `sync-report` pra updates subsequentes; `upload-report` só pra criação inicial.

---

## Regras invariáveis (consultar `context/editorial-rules.md`)

- Sem links de agregadores.
- Sem links de paywall marcados como acessíveis.
- Sem links repetidos das últimas 3 edições (verificado contra `data/past-editions.md`).
- Destaques com título ≤52 caracteres, 3 opções por destaque.
- "Por que isso importa:" em linha separada.
- Prompt de imagem: Van Gogh impasto, 2:1, SEM resolução em pixels, SEM Noite Estrelada.
- Output final sem markdown (nada de `**`, `#`, `- `).
- **LANÇAMENTOS só com link oficial** (#160). Cobertura de imprensa, blog pessoal, agregador → NOTÍCIAS. Validar com `scripts/validate-lancamentos.ts`.

## Princípios operacionais invariáveis

- **Nunca correr risco de ToS.** Qualquer automação de sites de terceiros (ChatGPT, Bing, Leonardo.ai, LinkedIn via puppeteer, etc.) via browser automation, scraping ou reverse-engineering de endpoints não-oficiais está **descartada por padrão**. Prefira: (a) API oficial com key, (b) free tier de plataforma que permita uso automatizado, (c) modelo local. Claude in Chrome **é aceitável** em sites onde o usuário está logado pessoalmente e o uso reflete interação humana natural (Beehiiv/LinkedIn post scheduling — volume baixo, ações editoriais, ToS aceitam uso de ferramentas de terceiro). **Nunca** em scale ou pra scraping.

- **Zero custo recorrente** como princípio editorial. Preferir: free tier oficial > API pay-per-call baixo custo > assinatura fixa. Escolhas acima de ~$50/ano precisam justificativa concreta.

- **Pipeline reproducible**: mudanças em agent prompts, config ou scripts devem ser committed + testadas; nunca rodadas direto de stash ou memória.

- **Sync de código no início de cada edição (#2686).** O Passo 0 de `/diaria-edicao` roda `npx tsx scripts/sync-code.ts` (wrapper de `scripts/lib/git-sync.ts`) antes de qualquer trabalho do Stage 0. Garante que o pipeline rode com a versão mais recente do código — rodadas overnight/develop mergeiam frequentemente e código defasado re-introduz bugs. Comportamento: fetch origin → se dirty, stash → pull --ff-only → stash pop; se branch != master, checkout master primeiro. **Fail-soft invariável**: qualquer falha de sync (offline, divergência, conflito de stash) vira warning e a edição prossegue normalmente — nunca bloqueia. Só no início, nunca mid-edição; idempotente em resume.

- **Data da edição é sempre explícita.** Skills `/diaria-*` que aceitam `AAMMDD` **nunca** inferem a partir de `today()` ou da edição mais recente em `data/editions/`. Se o usuário não passar a data, perguntar com sugestão de hoje/ontem como atalho mas exigir confirmação. Risco de rodar stage destrutivo/publicador (Stage 5) na edição errada é alto demais pra default silencioso.

  Exceção (#583): skills `/diaria-2-escrita`, `/diaria-3-imagens`, `/diaria-4-revisao`, `/diaria-5-publicacao`, `/diaria-6-agendamento` aceitam AAMMDD opcional. Se omitido, rodar `npx tsx scripts/lib/find-current-edition.ts --stage N` e — se exatamente 1 edição estiver em curso (prereq do stage atendido + output faltando) — assumir essa edição com info log. Caso 0 candidatos: erro. Caso ≥2: perguntar como antes. Stage 1 não muda — cria a edição.

- **Edição é sempre D+1.** A pesquisa (Etapa 1) é rodada no dia *anterior* à publicação — a data da edição é sempre **amanhã** (`today + 1 dia`), não hoje. Exemplo: se a rotina roda em 2026-04-26, a edição é `260427`. Isso vale para chamadas automáticas (CI, automação) e para chamadas manuais sem data explícita. Quando o usuário passar a data explicitamente, usar a data informada sem ajuste.

- **Atacar todas as issues que dá pra atacar autonomamente.** A mandato anterior de "autonomia ampla" se aplica a issues também: revisar a fila aberta, identificar quais não têm bloqueio externo (allowlist, conta de terceiro, decisão editorial específica), e atacar até o fim — Tier A + Tier B quando a direção da issue é clara. Issues com trade-off real (escolha entre opções genuinamente equivalentes que afetam usuários finais) ainda merecem consulta. Bloqueio externo verdadeiro (precisa do editor abrir conta, mexer em allowlist GitHub, dar input de produto que não foi documentado) → comentar na issue com o que falta e pular. Tudo mais: avançar.

- **Sempre indicar prioridade ao criar issues.** Nova issue **deve** entrar com 1 label `P0`/`P1`/`P2`/`P3` além do tipo (`enhancement`/`bug`/etc). Se a prioridade não estiver óbvia, sugerir uma com justificativa breve no corpo da issue (não deixar pra triagem depois). Default: `P2` pra bug com workaround / enhancement importante; `P3` pra cleanup, scoping, produto/decisão editorial; `P1` pra bug que afeta produção atual sem workaround; `P0` só pra fire (publicação corrompida, leak, etc).

- **Etapa 5 (publicadores) default = tudo automático (#336 invertido em #1326, #1694).** Stage 5 é dispatch — editor já revisou no gate do Stage 4 (Revisão). Default em modo interativo, em `auto_approve`, e em `--no-gates` é o mesmo: dispatchar nos 3 canais (newsletter Beehiiv via Worker-hosted, LinkedIn agendado 17:00 BRT, Facebook agendado via `--schedule`). **Fase 3 (fetch in-page do Worker) recuperada desde #2550 (260625, `tr.insertText` em vez de `editor.commands.insertContent`) e reconfirmada em #2500 (`/diaria-develop` 260701, re-teste ao vivo: 200 OK, corpo completo).** Metadados de post (subject/preview/slug/capa) continuam manuais na UI do Beehiiv — `edit_post`/`save_post` seguem gated pelo plano Launch/free, decisão final (#2501) foi manter esse fluxo manual sem upgrade — ver `context/publishers/beehiiv-playbook.md`. Editor pode opt-out por canal via flag `--skip {newsletter,linkedin,facebook}` ou via gate interativo (`/diaria-5-publicacao` apresenta menu numérico). Se editor não responder no gate, fallback é tudo auto. Blast radius alto mas mitigado: Beehiiv sai como rascunho (com test email loop antes do schedule), LinkedIn agenda 24h+ à frente, Facebook é agendado — todos reversíveis por ação do editor no dashboard de cada plataforma. Logar source da decisão em `_internal/05-publish-consent.json` (`source: "default_auto" | "skip_flag_X" | "editor_response_X" | "auto_approve_default"`). O Schedule do Beehiiv (agendamento final da newsletter) ocorre no Stage 6 com gate humano; com `--no-gates` é auto-agendado para amanhã 06:00 BRT.

- **Pull antes de editar arquivo que existe no Drive (#494).** Antes de usar `Edit` ou `Write` em qualquer arquivo que o editor pode ter modificado no Google Drive (`01-categorized.md`, `02-reviewed.md`, `03-social.md`), sempre fazer pull para trazer a versão mais recente: `npx tsx scripts/drive-sync.ts --mode pull --edition-dir {edition_dir} --stage {N} --files {arquivo}`. Nunca assumir que o arquivo local está atualizado.

- **Edições em arquivos Drive são sempre cirúrgicas (#495).** Ao modificar um arquivo que o editor pode ter editado, usar substituições linha a linha (`Edit` com `old_string` mínimo) em vez de substituir blocos grandes. Nunca incluir no `old_string` linhas que o editor pode ter alterado além das linhas que precisam mudar.

- **Publicação manual requer refresh-dedup.** Sempre que uma edição for publicada manualmente no Beehiiv (sem `/diaria-5-publicacao`), rodar `/diaria-refresh-dedup` imediatamente após para manter `data/past-editions.md` atualizado. Sem isso, a próxima edição pode repetir URLs já publicadas.

- **Publicação manual requer prep-manual-publish.ts antes (#1044, #1047, refatorado #1185, simplificado #1186).** Sempre que for publicar manualmente no Beehiiv, **antes** do paste no template, rodar `npx tsx scripts/prep-manual-publish.ts --edition AAMMDD`. O script valida pré-condições (newsletter-final.html tem merge tag `{{email}}`, Worker disponível) e imprime instruções step-by-step (URL do template, file path do HTML, comando close-poll após publicar). Modo merge-tag (#1186): a URL de voto usa `{{email}}` sem sig HMAC — `inject-poll-sig.ts` foi removido. Após publicar, rodar `npx tsx scripts/close-poll.ts --edition AAMMDD`.

- **Validar afirmações de subagent sobre estado externo via TS determinístico antes de relayar pro editor (#573).** Subagentes (especialmente Haiku) podem etiquetar mal estados ambíguos — ex: `status: "confirmed"` na Beehiiv API significa "agendado-na-fila" OU "já-enviado", indistinguíveis sem checar `publish_date` contra `now`. Sempre que o orchestrator (top-level) for relayar fato sobre Beehiiv/LinkedIn/Facebook ao editor, validar o timestamp/state via comparação determinística em TS (helpers em `scripts/lib/publish-state.ts` — `resolveBeehiivState`, `resolveLinkedInState`, `resolveFacebookState`, todos retornam `PublishState = 'draft' | 'scheduled' | 'published' | 'sent' | 'unknown'`) — não só ler o gloss do agent. Se o agent diz "X publicado", chamar o helper antes de afirmar isso. Falha desse guard em 2026-05-05: orchestrator afirmou "3 edições publicadas" baseado em `status: confirmed`, mas uma estava 16h no futuro (agendamento, não publicação).

- **Decisão de próxima wave da migração Clarice consulta dashboard, não memória (#1172).** Antes de propor lista/horário/cadência da próxima wave, fetch `https://clarice-dashboard.diaria.workers.dev/api/campaigns?limit=5` pra extrair última lista usada (próxima é list_id + 1 na série T1-W1 ... T1-W6) e padrão de horário das últimas N waves. Nunca usar memória da sessão como fonte primária — ela degrada entre sessões e dei lista correta + horário errado em 260512 baseado em recall (achei noturno 19h, real era manhã 06:00 BRT). Dashboard é fresh fetch da Brevo, autoritativo. Métricas de saúde também vêm de lá (circuit breakers já mostram alerta vermelho se cruzou threshold).

- **Verificar emails no MillionVerifier antes de enviar cohorts não-assinantes (#1297, nomenclatura de cohort desde #2857 fase C).** Antes do primeiro envio de qualquer wave que inclua contatos não-assinantes (ex-assinantes / leads — `verify_risk ≥ 3`), rodar `npx tsx scripts/verify-emails-mv.ts --cycle {conteúdo}-{envio} --input stripe-export-ex-assinantes.csv` (ex: `--cycle 2605-06`; pra outro cohort, use o slug gerado pela merge — `ls data/clarice-subscribers/stripe-export-*`). O input é a base (cohort no root, **nome = slug do cohort** `stripe-export-{cohort}.csv`, ex: `stripe-export-leads-2026-06.csv`); as saídas verificadas vão pra subpasta do ciclo `data/clarice-subscribers/{conteúdo}-{envio}/` (#1961 — `{conteúdo}` = mês do digest, `{envio}` = mês do disparo, que é o seguinte). O script verifica cada email via MillionVerifier (resumível via checkpoint `.mv-cache-*.json` — re-rodar não re-gasta crédito), e divide em verified (`ok`+`catch_all` → mandar pro Brevo), rejected (`invalid`+`disposable` → excluir) e unknown (inconclusivo). **Proveniência no nome:** as saídas trocam o prefixo `stripe-export-` → `mv-export-` (são output do MV) — ex: `mv-export-ex-assinantes-verified.csv`. Importar **só o `-verified.csv`** no Brevo. Sem isso, bounce de 5–10% em ex-assinantes degrada a reputação do IP/domínio e contamina os assinantes-ativos no mesmo IP. `assinantes-ativos` (`verify_risk 1`) pula a verificação — pagamento Stripe já valida implicitamente. Requer `MILLION_VERIFIER_API_KEY` no env (custo one-time ~$1.90/1000). **Os 3 scripts do ciclo exigem `--cycle {conteúdo}-{envio}`** (#1961): `verify-emails-mv` (escreve `mv-export-ex-assinantes-verified.csv` no `{ciclo}/`), depois `clarice-build-waves-store --cycle ... --budget N [--wave-size N]` (#2656 cutover — sucessor único desde #2844/260702; lê o STORE único de contatos, não os CSVs por cohort; corte por `send_eligible`, ordem por `priority_points`/`cohort`; escreve `wN-store.csv` + `waves-manifest.json` em `{ciclo}/waves/`), depois `clarice-import-waves --cycle ...` (lê `{ciclo}/waves/` via manifest). O `--cycle` é validado (formato + envio = conteúdo+1) — typo de mês aborta limpo.

- **MCP indisponível = fail-fast, nunca stall (#738).** Se qualquer chamada `mcp__*` retornar erro de disconnect/unavailable (ou se um `<system-reminder>` do runtime indicar que um MCP ficou offline durante a sessão), o comportamento correto é **imediatamente**: (a) parar o stage atual, (b) renderizar halt banner via `npx tsx scripts/render-halt-banner.ts --stage "{N} — {nome}" --reason "mcp__{servidor} desconectado" --action "reconecte e responda 'retry', ou 'abort' para abortar"` (#737), (c) aguardar resposta explícita antes de qualquer ação adicional. **Nunca aguardar passivamente.** Sistema reminders sobre MCP devem ser tratados como mensagem de erro do usuário, não como contexto ignorável. Stall silencioso > 60s é inaceitável — aplica-se a todos os MCPs: clarice, beehiiv, gmail, claude-in-chrome, Google Drive. Detalhes por stage: Stage 0 depende de beehiiv + gmail; Stage 2 depende de clarice; Stage 5 depende de beehiiv (Chrome) + gmail. **Outras paradas inesperadas** (subagent error/timeout, exception não-tratada, ratelimit persistente, loop verify→fix esgotado): mesma regra — render halt banner com motivo + ação específica antes de aguardar input.

- **1 PR aberto por vez (#636).** Mergear antes de abrir o próximo. Refactors em `scripts/lib/` bloqueiam outros PRs até mergear — anunciar no commit message quando isso se aplicar. Exceções: hotfix P0 (pode ser aberto em paralelo a feature PR, com merge prioritário), docs-only PRs (CLAUDE.md, README), bot PRs (Dependabot).

- **PR de bugfix exige teste de regressão (#633).** Sem teste novo demonstrando que o bug não voltaria → não merge. Se não for possível testar (ex: agent prompt), justificar explicitamente no PR body. Cobre o padrão recorrente "fix → close → reaparece semanas depois".

- **Digest mensal: Drive sync inclui só Doc editorial + imagens (#1022).** O HTML render (`preview.html`, `preview-list*.html`, e — desde #2793 — `_internal/cloudflare-preview.html` da Etapa 4 Revisão consolidada) é exclusivamente local — input direto do Brevo, nunca sobe pro Drive. O editor revisa o Google Doc (`Edição {Mês}/{Mês} v{N}`), não o HTML. Análogo à convenção `_internal/*` (#959): só sobe pro Drive o que o editor de fato edita.

- **Digest mensal: etapas espelham a numeração da diária (#2795).** `/diaria-mensal` adota o mesmo esquema de 6 etapas + checkpoints da diária (#1694): 0 Preflight, 1 Coleta/Análise, 2 Escrita, 3 Imagens, 4 Revisão consolidada (gate humano — pré-render completo + lint + fact-check, #2793), 5 Publicação Brevo. Checkpoints `_internal/.step-N-done.json` no mesmo formato do diário (`scripts/lib/pipeline-state.ts`), só que sob `data/monthly/{ciclo}/`. Ver `.claude/skills/diaria-mensal/SKILL.md`.

- **Label `local` — issues que requerem sessão local (#2643).** Sessões podem rodar em cloud (container efêmero, clone fresco) ou localmente (máquina do editor). Issues com label **`local`** dependem de recursos machine-local — junction `data/` (OneDrive), ComfyUI, credenciais persistidas, Task Scheduler, etc. — e **não fecham em sessão cloud**. O sinal canônico de detecção é a presença do junction `data/` como diretório acessível: `npx tsx scripts/lib/exec-mode.ts` imprime `local` ou `cloud` (helper testável em `scripts/lib/exec-mode.ts`). **`/diaria-overnight` em cloud:** issues `local` → puladas com motivo `requer-sessao-local` (comentário na issue com dedup). **`/diaria-overnight` local:** issues `local` → elegíveis normalmente. **`/diaria-develop`:** roda por natureza local — issues `local` são elegíveis; a label é informacional aqui. **Quando aplicar:** implementação ou teste requer qualquer recurso ausente num clone fresco — `data/`, ComfyUI, OneDrive, credenciais locais não-gitadas, Task Scheduler, ou path local do editor.

---

## Otimização de tokens

Todo arquivo em `context/` entra no prompt cache. Mantenha esses arquivos **curados** — mudanças invalidam o cache.

Model mix (definido no frontmatter de cada agente):
- **Opus 4.8** (#1951) — `orchestrator`, `scorer-select` (chunked-parallel, #1611), `analyst-monthly` + `scorer-monthly` (pipeline mensal). Decisão editorial pós-gate de julgamento holístico (seleção subjetiva, coordenação, diversidade temática), volume baixo, alto impacto em CTR — #159.
- **Sonnet 5** (#2745) — `writer`, `writer-destaque`, `writer-monthly`, `publish-social`, `social-linkedin`, `social-facebook`, `fact-checker`, `scorer`, `scorer-chunk`, `title-picker` (#2772 — migrados de Opus: pontuação contra rubrico explícito / escolha entre opções já escritas, mais mecânico que julgamento holístico). (`publish-newsletter` migrou pra playbook lido pelo top-level em #1054; movido pra `context/publishers/beehiiv-playbook.md` em #1114.)
- **Haiku 4.5 (shorthand `haiku`, auto-tracks latest stable)** — `source-researcher`, `discovery-searcher`. Dedup, Clarice, geração de imagem, link-verifier, categorizer, drive-sync, inbox-drain e eia-composer (#1111) foram migrados para scripts TS — não são mais agentes LLM.
- **Haiku 4.5 (pinned `claude-haiku-4-5-20251001`)** — `research-reviewer` (lógica de raciocínio estruturado; re-avaliar pin a cada release).
- **Subagentes ad-hoc (`general-purpose`) SEMPRE com `model` explícito (#2019)** — sessões em modelo que só aceita thinking enabled/adaptive (ex: `claude-fable-5`) quebram com `400 'thinking.type.disabled' is not supported` quando o launcher herda o modelo sem override. Vale principalmente pra finders/verifiers de `/code-review` e subagentes de skills (overnight usa `sonnet`). Se o erro aparecer: retry com `model: "sonnet"` explícito.

---

## Estrutura

```
.claude/
  agents/         # subagentes (1 arquivo = 1 subagente)
  skills/         # slash commands invocáveis (1 diretório com SKILL.md = 1 skill)
  settings.json   # permissions, hooks
.mcp.json         # MCPs: clarice, beehiiv, playwright, sd-local
context/          # carregado no system prompt → cacheado
  editorial-rules.md
  audience-profile.md   # gerado
  sources.md             # gerado de seed/sources.csv
  templates/
  publishers/            # roteiros Claude in Chrome por plataforma (Beehiiv, LinkedIn, Facebook)
seed/sources.csv  # 35 fontes iniciais
scripts/          # utilitários TypeScript (Node)
  lib/shared/     # genérico usado por diária E mensal (design-tokens, newsletter-styles) — NÃO importa de diaria/ nem mensal/
  lib/mensal/     # mensal-específico (monthly-*) — cruzamento com diária só via shared/
  lib/diaria/     # (futuro) diária-específico; raiz de lib/ = legado não-classificado, migra sob demanda
                  # Fronteira lint-enforced por test/lib-boundary.test.ts (#2747): import cruzado quebra o teste —
                  # a falha força a pergunta "isso devia ser genérico?" (aí move pra shared/ via git mv)
data/past-editions.md    # gerado (#1847: movido de context/ — regenera todo Stage 0, não cacheado)
data/editions/{AAMMDD}/  # outputs por edição (gate-facing no root, pipeline internals em _internal/)
platform.config.json     # { newsletter: "beehiiv", socials: [...] }
```

---

## Estado atual

**Pipeline completo implementado** (6 etapas, #1694). Fluxo: Pesquisa → Escrita → Imagens → Revisão (gate humano pré-publicação) → Publicação (Beehiiv draft + social agendado, auto) → Agendamento (gate humano: Schedule Beehiiv + auto-reporter). Gates humanos: Stage 4 (revisão editorial) e Stage 6 (agendamento final).
