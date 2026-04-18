# Diar.ia Studio

Projeto Claude Code fim-a-fim para produção da newsletter **Diar.ia** (diaria.beehiiv.com).

O fluxo editorial é modelado como 7 stages com gate humano em cada um. A execução acontece via skills (`/diaria-edicao`, `/diaria-research`, etc.) que disparam um orquestrador; o orquestrador distribui trabalho para subagentes especializados em paralelo quando possível.

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
5. Confirmar que os MCPs estão ativos: `/mcp` deve listar `clarice` (local), `claude.ai Beehiiv` e `claude.ai Gmail` (conectores nativos). Nas fases 2/3, também `playwright` (conector nativo) e `stable-diffusion-local` (precisa instalar).
6. **Inbox editorial** (`diariaeditor@gmail.com`): seguir `docs/gmail-inbox-setup.md` (forward + label). Isso permite enviar links/temas durante o dia que são considerados na próxima edição automaticamente.
7. Rodar `/diaria-atualiza-audiencia` para gerar `context/audience-profile.md` a partir das respostas de survey do Beehiiv (re-rodar semanalmente ou quando quiser recalibrar o perfil).

**Para cada nova edição:**
1. `/diaria-edicao YYYY-MM-DD` — roda todos os stages em sequência. O próprio orchestrator regenera `context/past-editions.md` (Stage 0) e drena o inbox editorial (`diariaeditor@gmail.com`, Stage 1) automaticamente.
2. Alternativamente, rodar stages isolados (Fase 1): `/diaria-research` (também refresca dedup + drena inbox), `/diaria-escrever`, `/diaria-social`.
3. Skills auxiliares (debug, raramente usadas):
   - `/diaria-refresh-dedup` — testa conexão com Beehiiv MCP.
   - `/diaria-inbox` — drena manualmente o Gmail pra ver submissões antes de iniciar a edição.
   - `/diaria-log [edition] [level]` — lê `data/run-log.jsonl`; use quando algo der errado e quiser que eu investigue. Ex: `/diaria-log 260418 error`.
   - `/diaria-source-health [fonte]` — visão geral ou auditoria individual da saúde das fontes (successes, failures, timeouts, duração, últimas execuções). `data/sources/{slug}.jsonl` é o log append-only por fonte.

**Retomar edição interrompida:** se você sair do Claude no meio de uma edição, basta rodar `/diaria-edicao {mesma-data}` de novo. O orchestrator detecta quais stages já completaram (via arquivos em `data/editions/{YYMMDD}/`) e retoma de onde parou. Se um stage foi interrompido no meio (antes de gravar seu output), ele só re-executa aquele stage, não o pipeline inteiro.

Outputs ficam em `data/editions/{YYMMDD}/` (formato `YYMMDD` = AAMMDD; ex: edição `2026-04-18` → `260418/`) com sufixos numéricos por stage (`01-*`, `02-*`, etc.).

---

## Pipeline

**Fase 1 (implementada):**

| # | Stage | Subagentes | Output |
|---|---|---|---|
| 1 | Research | orchestrator → N× `source-researcher` + M× `discovery-searcher` (paralelo) → `link-verifier` (chunks) → `deduplicator` → `categorizer` | `01-categorized.json` → `01-approved.json` |
| 2 | Writing | `scorer` (Sonnet) → `writer` (Sonnet) → `clarice-runner` | `02-reviewed.md` |
| 3 | Social | 4× social writers paralelos + Clarice | `03-social.md` |

**Fases 2 e 3 (não implementadas ainda):**

| # | Stage | Output |
|---|---|---|
| 4 | É AI? — Wikimedia POTD + texto | `04-eai.md + eai.jpg` |
| 5 | Imagens — SD local impasto Van Gogh | `05-cover.jpg`, `05-d2.jpg`, `05-d3.jpg` |
| 6 | Publish newsletter — Playwright MCP + Beehiiv | Link do post agendado |
| 7 | Publish social — Playwright MCP × N plataformas | Posts agendados |

---

## Regras invariáveis (consultar `context/editorial-rules.md`)

- Sem links de agregadores.
- Sem links de paywall marcados como acessíveis.
- Sem links repetidos das últimas 3 edições (verificado contra `context/past-editions.md`).
- Destaques com título ≤52 caracteres, 3 opções por destaque.
- "Por que isso importa:" em linha separada.
- Prompt de imagem: Van Gogh impasto, 16:9, SEM resolução em pixels, SEM Noite Estrelada.
- Output final sem markdown (nada de `**`, `#`, `- `).

---

## Otimização de tokens

Todo arquivo em `context/` entra no prompt cache. Mantenha esses arquivos **curados** — mudanças invalidam o cache.

Model mix (definido no frontmatter de cada agente):
- **Opus 4.7** — `orchestrator`
- **Sonnet 4.6** — `scorer`, `writer`
- **Haiku 4.5** — todos os outros da Fase 1 (`source-researcher`, `discovery-searcher`, `link-verifier`, `deduplicator`, `categorizer`, `clarice-runner`, `social-*`)

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
  publishers/            # roteiros Playwright por plataforma
seed/sources.csv  # 35 fontes iniciais
scripts/          # utilitários TypeScript (Node)
data/editions/{YYMMDD}/  # outputs por edição
platform.config.json     # { newsletter: "beehiiv", socials: [...] }
```

---

## Fase atual

**Fase 1** (stages 1–3, textuais). Imagens e publicação via browser vêm nas fases 2 e 3.
