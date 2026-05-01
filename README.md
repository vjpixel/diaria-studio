# Diar.ia Studio

Pipeline Claude Code fim-a-fim para produção da newsletter **Diar.ia** — cobertura diária de inteligência artificial em português, publicada em [diar.ia.br](https://diar.ia.br). 7 stages, gates humanos, zero custo recorrente de LLM (roda via OAuth da assinatura Claude).

## Stack

- **Runtime**: [Claude Code](https://claude.com/claude-code) CLI como orquestrador.
- **Linguagem**: TypeScript + Node 22.
- **MCPs**: Clarice (local, revisão de PT-BR), Beehiiv (newsletter), Gmail (inbox editorial), Claude in Chrome (publicação web), GitHub (issues/PRs).
- **APIs**: Google Gemini (imagens), Facebook Graph (posts), Google Drive OAuth (sync).
- **CI**: GitHub Actions rodando typecheck + unit tests + smoke e2e em todo PR.

## Quick start

```bash
git clone git@github.com:vjpixel/diaria-studio.git
cd diaria-studio
npm ci
claude                              # abre Claude Code neste diretório
/mcp                                # confirma MCPs conectados
/diaria-edicao 260425               # roda pipeline completa da edição
```

Setup completo (tokens, MCPs, extensões) está documentado em [`CLAUDE.md`](./CLAUDE.md).

## Produzir uma edição

Slash commands disponíveis (pipeline completa ou etapas isoladas):

| Skill | O que faz |
|---|---|
| `/diaria-edicao AAMMDD [--no-gates]` | Pipeline completa (4 etapas). Retoma do ponto que parou se interrompido. |
| `/diaria-1-pesquisa AAMMDD` | Etapa 1 (pesquisa + dedup + categorize + score). |
| `/diaria-2-escrita AAMMDD [newsletter\|social]` | Etapa 2 (newsletter + posts sociais em paralelo). |
| `/diaria-3-imagens AAMMDD [eai\|d1\|d2\|d3]` | Etapa 3 (É IA? + 3 imagens de destaque). |
| `/diaria-4-publicar [all\|newsletter\|social] AAMMDD` | Etapa 4 (Beehiiv rascunho + LinkedIn + Facebook). |
| `/diaria-mensal YYMM [--no-gate]` | Digest mensal (coleta → análise → escrita → imagens). |
| `/diaria-test [AAMMDD]` | Edição de teste (sem Drive sync, social agendado 10 dias à frente). |
| `/diaria-atualiza-audiencia` | Recarrega perfil de audiência via Beehiiv survey. |
| `/diaria-refresh-dedup` | Regenera `context/past-editions.md` (usado pra evitar links repetidos). |
| `/diaria-inbox` | Drena submissões editoriais de `diariaeditor@gmail.com`. |
| `/diaria-log [edition] [level]` | Lê `data/run-log.jsonl` (debug). |
| `/diaria-source-health [fonte]` | Saúde agregada das fontes cadastradas. |

## Arquitetura

Pipeline em 4 etapas, cada uma com gate humano:

```
Etapa 1  Pesquisa  →  source-researcher ×N || discovery-searcher ×M || eai-composer
                      verify / dedup / categorize / score
                      → 01-categorized.md [gate]

Etapa 2  Escrita   →  writer (newsletter) || social-linkedin || social-facebook
                      → merge → humanizador × 2 → Clarice × 2
                      → 02-reviewed.md + 03-social.md [gate]

Etapa 3  Imagens   →  É IA? (Wikimedia POTD) + image-generate ×3 (Gemini/ComfyUI)
                      → 01-eai.md + 04-d{1,2,3}.jpg [gate]

Etapa 4  Publicação→  publish-newsletter (Chrome → Beehiiv rascunho + email teste)
                      || publish-facebook (Graph API ×3)
                      || publish-social (Chrome → LinkedIn ×3)
                      → review-test-email (loop) → auto-reporter [gate]
```

Outputs em `data/editions/{AAMMDD}/`. Detalhes em [`CLAUDE.md`](./CLAUDE.md).

## Desenvolvimento

```bash
npm test                  # unit tests (node:test, 148+)
npm run typecheck         # tsc --noEmit
npm run smoke             # smoke test end-to-end com fixture
npm run sync-sources      # regenera context/sources.md de seed/sources.csv
npm run validate-feeds    # valida feeds RSS das fontes cadastradas
```

CI automática em push/PR — ver [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

### Contribuir

1. Branch por feature/fix.
2. Push + PR (template em [`.github/pull_request_template.md`](./.github/pull_request_template.md)).
3. CI verde é requisito pra merge.
4. Issues rastreadas com labels `P0`-`P3` + `enhancement`/`post-mortem`.

## Estrutura

```
.claude/
  agents/         # subagentes (1 arquivo = 1 subagente)
  skills/         # slash commands (/diaria-*)
  settings.json   # permissions, hooks
.github/
  workflows/ci.yml           # CI automation
  pull_request_template.md
.mcp.json                    # MCPs: clarice, beehiiv, gmail, chrome, github
context/                     # system prompt (cacheado)
  editorial-rules.md
  audience-profile.md        # gerado
  past-editions.md           # gerado
  sources.md                 # gerado de seed/sources.csv
  templates/
  publishers/                # roteiros Claude in Chrome
scripts/                     # utilitários TS (Node)
  lib/                       # módulos compartilhados
test/                        # unit tests + fixtures
  fixtures/edition-sample/   # fixture pro smoke test
seed/sources.csv             # ~38 fontes cadastradas
data/                        # outputs e caches (gitignored)
  editions/{AAMMDD}/         # outputs por edição
  run-log.jsonl              # log estruturado
  sources/{slug}.jsonl       # saúde por fonte
docs/                        # guias de setup (Chrome, ComfyUI, Gmail)
platform.config.json         # configuração do pipeline
CLAUDE.md                    # instruções do projeto (lidas pelo Claude)
```

## Status

Pipeline fim-a-fim funcional (4 etapas). Editor revisa cada gate e dispara publicação final manualmente do dashboard de cada plataforma. Roadmap ativo via [issues P0–P3](https://github.com/vjpixel/diaria-studio/issues).

Roadmap ativo acompanhado via [issues P0–P3](https://github.com/vjpixel/diaria-studio/issues).

## Documentação

- [`CLAUDE.md`](./CLAUDE.md) — instruções do projeto (lidas automaticamente pelo Claude Code).
- [`context/editorial-rules.md`](./context/editorial-rules.md) — regras editoriais invariantes.
- [`docs/`](./docs/) — guias de setup de componentes (Chrome, ComfyUI, Gmail).
- [`.claude/agents/`](./.claude/agents/) — subagentes do pipeline.
- [`.claude/skills/`](./.claude/skills/) — slash commands invocáveis.
