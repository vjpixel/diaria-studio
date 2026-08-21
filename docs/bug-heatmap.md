# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-08-21T10:25:57.203Z
**Total de bugs analisados**: 1004 (4 open)
**Regressions detectadas**: 0

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 6 (open 0)
stage-1            | ■····························· 38 (open 0)
stage-2            | ······························ 14 (open 0)
stage-3            | ······························ 2 (open 0)
stage-4            | ······························ 13 (open 0)
stage-5            | ······························ 5 (open 0)
stage-publish      | ······························ 1 (open 0)
stage-research     | ······························ 1 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 924 (open 4)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 6 | 0 | 6 | 6.0h | 0 | #5434, #5302, #4836, #4835, #4834 |
| stage-1 | 38 | 0 | 38 | 9.5h | 0 | #4947, #4943, #4942, #4880, #4845 |
| stage-2 | 14 | 0 | 14 | 11.1h | 0 | #4952, #4838, #4310, #3696, #2798 |
| stage-3 | 2 | 0 | 2 | 4.0h | 0 | #1763, #1753 |
| stage-4 | 13 | 0 | 13 | 7.2h | 0 | #3700, #3691, #1828, #1782, #1766 |
| stage-5 | 5 | 0 | 5 | 7.3h | 0 | #4309, #4294, #3944, #2376, #2375 |
| stage-publish | 1 | 0 | 1 | 0.5h | 0 | #5472 |
| stage-research | 1 | 0 | 1 | 2.2h | 0 | #4955 |
| (unlabeled) | 924 | 4 | 920 | 7.3h | 0 | #5852, #5851, #5844, #5843, #5842 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.