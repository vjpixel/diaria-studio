/**
 * test/jev-eval-gray-zone-8417.test.ts (#8417 — medição 4 do epic #8412)
 *
 * Cobre `scripts/jev-eval-gray-zone-8417.ts` — mesma razão de existir de
 * `test/jev-eval-negative-impact.test.ts` (#8414): avaliação dedicada pra
 * `noul` sobre PAR (`state = {a, b}`), booleanização por limiar,
 * `fetchImpl` stubado — nenhum teste chama a rede real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateOnce, renderReport } from "../scripts/jev-eval-gray-zone-8417.ts";
import { generate, record } from "../scripts/lib/blind-label-core.ts";
import { DEDUP_GRAYZONE_8417_FEATURE, HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE } from "../scripts/lib/blind-label-features.ts";

let rootDir: string;
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "jev-eval-grayzone-test-"));
});
afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function pairFixture(feature: typeof DEDUP_GRAYZONE_8417_FEATURE, id: string, hiddenGuess: string, stratum: string) {
  return {
    ...feature,
    collectPool: (_rootDir: string) => ({
      pool: [
        {
          id,
          display: { titleA: "A", titleB: "B" },
          jevState: { a: { title: "A", summary: "sa", source: "fa" }, b: { title: "B", summary: "sb", source: "fb" } },
          stratum,
          hiddenGuess,
        },
      ],
      skipped: [],
    }),
  };
}

describe("jev-eval-gray-zone-8417 — dedup-grayzone-8417", () => {
  it("booleaniza noul pelo limiar e compara contra o rótulo do par", async () => {
    const def = pairFixture(DEDUP_GRAYZONE_8417_FEATURE, "https://a.com/1|||https://a.com/2", "historias_distintas", "dedup");
    generate(rootDir, def, 10);
    // mecanismo errou (disse historias_distintas, editor rotula mesma_historia)
    record(rootDir, def, def.collectPool(rootDir).pool[0].id, "mesma_historia");

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ answers: { same_story: { type: "noul", noul: 0.9 } } }), { status: 200 })) as unknown as typeof fetch;

    const { results, errors } = await evaluateOnce({ feature: "dedup-grayzone-8417", apiKey: "k", threshold: 0.5, fetchImpl, rootDir });
    assert.equal(errors.size, 0);
    assert.equal(results.length, 1);
    assert.equal(results[0].mechanismCorrect, false);
    assert.equal(results[0].jevGuess, "mesma_historia");
    assert.equal(results[0].jevCorrect, true);

    const md = renderReport("dedup-grayzone-8417", results, errors.size, 0.5);
    assert.match(md, /Jaccard\/thresholdForPair \(atual\) \| 0\/1/);
    assert.match(md, /Jev \(noul ≥ 0\.5\) \| 1\/1/);
  });
});

describe("jev-eval-gray-zone-8417 — highlight-themes-grayzone-8417", () => {
  it("resolve o vocabulário mesmo_tema/temas_distintos (rótulo diferente do dedup)", async () => {
    const def = pairFixture(HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE, "https://a.com/3|||https://a.com/4", "temas_distintos", "highlight_themes");
    generate(rootDir, def, 10);
    record(rootDir, def, def.collectPool(rootDir).pool[0].id, "temas_distintos");

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ answers: { same_theme: { type: "noul", noul: 0.2 } } }), { status: 200 })) as unknown as typeof fetch;

    const { results } = await evaluateOnce({ feature: "highlight-themes-grayzone-8417", apiKey: "k", threshold: 0.5, fetchImpl, rootDir });
    assert.equal(results[0].jevGuess, "temas_distintos");
    assert.equal(results[0].jevCorrect, true);
    assert.equal(results[0].mechanismCorrect, true);
  });
});
