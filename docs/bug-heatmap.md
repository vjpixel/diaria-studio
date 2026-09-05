# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-09-04T13:58:18.776Z
**Total de bugs analisados**: 1000 (20 open)
**Regressions detectadas**: 2

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 6 (open 0)
stage-1            | ······························ 6 (open 0)
stage-2            | ······························ 3 (open 0)
stage-3            | ······························ 1 (open 0)
stage-4            | ······························ 0 (open 0)
stage-5            | ······························ 4 (open 1)
stage-publish      | ······························ 1 (open 0)
stage-research     | ······························ 1 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 978 (open 19)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 6 | 0 | 6 | 5.4h | 0 | #6090, #5434, #5302, #4836, #4835 |
| stage-1 | 6 | 0 | 6 | 3.2h | 0 | #4947, #4943, #4942, #4880, #4845 |
| stage-2 | 3 | 0 | 3 | 5.6h | 0 | #4952, #4838, #4310 |
| stage-3 | 1 | 0 | 1 | 2.1h | 0 | #6078 |
| stage-4 | 0 | 0 | 0 | — | 0 | — |
| stage-5 | 4 | 1 | 3 | 10.3h | 0 | #7412, #4309, #4294, #3944 |
| stage-publish | 1 | 0 | 1 | 0.5h | 0 | #5472 |
| stage-research | 1 | 0 | 1 | 2.2h | 0 | #4955 |
| (unlabeled) | 978 | 19 | 959 | 12.8h | 2 | #7433, #7430, #7427, #7418, #7411 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.