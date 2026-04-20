---
name: diaria-3-social
description: Roda apenas o Stage 3 (social writers paralelos + clarice). Requer `02-reviewed.md`. Uso: `/diaria-3-social YYYY-MM-DD`.
---

# /diaria-3-social

Executa só o Stage 3.

## Argumentos

- `$1` = data da edição.

## Pré-requisitos

- `data/editions/{YYMMDD}/02-reviewed.md` deve existir.

## Execução

Dispare o `orchestrator` com instrução: rodar **somente Stage 3**.

O orchestrator dispara em paralelo `social-linkedin` e `social-facebook`, faz merge em `03-social.md` e roda Clarice.

## Output

- `03-social.md` (seções `# LinkedIn` / `# Facebook`, cada uma com `## d1/d2/d3`)
