---
name: diaria-research
description: Roda apenas o Stage 1 (research + verify + dedup + categorize). Útil para retry isolado. Uso: `/diaria-research YYYY-MM-DD`.
---

# /diaria-research

Executa só o Stage 1 da pipeline.

## Argumentos

- `$1` = data da edição (`YYYY-MM-DD`). Pergunte se faltar.

## Execução

1. Verifique pré-requisitos: `context/sources.md` e `context/audience-profile.md` (ambos não-placeholder). `past-editions.md` é regenerado automaticamente pelo orchestrator — não precisa estar atualizado.
2. Dispare o `orchestrator` com instrução: rodar **Stage 0 (refresh dedup automático) + Stage 1** e pausar no gate ao final.

O orchestrator primeiro executa o refresh automático de `past-editions.md` via Beehiiv MCP (ver Stage 0 em `agents/orchestrator.md`), depois o paralelismo do Stage 1 (source-researcher × N fontes + discovery-searcher × M queries + link-verifier em chunks + deduplicator + categorizer).

## Output

`data/editions/{YYMMDD}/01-categorized.json` — apresentar ao usuário para aprovação. Após aprovação, salvar em `01-approved.json`.
