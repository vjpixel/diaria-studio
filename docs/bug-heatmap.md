# Bug Heatmap — Diar.ia

**Gerado em**: 2026-06-05T11:08:32.655Z
**Total de bugs analisados**: 539 (1 open)
**Regressions detectadas**: 2

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 5 (open 0)
stage-1            | ■····························· 10 (open 0)
stage-2            | ■····························· 12 (open 0)
stage-3            | ······························ 3 (open 0)
stage-4            | ■····························· 18 (open 0)
stage-5            | ······························ 0 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 491 (open 1)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 5 | 0 | 5 | 2.7h | 0 | #1756, #1659, #1379, #1366, #1365 |
| stage-1 | 10 | 0 | 10 | 8.6h | 0 | #1765, #1759, #1756, #1716, #1671 |
| stage-2 | 12 | 0 | 12 | 4.0h | 0 | #1761, #1752, #1693, #1691, #1668 |
| stage-3 | 3 | 0 | 3 | 3.3h | 0 | #1763, #1753, #1373 |
| stage-4 | 18 | 0 | 18 | 7.2h | 0 | #1828, #1782, #1766, #1764, #1763 |
| stage-5 | 0 | 0 | 0 | — | 0 | — |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 491 | 1 | 490 | 5.0h | 2 | #1866, #1865, #1864, #1863, #1861 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.