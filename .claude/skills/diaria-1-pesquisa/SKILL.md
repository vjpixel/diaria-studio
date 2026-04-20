---
name: diaria-1-pesquisa
description: Roda apenas o Stage 1 (pesquisa + verify + dedup + categorize + score). Útil para retry isolado. Uso: `/diaria-1-pesquisa YYYY-MM-DD`.
---

# /diaria-1-pesquisa

Executa só o Stage 1 da pipeline.

## Argumentos

- `$1` = data da edição (`YYYY-MM-DD`). Pergunte se faltar.

## Execução

1. Verifique pré-requisitos: `context/sources.md` e `context/audience-profile.md` (ambos não-placeholder). `past-editions.md` é regenerado automaticamente pelo orchestrator — não precisa estar atualizado.
2. Dispare o `orchestrator` com instrução: rodar **Stage 0 (refresh dedup automático) + Stage 1** e pausar no gate ao final.

O orchestrator executa o refresh de `past-editions.md`, depois o paralelismo do Stage 1 (source-researcher × N fontes + discovery-searcher × M queries + link-verifier + deduplicator + categorizer + scorer).

## Output

`data/editions/{YYMMDD}/01-categorized.json` + `01-categorized.md` — apresentar ao usuário para aprovação. Após aprovação, salvar em `01-approved.json`.
