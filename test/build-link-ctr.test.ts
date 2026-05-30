/**
 * test/build-link-ctr.test.ts (#1567 audit, findings C + G)
 *
 * C — matchClick deve SOMAR cliques de variantes per-subscriber do mesmo link
 *     (baseUrl colapsa a query, Beehiiv emite 1 row por variante; o .find()
 *     antigo só pegava a primeira e subcontava o CTR editorial real).
 * G — isEditorial deve filtrar links de infra própria / utilitários
 *     (poll Workers, Google Meet, Creative Commons) que vazavam como "Outro".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchClick, isEditorial } from "../scripts/build-link-ctr.ts";

describe("matchClick — soma variantes split do mesmo base_url (#1567 finding C)", () => {
  it("soma unique_verified/verified/unique de todas as rows que colapsam pro mesmo base", () => {
    // 3 variantes per-subscriber (query diferente) → baseUrl colapsa todas pra https://x.com/a
    const clicks = [
      { url: "https://x.com/a?bhcl_id=1", email: { verified_clicks: 2, unique_verified_clicks: 1, unique_clicks: 2 } },
      { url: "https://x.com/a?bhcl_id=2", email: { verified_clicks: 0, unique_verified_clicks: 1, unique_clicks: 0 } },
      { url: "https://x.com/a?bhcl_id=3", email: { verified_clicks: 1, unique_verified_clicks: 1, unique_clicks: 1 } },
    ];
    const r = matchClick("https://x.com/a", clicks);
    // antes (.find): pegava só a 1ª → uvc=1. agora soma → uvc=3.
    assert.equal(r.unique_verified_clicks, 3);
    assert.equal(r.verified_clicks, 3);
    assert.equal(r.unique_clicks, 3);
  });

  it("bucket exato tem precedência sobre o fuzzy (não soma os dois)", () => {
    const clicks = [
      { base_url: "https://x.com/a", email: { verified_clicks: 5, unique_verified_clicks: 4, unique_clicks: 5 } },
      // mesma URL normalizada (fuzzy), NÃO deve ser somada quando há match exato
      { url: "HTTP://x.com/a/", email: { verified_clicks: 9, unique_verified_clicks: 9, unique_clicks: 9 } },
    ];
    const r = matchClick("https://x.com/a", clicks);
    assert.equal(r.unique_verified_clicks, 4); // só o bucket exato
  });

  it("sem match → zeros; array vazio → zeros", () => {
    const clicks = [{ url: "https://other.com/z", email: { verified_clicks: 3, unique_verified_clicks: 3, unique_clicks: 3 } }];
    assert.deepEqual(matchClick("https://x.com/a", clicks), {
      verified_clicks: 0, unique_verified_clicks: 0, unique_clicks: 0,
    });
    assert.deepEqual(matchClick("https://x.com/a", []), {
      verified_clicks: 0, unique_verified_clicks: 0, unique_clicks: 0,
    });
  });
});

describe("isEditorial — filtra infra própria / utilitários (#1567 finding G)", () => {
  it("rejeita poll Workers, Google Meet e Creative Commons", () => {
    assert.equal(isEditorial("https://poll.diaria.workers.dev/vote"), false);
    assert.equal(isEditorial("https://diar-ia-poll.diaria.workers.dev/vote"), false);
    assert.equal(isEditorial("http://meet.google.com/afe-tynp-qst"), false);
    assert.equal(isEditorial("https://creativecommons.org/licenses/by-sa/4.0"), false);
  });

  it("mantém links editoriais reais (não over-filtra)", () => {
    assert.equal(
      isEditorial("https://techcrunch.com/2026/05/19/openai-co-founder-joins-anthropic"),
      true,
    );
    assert.equal(
      isEditorial("https://g1.globo.com/tecnologia/noticia/2026/04/25/x.ghtml"),
      true,
    );
    // google.com com path editorial continua válido (só a raiz é filtrada)
    assert.equal(isEditorial("https://blog.google/technology/ai/gemini-update"), true);
  });
});
