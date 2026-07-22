/**
 * test/chat-badge.test.ts (#3888) — cobertura da lógica PURA do badge GLOBAL
 * de "algo pendente" (`scripts/studio-ui/public/chat-badge.js`), injetado em
 * TODAS as 8 páginas do Studio via `chat-drawer.js`.
 *
 * Regressão do #3888 (achado: "studio: badge global só conta perguntas do
 * chat — gates de pipeline (4/6) ficam invisíveis em 6 das 8 telas"): antes
 * deste fix, o badge só somava `chatPermissionsPending` — uma edição com
 * gate 4/6 pendente mas sem card de chat aberto nesta sessão (sessão que
 * rodou o stage já terminou, ou roda no terminal, não no chat desta página)
 * não acendia o badge em nenhuma tela fora de "/" e do cockpit. Estes testes
 * cobrem a decisão pura que evita essa regressão: `gatesPending.length` deve
 * contar pro total, mesmo com `chatPermissionsPending` vazio.
 *
 * Mesmo padrão de `test/gate-chat-bridge.test.ts` (#3870): módulo extraído
 * sem tocar `document`, testável via node:test puro — este projeto não tem
 * jsdom/happy-dom (ver `test/studio-edicao-page.test.ts`), então a cobertura
 * do wiring real (chat-drawer.js de fato chamando estas funções) fica pro
 * teste estrutural em `test/chat-drawer-mobile.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeGlobalBadgeCount, resolveBadgeClickAction } from "../scripts/studio-ui/public/chat-badge.js";

describe("computeGlobalBadgeCount (#3888)", () => {
  it("nada pendente → 0", () => {
    assert.equal(computeGlobalBadgeCount([], []), 0);
  });

  it("regression #3888: gate de pipeline pendente SEM nenhum card de chat ainda conta pro badge", () => {
    assert.equal(computeGlobalBadgeCount([{ edition: "260722", stage: 4 }], []), 1);
  });

  it("só chat pendente (comportamento pré-#3888 preservado)", () => {
    assert.equal(computeGlobalBadgeCount([], [{ toolUseId: "a" }]), 1);
  });

  it("soma os dois quando ambos têm itens pendentes", () => {
    const gatesPending = [
      { edition: "260722", stage: 4 },
      { edition: "260721", stage: 6 },
    ];
    const chatPermissionsPending = [{ toolUseId: "a" }];
    assert.equal(computeGlobalBadgeCount(gatesPending, chatPermissionsPending), 3);
  });

  it("defensivo: input não-array nunca lança, conta como 0", () => {
    assert.doesNotThrow(() => computeGlobalBadgeCount(undefined, null));
    assert.equal(computeGlobalBadgeCount(undefined, null), 0);
    assert.equal(computeGlobalBadgeCount("not-an-array", 42), 0);
  });
});

describe("resolveBadgeClickAction (#3888)", () => {
  it("nada pendente → { action: 'toggle' } (comportamento pré-#3888)", () => {
    assert.deepEqual(resolveBadgeClickAction([], [], null), { action: "toggle" });
  });

  it("card de chat pendente (com ou sem gate junto) → { action: 'scroll' }", () => {
    assert.deepEqual(resolveBadgeClickAction([], [{ toolUseId: "a" }], null), { action: "scroll" });
    assert.deepEqual(
      resolveBadgeClickAction([{ edition: "260722", stage: 4 }], [{ toolUseId: "a" }], "260722"),
      { action: "scroll" },
    );
  });

  it("regression #3888: gate pendente SEM card no chat (sessão terminal) → navega pro cockpit da edição corrente", () => {
    const result = resolveBadgeClickAction([{ edition: "260722", stage: 4 }], [], "260722");
    assert.deepEqual(result, { action: "navigate", href: "/edicao/260722" });
  });

  it("escapa o AAMMDD no href (defensivo contra edição com caractere especial)", () => {
    const result = resolveBadgeClickAction([{ edition: "260722", stage: 4 }], [], "260722/../x");
    assert.equal(result.action, "navigate");
    assert.doesNotMatch(result.href, /\.\.\//);
  });

  it("gate pendente mas currentEdition ausente (defensivo, não deveria ocorrer na prática) → toggle, não navega pra 'undefined'", () => {
    const result = resolveBadgeClickAction([{ edition: "260722", stage: 4 }], [], null);
    assert.deepEqual(result, { action: "toggle" });
  });

  it("defensivo: gatesPending/chatPermissionsPending malformados nunca lançam", () => {
    assert.doesNotThrow(() => resolveBadgeClickAction(undefined, undefined, undefined));
    assert.deepEqual(resolveBadgeClickAction(undefined, undefined, undefined), { action: "toggle" });
  });
});
