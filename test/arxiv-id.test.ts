import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseArxivId,
  expandYear,
  arxivIdSentinelDate,
  isClearlyBeforeCutoff,
} from "../scripts/lib/arxiv-id.ts";

describe("parseArxivId (#717 hyp 4)", () => {
  it("parseia URL /abs/ moderna", () => {
    const r = parseArxivId("https://arxiv.org/abs/2603.15988");
    assert.deepEqual(r, {
      year: 26,
      month: 3,
      id: "2603.15988",
      version: null,
    });
  });

  it("parseia /abs/ com versão (vN)", () => {
    const r = parseArxivId("https://arxiv.org/abs/2603.15988v2");
    assert.equal(r?.version, 2);
    assert.equal(r?.id, "2603.15988");
  });

  it("parseia /pdf/ e /html/", () => {
    assert.equal(parseArxivId("https://arxiv.org/pdf/2603.15988")?.id, "2603.15988");
    assert.equal(parseArxivId("https://arxiv.org/html/2603.15988")?.id, "2603.15988");
  });

  it("parseia /pdf/ID.pdf trailing extension", () => {
    const r = parseArxivId("https://arxiv.org/pdf/2603.15988.pdf");
    assert.equal(r?.id, "2603.15988");
  });

  it("parseia 4-dígito e 5-dígito IDs", () => {
    assert.equal(parseArxivId("https://arxiv.org/abs/2603.1598")?.id, "2603.1598");
    assert.equal(parseArxivId("https://arxiv.org/abs/2603.15988")?.id, "2603.15988");
  });

  it("aceita www.arxiv.org", () => {
    const r = parseArxivId("https://www.arxiv.org/abs/2603.15988");
    assert.equal(r?.year, 26);
  });

  it("retorna null pra non-arxiv", () => {
    assert.equal(parseArxivId("https://example.com/abs/2603.15988"), null);
    assert.equal(parseArxivId("https://github.com/foo"), null);
  });

  it("retorna null pra formato antigo (cs/0610068)", () => {
    // Formato pre-2007 não é suportado — pipeline editorial só vê papers recentes.
    assert.equal(parseArxivId("https://arxiv.org/abs/cs/0610068"), null);
  });

  it("retorna null pra mês inválido", () => {
    // 2613 = month 13 → inválido
    assert.equal(parseArxivId("https://arxiv.org/abs/2613.15988"), null);
  });

  it("retorna null pra path errado", () => {
    assert.equal(parseArxivId("https://arxiv.org/find/2603.15988"), null);
    assert.equal(parseArxivId("https://arxiv.org/"), null);
  });

  it("retorna null pra URL inválida", () => {
    assert.equal(parseArxivId(""), null);
    assert.equal(parseArxivId("not a url"), null);
    assert.equal(parseArxivId(null as unknown as string), null);
  });

  it("ignora query string e fragment", () => {
    const r = parseArxivId("https://arxiv.org/abs/2603.15988?utm_source=foo#section");
    assert.equal(r?.id, "2603.15988");
  });
});

describe("expandYear", () => {
  it("YY=26 → 2026", () => assert.equal(expandYear(26), 2026));
  it("YY=07 → 2007", () => assert.equal(expandYear(7), 2007));
  it("YY=99 → 2099", () => assert.equal(expandYear(99), 2099));
});

describe("arxivIdSentinelDate", () => {
  it("retorna YYYY-MM-15", () => {
    const r = arxivIdSentinelDate({ year: 26, month: 3, id: "2603.15988", version: null });
    assert.equal(r, "2026-03-15");
  });

  it("zero-pad de mês", () => {
    const r = arxivIdSentinelDate({ year: 26, month: 5, id: "2605.00001", version: null });
    assert.equal(r, "2026-05-15");
  });
});

describe("isClearlyBeforeCutoff (#717 hyp 4)", () => {
  const arxiv = (year: number, month: number) => ({
    year,
    month,
    id: `${year.toString().padStart(2, "0")}${month.toString().padStart(2, "0")}.00000`,
    version: null,
  });

  it("paper de 2 meses atrás, cutoff hoje, margin=1 → true (clearly old)", () => {
    // arxiv 2603 (Mar 2026), cutoff 2026-05-06 → diff = 2 meses, com margin 1 → diff > 1 → true
    assert.equal(isClearlyBeforeCutoff(arxiv(26, 3), "2026-05-06"), true);
  });

  it("paper de 1 mês atrás, cutoff hoje, margin=1 → false (borderline)", () => {
    // arxiv 2604 (Apr 2026), cutoff 2026-05-06 → diff = 1, NÃO clearly old com margin 1
    assert.equal(isClearlyBeforeCutoff(arxiv(26, 4), "2026-05-06"), false);
  });

  it("paper do mesmo mês do cutoff → false", () => {
    assert.equal(isClearlyBeforeCutoff(arxiv(26, 5), "2026-05-06"), false);
  });

  it("paper do futuro → false", () => {
    assert.equal(isClearlyBeforeCutoff(arxiv(26, 6), "2026-05-06"), false);
  });

  it("respeita margem custom (margin=0 = mais agressivo)", () => {
    // margin=0: paper do mês anterior já vira "clearly before"
    assert.equal(isClearlyBeforeCutoff(arxiv(26, 4), "2026-05-06", 0), true);
  });

  it("lida com virada de ano", () => {
    // Cutoff Jan 2026, paper Nov 2025 (yymm=2511) → 2 meses atrás, clearly old
    assert.equal(isClearlyBeforeCutoff(arxiv(25, 11), "2026-01-15"), true);
    // Paper Dec 2025 (yymm=2512) → 1 mês atrás, borderline
    assert.equal(isClearlyBeforeCutoff(arxiv(25, 12), "2026-01-15"), false);
  });

  it("retorna false pra cutoff inválido (defensive)", () => {
    assert.equal(isClearlyBeforeCutoff(arxiv(26, 3), "not a date"), false);
    assert.equal(isClearlyBeforeCutoff(arxiv(26, 3), ""), false);
  });
});
