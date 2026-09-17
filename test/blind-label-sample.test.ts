/**
 * test/blind-label-sample.test.ts (#5995)
 *
 * Guard das partes PURAS de `scripts/blind-label-sample.ts` — a ferramenta de
 * rotulagem às cegas que produz gabarito limpo para medir o categorizador.
 *
 * Só as funções sem I/O são testadas: o corpus (`data/editions/`) é uma
 * junction local do OneDrive, ausente em clone fresco e no CI (CLAUDE.md §2b),
 * então qualquer teste que dependesse dele passaria vazio e não guardaria nada.
 *
 * A propriedade que estes testes existem para proteger é UMA, e é cara:
 * **nenhum item JÁ ROTULADO sai da amostra numa re-geração**. O rótulo do
 * editor custa tempo humano e não é reproduzível; se uma re-geração puder
 * derrubar um item rotulado, esse trabalho se perde em silêncio.
 *
 * O que deliberadamente NÃO é prometido: estabilidade da amostra NÃO rotulada.
 * Com alvo de tamanho fixo e pool crescente, o corte aperta e item sem rótulo
 * pode entrar ou sair entre rodadas — não custou trabalho humano, então o
 * desenho aceita isso em troca de manter o tamanho da amostra sob controle.
 *
 * A primeira versão desta PR falhava exatamente aí e o teste NÃO pegava: a
 * seleção era top-K com quota proporcional ao pool INTEIRO, então o
 * crescimento de outro bucket encolhia a quota deste e cortava a cauda do
 * conjunto anterior — rótulos incluídos. O teste da época só verificava que
 * `stableRank` era determinístico para uma lista fixa ordenada duas vezes no
 * mesmo processo, uma propriedade muito mais fraca que passava com o bug de pé
 * (#8206 review, findings 1 e 2). Os testes abaixo exercitam a seleção sob
 * crescimento real, que é o cenário que o docstring promete.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stableRank,
  bucketQuota,
  selectByThreshold,
  MIN_PER_BUCKET,
  type Sampled,
} from "../scripts/blind-label-sample.ts";

function item(url: string): Sampled {
  return {
    url,
    title: "t " + url,
    source: "s",
    summary: "",
    edition: "260101",
    hidden_guess: "radar",
    hidden_rule: "noticias-default",
    hidden_shipped: "radar",
  };
}

const corpus = (n: number, prefix = "https://example.com/a/") =>
  Array.from({ length: n }, (_, i) => item(prefix + i));

describe("stableRank", () => {
  it("é determinístico para o mesmo URL", () => {
    const u = "https://blog.google/products/ads-commerce/ads-decoded-finale/";
    assert.equal(stableRank(u), stableRank(u));
  });

  it("separa URLs diferentes", () => {
    assert.notEqual(stableRank("https://example.com/a"), stableRank("https://example.com/b"));
  });
});

describe("bucketQuota", () => {
  it("é proporcional quando o bucket é grande", () => {
    assert.equal(bucketQuota(3000, 4000, 60), 45);
  });

  it("aplica o piso quando a proporção daria menos", () => {
    assert.equal(bucketQuota(100, 4000, 60), MIN_PER_BUCKET);
  });

  it("nunca pede mais itens do que o bucket tem, mesmo abaixo do piso", () => {
    assert.equal(bucketQuota(3, 4000, 60), 3);
  });

  it("devolve 0 para entradas degeneradas em vez de NaN/Infinity", () => {
    assert.equal(bucketQuota(0, 4000, 60), 0);
    assert.equal(bucketQuota(10, 0, 60), 0);
    assert.equal(bucketQuota(10, 4000, NaN), 0);
  });
});

describe("selectByThreshold — amostra aditiva", () => {
  it("devolve aproximadamente a quota pedida", () => {
    const picked = selectByThreshold(corpus(400), 40, new Set());
    assert.ok(picked.length >= 20 && picked.length <= 60, `esperava ~40, veio ${picked.length}`);
  });

  // LIMITE CONHECIDO, e é o ponto do desenho: com alvo de tamanho FIXO e pool
  // crescente, a pertinência de um item NÃO rotulado pode mudar entre rodadas —
  // o corte aperta para continuar rendendo ~`quota`. Isso é aceito de propósito:
  // item sem rótulo não custou trabalho humano, e `--next` simplesmente mostra
  // outro. O invariante caro é o do teste seguinte (rótulo nunca sai), e é ele
  // que o guard de `generate` reforça com abort.
  it("mantém o tamanho da amostra sob crescimento do corpus", () => {
    const antes = selectByThreshold(corpus(200), 40, new Set()).length;
    const depois = selectByThreshold(corpus(800), 40, new Set()).length;
    assert.ok(Math.abs(antes - depois) <= 20, `amostra instável: ${antes} -> ${depois}`);
  });

  it("todo item rotulado sobrevive ao crescimento do corpus", () => {
    const small = corpus(200);
    const rotulados = new Set(selectByThreshold(small, 40, new Set()).map((p) => p.url));
    const grown = corpus(800);
    const depois = selectByThreshold(grown, 40, rotulados).map((p) => p.url);
    for (const u of rotulados) {
      assert.ok(depois.includes(u), `rótulo perdido após crescimento do corpus: ${u}`);
    }
  });

  it("NUNCA descarta item já rotulado, mesmo fora do corte", () => {
    const pool = corpus(500);
    // pega um URL que o corte estreito deixaria de fora
    const narrow = new Set(selectByThreshold(pool, 10, new Set()).map((p) => p.url));
    const outside = pool.find((p) => !narrow.has(p.url));
    assert.ok(outside, "fixture precisa de um item fora do corte");
    const picked = selectByThreshold(pool, 10, new Set([outside.url]));
    assert.ok(picked.some((p) => p.url === outside.url), "item rotulado foi descartado");
  });

  it("regressão #8206: bucket estável não perde itens quando OUTRO bucket cresce", () => {
    // O bug: quota = (bucketSize / poolSize) * target. Com poolSize crescendo
    // por causa de outro bucket, a quota deste encolhia e a cauda do top-K caía.
    const stable = corpus(20, "https://example.com/lanc/");
    const quotaAntes = bucketQuota(stable.length, 100, 60);
    const quotaDepois = bucketQuota(stable.length, 400, 60);
    assert.ok(quotaDepois <= quotaAntes, "fixture: a quota precisa mesmo encolher");

    const antes = selectByThreshold(stable, quotaAntes, new Set()).map((p) => p.url);
    const rotulados = new Set(antes);
    const depois = selectByThreshold(stable, quotaDepois, rotulados).map((p) => p.url);
    for (const u of antes) {
      assert.ok(depois.includes(u), `rótulo perdido por encolhimento de quota: ${u}`);
    }
  });

  it("devolve vazio para lista vazia", () => {
    assert.deepEqual(selectByThreshold([], 10, new Set()), []);
  });
});
