---
name: diaria-edicao
description: Roda a pipeline completa da Diar.ia (stages 1-3 na Fase 1), pausando em cada gate humano. Uso: `/diaria-edicao YYYY-MM-DD`.
---

# /diaria-edicao

Invoca o orchestrator para produzir uma nova edição da Diar.ia.

## Argumentos

- `$1` = data da edição no formato `YYYY-MM-DD` (ex: `2026-04-18`).

Se `$1` não for passado, peça ao usuário.

## Pré-requisitos

Antes de iniciar, verifique:
1. `context/audience-profile.md` existe e não é placeholder. Se for, avise: rode `/diaria-atualiza-audiencia` primeiro (muda lento, rodar semanalmente/mensalmente).
2. `context/sources.md` existe. Se não, rode `npm run sync-sources`.
3. `context/past-editions.md` **não precisa estar atualizado** — o orchestrator regenera automaticamente via Beehiiv MCP no Stage 0.

## Execução

Dispare o subagente `orchestrator` passando `edition_date = $1`.

O orchestrator vai:
- Stage 0 (refresh automático de `past-editions.md` via Beehiiv MCP) — sem gate
- Stage 1 (research + dedup + categorize) → GATE humano
- Stage 2 (writer + clarice) → GATE humano
- Stage 3 (4 social writers + clarice) → GATE humano

Em cada gate, apresente ao usuário o output do stage e peça aprovação (`sim` / `editar` / `retry`).

Stages 4-7 não estão implementados na Fase 1 — se o usuário pedir, informe.

## Outputs

Todos em `data/editions/{YYMMDD}/`:
- `01-categorized.json`, `01-approved.json`
- `02-draft.md`, `02-clarice-diff.md`, `02-reviewed.md`
- `03-twitter.md`, `03-linkedin.md`, `03-instagram.md`, `03-cast.md`, `03-social.md` (agregado)
