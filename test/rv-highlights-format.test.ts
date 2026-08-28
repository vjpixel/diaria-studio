/**
 * test/rv-highlights-format.test.ts (#6447 Fatia 2)
 *
 * Testa a formatação/lógica PURA (sem DOM) do painel "Editor por destaque" —
 * `scripts/studio-ui/public/rv-highlights-format.js` — mesmo padrão de
 * `test/rv-gate-format.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  graphemeLength,
  isTitleTooLong,
  formatTitleCharCount,
  resolveFinalTitle,
  buildHighlightSavePayload,
  initCardState,
  mergeIncomingHighlights,
} from "../scripts/studio-ui/public/rv-highlights-format.js";

describe("graphemeLength", () => {
  it("conta emoji de bandeira como 1 grafema, não 4 code units", () => {
    assert.equal(graphemeLength("🇧🇷 Brasil"), 8); // 🇧🇷 + espaço + "Brasil" (6) = 1+1+6
  });

  it("string vazia -> 0", () => {
    assert.equal(graphemeLength(""), 0);
  });
});

describe("isTitleTooLong / formatTitleCharCount", () => {
  it("título dentro do limite -> não estoura, contador correto", () => {
    const title = "Título curto";
    assert.equal(isTitleTooLong(title, 52), false);
    assert.equal(formatTitleCharCount(title, 52), `${title.length}/52`);
  });

  it("título acima do limite -> estoura", () => {
    const longTitle = "x".repeat(60);
    assert.equal(isTitleTooLong(longTitle, 52), true);
    assert.equal(formatTitleCharCount(longTitle, 52), "60/52");
  });

  it("título nulo/undefined não lança — trata como vazio", () => {
    assert.equal(isTitleTooLong(undefined, 52), false);
    assert.equal(formatTitleCharCount(null, 52), "0/52");
  });
});

describe("resolveFinalTitle", () => {
  it("campo livre vazio -> usa a opção selecionada", () => {
    assert.equal(resolveFinalTitle("Opção 2", ""), "Opção 2");
    assert.equal(resolveFinalTitle("Opção 2", "   "), "Opção 2");
  });

  it("campo livre preenchido -> vence sobre a opção selecionada", () => {
    assert.equal(resolveFinalTitle("Opção 2", "Título reescrito à mão"), "Título reescrito à mão");
  });
});

describe("buildHighlightSavePayload", () => {
  it("monta o payload com trim + filtra parágrafos vazios", () => {
    const payload = buildHighlightSavePayload({
      title: "  Título final  ",
      url: " https://example.com ",
      bodyParagraphs: ["Parágrafo 1", "  ", "", "Parágrafo 2  "],
      whyMatters: "  Impacto.  ",
      expectedModifiedAt: "2026-08-28T00:00:00.000Z",
    });
    assert.deepEqual(payload, {
      title: "Título final",
      url: "https://example.com",
      body: ["Parágrafo 1", "Parágrafo 2"],
      whyMatters: "Impacto.",
      expectedModifiedAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("expectedModifiedAt ausente vira null", () => {
    const payload = buildHighlightSavePayload({
      title: "t",
      url: "u",
      bodyParagraphs: ["p"],
      whyMatters: "w",
    });
    assert.equal(payload.expectedModifiedAt, null);
  });
});

// #6493 review (code-reviewer, P2): mergeIncomingHighlights é o fix pro
// achado "reload de 1 card apaga edição não-salva de OUTRO card" —
// preservar cobertura direta da função pura, não só via o card que a chama.
describe("initCardState / mergeIncomingHighlights (#6493 review)", () => {
  const H1 = { n: 1, category: "🚀 LANÇAMENTO", titleOptions: [{ text: "T1", line: 3 }], url: "https://x/1", body: ["b1"], whyMatters: "w1" };
  const H2 = { n: 2, category: "💼 MERCADO", titleOptions: [{ text: "T2", line: 10 }], url: "https://x/2", body: ["b2"], whyMatters: "w2" };

  it("initCardState monta o estado inicial não-dirty a partir do highlight + modifiedAt", () => {
    const state = initCardState(H1, "2026-08-28T00:00:00.000Z");
    assert.equal(state.n, 1);
    assert.equal(state.dirty, false);
    assert.equal(state.selectedIndex, 0);
    assert.equal(state.freeformTitle, "");
    assert.equal(state.modifiedAt, "2026-08-28T00:00:00.000Z");
    assert.deepEqual(state.body, ["b1"]);
  });

  it("initCardState copia body (não compartilha array com o highlight de entrada)", () => {
    const state = initCardState(H1, null);
    state.body.push("mutado");
    assert.deepEqual(H1.body, ["b1"], "o array original não deve ser afetado");
  });

  it("sem estado anterior (1ª carga): monta tudo do zero, nada 'dirty'", () => {
    const merged = mergeIncomingHighlights([], [H1, H2], "m1");
    assert.equal(merged.length, 2);
    assert.equal(merged.every((s: any) => s.dirty === false), true);
  });

  it("card NÃO dirty é substituído pelo estado fresco do servidor", () => {
    const prev = initCardState(H1, "m-old");
    prev.freeformTitle = "algo que não importa mais";
    const freshH1 = { ...H1, body: ["b1 atualizado pelo pipeline"] };
    const merged = mergeIncomingHighlights([prev], [freshH1], "m-new");
    assert.equal(merged[0].modifiedAt, "m-new");
    assert.deepEqual(merged[0].body, ["b1 atualizado pelo pipeline"]);
    assert.equal(merged[0].freeformTitle, "", "estado fresco não herda o freeformTitle do estado antigo");
  });

  it("card dirty:true é preservado INTOCADO — não perde a edição não-salva do editor", () => {
    const prev = initCardState(H1, "m-old");
    prev.dirty = true;
    prev.freeformTitle = "edição em progresso, ainda não salva";
    prev.body = ["corpo editado pelo editor, não salvo"];
    const freshH1 = { ...H1, body: ["b1 versão do disco, diferente da editada"] };
    const merged = mergeIncomingHighlights([prev], [freshH1], "m-new");
    assert.strictEqual(merged[0], prev, "o mesmo objeto de estado, não uma cópia/reconstrução");
    assert.equal(merged[0].freeformTitle, "edição em progresso, ainda não salva");
    assert.deepEqual(merged[0].body, ["corpo editado pelo editor, não salvo"]);
    assert.equal(merged[0].modifiedAt, "m-old", "modifiedAt do card dirty NÃO é atualizado — próximo save detecta conflito corretamente");
  });

  it("1 card dirty + 1 card não-dirty: só o não-dirty é atualizado", () => {
    const prevH1 = initCardState(H1, "m-old");
    prevH1.dirty = true;
    prevH1.freeformTitle = "não perder isto";
    const prevH2 = initCardState(H2, "m-old");
    const freshH2 = { ...H2, body: ["b2 atualizado"] };

    const merged = mergeIncomingHighlights([prevH1, prevH2], [H1, freshH2], "m-new");
    const mergedH1 = merged.find((s: any) => s.n === 1);
    const mergedH2 = merged.find((s: any) => s.n === 2);
    assert.equal(mergedH1.freeformTitle, "não perder isto");
    assert.deepEqual(mergedH2.body, ["b2 atualizado"]);
  });
});
