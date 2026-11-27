# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-11-27T19:19:39.224Z
**Total de bugs analisados**: 1000 (21 open)
**Regressions detectadas**: 3

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 0 (open 0)
stage-1            | ······························ 5 (open 0)
stage-2            | ······························ 0 (open 0)
stage-3            | ······························ 1 (open 0)
stage-4            | ······························ 3 (open 0)
stage-5            | ······························ 3 (open 0)
stage-publish      | ······························ 1 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 987 (open 21)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 0 | 0 | 0 | — | 0 | — |
| stage-1 | 5 | 0 | 5 | 17.3h | 0 | #14022, #14021, #14020, #13846, #13844 |
| stage-2 | 0 | 0 | 0 | — | 0 | — |
| stage-3 | 1 | 0 | 1 | 5.1h | 0 | #14019 |
| stage-4 | 3 | 0 | 3 | 1.8h | 0 | #13860, #13856, #13848 |
| stage-5 | 3 | 0 | 3 | 1.1d | 0 | #14011, #14010, #13847 |
| stage-publish | 1 | 0 | 1 | 5.3h | 0 | #14012 |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 987 | 21 | 966 | 15.1h | 3 | #14358, #14356, #14355, #14354, #14344 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.