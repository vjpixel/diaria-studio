# lint-checks/ — decomposição do `lint-newsletter-md.ts` (#1737 item 2)

Cada check do `lint-newsletter-md.ts` (1800+ linhas, 14 modos `--check`) está
saindo, **incremental** (1–2 checks por PR, per #1737), pra um módulo por-check
aqui. Espelha a ideia de `scripts/lib/invariant-checks/`, mas com uma diferença
deliberada de escopo descrita abaixo.

## Estado

| módulo | check (`--check ...`) | issue |
|---|---|---|
| `multiline-links.ts` | `multiline-links` | #1213 |
| `relative-time.ts` | `relative-time` | #747 |
| `why-matters-format.ts` | `why-matters-format` | #701 |
| `eai-section.ts` | `eai-section` | #588 |
| `coverage-line-format.ts` | `coverage-line-format` | #592/#609/#1207 |
| `destaque-chars.ts` | `destaque-min-chars` + `destaque-max-chars` | #914/#964 |

Os demais (`titles-per-highlight`, `title-length`, `eia-answer`,
`intentional-error-flagged`, `section-item-format`, `section-counts`,
`intro-count`) ainda vivem no `lint-newsletter-md.ts`.

## Plano em fases (por que NÃO há registry/`types.ts` ainda)

Diferente do `invariant-checks/` — onde **toda** regra tem a mesma assinatura
`(editionDir) => InvariantViolation[]` e um registry (`index.ts`) faz o dispatch
uniforme — os checks de lint são **heterogêneos**: inputs diferentes (`(md)` vs
`(md, approved)` vs `(md, editionDir)`), shapes de resultado diferentes
(`{ok, matches}`, `{ok, error}`, `{ok, claimed, actual}`, `{ok, errors}`) e
formatação de output/exit própria por check no `main()`.

Forçar um contrato comum + registry com só 2 checks extraídos seria abstração
prematura (o shape certo só fica claro com mais checks à vista). Então:

- **Fase 1 (em curso):** mover os checks auto-contidos pra módulos puros aqui;
  `lint-newsletter-md.ts` re-exporta pra back-compat e o `main()` importa +
  mantém o dispatch. Ganho imediato: arquivo menor, módulos isoláveis/testáveis.
- **Fase 2 (depois que a maioria estiver extraída):** com o conjunto de shapes
  visível, introduzir um `types.ts` (contrato `LintCheck`) + registry e reduzir
  o `main()` a um dispatcher fino. Só então o retrofit vale, sem chutar o shape.

Cada extração é validada byte-a-byte (smoke do CLI + suíte existente) e mantém a
disciplina de teste do #633.
