# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-10-23T14:38:38.420Z
**Total de bugs analisados**: 1000 (11 open)
**Regressions detectadas**: 4

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 0 (open 0)
stage-1            | ······························ 8 (open 0)
stage-2            | ······························ 1 (open 0)
stage-3            | ······························ 0 (open 0)
stage-4            | ······························ 2 (open 0)
stage-5            | ······························ 0 (open 0)
stage-publish      | ······························ 1 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 988 (open 11)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 0 | 0 | 0 | — | 0 | — |
| stage-1 | 8 | 0 | 8 | 1.9d | 0 | #9652, #9645, #9644, #8682, #8680 |
| stage-2 | 1 | 0 | 1 | 6.5h | 0 | #10058 |
| stage-3 | 0 | 0 | 0 | — | 0 | — |
| stage-4 | 2 | 0 | 2 | 1.0d | 0 | #8757, #8679 |
| stage-5 | 0 | 0 | 0 | — | 0 | — |
| stage-publish | 1 | 0 | 1 | 6.5h | 0 | #8734 |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 988 | 11 | 977 | 15.7h | 4 | #11029, #11026, #11024, #11019, #10998 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.