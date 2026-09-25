# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-09-25T14:58:26.646Z
**Total de bugs analisados**: 1000 (27 open)
**Regressions detectadas**: 3

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 1 (open 0)
stage-1            | ······························ 5 (open 1)
stage-2            | ······························ 0 (open 0)
stage-3            | ······························ 1 (open 0)
stage-4            | ······························ 2 (open 0)
stage-5            | ······························ 1 (open 0)
stage-publish      | ······························ 1 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 989 (open 26)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 1 | 0 | 1 | 2.5h | 0 | #6090 |
| stage-1 | 5 | 1 | 4 | 14.9h | 0 | #8682, #8680, #8668, #8667, #8666 |
| stage-2 | 0 | 0 | 0 | — | 0 | — |
| stage-3 | 1 | 0 | 1 | 2.1h | 0 | #6078 |
| stage-4 | 2 | 0 | 2 | 1.0d | 0 | #8757, #8679 |
| stage-5 | 1 | 0 | 1 | 1.5d | 0 | #7412 |
| stage-publish | 1 | 0 | 1 | 6.5h | 0 | #8734 |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 989 | 26 | 963 | 1.0d | 3 | #8806, #8804, #8803, #8802, #8795 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.