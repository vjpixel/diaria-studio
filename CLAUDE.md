# Diar.ia Studio

Projeto Claude Code fim-a-fim para produção da newsletter **Diar.ia** (diar.ia.br).

O fluxo editorial é modelado como 6 etapas com gate humano em 2 delas (Stage 4: revisão; Stage 6: agendamento). A execução acontece via skills (`/diaria-edicao`, `/diaria-1-pesquisa`, etc.) que disparam um orquestrador; o orquestrador distribui trabalho para subagentes especializados em paralelo quando possível.

---

## Como usar

**Setup (1x):**
1. Exportar `CLARICE_API_KEY` no ambiente do shell. **Uma key serve os dois caminhos** da Clarice: o MCP (`.mcp.json` manda no header `X-Clarice-Api-Key`, via `${CLARICE_API_KEY}`) e o REST fallback (`scripts/clarice-correct.ts` → `cortex.clarice.ai`). Pegue a sua em https://cortex.clarice.ai (cada usuário usa a própria — o servidor é passthrough, não tem key compartilhada). No Windows (persistente, requer reabrir o terminal):
   ```powershell
   [Environment]::SetEnvironmentVariable("CLARICE_API_KEY", "SEU_TOKEN_AQUI", "User")
   ```
   Sem ela o invariant `clarice-key-set` **halta a pipeline no Stage 0**. Veja `.env.example`.
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
3a. **Instalar a skill `humanizador`** (repo separado, instalação global — não é vendorada aqui, ver #1676):
   ```bash
   git clone https://github.com/vjpixel/humanizador.git ~/.claude/skills/humanizador
   ```
   **Não é opcional:** o Stage 2 invoca `Skill("humanizador", …)` 2× (newsletter + social) e, por decisão do #1072, ausência/no-op = **abort do Stage 2** após 3 retries — nunca fallback silencioso. `verify-stage-2` também trata `02-humanized.md ≠ 02-normalized.md` como invariante. Confirme com `/humanizador` ou reabrindo o Claude Code.
4. Abrir Claude Code neste diretório: `cd diaria-studio && claude`.
5. Confirmar que os MCPs estão ativos: `/mcp` deve listar `clarice` (HTTP, de `.mcp.json` — header-auth via `${CLARICE_API_KEY}`, **não** OAuth), `claude.ai Beehiiv` e `claude.ai Gmail` (conectores nativos). Para Fase 2 (imagens), instalar ComfyUI local (ver `docs/comfyui-setup.md`). Para Fase 3 (publicação), instalar e logar a extensão `Claude in Chrome` em Beehiiv/LinkedIn/Facebook (ver `docs/browser-publish-setup.md`).
6. **Inbox editorial** (`diariaeditor@gmail.com`): nenhum setup necessário — o drain busca direto na pasta Enviados da conta pessoal (ver `docs/gmail-inbox-setup.md`). Isso permite enviar links/temas durante o dia que são considerados na próxima edição automaticamente.
7. Rodar `/diaria-atualiza-audiencia` para importar respostas de survey do Beehiiv em `data/audience-raw.json` (re-rodar semanalmente ou quando quiser recalibrar). O `context/audience-profile.md` é regenerado automaticamente no Stage 0, combinando CTR comportamental (primário) e survey (secundário).

**Para cada nova edição:**
1. `/diaria-edicao AAMMDD [--no-gates]` — roda todos os stages em sequência. O próprio orchestrator regenera `data/past-editions.md` (Stage 0) e drena o inbox editorial (`diariaeditor@gmail.com`, Stage 1) automaticamente. Com `--no-gates`, auto-aprova todos os gates humanos mas mantém social scheduling normal.
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
**Fim do dia:** `/diaria-overnight [--dry-run]` — fora do fluxo de edição. Varre as issues abertas, faz briefing interativo com o editor antes dele sair, e resolve a fila autonomamente até esgotá-la (PR → CI → auto-merge, 1 unidade por vez). Ao final, code-review consolidado do diff da noite + registro do relatório na superfície de Relatórios do Studio (`/relatorios`, #3714) + resumo no terminal (#2021).

**Watchdog de stall overnight (#2688):** `scripts/overnight-watchdog.ts` — roda via Task Scheduler a cada 10 min e detecta stall por tempo mesmo quando o coordenador está completamente parado (caso não coberto pelo #2379, que é event-driven). Arme local one-time: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\overnight\setup-watchdog-schedule.ps1`. Ver `docs/overnight-watchdog-setup.md`.

**Sync incremental diário do store Clarice (#2932):** a task `Diaria-Clarice-Sync` roda via Task Scheduler às 03:40 e faz **dois passos** (`scripts/run-clarice-sync-daily.ps1`): (1) `clarice-sync-brevo.ts --incremental` sincroniza só os contatos MUDADOS desde o último sync (`modifiedSince` da Brevo, #2928 — barato, vs o full de ~44k chamadas) → atualiza o **store** (SQLite); (2) `clarice-db-summary.ts` empurra o summary pra **KV** → atualiza a **dashboard**. Store e KV são superfícies SEPARADAS: sem o passo 2 a dashboard fica defasada mesmo com o store fresco. Arme local one-time: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-clarice-sync-schedule.ps1`. Log em `data/clarice-subscribers/.brevo-sync-daily.log`. `local` (precisa do junction `data/` + `BREVO_CLARICE_API_KEY` + creds Cloudflare).

**Sessão supervisionada:** `/diaria-develop [AAMMDD] [--issues N,M] [--only A-E] [--dry-run] [--no-implement] [--serial]` — o **espelho invertido do overnight** (#2636). Roda **com o editor presente** e ataca justamente o backlog **BLOQUEADO** (o que o overnight pula): credencial-runtime, conta-externa, decisão-produto, supervisão-blast-radius, plataforma-sem-fix (cat. A–E). O editor desbloqueia ao vivo (cola token, confirma conta, decide trade-off, autoriza blast-radius), a skill valida deterministicamente (#573) e leva ao merge reusando a maquinaria do overnight, **paralelizando tudo que for seguro** (worktrees concorrentes sem colisão de arquivo; teto 6, #2754; `--serial` desliga). Diferente do overnight, perguntar é permitido e central; nunca continua sem o editor.

**Retomar edição interrompida:** se você sair do Claude no meio de uma edição, basta rodar `/diaria-edicao {mesmo-AAMMDD}` de novo. O orchestrator detecta quais stages já completaram (via arquivos em `data/editions/{AAMMDD}/`) e retoma de onde parou. Se um stage foi interrompido no meio (antes de gravar seu output), ele só re-executa aquele stage, não o pipeline inteiro.

Outputs ficam em `data/editions/{AAMMDD}/` (ex: edição `260418/`) com sufixos numéricos por stage (`01-*`, `02-*`, etc.).

---

## Pipeline

**Todas as etapas implementadas:**

| # | Etapa | Subagentes / Scripts | Output |
|---|---|---|---|
| 1 | Pesquisa | N× `source-researcher` + M× `discovery-searcher` + `eia-composer` (em paralelo, É IA? em background) → `scripts/verify-accessibility.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `research-reviewer` → `scorer` → `scripts/render-categorized-md.ts` | `01-categorized.md` → `_internal/01-approved.json` |
| 2 | Escrita | **`writer-destaque` × 3** (paralelo, #1158/#1451) + `social-linkedin` + `social-facebook` + `social-instagram` (#3486) em paralelo, todos a partir de `_internal/01-approved.json` → stitch + merge → humanizador × 2 → Clarice × 2 | `02-reviewed.md` + `03-social.md` |
| 3 | Imagens | É IA? gate (coleta `eia-composer` do background) + `scripts/image-generate.ts` × 3 destaques (Gemini/ComfyUI via `platform.config.json`) | `01-eia.md` + `01-eia-A/B.jpg` + `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` |
| 4 | Revisão (#1694) | pré-render técnico (HTML + imagens + upload Worker + close-poll) → resumo consolidado (destaques, títulos, lints, preview) → **gate humano pré-publicação** | `_internal/.step-4-done.json` + `_internal/newsletter-final.html` |
| 5 | Publicação (#1694) | `publish-newsletter` (Chrome → Beehiiv draft) + `scripts/publish-facebook.ts` (Graph API × 3, `--schedule`) + `scripts/publish-linkedin.ts` (Worker queue + Make webhook × 3) **em paralelo** → `review-test-email` (loop até 10×) | `_internal/05-published.json` + `_internal/06-social-published.json` |
| 6 | Agendamento (#1694) | resumo de agendamento → **gate humano** → Schedule Beehiiv → `verify-scheduled-post.ts` → auto-reporter → `send-edition-report.ts` | `_internal/05-published.json` (com `scheduled_at`) + `_internal/edition-report.html` |

**Revisão fora do terminal (mobile) — só pipeline DIÁRIO (#3636, #3729):** o Studio (`npm run studio`, acesso remoto via Cloudflare Tunnel desde #3560) cobre a revisão/edição dos outputs de cada etapa fora do terminal — inclusive no celular. O Google Drive sync que cumpria esse papel antes do Studio existir foi aposentado da edição **diária** (#3636); nenhuma etapa de `/diaria-edicao`/`/diaria-N-*` invoca mais `scripts/drive-sync.ts` automaticamente. **O digest MENSAL continua 100% dependente do Drive** — `.claude/skills/diaria-mensal/SKILL.md` tem 4 call sites ativos de `drive-sync.ts --mode push/pull` (Etapas 1, 2, 4 e 5), porque o Studio ainda não cobre a revisão do fluxo mensal. `scripts/drive-sync.ts` e `scripts/oauth-setup.ts` **não são código morto** — não remover nem tratar como legado sem checar `/diaria-mensal` primeiro (achado #3729, review consolidado 260719).

**Reports Drive sync — descontinuado (#3713).** `scripts/upload-report-to-drive.ts` e `scripts/sync-report.ts` (Google Doc em `Work/Startups/diar.ia.br/relatorios/`) foram removidos — mecanismo confirmado sem uso ad-hoc fora do fluxo de relatório de fim-de-trabalho, que está migrando pra superfície própria no Studio (#3714, em progresso). Docs já criados no Drive permanecem como estão (histórico), sem ação automática sobre eles. A árvore de edições (`edicoes/{YYMM}/{AAMMDD}/`) segue no Drive até arquivamento manual pelo editor (mover pra `_arquivo/`, #3713).

---

## Regras invariáveis (consultar `context/editorial-rules.md`)

- Sem links de agregadores.
- Sem links de paywall marcados como acessíveis.
- Sem links repetidos das últimas 3 edições (verificado contra `data/past-editions.md`).
- Destaques com título ≤52 caracteres, 3 opções por destaque.
- **Edição tem sempre 2 ou 3 destaques, nunca 4 (#3369).** 3 é o padrão; 2 é o único edge case legítimo (editor demove D3 para o Radar, #2316/#2343). Promover um item do pool (RADAR/USE MELHOR/etc.) a destaque **substitui** um D1/D2/D3 existente — nunca adiciona um D4 (perguntar ao editor qual substituir quando não for óbvio). Enforcement: `scripts/extract-destaques.ts` rejeita qualquer contagem fora do intervalo 2–3.
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

- **Sempre indicar prioridade ao criar issues.** Nova issue **deve** entrar com 1 label `P0`/`P1`/`P2`/`P3` além do tipo (`enhancement`/`bug`/etc). Se a prioridade não estiver óbvia, sugerir uma com justificativa breve no corpo da issue (não deixar pra triagem depois). Default: `P2` pra bug com workaround / enhancement importante; `P3` pra cleanup, scoping, produto/decisão editorial; `P1` pra bug que afeta produção atual sem workaround; `P0` só pra fire (publicação corrompida, leak, etc). **Nunca perguntar se deve criar a issue** — em sessões autônomas (overnight/develop) a pergunta em si já é a resposta (sim); o único gate real é a prioridade, que vem com justificativa no corpo, não confirmação prévia do editor (incidente 260706/07, travou `/diaria-overnight` ~8h por uma confirmação desnecessária — ver Regra 1 de `.claude/skills/diaria-overnight/SKILL.md`).

- **Etapa 5 (publicadores) default = tudo automático (#336 invertido em #1326, #1694).** Stage 5 é dispatch — editor já revisou no gate do Stage 4 (Revisão). Default em modo interativo, em `auto_approve`, e em `--no-gates` é o mesmo: dispatchar nos 3 canais (newsletter Beehiiv via Worker-hosted, LinkedIn agendado 17:30 BRT, Facebook agendado via `--schedule`). **Fase 3 (fetch in-page do Worker) recuperada desde #2550 (260625, `tr.insertText` em vez de `editor.commands.insertContent`) e reconfirmada em #2500 (`/diaria-develop` 260701, re-teste ao vivo: 200 OK, corpo completo).** Metadados de post (subject/preview/slug/capa) continuam manuais na UI do Beehiiv — `edit_post`/`save_post` seguem gated pelo plano Launch/free, decisão final (#2501) foi manter esse fluxo manual sem upgrade — ver `context/publishers/beehiiv-playbook.md`. Editor pode opt-out por canal via flag `--skip {newsletter,linkedin,facebook}` ou via gate interativo (`/diaria-5-publicacao` apresenta menu numérico). Se editor não responder no gate, fallback é tudo auto. Blast radius alto mas mitigado: Beehiiv sai como rascunho (com test email loop antes do schedule), LinkedIn agenda 24h+ à frente, Facebook é agendado — todos reversíveis por ação do editor no dashboard de cada plataforma. Logar source da decisão em `_internal/05-publish-consent.json` (`source: "default_auto" | "skip_flag_X" | "editor_response_X" | "auto_approve_default"`). O Schedule do Beehiiv (agendamento final da newsletter) ocorre no Stage 6 com gate humano; com `--no-gates` é auto-agendado para amanhã 06:00 BRT.

- **Edições em arquivos que o editor pode ter editado são sempre cirúrgicas (#495).** Ao modificar um arquivo que o editor pode ter editado, usar substituições linha a linha (`Edit` com `old_string` mínimo) em vez de substituir blocos grandes. Nunca incluir no `old_string` linhas que o editor pode ter alterado além das linhas que precisam mudar.

- **Conflito editor(Studio)×pipeline em `02-reviewed.md`/`03-social.md`: warn-before-save implementado, sentido inverso continua risco aceito (#3729).** A retirada do Drive sync (#3636) removeu o único mecanismo que existia pra esse cenário — o push do Stage 2 rodava com `--on-conflict pull-merge --fail-on-conflict` (3-way merge + halt banner quando editor e pipeline tocavam a mesma região). Investigado no #3729 (rodada overnight 260719/20): um lockfile análogo ao já usado em `scripts/lib/social-published-store.ts` não é viável aqui porque o lado pipeline escreve via `Edit`/`Write` do agente (LLM tool call), não via script interceptável que possa checar/segurar um lock. A mitigação implementada (decisão `/diaria-develop` 260720) foi **warn-before-save no client do Studio**, reusando o padrão do guard de divergência já usado pro slug `html-final` (#3635): `GET .../review/:slug` retorna `modifiedAt` (mtime do arquivo no momento da leitura); o painel guarda esse valor e reenvia como `expectedModifiedAt` no `PUT .../review/:slug`; `saveReviewFile` (`scripts/studio-ui/studio-review.ts`) compara contra o mtime ATUAL em disco e recusa o write com `{conflict: true}` se divergir (o handler HTTP em `server.ts` responde 409) — o write NUNCA é feito silenciosamente por cima. O painel (`scripts/studio-ui/public/revisao.js`) trata o 409 com um dialog (`SAVE_CONFLICT_CONFIRM_MESSAGE` em `revisao-guards.js`): OK sobrescreve mesmo assim (retry com `force: true`), Cancelar recarrega a versão do disco descartando a edição local não salva. **Escopo explícito, ainda parcial:** isto protege só o save do EDITOR sobrescrever uma escrita do PIPELINE. O sentido inverso — pipeline sobrescrevendo uma edição do editor feita no Studio mas ainda não vista pelo pipeline — **não é coberto** (o pipeline escreve via `Edit`/`Write` do agente, sem esse ponto de interceptação) e continua risco aceito, mitigado pela mesma janela estreita de tempo-real do Studio (segundos, não as horas do Drive assíncrono antigo). Se o editor notar perda de edição no sentido inverso, reportar em issue nova.

- **Publicação manual requer refresh-dedup.** Sempre que uma edição for publicada manualmente no Beehiiv (sem `/diaria-5-publicacao`), rodar `/diaria-refresh-dedup` imediatamente após para manter `data/past-editions.md` atualizado. Sem isso, a próxima edição pode repetir URLs já publicadas.

- **Publicação manual requer prep-manual-publish.ts antes (#1044, #1047, refatorado #1185, simplificado #1186).** Sempre que for publicar manualmente no Beehiiv, **antes** do paste no template, rodar `npx tsx scripts/prep-manual-publish.ts --edition AAMMDD`. O script valida pré-condições (newsletter-final.html tem merge tag `{{email}}`, Worker disponível) e imprime instruções step-by-step (URL do template, file path do HTML, comando close-poll após publicar). Modo merge-tag (#1186): a URL de voto usa `{{email}}` sem sig HMAC — `inject-poll-sig.ts` foi removido. Após publicar, rodar `npx tsx scripts/close-poll.ts --edition AAMMDD`. **`close-poll.ts` sincroniza `intentional-errors.jsonl` automaticamente (#3210)** — chama `sync-intentional-error.ts` internamente (idempotente, fail-soft) então o gabarito do "ache o erro" fica registrado mesmo sem passar pelo playbook automático (`beehiiv-playbook.md` §0.1, que só roda no fluxo `/diaria-5-publicacao`). Antes do #3210, publicação manual nunca sincronizava a entry — o jsonl ficava com buraco e §0-replies (Stage 0) não conseguia creditar leitor que acertasse o erro dessa edição.

- **Validar afirmações de subagent sobre estado externo via TS determinístico antes de relayar pro editor (#573).** Subagentes (especialmente Haiku) podem etiquetar mal estados ambíguos — ex: `status: "confirmed"` na Beehiiv API significa "agendado-na-fila" OU "já-enviado", indistinguíveis sem checar `publish_date` contra `now`. Sempre que o orchestrator (top-level) for relayar fato sobre Beehiiv/LinkedIn/Facebook ao editor, validar o timestamp/state via comparação determinística em TS (helpers em `scripts/lib/publish-state.ts` — `resolveBeehiivState`, `resolveLinkedInState`, `resolveFacebookState`, todos retornam `PublishState = 'draft' | 'scheduled' | 'published' | 'sent' | 'unknown'`) — não só ler o gloss do agent. Se o agent diz "X publicado", chamar o helper antes de afirmar isso. Falha desse guard em 2026-05-05: orchestrator afirmou "3 edições publicadas" baseado em `status: confirmed`, mas uma estava 16h no futuro (agendamento, não publicação).

- **Decisão de próxima wave da migração Clarice consulta dashboard, não memória (#1172).** Antes de propor lista/horário/cadência da próxima wave, fetch `https://clarice-dashboard.diaria.workers.dev/api/campaigns?limit=5` pra extrair última lista usada (próxima é list_id + 1 na série T1-W1 ... T1-W6) e padrão de horário das últimas N waves. Nunca usar memória da sessão como fonte primária — ela degrada entre sessões e dei lista correta + horário errado em 260512 baseado em recall (achei noturno 19h, real era manhã 06:00 BRT). Dashboard é fresh fetch da Brevo, autoritativo. Métricas de saúde também vêm de lá (circuit breakers já mostram alerta vermelho se cruzou threshold).

- **Verificar emails no MillionVerifier antes de enviar cohorts não-assinantes (#1297, nomenclatura de cohort desde #2857 fase C; fonte migrada de CSV pro store em #2886 PR3).** Antes do primeiro envio de qualquer wave que inclua contatos não-assinantes (ex-assinantes / leads — `verify_risk ≥ 3`), rodar `npx tsx scripts/verify-emails-mv.ts --cycle {conteúdo}-{envio} --cohort ex-assinantes` (ex: `--cycle 2605-06`; pra outro cohort, use o slug canônico, um alias pt-BR ou a forma YYYY-MM — resolvido via `resolveCohortArg`, o mesmo helper de `clarice-build-waves-store.ts`/`clarice-build-edition-sends.ts`, ver `scripts/lib/cohorts.ts` e `scripts/lib/clarice-segment.ts`). A lista de candidatos vem DIRETO do store (`clarice_users` WHERE `cohort = ? AND (mv_bucket IS NULL OR mv_bucket = '')`) — não mais de um CSV `stripe-export-{cohort}.csv`. Uma invocação com o `--input` antigo agora aborta com erro explícito em vez de cair silenciosamente no `--cohort` default. **Semântica "skip forever" (decisão do editor, #2886):** um contato já verificado em QUALQUER ciclo anterior nunca é re-verificado, mesmo em ciclos futuros — mais barato, assume que validade de email não degrada. As saídas continuam CSV como TRANSPORT, na subpasta do ciclo `data/clarice-subscribers/{conteúdo}-{envio}/` (#1961 — `{conteúdo}` = mês do digest, `{envio}` = mês do disparo, que é o seguinte). O script verifica cada email via MillionVerifier (resumível via checkpoint `.mv-cache-*.json` — re-rodar não re-gasta crédito), e divide em verified (`ok`+`catch_all` → mandar pro Brevo), rejected (`invalid`+`disposable` → excluir) e unknown (inconclusivo). As saídas usam o prefixo `mv-export-{cohort}` (são output do MV) — ex: `mv-export-ex-assinantes-verified.csv`. Importar **só o `-verified.csv`** no Brevo. Sem isso, bounce de 5–10% em ex-assinantes degrada a reputação do IP/domínio e contamina os assinantes-ativos no mesmo IP. `assinantes-ativos` (`verify_risk 1`) **nunca** é um `--cohort` válido aqui — pagamento Stripe já valida implicitamente, o script aborta se passado. Requer `MILLION_VERIFIER_API_KEY` no env (custo one-time ~$1.90/1000). **Os 3 scripts do ciclo exigem `--cycle {conteúdo}-{envio}`** (#1961): `verify-emails-mv` (escreve `mv-export-ex-assinantes-verified.csv` no `{ciclo}/`), depois `clarice-build-waves-store --cycle ... --budget N [--wave-size N]` (#2656 cutover — sucessor único desde #2844/260702; lê o STORE único de contatos, não os CSVs por cohort; corte por `send_eligible`, ordem por `priority_points`/`cohort`; escreve `wN-store.csv` + `waves-manifest.json` em `{ciclo}/waves/`), depois `clarice-import-waves --cycle ...` (lê `{ciclo}/waves/` via manifest). O `--cycle` é validado (formato + envio = conteúdo+1) — typo de mês aborta limpo.

- **MCP indisponível = fail-fast, nunca stall (#738).** Se qualquer chamada `mcp__*` retornar erro de disconnect/unavailable (ou se um `<system-reminder>` do runtime indicar que um MCP ficou offline durante a sessão), o comportamento correto é **imediatamente**: (a) parar o stage atual, (b) renderizar halt banner via `npx tsx scripts/render-halt-banner.ts --stage "{N} — {nome}" --reason "mcp__{servidor} desconectado" --action "reconecte e responda 'retry', ou 'abort' para abortar"` (#737), (c) aguardar resposta explícita antes de qualquer ação adicional. **Nunca aguardar passivamente.** Sistema reminders sobre MCP devem ser tratados como mensagem de erro do usuário, não como contexto ignorável. Stall silencioso > 60s é inaceitável — aplica-se a todos os MCPs: clarice, beehiiv, gmail, claude-in-chrome, Google Drive. Detalhes por stage: Stage 0 depende de beehiiv + gmail; Stage 2 depende de clarice; Stage 5 depende de beehiiv (Chrome) + gmail. **Outras paradas inesperadas** (subagent error/timeout, exception não-tratada, ratelimit persistente, loop verify→fix esgotado): mesma regra — render halt banner com motivo + ação específica antes de aguardar input.

- **1 PR aberto por vez (#636).** Mergear antes de abrir o próximo. Refactors em `scripts/lib/` bloqueiam outros PRs até mergear — anunciar no commit message quando isso se aplicar. Exceções: hotfix P0 (pode ser aberto em paralelo a feature PR, com merge prioritário), docs-only PRs (CLAUDE.md, README), bot PRs (Dependabot). **Esclarecimento (achado 260710, review 1.5b): em `/diaria-overnight`/`/diaria-develop`, a regra vale pro MERGE, não pro dispatch.** O fluxo documentado dessas skills (worktrees concorrentes sem colisão de arquivo, lotes despachados em paralelo) abre legitimamente múltiplos PRs simultâneos — cada um num worktree isolado, tipicamente tocando arquivos disjuntos. O invariante real é: o coordenador nunca executa dois `merge` ao mesmo tempo (master sempre recebe um squash-merge por vez, histórico linear) — não que só exista 1 branch/PR aberta no GitHub a qualquer momento. Issue de trade-off real (arquivos genuinamente sobrepostos entre lotes concorrentes) continua sendo bloqueio de merge, tratado pelo review leve do coordenador antes de cada merge.

- **PR de bugfix exige teste de regressão (#633).** Sem teste novo demonstrando que o bug não voltaria → não merge. Se não for possível testar (ex: agent prompt), justificar explicitamente no PR body. Cobre o padrão recorrente "fix → close → reaparece semanas depois".

- **`/code-review` default é `low`, opt-in pra mais profundidade (#3326).** `.claude/hooks/pr-create-review.mjs` já resolve `low` por padrão pra toda PR criada via `gh pr create` (branch `overnight/*`, sessão overnight ativa, ou nenhum sinal — todas caem em `low` desde #3326; `max` sobrevive só como fail-safe de estado indeterminado). Essa mesma regra vale quando o assistente invoca `/code-review` **fora** desse hook — revisão ad-hoc mid-sessão, diff ainda sem PR aberta, ou qualquer chamada onde o editor não pediu um nível de effort específico: usar `low` por default. O editor escala pra `max` (ou outro nível) pedindo explicitamente ("roda um code-review max nisso") — nunca assumir profundidade máxima como piso automático. Motivação: PR #3324 gastou ~1,5M tokens rodando o fleet completo (5+5 ângulos + verify + sweep) sobre um diff de ~250 linhas quando `low` já teria bastado; achou bugs reais, mas esse nível não deveria ser o padrão silencioso de toda PR manual/develop.

- **Digest mensal: Drive sync inclui só Doc editorial + imagens (#1022).** O HTML render (`preview.html`, `preview-list*.html`, e — desde #2793 — `_internal/cloudflare-preview.html` da Etapa 4 Revisão consolidada) é exclusivamente local — input direto do Brevo, nunca sobe pro Drive. O editor revisa o Google Doc (`Edição {Mês}/{Mês} v{N}`), não o HTML. Análogo à convenção `_internal/*` (#959): só sobe pro Drive o que o editor de fato edita.

- **Digest mensal: etapas espelham a numeração da diária (#2795).** `/diaria-mensal` adota o mesmo esquema de 6 etapas + checkpoints da diária (#1694): 0 Preflight, 1 Coleta/Análise, 2 Escrita, 3 Imagens, 4 Revisão consolidada (gate humano — pré-render completo + lint + fact-check, #2793), 5 Publicação Brevo. Checkpoints `_internal/.step-N-done.json` no mesmo formato do diário (`scripts/lib/pipeline-state.ts`), só que sob `data/monthly/{ciclo}/`. Ver `.claude/skills/diaria-mensal/SKILL.md`.

- **Label `local` — issues que requerem sessão local (#2643).** Sessões podem rodar em cloud (container efêmero, clone fresco) ou localmente (máquina do editor). Issues com label **`local`** dependem de recursos machine-local — junction `data/` (OneDrive), ComfyUI, credenciais persistidas, Task Scheduler, etc. — e **não fecham em sessão cloud**. O sinal canônico de detecção é a presença do junction `data/` como diretório acessível: `npx tsx scripts/lib/exec-mode.ts` imprime `local` ou `cloud` (helper testável em `scripts/lib/exec-mode.ts`). **`/diaria-overnight` em cloud:** issues `local` → puladas com motivo `requer-sessao-local` (comentário na issue com dedup). **`/diaria-overnight` local:** issues `local` → elegíveis normalmente. **`/diaria-develop`:** roda por natureza local — issues `local` são elegíveis; a label é informacional aqui. **Quando aplicar:** implementação ou teste requer qualquer recurso ausente num clone fresco — `data/`, ComfyUI, OneDrive, credenciais locais não-gitadas, Task Scheduler, ou path local do editor.

---

## Otimização de tokens

Todo arquivo em `context/` entra no prompt cache. Mantenha esses arquivos **curados** — mudanças invalidam o cache.

Model mix (definido no frontmatter de cada agente):
- **Opus 4.8** (#1951) — `orchestrator`, `scorer-select` (chunked-parallel, #1611), `analyst-monthly` (pipeline mensal). Decisão editorial pós-gate de julgamento holístico (seleção subjetiva, coordenação, diversidade temática), volume baixo, alto impacto em CTR — #159. Todos os 3 rodam com `effort: low` no frontmatter (#3218) — julgamento holístico não precisa de reasoning effort alto; `orchestrator` merece atenção extra por ser o maior blast radius do pipeline (dispatch de todos os stages, gates, halt banners).
- **Sonnet 5** (#2745) — `writer`, `writer-destaque`, `writer-monthly`, `publish-social`, `social-linkedin`, `social-facebook`, `social-instagram` (#3486), `fact-checker`, `scorer`, `scorer-chunk`, `scorer-monthly` (pipeline mensal, #3216 — mesmos critérios mecânicos do scorer diário, sem julgamento holístico), `title-picker` (#2772 — migrados de Opus: pontuação contra rubrico explícito / escolha entre opções já escritas, mais mecânico que julgamento holístico). (`publish-newsletter` migrou pra playbook lido pelo top-level em #1054; movido pra `context/publishers/beehiiv-playbook.md` em #1114.)
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
data/reports/index.jsonl # registry file-based da superfície de Relatórios do Studio (#3714) — aponta pros relatórios já persistidos (edition-report.html, data/overnight|develop/{AAMMDD}/report.md), não os duplica
platform.config.json     # { newsletter: "beehiiv", socials: [...] }
```

---

## Estado atual

**Pipeline completo implementado** (6 etapas, #1694). Fluxo: Pesquisa → Escrita → Imagens → Revisão (gate humano pré-publicação) → Publicação (Beehiiv draft + social agendado, auto) → Agendamento (gate humano: Schedule Beehiiv + auto-reporter). Gates humanos: Stage 4 (revisão editorial) e Stage 6 (agendamento final).
