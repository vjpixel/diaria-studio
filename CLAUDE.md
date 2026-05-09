# Diar.ia Studio

Projeto Claude Code fim-a-fim para produção da newsletter **Diar.ia** (diar.ia.br).

O fluxo editorial é modelado como 4 etapas com gate humano em cada uma. A execução acontece via skills (`/diaria-edicao`, `/diaria-1-pesquisa`, etc.) que disparam um orquestrador; o orquestrador distribui trabalho para subagentes especializados em paralelo quando possível.

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
3. `npm run sync-sources` para gerar `context/sources.md`.
4. Abrir Claude Code neste diretório: `cd diaria-studio && claude`.
5. Confirmar que os MCPs estão ativos: `/mcp` deve listar `clarice` (local), `claude.ai Beehiiv` e `claude.ai Gmail` (conectores nativos). Para Fase 2 (imagens), instalar ComfyUI local (ver `docs/comfyui-setup.md`). Para Fase 3 (publicação), instalar e logar a extensão `Claude in Chrome` em Beehiiv/LinkedIn/Facebook (ver `docs/browser-publish-setup.md`).
6. **Inbox editorial** (`diariaeditor@gmail.com`): seguir `docs/gmail-inbox-setup.md` (forward + label). Isso permite enviar links/temas durante o dia que são considerados na próxima edição automaticamente.
7. Rodar `/diaria-atualiza-audiencia` para importar respostas de survey do Beehiiv em `data/audience-raw.json` (re-rodar semanalmente ou quando quiser recalibrar). O `context/audience-profile.md` é regenerado automaticamente no Stage 0, combinando CTR comportamental (primário) e survey (secundário).

**Para cada nova edição:**
1. `/diaria-edicao AAMMDD [--no-gates]` — roda todos os stages em sequência. O próprio orchestrator regenera `context/past-editions.md` (Stage 0) e drena o inbox editorial (`diariaeditor@gmail.com`, Stage 1) automaticamente. Com `--no-gates`, auto-aprova todos os gates humanos mas mantém Drive sync e social scheduling normais (diferente de `/diaria-test` que também desabilita Drive e agenda social 10 dias à frente).
2. Alternativamente, rodar etapas isoladas:
   - **Etapa 1** (pesquisa): `/diaria-1-pesquisa` (também refresca dedup + drena inbox).
   - **Etapa 2** (escrita): `/diaria-2-escrita [newsletter|social]` (newsletter + social em paralelo a partir de `01-approved.json`).
   - **Etapa 3** (imagens): `/diaria-3-imagens [eia|d1|d2|d3]` (É IA? + imagens de destaque).
   - **Etapa 4** (publicação): `/diaria-4-publicar [newsletter|social|all]`.
3. Skills auxiliares (debug, raramente usadas):
   - `/diaria-refresh-dedup` — testa conexão com Beehiiv MCP.
   - `/diaria-inbox` — drena manualmente o Gmail pra ver submissões antes de iniciar a edição.
   - `/diaria-log [edition] [level]` — lê `data/run-log.jsonl`; use quando algo der errado e quiser que eu investigue. Ex: `/diaria-log 260418 error`.
   - `/diaria-source-health [fonte]` — visão geral ou auditoria individual da saúde das fontes (successes, failures, timeouts, duração, últimas execuções). `data/sources/{slug}.jsonl` é o log append-only por fonte.

**Retomar edição interrompida:** se você sair do Claude no meio de uma edição, basta rodar `/diaria-edicao {mesmo-AAMMDD}` de novo. O orchestrator detecta quais stages já completaram (via arquivos em `data/editions/{AAMMDD}/`) e retoma de onde parou. Se um stage foi interrompido no meio (antes de gravar seu output), ele só re-executa aquele stage, não o pipeline inteiro.

Outputs ficam em `data/editions/{AAMMDD}/` (ex: edição `260418/`) com sufixos numéricos por stage (`01-*`, `02-*`, etc.).

---

## Pipeline

**Todas as etapas implementadas:**

| # | Etapa | Subagentes / Scripts | Output |
|---|---|---|---|
| 1 | Pesquisa | N× `source-researcher` + M× `discovery-searcher` + `eia-composer` (em paralelo, É IA? em background) → `scripts/verify-accessibility.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `research-reviewer` → `scorer` → `scripts/render-categorized-md.ts` | `01-categorized.md` → `_internal/01-approved.json` |
| 2 | Escrita | `writer` (newsletter) + `social-linkedin` + `social-facebook` **em paralelo**, todos a partir de `_internal/01-approved.json` → merge → humanizador × 2 → Clarice × 2 | `02-reviewed.md` + `03-social.md` |
| 3 | Imagens | É IA? gate (coleta `eia-composer` do background) + `scripts/image-generate.ts` × 3 destaques (Gemini/ComfyUI via `platform.config.json`) | `01-eia.md` + `01-eia-A/B.jpg` + `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` |
| 4 | Publicação | `publish-newsletter` (Chrome → Beehiiv) + `scripts/publish-facebook.ts` (Graph API × 3) + `publish-social` (Chrome → LinkedIn × 3) **em paralelo** → `review-test-email` (loop até 10×) → auto-reporter | `_internal/05-published.json` + `_internal/06-social-published.json` |

**Sync com Google Drive (entre etapas):** **antes de cada gate** (etapas 1–3), `scripts/drive-sync.ts` sobe os outputs da etapa para `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/` — assim o editor pode revisar no celular antes de aprovar no terminal. **Antes de cada etapa** que consome inputs que podem ter sido editados no Drive (2, 3, 4), um pull traz a versão mais recente para o local. Retry cria `.v2`, `.v3` (versões contadas via `push_count` no cache). Falha de sync vira warning, nunca bloqueia. Cache em `data/drive-cache.json` (gitignored). Credenciais OAuth em `data/.credentials.json` — gerado com `npx tsx scripts/oauth-setup.ts` (setup único; requer `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`).

---

## Regras invariáveis (consultar `context/editorial-rules.md`)

- Sem links de agregadores.
- Sem links de paywall marcados como acessíveis.
- Sem links repetidos das últimas 3 edições (verificado contra `context/past-editions.md`).
- Destaques com título ≤52 caracteres, 3 opções por destaque.
- "Por que isso importa:" em linha separada.
- Prompt de imagem: Van Gogh impasto, 2:1, SEM resolução em pixels, SEM Noite Estrelada.
- Output final sem markdown (nada de `**`, `#`, `- `).
- **LANÇAMENTOS só com link oficial** (#160). Cobertura de imprensa, blog pessoal, agregador → NOTÍCIAS. Validar com `scripts/validate-lancamentos.ts`.

## Princípios operacionais invariáveis

- **Nunca correr risco de ToS.** Qualquer automação de sites de terceiros (ChatGPT, Bing, Leonardo.ai, LinkedIn via puppeteer, etc.) via browser automation, scraping ou reverse-engineering de endpoints não-oficiais está **descartada por padrão**. Prefira: (a) API oficial com key, (b) free tier de plataforma que permita uso automatizado, (c) modelo local. Claude in Chrome **é aceitável** em sites onde o usuário está logado pessoalmente e o uso reflete interação humana natural (Beehiiv/LinkedIn post scheduling — volume baixo, ações editoriais, ToS aceitam uso de ferramentas de terceiro). **Nunca** em scale ou pra scraping.

- **Zero custo recorrente** como princípio editorial. Preferir: free tier oficial > API pay-per-call baixo custo > assinatura fixa. Escolhas acima de ~$50/ano precisam justificativa concreta.

- **Pipeline reproducible**: mudanças em agent prompts, config ou scripts devem ser committed + testadas; nunca rodadas direto de stash ou memória.

- **Data da edição é sempre explícita.** Skills `/diaria-*` que aceitam `AAMMDD` **nunca** inferem a partir de `today()` ou da edição mais recente em `data/editions/`. Se o usuário não passar a data, perguntar com sugestão de hoje/ontem como atalho mas exigir confirmação. Risco de rodar stage destrutivo/publicador (3, 5, 6) na edição errada é alto demais pra default silencioso.

  Exceção (#583): skills `/diaria-2-escrita`, `/diaria-3-imagens`, `/diaria-4-publicar` aceitam AAMMDD opcional. Se omitido, rodar `npx tsx scripts/lib/find-current-edition.ts --stage N` e — se exatamente 1 edição estiver em curso (prereq do stage atendido + output faltando) — assumir essa edição com info log. Caso 0 candidatos: erro. Caso ≥2: perguntar como antes. Stage 1 não muda — cria a edição.

- **Edição é sempre D+1.** A pesquisa (Etapa 1) é rodada no dia *anterior* à publicação — a data da edição é sempre **amanhã** (`today + 1 dia`), não hoje. Exemplo: se a rotina roda em 2026-04-26, a edição é `260427`. Isso vale para chamadas automáticas (CI, automação) e para chamadas manuais sem data explícita. Quando o usuário passar a data explicitamente, usar a data informada sem ajuste.

- **Atacar todas as issues que dá pra atacar autonomamente.** A mandato anterior de "autonomia ampla" se aplica a issues também: revisar a fila aberta, identificar quais não têm bloqueio externo (allowlist, conta de terceiro, decisão editorial específica), e atacar até o fim — Tier A + Tier B quando a direção da issue é clara. Issues com trade-off real (escolha entre opções genuinamente equivalentes que afetam usuários finais) ainda merecem consulta. Bloqueio externo verdadeiro (precisa do editor abrir conta, mexer em allowlist GitHub, dar input de produto que não foi documentado) → comentar na issue com o que falta e pular. Tudo mais: avançar.

- **Sempre indicar prioridade ao criar issues.** Nova issue **deve** entrar com 1 label `P0`/`P1`/`P2`/`P3` além do tipo (`enhancement`/`bug`/etc). Se a prioridade não estiver óbvia, sugerir uma com justificativa breve no corpo da issue (não deixar pra triagem depois). Default: `P2` pra bug com workaround / enhancement importante; `P3` pra cleanup, scoping, produto/decisão editorial; `P1` pra bug que afeta produção atual sem workaround; `P0` só pra fire (publicação corrompida, leak, etc).

- **Etapa 4 (publicadores) sempre exige consentimento explícito por canal antes do dispatch (#336).** Antes de invocar qualquer `publish-*` agent ou script publicador (newsletter Beehiiv, LinkedIn, Facebook), perguntar explicitamente ao editor qual canal ele quer automático e qual vai fazer manual. Default se não responder = manual em tudo. Não há exceção pra `/diaria-edicao` sem `--no-gates`. Com `--no-gates` (`auto_approve = true`): auto-aprovar mas registrar warn no run-log. Blast radius alto: publicação real em plataforma de audiência, não-reversível sem ação do editor.

- **Pull antes de editar arquivo que existe no Drive (#494).** Antes de usar `Edit` ou `Write` em qualquer arquivo que o editor pode ter modificado no Google Drive (`01-categorized.md`, `02-reviewed.md`, `03-social.md`), sempre fazer pull para trazer a versão mais recente: `npx tsx scripts/drive-sync.ts --mode pull --edition-dir {edition_dir} --stage {N} --files {arquivo}`. Nunca assumir que o arquivo local está atualizado.

- **Edições em arquivos Drive são sempre cirúrgicas (#495).** Ao modificar um arquivo que o editor pode ter editado, usar substituições linha a linha (`Edit` com `old_string` mínimo) em vez de substituir blocos grandes. Nunca incluir no `old_string` linhas que o editor pode ter alterado além das linhas que precisam mudar.

- **Publicação manual requer refresh-dedup.** Sempre que uma edição for publicada manualmente no Beehiiv (sem `/diaria-4-publicar`), rodar `/diaria-refresh-dedup` imediatamente após para manter `context/past-editions.md` atualizado. Sem isso, a próxima edição pode repetir URLs já publicadas.

- **Publicação manual requer prep-manual-publish.ts antes (#1044, #1047).** Sempre que for publicar manualmente no Beehiiv, **antes** do paste no template, rodar `npx tsx scripts/prep-manual-publish.ts --edition AAMMDD`. O script valida pré-condições (newsletter-final.html tem botões A/B + merge tags, custom fields existem na publicação, Worker disponível), roda `inject-poll-urls.ts` automaticamente populando custom fields per subscriber, e imprime instruções step-by-step (URL do template, file path do HTML, comando close-poll após publicar). Aborta se >10% subscribers falharem. Sem esse gate, paste manual sem inject prévio = `{{poll_a_url}}` substitui por string vazia → botões com `href=""` → click dos leitores não funciona (UX break visível, pior que zero votos). Após publicar, rodar `npx tsx scripts/close-poll.ts --edition AAMMDD`.

- **Validar afirmações de subagent sobre estado externo via TS determinístico antes de relayar pro editor (#573).** Subagentes (especialmente Haiku) podem etiquetar mal estados ambíguos — ex: `status: "confirmed"` na Beehiiv API significa "agendado-na-fila" OU "já-enviado", indistinguíveis sem checar `publish_date` contra `now`. Sempre que o orchestrator (top-level) for relayar fato sobre Beehiiv/LinkedIn/Facebook ao editor, validar o timestamp/state via comparação determinística em TS (helpers em `scripts/lib/publish-state.ts` — `resolveBeehiivState`, `resolveLinkedInState`, `resolveFacebookState`, todos retornam `PublishState = 'draft' | 'scheduled' | 'published' | 'sent' | 'unknown'`) — não só ler o gloss do agent. Se o agent diz "X publicado", chamar o helper antes de afirmar isso. Falha desse guard em 2026-05-05: orchestrator afirmou "3 edições publicadas" baseado em `status: confirmed`, mas uma estava 16h no futuro (agendamento, não publicação).

- **MCP indisponível = fail-fast, nunca stall (#738).** Se qualquer chamada `mcp__*` retornar erro de disconnect/unavailable (ou se um `<system-reminder>` do runtime indicar que um MCP ficou offline durante a sessão), o comportamento correto é **imediatamente**: (a) parar o stage atual, (b) renderizar halt banner via `npx tsx scripts/render-halt-banner.ts --stage "{N} — {nome}" --reason "mcp__{servidor} desconectado" --action "reconecte e responda 'retry', ou 'abort' para abortar"` (#737), (c) aguardar resposta explícita antes de qualquer ação adicional. **Nunca aguardar passivamente.** Sistema reminders sobre MCP devem ser tratados como mensagem de erro do usuário, não como contexto ignorável. Stall silencioso > 60s é inaceitável — aplica-se a todos os MCPs: clarice, beehiiv, gmail, claude-in-chrome, Google Drive. Detalhes por stage: Stage 0 depende de beehiiv + gmail; Stage 2 depende de clarice; Stage 4 depende de beehiiv (Chrome) + gmail. **Outras paradas inesperadas** (subagent error/timeout, exception não-tratada, ratelimit persistente, loop verify→fix esgotado): mesma regra — render halt banner com motivo + ação específica antes de aguardar input.

- **1 PR aberto por vez (#636).** Mergear antes de abrir o próximo. Refactors em `scripts/lib/` bloqueiam outros PRs até mergear — anunciar no commit message quando isso se aplicar. Exceções: hotfix P0 (pode ser aberto em paralelo a feature PR, com merge prioritário), docs-only PRs (CLAUDE.md, README), bot PRs (Dependabot).

- **PR de bugfix exige teste de regressão (#633).** Sem teste novo demonstrando que o bug não voltaria → não merge. Se não for possível testar (ex: agent prompt), justificar explicitamente no PR body. Cobre o padrão recorrente "fix → close → reaparece semanas depois".

- **Digest mensal: Drive sync inclui só Doc editorial + imagens (#1022).** O HTML render (`preview.html`, `preview-list*.html`) é exclusivamente local — input direto do Brevo, nunca sobe pro Drive. O editor revisa o Google Doc (`Edição {Mês}/{Mês} v{N}`), não o HTML. Análogo à convenção `_internal/*` (#959): só sobe pro Drive o que o editor de fato edita.

---

## Otimização de tokens

Todo arquivo em `context/` entra no prompt cache. Mantenha esses arquivos **curados** — mudanças invalidam o cache.

Model mix (definido no frontmatter de cada agente):
- **Opus 4.7** — `orchestrator`, `title-picker` (decisão editorial pós-gate, volume baixo, alto impacto em CTR — #159)
- **Opus 4.6** — `scorer`
- **Sonnet 4.6** — `writer`, `publish-newsletter`, `publish-social`, `social-linkedin`, `social-facebook`.
- **Haiku 4.5 (shorthand `haiku`, auto-tracks latest stable)** — `source-researcher`, `discovery-searcher`, `eia-composer`. Dedup, Clarice, geração de imagem, link-verifier, categorizer, drive-sync e inbox-drain foram migrados para scripts TS — não são mais agentes LLM.
- **Haiku 4.5 (pinned `claude-haiku-4-5-20251001`)** — `research-reviewer` (lógica de raciocínio estruturado; re-avaliar pin a cada release).

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
  past-editions.md       # gerado
  sources.md             # gerado de seed/sources.csv
  templates/
  publishers/            # roteiros Claude in Chrome por plataforma (Beehiiv, LinkedIn, Facebook)
seed/sources.csv  # 35 fontes iniciais
scripts/          # utilitários TypeScript (Node)
data/editions/{AAMMDD}/  # outputs por edição (gate-facing no root, pipeline internals em _internal/)
platform.config.json     # { newsletter: "beehiiv", socials: [...] }
```

---

## Estado atual

**Pipeline completo implementado** (4 etapas). Fluxo: Pesquisa → Escrita (newsletter + social em paralelo) → Imagens (É IA? + destaques) → Publicação (Beehiiv rascunho + teste + LinkedIn + Facebook). Editor revisa cada gate e dispara a publicação final manualmente do dashboard de cada plataforma.
