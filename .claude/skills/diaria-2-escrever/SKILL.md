---
name: diaria-2-escrever
description: Roda apenas o Stage 2 (writer + clarice). Requer `_internal/01-approved.json` já existente. Uso — `/diaria-2-escrever AAMMDD`.
---

# /diaria-2-escrever

Executa só o Stage 2.

## Argumentos

- `$1` = data da edição (`AAMMDD`). **Se não passar, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação.

## Pré-requisitos

- `data/editions/{AAMMDD}/_internal/01-approved.json` deve existir com `highlights[]` (scorer já rodou no Stage 1). Se não, avise: rode `/diaria-1-pesquisa` primeiro e aprove.

## Execução

**Executar o playbook diretamente no top-level (#207).** Você (top-level Claude Code) lê `.claude/agents/orchestrator.md` § **2. Stage 2 — Writing** e executa os passos prescritos. **Não delegue a um subagente `orchestrator` via `Agent`** — o runtime bloqueia recursão de Agent dentro de subagentes (issue #207). O top-level tem `Agent` disponível e pode dispatchar `writer` (Sonnet), `humanizer-llm` (opcional), `title-picker` (Opus) conforme o playbook.

Variáveis pra alimentar o playbook:
- `edition_date = $1` (AAMMDD)
- Inputs: `data/editions/{AAMMDD}/_internal/01-approved.json` (scorer já populou `highlights[]` no Stage 1).

Sequência (§ 2 do playbook): ler `01-approved.json` → dispatch `writer` (Sonnet) → `scripts/lint-newsletter-md.ts` (lint seções vs buckets) → `scripts/normalize-newsletter.ts` → `scripts/humanize.ts` (inline) → `humanizer-llm` opcional (Sonnet, Agent — só se config ou flags ≥ threshold) → Clarice inline (`mcp__clarice__correct_text`) → `scripts/clarice-diff.ts` → `scripts/validate-lancamentos.ts` → drive push → GATE → `title-picker` (Opus, Agent) → `scripts/lint-newsletter-md.ts --check titles-per-highlight`.

## Output

- `_internal/02-draft.md` (pre-Clarice)
- `_internal/02-clarice-diff.md`
- `02-reviewed.md` (final, após aprovação humana no diff)

Apresente diff ao usuário antes de marcar como aprovado.
