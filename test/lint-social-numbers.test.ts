import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMagnitude,
  normalizeDigits,
  extractMoneyFigures,
  sourceFigureKeys,
  findUnsourcedFigures,
  approvedSourceText,
} from "../scripts/lint-social-numbers.ts";

describe("normalizeMagnitude (#1711)", () => {
  it("bilhões/billion/bi/bn/B → B", () => {
    for (const u of ["bilhões", "billion", "bi", "bn", "B", "Bilhões"]) {
      assert.equal(normalizeMagnitude(u), "B");
    }
  });
  it("milhões/million/mi/M → M", () => {
    for (const u of ["milhões", "million", "mi", "M"]) {
      assert.equal(normalizeMagnitude(u), "M");
    }
  });
  it("desconhecido → ''", () => {
    assert.equal(normalizeMagnitude("xyz"), "");
  });
});

describe("normalizeDigits (#1711)", () => {
  it("separador de milhar some", () => {
    assert.equal(normalizeDigits("1.000"), "1000");
    assert.equal(normalizeDigits("1,234,567"), "1234567");
  });
  it("decimal de 1-2 dígitos preservado", () => {
    assert.equal(normalizeDigits("2,5"), "2.5");
    assert.equal(normalizeDigits("2.50"), "2.5");
  });
  it("número simples inalterado", () => {
    assert.equal(normalizeDigits("965"), "965");
  });
});

describe("extractMoneyFigures (#1711)", () => {
  it("extrai cifra com magnitude por extenso", () => {
    const f = extractMoneyFigures("levantou US$ 965 bilhões em valuation");
    assert.equal(f.length, 1);
    assert.equal(f[0].key, "965B");
  });
  it("extrai cifra com magnitude abreviada colada", () => {
    const f = extractMoneyFigures("avaliada em $10B após a rodada");
    assert.equal(f[0].key, "10B");
  });
  it("R$ com decimal PT", () => {
    const f = extractMoneyFigures("R$ 2,5 bi em receita");
    assert.equal(f[0].key, "2.5B");
  });
  it("NÃO extrai cifra SEM magnitude (específica demais / comum)", () => {
    assert.deepEqual(extractMoneyFigures("custou US$ 50 por mês"), []);
  });
  it("NÃO extrai porcentagem", () => {
    assert.deepEqual(extractMoneyFigures("cresceu 45% no trimestre"), []);
  });
});

describe("sourceFigureKeys (#1711) — com e sem símbolo de moeda", () => {
  it("captura cifra sem símbolo na fonte ('965 bilhões de dólares')", () => {
    const keys = sourceFigureKeys("avaliada em 965 bilhões de dólares");
    assert.ok(keys.has("965B"));
  });
});

describe("findUnsourcedFigures (#1711) — caso real 260602", () => {
  it("flaga 'US$ 965 bilhões' ausente da fonte (alucinação)", () => {
    const social = "A Anthropic vai abrir capital; a última rodada levantou US$ 965 bilhões em valuation.";
    const source = "Anthropic planeja IPO, diz The Guardian. A empresa busca novos investidores.";
    const unsourced = findUnsourcedFigures(social, source);
    assert.equal(unsourced.length, 1);
    assert.equal(unsourced[0].key, "965B");
  });

  it("NÃO flaga cifra que ESTÁ na fonte (mesmo formato diferente)", () => {
    const social = "A startup foi avaliada em US$ 10B.";
    const source = "A startup atingiu valuation de 10 bilhões de dólares.";
    assert.deepEqual(findUnsourcedFigures(social, source), []);
  });

  it("post sem cifras → nada a flagar", () => {
    assert.deepEqual(findUnsourcedFigures("A OpenAI lançou um novo modelo hoje.", "fonte qualquer"), []);
  });
});

describe("approvedSourceText (#1711)", () => {
  it("concatena títulos + summaries de highlights e buckets", () => {
    const approved = {
      highlights: [{ article: { title: "Anthropic IPO", summary: "Sem cifra aqui." } }],
      radar: [{ title: "Outra", summary: "10 bilhões mencionados." }],
    };
    const text = approvedSourceText(approved);
    assert.match(text, /Anthropic IPO/);
    assert.match(text, /10 bilhões/);
    assert.ok(sourceFigureKeys(text).has("10B"));
  });
});
