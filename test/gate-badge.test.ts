/**
 * test/gate-badge.test.ts (#7050) — cobertura da lógica PURA do badge
 * global de gate de pipeline pendente (`scripts/studio-ui/public/gate-badge.js`),
 * injetado por `nav.js` em toda página do Studio que monta o menu
 * compartilhado.
 *
 * Regressão do #7050 (achado do review da PR que fechou o #6942 — remoção
 * do chat do Studio por inteiro): `chat-badge.js` não era só o badge do
 * chat — desde o #3888 ele era o único sinal de `gatesPending` (Stage 4/6)
 * visível fora de "/" e do cockpit "/edicao/:aammdd". Remover o chat por
 * inteiro sem portar essa metade reabriria a mesma lacuna que o #3888
 * fechou (edição com gate pendente ficando sem nenhum sinal em quase toda
 * tela do Studio). Estes testes cobrem a decisão pura que evita essa
 * regressão.
 *
 * Mesmo padrão de `test/chat-badge.test.ts` (removido no #6942 junto com o
 * chat) e de `test/gate-chat-bridge.test.ts` — módulo extraído sem tocar
 * `document`, testável via node:test puro (este projeto não tem
 * jsdom/happy-dom, ver `test/studio-edicao-page.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeGateBadgeCount,
  resolveGateBadgeHref,
  renderGateBadgeHtml,
} from "../scripts/studio-ui/public/gate-badge.js";

describe("computeGateBadgeCount (#7050)", () => {
  it("nada pendente → 0", () => {
    assert.equal(computeGateBadgeCount([]), 0);
  });

  it("soma todos os gates pendentes, qualquer edição/stage", () => {
    const gatesPending = [
      { edition: "260722", stage: 4 },
      { edition: "260721", stage: 6 },
    ];
    assert.equal(computeGateBadgeCount(gatesPending), 2);
  });

  it("defensivo: input não-array nunca lança, conta como 0", () => {
    assert.doesNotThrow(() => computeGateBadgeCount(undefined));
    assert.equal(computeGateBadgeCount(undefined), 0);
    assert.equal(computeGateBadgeCount(null), 0);
    assert.equal(computeGateBadgeCount("not-an-array"), 0);
  });
});

describe("resolveGateBadgeHref (#7050)", () => {
  it("nada pendente → null (badge não aparece)", () => {
    assert.equal(resolveGateBadgeHref([], "260722"), null);
  });

  it("gate pendente + edição corrente resolvida → href do cockpit", () => {
    const result = resolveGateBadgeHref([{ edition: "260722", stage: 4 }], "260722");
    assert.equal(result, "/edicao/260722");
  });

  it("gate pendente mas sem edição corrente (defensivo, não deveria ocorrer na prática) → null", () => {
    assert.equal(resolveGateBadgeHref([{ edition: "260722", stage: 4 }], null), null);
  });

  it("escapa o AAMMDD no href (defensivo contra edição com caractere especial)", () => {
    const result = resolveGateBadgeHref([{ edition: "260722", stage: 4 }], "260722/../x");
    assert.ok(result);
    assert.doesNotMatch(result as string, /\.\.\//);
  });

  it("defensivo: gatesPending malformado nunca lança", () => {
    assert.doesNotThrow(() => resolveGateBadgeHref(undefined, undefined));
    assert.equal(resolveGateBadgeHref(undefined, undefined), null);
  });
});

describe("renderGateBadgeHtml (#7050)", () => {
  it("nada pendente → string vazia (nenhum badge no DOM)", () => {
    assert.equal(renderGateBadgeHtml([], "260722"), "");
  });

  it("gate pendente sem edição corrente → string vazia", () => {
    assert.equal(renderGateBadgeHtml([{ edition: "260722", stage: 4 }], null), "");
  });

  it("1 gate pendente → HTML com contagem no singular, texto visível (R7)", () => {
    const html = renderGateBadgeHtml([{ edition: "260722", stage: 4 }], "260722");
    assert.match(html, /href="\/edicao\/260722"/);
    assert.match(html, /1 gate pendente/);
  });

  it("múltiplos gates pendentes → contagem no plural", () => {
    const gatesPending = [
      { edition: "260722", stage: 4 },
      { edition: "260721", stage: 6 },
    ];
    const html = renderGateBadgeHtml(gatesPending, "260722");
    assert.match(html, /2 gates pendentes/);
  });

  it("defensivo: input malformado nunca lança, sempre string", () => {
    assert.doesNotThrow(() => renderGateBadgeHtml(undefined, undefined));
    assert.equal(typeof renderGateBadgeHtml(undefined, undefined), "string");
  });
});
