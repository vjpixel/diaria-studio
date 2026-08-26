/**
 * test/plan-merge-train.test.ts (#6300)
 *
 * Cobre `printPlan` (formatação pura) de scripts/plan-merge-train.ts. O
 * script inteiro é read-only por design (nunca muta git/gh) — não há
 * comportamento de execução pra testar aqui, só a composição/impressão do
 * plano. Chamadas reais a `gh` (descoberta de PRs abertos, diff por PR)
 * não são cobertas por teste automatizado — dependem de rede/autenticação,
 * mesmo tratamento de qualquer outro script `gh`-dependente do repo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { printPlan } from "../scripts/plan-merge-train.ts";

describe("printPlan", () => {
  it("PRs sem colisão viram 1 trem só, reportado como não-singleton", () => {
    const out = printPlan(
      [
        { pr: 1, files: ["a.ts"] },
        { pr: 2, files: ["b.ts"] },
      ],
      3,
    );
    assert.match(out, /1 lote\(s\) composto/);
    assert.match(out, /trem de 2.*#1, #2/);
  });

  it("PRs colidentes viram lotes singleton, cada um rotulado 'caminho de hoje'", () => {
    const out = printPlan(
      [
        { pr: 1, files: ["shared.ts"] },
        { pr: 2, files: ["shared.ts"] },
      ],
      3,
    );
    assert.match(out, /2 lote\(s\) composto/);
    assert.match(out, /singleton \(caminho de hoje, sem trem\)/);
  });

  it("reporta contagem de runs de CI hoje vs. com o trem no caminho feliz", () => {
    const out = printPlan(
      [
        { pr: 1, files: ["a.ts"] },
        { pr: 2, files: ["b.ts"] },
        { pr: 3, files: ["c.ts"] },
      ],
      3,
    );
    assert.match(out, /3 hoje \(1 por PR\)/);
    assert.match(out, /1 com o trem/);
  });
});
