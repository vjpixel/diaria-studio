/**
 * test/studio-utms-sort-4463.test.ts (#4463) — cobertura da lógica PURA de
 * ordenação/conversão da tabela de Emissores
 * (`scripts/studio-ui/public/utms-sort.js`). Mesmo padrão de
 * `test/revisao-guards.test.ts`: o módulo não toca `document`, então é
 * testável com fixtures puras, sem harness de DOM.
 *
 * O que este arquivo trava (regressão #633):
 *   1. `computeConversion` — `null`/`undefined` em `subscribers`/`clicks`, ou
 *      `clicks` zero/negativo, sempre vira `null` (nunca `Infinity`/`NaN`
 *      nem "0% real"); cálculo correto quando ambos existem.
 *   2. `fmtPercent` — mesma convenção de `fmtNum` (utms.js): `—` só pra
 *      `null`/`undefined`, nunca pra `0`.
 *   3. `sortRows` — REGRESSÃO CENTRAL do #4463: linhas com valor
 *      `null`/`undefined` na coluna ativa vão pro FIM em AMBAS as direções
 *      (asc E desc), nunca se misturam com "zero real", e `conversion` ordena
 *      pelo percentual JÁ CALCULADO (não recalcula um valor diferente no
 *      comparador). Sem coluna ativa, devolve uma cópia na ordem natural.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeConversion, fmtPercent, sortRows } from "../scripts/studio-ui/public/utms-sort.js";

describe("#4463 — computeConversion (cliques → assinantes)", () => {
  it("calcula o percentual quando ambos os números existem e clicks > 0", () => {
    assert.equal(computeConversion({ subscribers: 40, clicks: 200 }), 20);
    assert.equal(computeConversion({ subscribers: 130, clicks: 130 }), 100);
  });

  it("pode passar de 100% (emissor antigo com poucas campanhas recentes) — não é clampado", () => {
    assert.equal(computeConversion({ subscribers: 500, clicks: 10 }), 5000);
  });

  it("subscribers null (fetch do Beehiiv falhou) → null, nunca NaN", () => {
    assert.equal(computeConversion({ subscribers: null, clicks: 40 }), null);
  });

  it("clicks null (fetch da Brevo falhou) → null, nunca Infinity", () => {
    assert.equal(computeConversion({ subscribers: 40, clicks: null }), null);
  });

  it("clicks === 0 → null (dividir por zero não é '0% real', é 'não dá pra calcular')", () => {
    assert.equal(computeConversion({ subscribers: 0, clicks: 0 }), null);
    assert.equal(computeConversion({ subscribers: 40, clicks: 0 }), null);
  });

  it("subscribers === 0 com clicks > 0 é 0% real (não null)", () => {
    assert.equal(computeConversion({ subscribers: 0, clicks: 40 }), 0);
  });
});

describe("#4463 — fmtPercent (mesma convenção de fmtNum)", () => {
  it("null/undefined viram '—'", () => {
    assert.equal(fmtPercent(null), "—");
    assert.equal(fmtPercent(undefined), "—");
  });

  it("0 é um valor real — não vira '—'", () => {
    assert.equal(fmtPercent(0), "0.0%");
  });

  it("arredonda pra 1 casa decimal", () => {
    assert.equal(fmtPercent(33.333), "33.3%");
  });
});

describe("#4463 — sortRows: null/undefined SEMPRE no fim, em qualquer direção", () => {
  const rows = [
    { id: "a", clicks: 10, subscribers: 5 },
    { id: "b", clicks: null, subscribers: 100 },
    { id: "c", clicks: 50, subscribers: 2 },
    { id: "d", clicks: undefined, subscribers: 1 },
  ];

  it("sem coluna ativa devolve cópia na ordem natural (identidade)", () => {
    const out = sortRows(rows, null, "asc");
    assert.deepEqual(out.map((r) => r.id), ["a", "b", "c", "d"]);
    assert.notEqual(out, rows, "deve ser uma cópia, não a mesma referência");
  });

  it("clicks ASC: valores conhecidos crescentes primeiro, null/undefined no fim (nesta ordem de entrada)", () => {
    const out = sortRows(rows, "clicks", "asc");
    assert.deepEqual(out.map((r) => r.id), ["a", "c", "b", "d"]);
  });

  it("clicks DESC: valores conhecidos decrescentes primeiro, null/undefined AINDA no fim (não inverte pro topo)", () => {
    const out = sortRows(rows, "clicks", "desc");
    assert.deepEqual(out.map((r) => r.id), ["c", "a", "b", "d"]);
  });

  it("subscribers ASC/DESC: todas as linhas têm valor conhecido aqui — sort normal", () => {
    assert.deepEqual(sortRows(rows, "subscribers", "asc").map((r) => r.id), ["d", "c", "a", "b"]);
    assert.deepEqual(sortRows(rows, "subscribers", "desc").map((r) => r.id), ["b", "a", "c", "d"]);
  });
});

describe("#4463 — sortRows: coluna 'conversion' usa o percentual já calculado", () => {
  it("ordena por subscribers/clicks*100, com '—' (clicks 0 ou null) sempre no fim", () => {
    const rows = [
      { id: "alto", clicks: 10, subscribers: 50 }, // 500%
      { id: "zero-clicks", clicks: 0, subscribers: 40 }, // null
      { id: "medio", clicks: 100, subscribers: 20 }, // 20%
      { id: "sem-clicks", clicks: null, subscribers: 5 }, // null
      { id: "baixo", clicks: 200, subscribers: 4 }, // 2%
    ];
    const asc = sortRows(rows, "conversion", "asc");
    assert.deepEqual(asc.map((r) => r.id), ["baixo", "medio", "alto", "zero-clicks", "sem-clicks"]);

    const desc = sortRows(rows, "conversion", "desc");
    assert.deepEqual(desc.map((r) => r.id), ["alto", "medio", "baixo", "zero-clicks", "sem-clicks"]);
  });
});

describe("#4463 — sortRows: empates preservam a ordem natural de entrada (sort estável)", () => {
  it("valores iguais na coluna ativa não trocam de posição relativa", () => {
    const rows = [
      { id: "x", clicks: 10, subscribers: 1 },
      { id: "y", clicks: 10, subscribers: 2 },
      { id: "z", clicks: 5, subscribers: 3 },
    ];
    assert.deepEqual(sortRows(rows, "clicks", "desc").map((r) => r.id), ["x", "y", "z"]);
  });
});
