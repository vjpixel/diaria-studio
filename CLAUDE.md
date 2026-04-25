# Diar.ia Studio

Projeto Claude Code fim-a-fim para produção da newsletter **Diar.ia** (diar.ia.br).

O fluxo editorial é modelado como 7 stages com gate humano em cada um. A execução acontece via skills (`/diaria-edicao`, `/diaria-1-pesquisa`, etc.) que disparam um orquestrador; o orquestrador distribui trabalho para subagentes especializados em paralelo quando possível.

---

## Como usar

**Setup (1x):**
1. Exportar `CLARICE_API_KEY` no ambiente do shell (necessário para o MCP Clarice local). No Windows (persistente, requer reabrir o terminal):
   ```powershell
   [Environment]::SetEnvironmentVariable("CLARICE_API_KEY", "SEU_TOKEN_AQUI", "User")
   ```
   Use o mesmo token do `claude_desktop_config.json`. Veja `.env.example`.
2. `npm install` no diretório.
3. `npm run sync-sources` para gerar `context/sources.md`.
4. Abrir Claude Code neste diretório: `cd diaria-studio && claude`.
5. Confirmar que os MCPs estão ativos: `/mcp` deve listar `clarice` (local), `claude.ai Beehiiv` e `claude.ai Gmail` (conectores nativos). Para Fase 2 (imagens), instalar ComfyUI local (ver `docs/comfyui-setup.md`). Para Fase 3 (publicação), instalar e logar a extensão `Claude in Chrome` em Beehiiv/LinkedIn/Facebook (ver `docs/browser-publish-setup.md`).
6. **Inbox editorial** (`diariaeditor@gmail.com`): seguir `docs/gmail-inbox-setup.md` (forward + label). Isso permite enviar links/temas durante o dia que são considerados na próxima edição automaticamente.
7. Rodar `/diaria-atualiza-audiencia` para importar respostas de survey do Beehiiv em `data/audience-raw.json` (re-rodar semanalmente ou quando quiser recalibrar). O `context/audience-profile.md` é regenerado automaticamente no Stage 0, combinando CTR comportamental (primário) e survey (secundário).

**Para cada nova edição:**
1. `/diaria-edicao AAMMDD [--no-gates]` — roda todos os stages em sequência. O próprio orchestrator regenera `context/past-editions.md` (Stage 0) e drena o inbox editorial (`diariaeditor@gmail.com`, Stage 1) automaticamente. Com `--no-gates`, auto-aprova todos os gates humanos mas mantém Drive sync e social scheduling normais (diferente de `/diaria-test` que também desabilita Drive e agenda social 10 dias à frente).
2. Alternativamente, rodar stages isolados:
   - **Fase 1** (textos): `/diaria-1-pesquisa` (também refresca dedup + drena inbox), `/diaria-2-escrever`, `/diaria-3-social`.
   - **Fase 2** (imagens): `/diaria-4-eai` (É IA?), `/diaria-5-imagens [d1|d2|d3]` (Stage 4).
   - **Fase 3** (publicação): `/diaria-6-publicar [newsletter|social|all]` (Stages 5 + 6).
3. Skills auxiliares (debug, raramente usadas):
   - `/diaria-refresh-dedup` — testa conexão com Beehiiv MCP.
   - `/diaria-inbox` — drena manualmente o Gmail pra ver submissões antes de iniciar a edição.
   - `/diaria-log [edition] [level]` — lê `data/run-log.jsonl`; use quando algo der errado e quiser que eu investigue. Ex: `/diaria-log 260418 error`.
   - `/diaria-source-health [fonte]` — visão geral ou auditoria individual da saúde das fontes (successes, failures, timeouts, duração, últimas execuções). `data/sources/{slug}.jsonl` é o log append-only por fonte.

**Retomar edição interrompida:** se você sair do Claude no meio de uma edição, basta rodar `/diaria-edicao {mesmo-AAMMDD}` de novo. O orchestrator detecta quais stages já completaram (via arquivos em `data/editions/{AAMMDD}/`) e retoma de onde parou. Se um stage foi interrompido no meio (antes de gravar seu output), ele só re-executa aquele stage, não o pipeline inteiro.

Outputs ficam em `data/editions/{AAMMDD}/` (ex: edição `260418/`) com sufixos numéricos por stage (`01-*`, `02-*`, etc.).

---

## Pipeline

**Fases 1, 2 e 3 (implementadas):**

| # | Stage | Subagentes | Output |
|---|---|---|---|
| 1 | Research | orchestrator → N× `source-researcher` + M× `discovery-searcher` + `eai-composer` (todos em paralelo) → `scripts/verify-accessibility.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `research-reviewer` (datas + temas) → `scorer` → `scripts/render-categorized-md.ts` | `01-categorized.md` → `_internal/01-approved.json` |
| 1b | É IA? | Coleta resultado do `eai-composer` disparado em paralelo no Stage 1 — Wikimedia POTD + Gemini | `01-eai.md` + `01-eai-real.jpg` + `01-eai-ia.jpg` |
| 2 | Writing | `scorer` (Sonnet) → `writer` (Sonnet) → Clarice inline (`mcp__clarice__correct_text` + `scripts/clarice-diff.ts`) | `02-reviewed.md` |
| 3 | Social | 2× social writers paralelos (LinkedIn, Facebook) + 6× Clarice | `03-social.md` |
| 4 | Imagens | `scripts/image-generate.ts` — Gemini API por default (fallback ComfyUI via `platform.config.json > image_generator`) | `04-d1-2x1.jpg`, `04-d2.jpg`, `04-d3.jpg` |
| 5 | Publish newsletter | `publish-newsletter` — Claude in Chrome → Beehiiv (rascunho + email de teste) + `review-test-email` (loop até 10×) | `05-published.json` |
| 6 | Publish social | `scripts/publish-facebook.ts` (Graph API × 3) + `publish-social` (Claude in Chrome → LinkedIn × 3) em paralelo | `06-social-published.json` |

**Sync com Google Drive (entre stages):** **antes de cada gate** (stages 1–4), `scripts/drive-sync.ts` sobe os outputs do stage para `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/` — assim o editor pode revisar no celular antes de aprovar no terminal. **Antes de cada stage** que consome inputs que podem ter sido editados no Drive (3, 4, 5, 6), um pull traz a versão mais recente para o local. Retry cria `.v2`, `.v3` (versões contadas via `push_count` no cache). Falha de sync vira warning, nunca bloqueia. Cache em `data/drive-cache.json` (gitignored). Credenciais OAuth em `data/.credentials.json` — gerado com `npx tsx scripts/oauth-setup.ts` (setup único; requer `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`).

---

## Regras invariáveis (consultar `context/editorial-rules.md`)

- Sem links de agregadores.
- Sem links de paywall marcados como acessíveis.
- Sem links repetidos das últimas 3 edições (verificado contra `context/past-editions.md`).
- Destaques com título ≤52 caracteres, 3 opções por destaque.
- "Por que isso importa:" em linha separada.
- Prompt de imagem: Van Gogh impasto, 2:1, SEM resolução em pixels, SEM Noite Estrelada.
- Output final sem markdown (nada de `**`, `#`, `- `).

## Princípios operacionais invariáveis

- **Nunca correr risco de ToS.** Qualquer automação de sites de terceiros (ChatGPT, Bing, Leonardo.ai, LinkedIn via puppeteer, etc.) via browser automation, scraping ou reverse-engineering de endpoints não-oficiais está **descartada por padrão**. Prefira: (a) API oficial com key, (b) free tier de plataforma que permita uso automatizado, (c) modelo local. Claude in Chrome **é aceitável** em sites onde o usuário está logado pessoalmente e o uso reflete interação humana natural (Beehiiv/LinkedIn post scheduling — volume baixo, ações editoriais, ToS aceitam uso de ferramentas de terceiro). **Nunca** em scale ou pra scraping.

- **Zero custo recorrente** como princípio editorial. Preferir: free tier oficial > API pay-per-call baixo custo > assinatura fixa. Escolhas acima de ~$50/ano precisam justificativa concreta.

- **Pipeline reproducible**: mudanças em agent prompts, config ou scripts devem ser committed + testadas; nunca rodadas direto de stash ou memória.

- **Data da edição é sempre explícita.** Skills `/diaria-*` que aceitam `AAMMDD` **nunca** inferem a partir de `today()` ou da edição mais recente em `data/editions/`. Se o usuário não passar a data, perguntar com sugestão de hoje/ontem como atalho mas exigir confirmação. Risco de rodar stage destrutivo/publicador (3, 5, 6) na edição errada é alto demais pra default silencioso.

---

## Otimização de tokens

Todo arquivo em `context/` entra no prompt cache. Mantenha esses arquivos **curados** — mudanças invalidam o cache.

Model mix (definido no frontmatter de cada agente):
- **Opus 4.7** — `orchestrator`
- **Opus 4.6** — `scorer`
- **Sonnet 4.6** — `writer`, `publish-newsletter`, `publish-social`
- **Haiku 4.5 (shorthand `haiku`, auto-tracks latest stable)** — `source-researcher`, `discovery-searcher`, `social-*`, `eai-composer`. Dedup, Clarice, geração de imagem, link-verifier, categorizer, drive-sync e inbox-drain foram migrados para scripts TS — não são mais agentes LLM.
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

## Fase atual

**Fases 1, 2 e 3 implementadas** (stages 1–6). Pipeline fim-a-fim funcional: pesquisa → escrita → social → É IA? → imagens → newsletter (Beehiiv rascunho + teste) → social (LinkedIn + Facebook rascunho/agendado). Editor sempre revisa cada gate e dispara a publicação final manualmente do dashboard de cada plataforma.
