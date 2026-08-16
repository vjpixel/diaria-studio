# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-08-14T10:55:20.686Z
**Total de bugs analisados**: 1005 (0 open)
**Regressions detectadas**: 1

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 8 (open 0)
stage-1            | ■····························· 41 (open 0)
stage-2            | ■····························· 21 (open 0)
stage-3            | ······························ 3 (open 0)
stage-4            | ■····························· 20 (open 0)
stage-5            | ······························ 5 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 1 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 906 (open 0)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 8 | 0 | 8 | 4.4h | 0 | #4836, #4835, #4834, #1756, #1659 |
| stage-1 | 41 | 0 | 41 | 9.1h | 0 | #4947, #4943, #4942, #4880, #4845 |
| stage-2 | 21 | 0 | 21 | 8.1h | 0 | #4952, #4838, #4310, #3696, #2798 |
| stage-3 | 3 | 0 | 3 | 3.3h | 0 | #1763, #1753, #1373 |
| stage-4 | 20 | 0 | 20 | 6.6h | 0 | #3700, #3691, #1828, #1782, #1766 |
| stage-5 | 5 | 0 | 5 | 7.3h | 0 | #4309, #4294, #3944, #2376, #2375 |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 1 | 0 | 1 | 2.2h | 0 | #4955 |
| (unlabeled) | 906 | 0 | 906 | 7.5h | 1 | #5281, #5280, #5270, #5253, #5246 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.