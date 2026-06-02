import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeCategorizedBuckets } from "../scripts/lib/categorized-buckets.ts";

const A = (url: string) => ({ url });

describe("normalizeCategorizedBuckets (#1670/#1671)", () => {
  it("shape novo (#1629) passa direto", () => {
    const out = normalizeCategorizedBuckets({
      lancamento: [A("l1")],
      radar: [A("r1")],
      use_melhor: [A("u1")],
      video: [A("v1")],
    });
    assert.deepEqual(out.lancamento.map((a: any) => a.url), ["l1"]);
    assert.deepEqual(out.radar.map((a: any) => a.url), ["r1"]);
    assert.deepEqual(out.use_melhor.map((a: any) => a.url), ["u1"]);
    assert.deepEqual(out.video.map((a: any) => a.url), ["v1"]);
  });

  it("#1671: shape legacy SEM os buckets novos → não crasha, tudo []", () => {
    // Pré-#1629: {lancamento, pesquisa, noticias, tutorial} — sem radar/use_melhor/video.
    const out = normalizeCategorizedBuckets({ lancamento: [A("l1")] });
    assert.deepEqual(out.radar, []);
    assert.deepEqual(out.use_melhor, []);
    assert.deepEqual(out.video, []);
  });

  it("#1670: legacy pesquisa + noticias → radar (não somem)", () => {
    const out = normalizeCategorizedBuckets({
      pesquisa: [A("p1")],
      noticias: [A("n1"), A("n2")],
    });
    assert.deepEqual(out.radar.map((a: any) => a.url), ["p1", "n1", "n2"]);
  });

  it("#1670: legacy tutorial → use_melhor", () => {
    const out = normalizeCategorizedBuckets({ tutorial: [A("t1")] });
    assert.deepEqual(out.use_melhor.map((a: any) => a.url), ["t1"]);
  });

  it("mixed novo+legacy: radar = radar ∪ pesquisa ∪ noticias", () => {
    const out = normalizeCategorizedBuckets({
      radar: [A("r1")],
      pesquisa: [A("p1")],
      noticias: [A("n1")],
    });
    assert.deepEqual(out.radar.map((a: any) => a.url), ["r1", "p1", "n1"]);
  });

  it("null/undefined/sem-buckets → 4 arrays vazios (sem crash)", () => {
    for (const input of [null, undefined, {}, { foo: "bar" }]) {
      const out = normalizeCategorizedBuckets(input as any);
      assert.deepEqual(out, { lancamento: [], radar: [], use_melhor: [], video: [] });
    }
  });

  it("valor não-array num bucket → [] (defensivo)", () => {
    const out = normalizeCategorizedBuckets({ radar: "oops" as any, lancamento: null as any });
    assert.deepEqual(out.radar, []);
    assert.deepEqual(out.lancamento, []);
  });
});
