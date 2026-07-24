# Bug Heatmap — Diar.ia

**Gerado em**: 2026-07-24T11:39:15.714Z
**Total de bugs analisados**: 1005 (3 open)
**Regressions detectadas**: 2

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 5 (open 0)
stage-1            | ■····························· 35 (open 0)
stage-2            | ■····························· 18 (open 0)
stage-3            | ······························ 3 (open 0)
stage-4            | ■····························· 20 (open 0)
stage-5            | ······························ 3 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 921 (open 3)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 5 | 0 | 5 | 2.7h | 0 | #1756, #1659, #1379, #1366, #1365 |
| stage-1 | 35 | 0 | 35 | 10.2h | 0 | #3696, #2608, #2438, #2419, #2417 |
| stage-2 | 18 | 0 | 18 | 8.5h | 0 | #3696, #2798, #2794, #2377, #2320 |
| stage-3 | 3 | 0 | 3 | 3.3h | 0 | #1763, #1753, #1373 |
| stage-4 | 20 | 0 | 20 | 6.6h | 0 | #3700, #3691, #1828, #1782, #1766 |
| stage-5 | 3 | 0 | 3 | 10.1h | 0 | #3944, #2376, #2375 |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 921 | 3 | 918 | 7.9h | 2 | #4011, #4000, #3998, #3995, #3982 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.