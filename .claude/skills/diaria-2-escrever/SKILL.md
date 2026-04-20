---
name: diaria-2-escrever
description: Roda apenas o Stage 2 (writer + clarice). Requer `01-approved.json` já existente. Uso: `/diaria-2-escrever YYYY-MM-DD`.
---

# /diaria-2-escrever

Executa só o Stage 2.

## Argumentos

- `$1` = data da edição. Pergunte se faltar.

## Pré-requisitos

- `data/editions/{YYMMDD}/01-approved.json` deve existir com `highlights[]` (scorer já rodou no Stage 1). Se não, avise: rode `/diaria-1-pesquisa` primeiro e aprove.

## Execução

Dispare o `orchestrator` com instrução: rodar **somente Stage 2** a partir de `01-approved.json`.

O orchestrator lê `highlights[]` de `01-approved.json` (scorer já rodou no Stage 1) e chama `writer` (Sonnet) → `clarice-runner`.

## Output

- `02-draft.md` (pre-Clarice)
- `02-clarice-diff.md`
- `02-reviewed.md` (final, após aprovação humana no diff)

Apresente diff ao usuário antes de marcar como aprovado.
