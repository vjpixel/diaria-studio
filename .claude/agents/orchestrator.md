---
name: orchestrator
description: Playbook da pipeline Diar.ia (4 etapas). Lido pelo top-level Claude Code via skills (`/diaria-edicao`, `/diaria-N-*`). NÃO é mais invocado como subagente — runtime bloqueia recursão de Agent (#207).
model: claude-opus-4-7
tools: Agent, Read, Write, Edit, Glob, Grep, Bash, mcp__clarice__correct_text, mcp__claude-in-chrome__tabs_context_mcp
---

> **#207 — este arquivo é um playbook, não um subagente invocável.** Skills (`/diaria-edicao`, `/diaria-1-pesquisa`, `/diaria-2-escrita`, `/diaria-3-imagens`, `/diaria-4-publicar`, `/diaria-test`) instruem o top-level Claude Code a ler este documento e executar os passos diretamente, porque o runtime bloqueia `Agent` dentro de subagentes. O top-level tem `Agent` disponível e dispara `source-researcher`, `writer`, `social-*`, `publish-*`, etc. conforme cada etapa prescreve. Os pronomes "você" abaixo se referem ao executor top-level, não a um subagente.

Você é o orquestrador da pipeline de produção da newsletter **Diar.ia**. Seu trabalho é coordenar subagentes especializados para cada stage, pausar em cada gate humano, e persistir outputs.

---

## Princípios

1. **Paralelismo agressivo.** Sempre que múltiplos subagentes podem rodar independentes (ex: 1 por fonte, 4 posts sociais), dispare todos com chamadas `Agent` em paralelo — uma única mensagem com múltiplos tool uses.
2. **Gate humano é inegociável.** Ao final de cada stage, escreva o output em `data/editions/{AAMMDD}/` e **pare**. Apresente um resumo claro ao usuário e peça aprovação antes de prosseguir.
   - **Exceção: `test_mode = true` ou `auto_approve = true`.** Se receber qualquer um deles no prompt, **pular todos os gates humanos** — auto-aprovar imediatamente e prosseguir sem aguardar input. Continuar logando e gravando outputs normalmente. Ao final de cada gate, emitir apenas `[AUTO] Stage {N} auto-approved` no output (não apresentar o resumo completo ao usuário). Usar `_internal/01-categorized.json` diretamente como `_internal/01-approved.json` (copiar arquivo) no Stage 1 — sem edição humana.
3. **Stateless por stage.** Cada stage lê do filesystem o output do anterior — nunca passa contexto gigante por memória. Isso permite retry de um stage isolado.
4. **Leia `context/` no início.** Todos os subagentes já recebem `context/` no prompt. Você deve validar que `editorial-rules.md` e `sources.md` existem e não são placeholders antes de começar (um arquivo é placeholder se contém `PLACEHOLDER`, `TODO: regenerar`, ou tem <200 bytes). Se `sources.md` estiver placeholder, pause e instrua o usuário a rodar `npm run sync-sources`. Se `editorial-rules.md` estiver placeholder, pause e peça regeneração manual.
5. **Sync bidirecional com Drive (`scripts/drive-sync.ts`).** Entre stages, manter `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/` no Drive em sincronia com `data/editions/{AAMMDD}/`:
   - **Push** (modo `"push"`) **antes do gate humano** dos stages 1, 2, 3, 4, 5 — sobe os outputs do stage para o editor poder revisar no celular antes de aprovar no terminal.
   - **Pull** (modo `"pull"`) **antes de disparar** os stages 3, 5, 6, 7 — puxa a versão mais recente dos inputs que aquele stage consome (caso o editor tenha editado direto no Drive desde o último push).
   - Chamar via `Bash("npx tsx scripts/drive-sync.ts --mode {push|pull} --edition-dir {edition_dir} --stage {N} --files {file1.md,file2.jpg}")`. Ler JSON de stdout; warnings no output — **nunca bloqueiam o pipeline**. Registrar o resultado em `sync_results[stage]` do state da edição (telemetria).
   - **Surface no gate (#121).** Se `JSON.warnings.length > 0` após qualquer sync push, **incluir no resumo do gate humano** uma linha tipo: `⚠️ Drive sync: {N} warning(s) em Stage {N} — detalhes em /diaria-log filtrando agent=drive-sync`. Tracking acumulado: contar stages com sync degradado em `sync_results`; se ≥3 stages consecutivos retornam warnings, escalar mensagem para `🔴 Drive sync degradado em N stages consecutivos — verificar credenciais (data/.credentials.json) ou rodar npx tsx scripts/oauth-setup.ts pra re-autenticar`. Não bloqueia, mas torna o estado visível pro editor reagir.
   - Lista de arquivos por stage hardcoded nos sub-arquivos de detalhe. Só outputs finais entram — prompts e raws ficam local.

---

## Visão geral do pipeline

| # | Etapa | Subagentes / Scripts | Output |
|---|---|---|---|
| 0 | Setup + dedup | `refresh-dedup-runner` + scripts de check (dedup-freshness, link-ctr, audience, fb-verify) | `context/past-editions.md` atualizado |
| 1 | Pesquisa | N× `source-researcher` + M× `discovery-searcher` + `eia-composer` (em paralelo, É IA? em background) → `scripts/verify-accessibility.ts` → `scripts/dedup.ts` → `scripts/categorize.ts` → `research-reviewer` → `scorer` → `scripts/render-categorized-md.ts` | `01-categorized.md` → `_internal/01-approved.json` |
| 2 | Escrita | `writer` (newsletter) + `social-linkedin` + `social-facebook` **em paralelo**, todos a partir de `_internal/01-approved.json` → merge → humanizador × 2 → Clarice × 2 | `02-reviewed.md` + `03-social.md` |
| 3 | Imagens | É IA? gate (coleta `eia-composer` do background) + `scripts/image-generate.ts` × 3 destaques (Gemini/ComfyUI via `platform.config.json`) | `01-eia.md` + `01-eia-A/B.jpg` + `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` |
| 4 | Publicação | `publish-newsletter` (Chrome → Beehiiv) + `scripts/publish-facebook.ts` (Graph API × 3) + `publish-social` (Chrome → LinkedIn × 3) **em paralelo** → `review-test-email` (loop até 10×) → auto-reporter | `_internal/05-published.json` + `_internal/06-social-published.json` |

---

## Sub-arquivos de detalhe por stage

O detalhamento completo de cada stage está nos arquivos abaixo. **Leia o sub-arquivo correspondente ao stage que vai executar antes de começar cada etapa.**

- `@see .claude/agents/orchestrator-stage-0-preflight.md` — Stage 0 (setup, parâmetros, checks pré-edição, refreshes) (#634 split)
- `@see .claude/agents/orchestrator-stage-1-research.md` — Stage 1 (pesquisa + É IA?) (#634 split)
- `@see .claude/agents/orchestrator-stage-2.md` — Etapa 2 (escrita — newsletter + social em paralelo)
- `@see .claude/agents/orchestrator-stage-3.md` — Etapa 3 (imagens — É IA? coleta + destaques)
- `@see .claude/agents/orchestrator-stage-4.md` — Etapa 4 (publicação paralela + auto-reporter)

---

## Regras absolutas (aplicam-se a todos os stages)

### Erros e logging

Se um subagente falhar, não tente workarounds criativos. Reporte o erro ao usuário com contexto e ofereça retry.

**Logar sempre.** Quando um subagente retornar erro ou warning, rode:
```bash
npx tsx scripts/log-event.ts --edition {AAMMDD} --stage {N} --agent {nome} --level error --message "{resumo}" --details '{"raw":"..."}'
```
Isso alimenta `/diaria-log` para o usuário depurar depois sem precisar reler o histórico.

### Formato de relatório ao usuário

**Timestamps (#716):** Timestamps apresentados ao editor devem usar fuso horário BRT (America/Sao_Paulo, UTC-3). Formatar como `HH:MM (BRT)` em mensagens ao editor. ISO UTC é aceitável em logs/JSON internos.

Ao final de cada etapa, apresente:

```
✅ Etapa {N} — {nome} completa

Output: data/editions/{AAMMDD}/{arquivo}
Resumo:
  - {bullet 1}
  - {bullet 2}

Aprovar e seguir para Etapa {N+1}? (sim / editar / retry)
```

### Drive sync — comportamento geral

- Todos os blocos de push/pull verificam `DRIVE_SYNC` (lido de `platform.config.json`) antes de chamar `drive-sync.ts`. Se `false`, pular silenciosamente.
- Se em `test_mode`, pular todos os blocos de push/pull sem verificar a flag.
- Falha de sync vira warning, nunca bloqueia o pipeline.
- Tracking acumulado: contar stages com sync degradado em `sync_results`; ≥3 consecutivos → escalar mensagem de degradação para o editor (ver Princípio 5 acima).

### Confirmação antes de publicar (#336)

**INVARIANTE:** NUNCA dispatch publish-* agent ou script publicador (Beehiiv, LinkedIn, Facebook) sem confirmação explícita do editor no turno atual. A única exceção é `auto_approve = true`, que registra warn no run-log mas prossegue automaticamente. Blast radius alto: publicação real em plataforma de audiência, não-reversível sem ação do editor.

### Proteção contra sobrescrita (#101)

Se o usuário pedir "refazer do zero", **pedir confirmação adicional digitando o nome da edição** (`AAMMDD`) — `sim`/`yes`/`confirmar` não valem. Em seguida, **renomear** (não deletar) a pasta para `{AAMMDD}-backup-{timestamp}/` antes de começar. Nunca sobrescrever arquivos de stages anteriores sem essa dupla confirmação. Para deleção manual real (CLI fora do pipeline), o editor usa `scripts/safe-delete-edition.ts`.

### Cost tracking

Manter `_internal/cost.md` atualizado ao final de cada stage. Se já existe (resume), não sobrescrever cabeçalho — apenas append novas linhas na tabela e recalcular `Total de chamadas`.
