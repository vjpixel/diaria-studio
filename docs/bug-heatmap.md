# Bug Heatmap — Diar.ia

**Gerado em**: 2026-05-29T11:07:39.311Z
**Total de bugs analisados**: 460 (0 open)
**Regressions detectadas**: 2

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 3 (open 0)
stage-1            | ······························ 2 (open 0)
stage-2            | ······························ 4 (open 0)
stage-3            | ······························ 1 (open 0)
stage-4            | ······························ 4 (open 0)
stage-5            | ······························ 0 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 446 (open 0)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 3 | 0 | 3 | 1.5h | 0 | #1379, #1366, #1365 |
| stage-1 | 2 | 0 | 2 | 2.0h | 0 | #1375, #1374 |
| stage-2 | 4 | 0 | 4 | 1.7h | 0 | #1378, #1368, #1364, #1363 |
| stage-3 | 1 | 0 | 1 | 1.9h | 0 | #1373 |
| stage-4 | 4 | 0 | 4 | 1.9h | 0 | #1376, #1371, #1367, #1365 |
| stage-5 | 0 | 0 | 0 | — | 0 | — |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 446 | 0 | 446 | 5.0h | 2 | #1589, #1588, #1587, #1586, #1585 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.