/**
 * test/candidate-feature-type-sync.test.ts (#7990)
 *
 * Guard permanente contra a classe de bug que motivou o refactor do #7990
 * (achado de review, type-design-analyzer): `CandidateFeature` (tipo,
 * `scripts/calibration-power-report.ts`) e `CANDIDATE_FEATURES` (runtime)
 * derivam de `ALL_BOOLEAN_FEATURE_NAMES` + o mesmo par `Exclude<>`/
 * `NON_CALIBRATABLE_FEATURES` — mas as duas listas de exclusão (uma em
 * tipo, outra em `Set` runtime) são mantidas manualmente em paralelo, não
 * uma derivada da outra. Este teste tem 2 partes:
 *
 * 1. Runtime: `CANDIDATE_FEATURES` nunca contém nenhum membro de
 *    `NON_CALIBRATABLE_FEATURES` — se alguém adicionar um 3º nome a
 *    `NON_CALIBRATABLE_FEATURES` sem espelhar no `Exclude<>` do tipo, o
 *    RUNTIME continua correto (é o `Set.has()` que decide em runtime) mas
 *    o TIPO ficaria permissivo demais — capturado pela parte 2.
 * 2. Compile-time (`@ts-expect-error`, checado por `npx tsc --noEmit` no
 *    CI, não pelo runtime de teste que faz só type-stripping): atribuir
 *    `"negative_impact"` a `CandidateFeature` precisa FALHAR a compilação.
 *    Se um dia passar a compilar (porque alguém removeu do `Exclude<>` sem
 *    querer), o `@ts-expect-error` sem erro correspondente também falha o
 *    `tsc --noEmit` (regra padrão do TS) — dupla trava.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_FEATURES, type CandidateFeature } from "../scripts/calibration-power-report.ts";
import { NON_CALIBRATABLE_FEATURES } from "../scripts/lib/scoring-features.ts";

describe("CandidateFeature × CANDIDATE_FEATURES nunca desalinham (#7990)", () => {
  it("CANDIDATE_FEATURES não contém nenhum membro de NON_CALIBRATABLE_FEATURES", () => {
    for (const f of CANDIDATE_FEATURES) {
      assert.equal(NON_CALIBRATABLE_FEATURES.has(f), false, `${f} não deveria estar em CANDIDATE_FEATURES — está em NON_CALIBRATABLE_FEATURES`);
    }
  });

  it("NON_CALIBRATABLE_FEATURES cobre exatamente {negative_impact, bucket} — se crescer, o Exclude<> do tipo precisa acompanhar", () => {
    assert.deepEqual([...NON_CALIBRATABLE_FEATURES].sort(), ["bucket", "negative_impact"]);
  });

  it("@ts-expect-error: 'negative_impact' não compila como CandidateFeature (checado por tsc --noEmit no CI)", () => {
    // @ts-expect-error — negative_impact é NON_CALIBRATABLE, nunca um CandidateFeature válido.
    const invalid: CandidateFeature = "negative_impact";
    assert.equal(invalid, "negative_impact"); // só pra não sobrar variável não-usada; o que importa é a linha acima não compilar sem o comentário.
  });
});
