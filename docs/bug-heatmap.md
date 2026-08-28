# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-08-28T21:04:03.824Z
**Total de bugs analisados**: 1001 (52 open)
**Regressions detectadas**: 0

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 6 (open 0)
stage-1            | ······························ 7 (open 0)
stage-2            | ······························ 6 (open 0)
stage-3            | ······························ 1 (open 0)
stage-4            | ······························ 2 (open 0)
stage-5            | ······························ 3 (open 0)
stage-publish      | ······························ 1 (open 0)
stage-research     | ······························ 1 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 974 (open 52)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 6 | 0 | 6 | 5.4h | 0 | #6090, #5434, #5302, #4836, #4835 |
| stage-1 | 7 | 0 | 7 | 3.0h | 0 | #4947, #4943, #4942, #4880, #4845 |
| stage-2 | 6 | 0 | 6 | 18.4h | 0 | #4952, #4838, #4310, #3696, #2798 |
| stage-3 | 1 | 0 | 1 | 2.1h | 0 | #6078 |
| stage-4 | 2 | 0 | 2 | 1.4h | 0 | #3700, #3691 |
| stage-5 | 3 | 0 | 3 | 10.3h | 0 | #4309, #4294, #3944 |
| stage-publish | 1 | 0 | 1 | 0.5h | 0 | #5472 |
| stage-research | 1 | 0 | 1 | 2.2h | 0 | #4955 |
| (unlabeled) | 974 | 52 | 922 | 7.7h | 0 | #6646, #6643, #6641, #6640, #6638 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.