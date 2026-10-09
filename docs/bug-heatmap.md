# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-10-09T16:47:23.262Z
**Total de bugs analisados**: 1000 (26 open)
**Regressions detectadas**: 5

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 0 (open 0)
stage-1            | ······························ 8 (open 0)
stage-2            | ······························ 0 (open 0)
stage-3            | ······························ 0 (open 0)
stage-4            | ······························ 2 (open 0)
stage-5            | ······························ 1 (open 0)
stage-publish      | ······························ 1 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 988 (open 26)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 0 | 0 | 0 | — | 0 | — |
| stage-1 | 8 | 0 | 8 | 1.9d | 0 | #9652, #9645, #9644, #8682, #8680 |
| stage-2 | 0 | 0 | 0 | — | 0 | — |
| stage-3 | 0 | 0 | 0 | — | 0 | — |
| stage-4 | 2 | 0 | 2 | 1.0d | 0 | #8757, #8679 |
| stage-5 | 1 | 0 | 1 | 1.5d | 0 | #7412 |
| stage-publish | 1 | 0 | 1 | 6.5h | 0 | #8734 |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 988 | 26 | 962 | 20.7h | 5 | #9997, #9996, #9995, #9994, #9993 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.