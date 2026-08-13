---
name: diaria-source-health
description: Mostra a saúde agregada de cada fonte cadastrada (successes, failures, timeouts, duração média) e permite inspecionar o log individual de uma fonte específica para auditoria fina.
---

# /diaria-source-health [fonte]

Desde #5191, todo o cálculo (`success_rate`, `consecutive_failures`, limiares
🟢/🟡/🔴, leitura do log individual) é `scripts/source-health-report.ts` —
testado, não mais interpretação de prosa a cada invocação (mesmo molde do
precedente `/diaria-clarice-novos` → `scripts/clarice-novos-run.ts`, #4941).
Esta skill apenas invoca:

```bash
npx tsx scripts/source-health-report.ts                    # visão geral, todas as fontes
npx tsx scripts/source-health-report.ts --source "AI Breakfast"   # auditoria individual (últimas 20 execuções)
npx tsx scripts/source-health-report.ts --json              # qualquer um dos dois modos, output estruturado
```

**Regra crítica preservada em código e testada (`test/source-health-report.test.ts`, #1576/#1665):**
uma entrada `empty` (fetch OK, zero artigos) NÃO conta como falha dura pro
streak de `consecutive_failures` — só `fail`/`timeout` contam, e `empty`
encerra o streak (mesmo efeito de `ok`). Antes disso viver só em prosa no
SKILL.md, sem teste travando o comportamento.

## Depois de rodar

- Se houver fontes 🔴 no overview, ofereça inspecionar (`--source "Nome"`) ou
  desativar em `seed/sources.csv`.
- Na auditoria individual, se o padrão for óbvio (3 timeouts seguidos, sempre
  mesmo `reason`), ofereça investigar se o site mudou (robots.txt,
  Cloudflare) ou está fora do ar — esse julgamento fica na conversa, não no
  script.

## Regras

- **Somente leitura.** O script nunca escreve em `source-health.json` nem nos
  logs individuais — só `record-source-run(s).ts` escreve.
- Se o usuário pedir "resetar" uma fonte, mover `data/sources/{slug}.jsonl` →
  `data/sources/{slug}.jsonl.bak-{timestamp}` e zerar a entrada da fonte em
  `source-health.json` manualmente. Nunca deletar sem backup — fora do
  escopo do script (ação destrutiva rara, não vale automatizar).
