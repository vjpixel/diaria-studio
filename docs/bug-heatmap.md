# Bug Heatmap — Diar.ia

**Gerado em**: 2026-07-10T12:23:00.856Z
**Total de bugs analisados**: 814 (3 open)
**Regressions detectadas**: 2

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 5 (open 0)
stage-1            | ■····························· 34 (open 0)
stage-2            | ■····························· 17 (open 0)
stage-3            | ······························ 3 (open 0)
stage-4            | ■····························· 18 (open 0)
stage-5            | ······························ 2 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 735 (open 3)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 5 | 0 | 5 | 2.7h | 0 | #1756, #1659, #1379, #1366, #1365 |
| stage-1 | 34 | 0 | 34 | 10.4h | 0 | #2608, #2438, #2419, #2417, #2414 |
| stage-2 | 17 | 0 | 17 | 8.9h | 0 | #2798, #2794, #2377, #2320, #1972 |
| stage-3 | 3 | 0 | 3 | 3.3h | 0 | #1763, #1753, #1373 |
| stage-4 | 18 | 0 | 18 | 7.2h | 0 | #1828, #1782, #1766, #1764, #1763 |
| stage-5 | 2 | 0 | 2 | 2.9h | 0 | #2376, #2375 |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 735 | 3 | 732 | 8.7h | 2 | #3226, #3223, #3222, #3220, #3215 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.