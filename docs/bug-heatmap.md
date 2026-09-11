# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-09-11T14:01:27.057Z
**Total de bugs analisados**: 1000 (24 open)
**Regressions detectadas**: 2

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 6 (open 0)
stage-1            | ······························ 6 (open 0)
stage-2            | ······························ 2 (open 0)
stage-3            | ······························ 1 (open 0)
stage-4            | ······························ 0 (open 0)
stage-5            | ······························ 1 (open 0)
stage-publish      | ······························ 1 (open 0)
stage-research     | ······························ 1 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 982 (open 24)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 6 | 0 | 6 | 5.4h | 0 | #6090, #5434, #5302, #4836, #4835 |
| stage-1 | 6 | 0 | 6 | 3.2h | 0 | #4947, #4943, #4942, #4880, #4845 |
| stage-2 | 2 | 0 | 2 | 6.4h | 0 | #4952, #4838 |
| stage-3 | 1 | 0 | 1 | 2.1h | 0 | #6078 |
| stage-4 | 0 | 0 | 0 | — | 0 | — |
| stage-5 | 1 | 0 | 1 | 1.5d | 0 | #7412 |
| stage-publish | 1 | 0 | 1 | 0.5h | 0 | #5472 |
| stage-research | 1 | 0 | 1 | 2.2h | 0 | #4955 |
| (unlabeled) | 982 | 24 | 958 | 14.9h | 2 | #7988, #7970, #7969, #7963, #7962 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.