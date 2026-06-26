# Bug Heatmap — Diar.ia

**Gerado em**: 2026-06-26T11:02:26.252Z
**Total de bugs analisados**: 705 (10 open)
**Regressions detectadas**: 2

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 5 (open 0)
stage-1            | ■■···························· 33 (open 0)
stage-2            | ■····························· 15 (open 0)
stage-3            | ······························ 3 (open 0)
stage-4            | ■····························· 18 (open 0)
stage-5            | ······························ 2 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 629 (open 10)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 5 | 0 | 5 | 2.7h | 0 | #1756, #1659, #1379, #1366, #1365 |
| stage-1 | 33 | 0 | 33 | 10.3h | 0 | #2438, #2419, #2417, #2414, #2413 |
| stage-2 | 15 | 0 | 15 | 4.0h | 0 | #2377, #2320, #1972, #1761, #1752 |
| stage-3 | 3 | 0 | 3 | 3.3h | 0 | #1763, #1753, #1373 |
| stage-4 | 18 | 0 | 18 | 7.2h | 0 | #1828, #1782, #1766, #1764, #1763 |
| stage-5 | 2 | 0 | 2 | 2.9h | 0 | #2376, #2375 |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 629 | 10 | 619 | 5.2h | 2 | #2605, #2604, #2603, #2600, #2595 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.