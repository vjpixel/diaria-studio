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

Dispare o `orchestrator` com instrução: rodar **somente Stage 2** a partir de `_internal/01-approved.json`.

O orchestrator lê `highlights[]` de `_internal/01-approved.json` (scorer já rodou no Stage 1) e chama `writer` (Sonnet) → Clarice inline (`mcp__clarice__correct_text` + `scripts/clarice-diff.ts`).

## Output

- `_internal/02-draft.md` (pre-Clarice)
- `_internal/02-clarice-diff.md`
- `02-reviewed.md` (final, após aprovação humana no diff)

Apresente diff ao usuário antes de marcar como aprovado.
