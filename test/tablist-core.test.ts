/**
 * test/tablist-core.test.ts (#3874) — cobertura da lógica PURA de navegação
 * por teclado em WAI-ARIA APG tabs (`scripts/studio-ui/public/tablist-core.js`),
 * compartilhada por revisao.js (2 tablists) e rodada.js (1 tablist). Mesmo
 * padrão de `test/revisao-guards.test.ts`/`test/studio-nav.test.ts`: o
 * módulo não toca `document`, testável com fixtures puras.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextTabIndex, syncTabAria } from "../scripts/studio-ui/public/tablist-core.js";

describe("nextTabIndex (#3874)", () => {
  it("ArrowRight avança pro próximo índice", () => {
    assert.equal(nextTabIndex("ArrowRight", 0, 3), 1);
    assert.equal(nextTabIndex("ArrowRight", 1, 3), 2);
  });

  it("ArrowRight na última aba dá wrap-around pra primeira (padrão APG)", () => {
    assert.equal(nextTabIndex("ArrowRight", 2, 3), 0);
  });

  it("ArrowLeft volta pro índice anterior", () => {
    assert.equal(nextTabIndex("ArrowLeft", 2, 3), 1);
  });

  it("ArrowLeft na primeira aba dá wrap-around pra última (padrão APG)", () => {
    assert.equal(nextTabIndex("ArrowLeft", 0, 3), 2);
  });

  it("Home sempre vai pro índice 0", () => {
    assert.equal(nextTabIndex("Home", 2, 4), 0);
  });

  it("End sempre vai pro último índice", () => {
    assert.equal(nextTabIndex("End", 0, 4), 3);
  });

  it("tecla que não é de navegação de tabs -> null (não intercepta o comportamento default)", () => {
    assert.equal(nextTabIndex("Enter", 0, 3), null);
    assert.equal(nextTabIndex("a", 0, 3), null);
    assert.equal(nextTabIndex("Tab", 1, 3), null);
  });

  it("count <= 0 -> sempre null (nenhuma aba pra navegar)", () => {
    assert.equal(nextTabIndex("ArrowRight", 0, 0), null);
    assert.equal(nextTabIndex("Home", 0, -1), null);
  });

  it("2 abas (caso real de rodada.js: overnight/develop) — wrap-around também funciona", () => {
    assert.equal(nextTabIndex("ArrowRight", 0, 2), 1);
    assert.equal(nextTabIndex("ArrowRight", 1, 2), 0);
    assert.equal(nextTabIndex("ArrowLeft", 0, 2), 1);
  });
});

describe("syncTabAria (#3874)", () => {
  /** Stub mínimo de um elemento `role="tab"` — só o suficiente pra exercer
   * `syncTabAria` sem harness de DOM real (mesmo princípio de pureza do
   * resto do módulo). */
  function makeTabStub(id) {
    const attrs = {};
    return {
      id,
      tabIndex: undefined,
      setAttribute(name, value) {
        attrs[name] = value;
      },
      getAttribute(name) {
        return attrs[name];
      },
    };
  }

  it("marca aria-selected=true e tabindex=0 só na aba ativa; as outras ficam false/-1", () => {
    const tabs = [makeTabStub("a"), makeTabStub("b"), makeTabStub("c")];
    syncTabAria(tabs, (el) => el.id === "b");
    assert.equal(tabs[0].getAttribute("aria-selected"), "false");
    assert.equal(tabs[0].tabIndex, -1);
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    assert.equal(tabs[1].tabIndex, 0);
    assert.equal(tabs[2].getAttribute("aria-selected"), "false");
    assert.equal(tabs[2].tabIndex, -1);
  });

  it("nenhuma aba ativa (predicado sempre falso) -> todas false/-1, nunca quebra", () => {
    const tabs = [makeTabStub("a"), makeTabStub("b")];
    syncTabAria(tabs, () => false);
    assert.equal(tabs[0].getAttribute("aria-selected"), "false");
    assert.equal(tabs[1].getAttribute("aria-selected"), "false");
  });
});
