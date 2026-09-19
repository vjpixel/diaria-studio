/**
 * test/jev-eval-negative-impact.test.ts (#8414 — medição 1 do epic #8412)
 *
 * Cobre `scripts/jev-eval-negative-impact.ts` — a avaliação dedicada pra
 * `noul` (o `jev-eval.ts` genérico só compara `choice`, ver docstring
 * daquele arquivo). Booleanização por limiar, matriz de confusão e McNemar,
 * fim-a-fim contra amostra em disco com `fetchImpl` stubado — nenhum teste
 * chama a rede real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateOnce, renderReport } from "../scripts/jev-eval-negative-impact.ts";
import { generate, record } from "../scripts/lib/blind-label-core.ts";
import { NEGATIVE_IMPACT_8414_FEATURE } from "../scripts/lib/blind-label-features.ts";

describe("jev-eval-negative-impact — evaluateOnce (fetch stubado)", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "jev-eval-negimpact-test-"));
  });
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function fixtureFeature() {
    return {
      ...NEGATIVE_IMPACT_8414_FEATURE,
      collectPool: () => ({
        pool: [
          {
            id: "https://a.com/1",
            display: { url: "https://a.com/1", title: "empresa demite citando IA" },
            jevState: { title: "empresa demite citando IA", url: "https://a.com/1", summary: "s1" },
            stratum: "dano_real",
            hiddenGuess: "dano_real",
          },
          {
            id: "https://a.com/2",
            display: { url: "https://a.com/2", title: "modelo erra benchmark" },
            jevState: { title: "modelo erra benchmark", url: "https://a.com/2", summary: "s2" },
            stratum: "nao_dano",
            hiddenGuess: "nao_dano",
          },
        ],
        skipped: [],
      }),
    };
  }

  it("booleaniza `noul` pelo limiar e compara contra o rótulo", async () => {
    const def = fixtureFeature();
    generate(rootDir, def, 10);
    // item 1: mecanismo diz dano_real, editor concorda.
    record(rootDir, def, "https://a.com/1", "dano_real");
    // item 2: mecanismo diz nao_dano, mas o EDITOR rotula dano_real (mecanismo errado).
    record(rootDir, def, "https://a.com/2", "dano_real");

    const probByUrl: Record<string, number> = {
      "https://a.com/1": 0.9, // Jev concorda com o rótulo
      "https://a.com/2": 0.8, // Jev TAMBÉM acerta onde o mecanismo errou
    };
    let call = 0;
    const fetchImpl = (async (_url: unknown, init: any) => {
      call++;
      const body = JSON.parse(init.body);
      const url = body.state.url as string;
      return new Response(
        JSON.stringify({ answers: { negative_impact: { type: "noul", noul: probByUrl[url] } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    // Substitui o registry temporariamente não é necessário — getFeature/getJevQuestionSpec
    // resolvem pelo id real `negative-impact-8414`, que já está registrado; só o
    // collectPool do fixture precisa ser injetado via rootDir + generate acima
    // (o registry aponta pro FeatureDef real, mas o pool já foi persistido em disco
    // por `generate(rootDir, def, ...)` usando o fixture — evaluateOnce só lê a
    // amostra gravada, nunca re-chama collectPool).
    const { results, errors } = await evaluateOnce({ apiKey: "k", threshold: 0.5, fetchImpl, rootDir });
    assert.equal(errors.size, 0);
    assert.equal(results.length, 2);
    assert.equal(call, 2);

    const r1 = results.find((r) => r.id === "https://a.com/1")!;
    const r2 = results.find((r) => r.id === "https://a.com/2")!;
    assert.equal(r1.mechanismCorrect, true);
    assert.equal(r1.jevGuess, "dano_real");
    assert.equal(r1.jevCorrect, true);
    assert.equal(r2.mechanismCorrect, false); // mecanismo disse nao_dano, editor rotulou dano_real
    assert.equal(r2.jevGuess, "dano_real"); // Jev (p=0.8 >= 0.5) acerta onde o mecanismo errou
    assert.equal(r2.jevCorrect, true);

    const md = renderReport(results, errors.size, 0.5);
    assert.match(md, /scorer-chunk \(atual\) \| 1\/2/);
    assert.match(md, /Jev \(noul ≥ 0\.5\) \| 2\/2/);
    assert.match(md, /McNemar/);
  });

  it("limiar mais alto pode reverter o veredito do Jev pro mesmo item", async () => {
    const def = fixtureFeature();
    generate(rootDir, def, 10);
    record(rootDir, def, "https://a.com/1", "dano_real");
    record(rootDir, def, "https://a.com/2", "nao_dano");

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ answers: { negative_impact: { type: "noul", noul: 0.6 } } }), { status: 200 })) as unknown as typeof fetch;

    const low = await evaluateOnce({ apiKey: "k", threshold: 0.5, fetchImpl, rootDir });
    const high = await evaluateOnce({ apiKey: "k", threshold: 0.9, fetchImpl, rootDir });
    const lowGuess = low.results.find((r) => r.id === "https://a.com/1")!.jevGuess;
    const highGuess = high.results.find((r) => r.id === "https://a.com/1")!.jevGuess;
    assert.equal(lowGuess, "dano_real");
    assert.equal(highGuess, "nao_dano");
  });
});
