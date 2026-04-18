---
name: diaria-escrever
description: Roda apenas o Stage 2 (writer + clarice). Requer `01-approved.json` já existente. Uso: `/diaria-escrever YYYY-MM-DD`.
---

# /diaria-escrever

Executa só o Stage 2.

## Argumentos

- `$1` = data da edição. Pergunte se faltar.

## Pré-requisitos

- `data/editions/{YYMMDD}/01-approved.json` deve existir. Se não, avise: rode `/diaria-research` primeiro e aprove.

## Execução

Dispare o `orchestrator` com instrução: rodar **somente Stage 2** a partir de `01-approved.json`.

O orchestrator chama `scorer` (Sonnet) → `writer` (Sonnet) → `clarice-runner`.

## Output

- `02-draft.md` (pre-Clarice)
- `02-clarice-diff.md`
- `02-reviewed.md` (final, após aprovação humana no diff)

Apresente diff ao usuário antes de marcar como aprovado.
