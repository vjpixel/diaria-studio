# Bug Heatmap — Diar.ia

**Gerado em**: 2026-05-09T05:57:10.871Z
**Total de bugs analisados**: 200 (1 open)
**Regressions detectadas**: 1

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 0 (open 0)
stage-1            | ······························ 0 (open 0)
stage-2            | ······························ 0 (open 0)
stage-3            | ······························ 0 (open 0)
stage-4            | ······························ 0 (open 0)
stage-5            | ······························ 0 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 200 (open 1)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR (h) | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 0 | 0 | 0 | — | 0 | — |
| stage-1 | 0 | 0 | 0 | — | 0 | — |
| stage-2 | 0 | 0 | 0 | — | 0 | — |
| stage-3 | 0 | 0 | 0 | — | 0 | — |
| stage-4 | 0 | 0 | 0 | — | 0 | — |
| stage-5 | 0 | 0 | 0 | — | 0 | — |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 200 | 1 | 199 | 3.7 | 1 | #1017, #998, #997, #996, #995 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.