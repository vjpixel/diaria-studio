# Bug Heatmap — diar.ia.br

**Gerado em**: 2026-10-30T16:31:16.989Z
**Total de bugs analisados**: 1000 (18 open)
**Regressions detectadas**: 4

## ASCII Heatmap

```
Stage              | Bugs (■ ≈ proporcional ao máximo)
----------------------------------------------------------------------
stage-0            | ······························ 0 (open 0)
stage-1            | ······························ 3 (open 0)
stage-2            | ······························ 1 (open 0)
stage-3            | ······························ 0 (open 0)
stage-4            | ······························ 0 (open 0)
stage-5            | ······························ 0 (open 0)
stage-publish      | ······························ 0 (open 0)
stage-research     | ······························ 0 (open 0)
(unlabeled)        | ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ 996 (open 18)
```

## Tabela detalhada

| Stage | Total | Open | Closed | MTTR | Regression | Examples |
|---|---|---|---|---|---|---|
| stage-0 | 0 | 0 | 0 | — | 0 | — |
| stage-1 | 3 | 0 | 3 | 0.5h | 0 | #9652, #9645, #9644 |
| stage-2 | 1 | 0 | 1 | 6.5h | 0 | #10058 |
| stage-3 | 0 | 0 | 0 | — | 0 | — |
| stage-4 | 0 | 0 | 0 | — | 0 | — |
| stage-5 | 0 | 0 | 0 | — | 0 | — |
| stage-publish | 0 | 0 | 0 | — | 0 | — |
| stage-research | 0 | 0 | 0 | — | 0 | — |
| (unlabeled) | 996 | 18 | 978 | 10.0h | 4 | #11692, #11691, #11690, #11689, #11688 |

## Como interpretar

- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.
- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.
- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.
- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.