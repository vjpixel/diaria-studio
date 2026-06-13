# Bug Heatmap — Diar.ia

**Gerado em**: 2026-06-12T11:18:55.608Z
**Total de bugs analisados**: 583 (0 open)
**Regressions detectadas**: 2

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 5 (open 0)
stage-1            | ■····························· 12 (open 0)
stage-2            | ■····························· 13 (open 0)
stage-3            | ······························ 3 (open 0)
stage-4            | ■····························· 18 (open 0)
stage-5            | ······························ 0 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 532 (open 0)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 5 | 0 | 5 | 2.7h | 0 | #1756, #1659, #1379, #1366, #1365 |
| stage-1 | 12 | 0 | 12 | 8.7h | 0 | #1984, #1969, #1765, #1759, #1756 |
| stage-2 | 13 | 0 | 13 | 3.8h | 0 | #1972, #1761, #1752, #1693, #1691 |
| stage-3 | 3 | 0 | 3 | 3.3h | 0 | #1763, #1753, #1373 |
| stage-4 | 18 | 0 | 18 | 7.2h | 0 | #1828, #1782, #1766, #1764, #1763 |
| stage-5 | 0 | 0 | 0 | — | 0 | — |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 532 | 0 | 532 | 4.9h | 2 | #2152, #2151, #2148, #2147, #2145 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.