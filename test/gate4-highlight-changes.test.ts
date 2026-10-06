/**
 * test/gate4-highlight-changes.test.ts (#9693)
 *
 * Medição das mudanças de destaque no gate 4 casando por URL: troca de item ×
 * reordenação × título × categoria, e a reclassificação dos eventos
 * `title-choice` do auto-reporter (que comparam por posição).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPoolSection,
  compareHighlights,
  extractDestaqueCategories,
  findSectionBySlug,
  primaryClass,
  primaryPoolClass,
  reconcileEvent,
  sectionSlug,
} from "../scripts/lib/gate4-highlight-changes.ts";
import { extractDestaques } from "../scripts/lib/manual-edit-diff.ts";
import { collectUrls, measureEdition, readReporterEvents, renderMarkdown } from "../scripts/measure-gate4-highlight-changes.ts";

const A = "https://a.example.com/story-alpha-long";
const B = "https://b.example.com/story-bravo-long";
const C = "https://c.example.com/story-charlie-long";
const D = "https://d.example.com/story-delta-long";
const E = "https://e.example.com/story-echo-long";

function dest(n: number, cat: string, titles: string[], url: string): string {
  return [`**DESTAQUE ${n} | 🔬 ${cat}**`, "", ...titles.flatMap((t) => [`**[${t}](${url})**  `, ""]), `Corpo do destaque ${n}.`, "", "---", ""].join("\n");
}

function edition(destaques: string[], pool: Record<string, Array<[string, string]>> = {}): string {
  const out = [...destaques];
  for (const [section, items] of Object.entries(pool)) {
    out.push(`**📡 ${section}**`, "");
    for (const [t, u] of items) out.push(`**[${t}](${u})**`, "Resumo.", "");
    out.push("---", "");
  }
  return out.join("\n");
}

describe("extractDestaqueCategories", () => {
  it("lê o rótulo sem emoji, por posição", () => {
    const md = edition([dest(1, "PESQUISA", ["T"], A), dest(2, "LANÇAMENTO", ["U"], B)]);
    assert.deepEqual([...extractDestaqueCategories(md)], [[1, "PESQUISA"], [2, "LANÇAMENTO"]]);
  });
});

describe("compareHighlights — casamento por URL, nunca por posição", () => {
  it("reordenação pura (261006): D1→D2, D2→D3 não é troca de título", () => {
    const base = edition([dest(1, "PESQUISA", ["Alfa"], A), dest(2, "SEGURANÇA", ["Bravo"], B), dest(3, "PRODUTO", ["Charlie"], C)]);
    const fin = edition([dest(1, "PRODUTO", ["Charlie"], C), dest(2, "PESQUISA", ["Alfa"], A), dest(3, "SEGURANÇA", ["Bravo"], B)]);
    const cmp = compareHighlights(base, fin);
    // C sobe pra D1 (fora da subsequência crescente), A e B só descem uma casa.
    const byPos = new Map(cmp.highlights.map((h) => [h.position, h]));
    assert.equal(byPos.get(1)!.title_change, null);
    assert.equal(byPos.get(1)!.category_change, null, "categoria acompanha o item, não a posição");
    assert.equal(primaryClass(byPos.get(1)!), "reordenado");
    assert.equal(cmp.highlights.filter((h) => h.item_swapped).length, 0);
    assert.equal(cmp.dropped.length, 0);
  });

  it("item trocado: origem pool, mesma pauta (título idêntico, outra URL) e fora da saída", () => {
    const base = edition(
      [dest(1, "PESQUISA", ["Alfa"], A), dest(2, "SEGURANÇA", ["Bravo"], B), dest(3, "PRODUTO", ["Charlie"], C)],
      { RADAR: [["Delta no radar", D]] },
    );
    const B2 = "https://primary.example.org/bravo-source-original";
    const fin = edition(
      [dest(1, "PESQUISA", ["Delta promovido"], D), dest(2, "SEGURANÇA", ["Bravo"], B2), dest(3, "PRODUTO", ["Eco"], E)],
      { RADAR: [["Alfa rebaixado", A]] },
    );
    const cmp = compareHighlights(base, fin, [], [], [E]);
    const o = cmp.highlights.map((h) => h.origin?.kind);
    assert.deepEqual(o, ["pool", "mesma-pauta", "candidato-pontuado"]);
    assert.ok(cmp.highlights.every((h) => primaryClass(h) === "item-trocado"));
    const fates = Object.fromEntries(cmp.dropped.map((d) => [d.position, d.fate.kind]));
    assert.deepEqual(fates, { 1: "rebaixado", 2: "mesma-pauta", 3: "cortado" });
  });

  it("URL não vista em lugar nenhum → fora-da-saida", () => {
    const cmp = compareHighlights(edition([dest(1, "X", ["Alfa"], A)]), edition([dest(1, "X", ["Eco"], E)]));
    assert.equal(cmp.highlights[0].origin?.kind, "fora-da-saida");
  });

  it("título: outra das 3 opções × reescrito; categoria trocada", () => {
    const base = edition([dest(1, "PESQUISA", ["Alfa um"], A), dest(2, "NOTÍCIAS", ["Bravo um"], B)]);
    const writer = extractDestaques(
      edition([dest(1, "PESQUISA", ["Alfa um", "Alfa dois", "Alfa três"], A), dest(2, "NOTÍCIAS", ["Bravo um", "Bravo dois", "Bravo três"], B)]),
    );
    const fin = edition([dest(1, "PESQUISA", ["Alfa dois"], A), dest(2, "SEGURANÇA", ["Bravo totalmente novo"], B)]);
    const [h1, h2] = compareHighlights(base, fin, writer).highlights;
    assert.equal(h1.title_change, "outra-opcao");
    assert.equal(h1.category_change, null);
    assert.equal(h2.title_change, "reescrito");
    assert.deepEqual(h2.category_change, { from: "NOTÍCIAS", to: "SEGURANÇA" });
    assert.equal(primaryClass(h2), "titulo");
  });

  it("alternativas do title-picker contam como opções", () => {
    const base = edition([dest(1, "X", ["Escolhido"], A)]);
    const fin = edition([dest(1, "X", ["Alternativa B"], A)]);
    const [h] = compareHighlights(base, fin, [], [{ chosen: "Escolhido", alternatives: ["Alternativa A", "Alternativa B"] }]).highlights;
    assert.equal(h.title_change, "outra-opcao");
  });

  it("nada mudou → mantido", () => {
    const md = edition([dest(1, "X", ["Alfa"], A)]);
    assert.equal(primaryClass(compareHighlights(md, md).highlights[0]), "mantido");
  });
});

describe("seções do pool", () => {
  it("slug e singular/plural (261002: LANÇAMENTO × alvo lancamentos)", () => {
    assert.equal(sectionSlug("USE MELHOR"), "use-melhor");
    assert.equal(sectionSlug("LANÇAMENTOS"), "lancamentos");
    const md = edition([], { "LANÇAMENTO": [["Item", A]] });
    assert.equal(findSectionBySlug(md, md, "lancamentos"), "LANÇAMENTO");
  });

  it("classifica entrada/saída de seção, inclusão, título e corte", () => {
    const base = edition([dest(1, "X", ["Alfa"], A)], { RADAR: [["Bravo", B], ["Charlie", C], ["Delta", D]] });
    const fin = edition([dest(1, "X", ["Bravo"], B)], { RADAR: [["Alfa", A], ["Charlie novo título", C], ["Eco", E]] });
    const c = classifyPoolSection(base, fin, "RADAR");
    assert.deepEqual(c.moved_in.map((m) => m.from), ["DESTAQUE 1"]);
    assert.deepEqual(c.moved_out.map((m) => m.to), ["DESTAQUE 1"]);
    assert.deepEqual(c.included.map((m) => m.url), [E]);
    assert.deepEqual(c.retitled.map((m) => m.to), ["Charlie novo título"]);
    assert.deepEqual(c.cut.map((m) => m.url), [D]);
    assert.equal(primaryPoolClass(c), "item-trocado");
  });
});

describe("reconcileEvent — evento title-choice por posição, relido por URL", () => {
  it("d1 de uma reordenação vira reordenado; seção ausente é rotulada", () => {
    const base = edition([dest(1, "X", ["Alfa"], A), dest(2, "X", ["Bravo"], B)]);
    const fin = edition([dest(1, "X", ["Bravo"], B), dest(2, "X", ["Alfa"], A)]);
    const cmp = compareHighlights(base, fin);
    const moved = cmp.highlights.find((h) => h.reordered)!;
    const ev = reconcileEvent({ edition: "999999", target: `d${moved.position}` }, cmp, base, fin);
    assert.equal(ev.class, "reordenado");
    assert.deepEqual(ev.dimensions, ["posicao"]);
    assert.equal(reconcileEvent({ edition: "999999", target: "d3" }, cmp, base, fin).class, "destaque-ausente");
    assert.equal(reconcileEvent({ edition: "999999", target: "radar" }, cmp, base, fin).class, "secao-ausente");
  });
});

describe("measureEdition (fixture em disco)", () => {
  it("lê baseline reconstruído, eventos title-choice do Stage 4 e candidatos", () => {
    const root = mkdtempSync(join(tmpdir(), "gate4-9693-"));
    try {
      const dir = join(root, "2610", "261099");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const base = edition([dest(1, "PESQUISA", ["Alfa"], A), dest(2, "SEGURANÇA", ["Bravo"], B)]);
      const fin = edition([dest(1, "SEGURANÇA", ["Bravo"], B), dest(2, "PRODUTO", ["Eco"], E)]);
      writeFileSync(join(dir, "_internal", "02-humanized.md"), base);
      writeFileSync(join(dir, "02-reviewed.md"), fin);
      writeFileSync(join(dir, "_internal", "01-categorized.json"), JSON.stringify({ radar: [{ url: E, score: 70 }] }));
      writeFileSync(
        join(dir, "_internal", "editor-requests.jsonl"),
        [
          { request_type: "title-choice", target: "d1", stage: 4 },
          { request_type: "title-choice", target: "d1", stage: 4 },
          { request_type: "title-choice", target: "d2", stage: 4 },
          { request_type: "length-cut", target: "radar", stage: 4 },
          { request_type: "title-choice", target: "d2", stage: 6 },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n") + "\n",
      );
      assert.deepEqual(readReporterEvents(dir, "261099").map((e) => e.target), ["d1", "d2"]);
      const m = measureEdition(dir, "261099");
      assert.equal(m.status, "measured");
      assert.equal(m.baseline_source, "reconstructed");
      // #9754: B só subiu de D2 pra D1 porque A saiu — a ordem entre os
      // mantidos é a da pipeline (LIS de `matchDestaquesByUrl`), então não é reordenação.
      assert.deepEqual(m.events.map((e) => e.class), ["mantido", "item-trocado"]);
      assert.equal(m.comparison!.highlights[1].origin?.kind, "candidato-pontuado");
      const md = renderMarkdown([m]);
      assert.match(md, /Reclassificação dos 2 eventos/);
      assert.match(md, /Baseline reconstruído/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem 02-reviewed.md → não medida, com motivo", () => {
    const root = mkdtempSync(join(tmpdir(), "gate4-9693-"));
    try {
      const m = measureEdition(root, "261098");
      assert.equal(m.status, "unmeasured");
      assert.match(m.reason!, /02-reviewed\.md ausente/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collectUrls varre JSON aninhado", () => {
    assert.deepEqual(collectUrls({ a: [{ url: A }, { nested: { url: B } }], url: "não-é-url" }), [A, B]);
  });
});
