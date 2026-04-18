---
name: diaria-source-health
description: Mostra a saúde agregada de cada fonte cadastrada (successes, failures, timeouts, duração média) e permite inspecionar o log individual de uma fonte específica para auditoria fina.
---

# /diaria-source-health [fonte]

Inspeciona a saúde das fontes usadas no Stage 1 da pipeline.

## Sem argumento — visão geral

1. Ler `data/source-health.json`.
2. Para cada fonte, computar:
   - `success_rate = successes / attempts` (em %)
   - `consecutive_failures` = contar entradas não-ok do fim de `recent_outcomes` até o primeiro `ok` (cada entrada é `{ outcome, timestamp }`)
   - status indicador: 🟢 success_rate ≥ 80% e sem streak; 🟡 success_rate ≥ 50% ou streak 1-2; 🔴 success_rate < 50% ou streak 3+
3. Apresentar tabela ordenada por status (pior primeiro):

```
📊 Source health — 14 fontes

🔴 AI Breakfast          0/3   (timeouts 3 seguidos, última falha: 2026-04-17T14:22Z)
🟡 MIT Tech Review BR    2/4   (50%, última falha: 2026-04-16T08:01Z, duração última: 178s)
🟢 DeepMind             12/13  (92%, duração média: 34s)
...
```

4. Ao final, se houver fontes 🔴, perguntar:
   > Quer inspecionar o log individual de alguma (ex: `/diaria-source-health "AI Breakfast"`) ou desativar em `seed/sources.csv`?

## Com argumento `[fonte]` — auditoria individual

1. Slugify o nome: lowercase + `[^a-z0-9]+` → `-`.
2. Abrir `data/sources/{slug}.jsonl`. Se não existir, reportar e abortar.
3. Ler as últimas 20 execuções (linhas JSON).
4. Apresentar em ordem cronológica reversa:

```
🔍 AI Breakfast — últimas 5 execuções

[2026-04-17 14:22Z · edição 260417] timeout em 180s  (reason: consecutive_fetch_errors)
  query: site:aibreakfast.beehiiv.com AI OR "inteligência artificial"
  0 artigos retornados

[2026-04-16 14:18Z · edição 260416] ok em 42s
  query: site:aibreakfast.beehiiv.com AI OR ...
  3 artigos:
    - "Novo modelo X supera benchmark Y" (2026-04-15)
      https://aibreakfast.beehiiv.com/p/novo-modelo-x
    ...
```

5. Se detectar padrão óbvio (ex: 3 timeouts seguidos, sempre mesmo `reason`), apontar com os timestamps e oferecer investigar:
   > 3 timeouts consecutivos (2026-04-15T14:18Z, 2026-04-16T14:20Z, 2026-04-17T14:22Z), sempre `consecutive_fetch_errors`. Quer que eu olhe se o site mudou (robots.txt, Cloudflare) ou se o domínio está fora do ar?

## Regras

- **Somente leitura.** Nunca modifique `source-health.json` ou os logs individuais — eles são escritos só por `record-source-run.ts`.
- Se o usuário pedir "resetar" uma fonte, mover `data/sources/{slug}.jsonl` → `data/sources/{slug}.jsonl.bak-{timestamp}` e zerar a entrada da fonte em `source-health.json`. Nunca deletar sem backup.
