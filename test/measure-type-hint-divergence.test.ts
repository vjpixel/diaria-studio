/**
 * measure-type-hint-divergence.test.ts (#1718)
 *
 * Instrumentação pura: compara type_hint (source-researcher) vs bucket
 * (categorize) pra a decisão de lançamento, sem mudar nada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { measureDivergence } from "../scripts/measure-type-hint-divergence.ts";

describe("measureDivergence — type_hint vs bucket (#1718)", () => {
  it("type_hint=lancamento E bucket=lancamento → concorda", () => {
    const cat = {
      lancamento: [{ url: "https://openai.com/gpt5", title: "GPT-5", type_hint: "lancamento" }],
    };
    const { records, summary } = measureDivergence(cat, "260604");
    assert.equal(records.length, 1);
    assert.equal(records[0].launch_agree, true);
    assert.equal(summary.launch_disagreements, 0);
  });

  it("type_hint=noticia mas bucket=lancamento → DIVERGE (override do categorize)", () => {
    const cat = {
      lancamento: [{ url: "https://x.com/y", title: "Algo", type_hint: "noticia" }],
    };
    const { records, summary } = measureDivergence(cat, "260604");
    assert.equal(records[0].launch_agree, false);
    assert.equal(records[0].type_hint_launch, false);
    assert.equal(records[0].bucket_launch, true);
    assert.equal(summary.launch_disagreements, 1);
    assert.equal(summary.disagreements[0].type_hint, "noticia");
    assert.equal(summary.disagreements[0].bucket, "lancamento");
  });

  it("type_hint=lancamento mas bucket=radar → DIVERGE (categorize rebaixou)", () => {
    const cat = {
      radar: [{ url: "https://x.com/z", type_hint: "lancamento" }],
    };
    const { summary } = measureDivergence(cat, "260604");
    assert.equal(summary.launch_disagreements, 1);
  });

  it("artigos sem type_hint são contados mas não geram record", () => {
    const cat = {
      lancamento: [{ url: "https://a.com", type_hint: "lancamento" }],
      radar: [{ url: "https://b.com" }, { url: "https://c.com", type_hint: "" }],
    };
    const { records, summary } = measureDivergence(cat, "260604");
    assert.equal(summary.total_articles, 3);
    assert.equal(summary.with_type_hint, 1);
    assert.equal(records.length, 1);
  });

  it("case-insensitive no type_hint", () => {
    const cat = { lancamento: [{ url: "https://a.com", type_hint: "Lancamento" }] };
    const { records } = measureDivergence(cat, "260604");
    assert.equal(records[0].launch_agree, true);
  });

  it("edição vazia → summary zerado, sem records", () => {
    const { records, summary } = measureDivergence({}, "260604");
    assert.equal(records.length, 0);
    assert.equal(summary.total_articles, 0);
    assert.equal(summary.with_type_hint, 0);
  });
});
