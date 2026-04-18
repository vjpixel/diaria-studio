---
name: diaria-social
description: Roda apenas o Stage 3 (4 social writers paralelos + clarice). Requer `02-reviewed.md`. Uso: `/diaria-social YYYY-MM-DD`.
---

# /diaria-social

Executa só o Stage 3.

## Argumentos

- `$1` = data da edição.

## Pré-requisitos

- `data/editions/{YYMMDD}/02-reviewed.md` deve existir.

## Execução

Dispare o `orchestrator` com instrução: rodar **somente Stage 3**.

O orchestrator dispara em paralelo: `social-twitter`, `social-linkedin`, `social-instagram`, `social-cast`. Roda Clarice em cada output. Agrega em `03-social.md`.

## Output

- `03-twitter.md`, `03-linkedin.md`, `03-instagram.md`, `03-cast.md`
- `03-social.md` (agregado para revisão humana)
