/**
 * Testes do override `isNonProductOfficialPost` (#5995 item 3 — modo de
 * falha 1: lancamento→radar, 34 casos medidos em 92 edições).
 *
 * Fixtures vêm do CORPUS REAL (títulos/URLs das edições citadas na issue),
 * não inventadas — requisito do item 5 da #5995.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorize, isNonProductOfficialPost, type Article } from "../scripts/lib/launch-heuristics.ts";

/** Amostra real da issue #5995 (modo de falha 1). */
const REAL_FIXTURES: Array<Pick<Article, "url" | "title"> & { edition: string }> = [
  { edition: "260814", url: "https://openai.com/index/expanding-daybreak-as-the-cyber-defense-window-narrows/", title: "Expanding Daybreak as the Cyber Defense Window Narrows" },
  { edition: "260814", url: "https://blogs.nvidia.com/blog/nvidia-ai-factory-compute-investable-asset-class/", title: "NVIDIA AI Factory Compute Is Becoming an Investable Asset Class" },
  { edition: "260817", url: "https://huggingface.co/blog/state-of-open-models/", title: "State of Open Models: Summer 2026 Observations" },
  { edition: "260817", url: "https://blog.google/technology/google-deepmind/omni-experts-share/", title: "Omni experts share what excites them most about the model" },
  { edition: "260820", url: "https://openai.com/index/zero-data-retention/", title: "Offering Zero Data Retention for frontier models" },
  { edition: "260821", url: "https://blog.google/products/gemini/start-the-semester-gemini-on-us/", title: "Start the semester with one year of Gemini, on us" },
  { edition: "260824", url: "https://blog.google/technology/developers/inside-the-gemmaverse-one-billion-downloads/", title: "Inside the Gemmaverse: Celebrating one billion Gemma downloads" },
];

describe("isNonProductOfficialPost (#5995 item 3)", () => {
  it("cada fixture real do corpus bate numa classe e é demovida de lancamento → noticias", () => {
    for (const f of REAL_FIXTURES) {
      assert.equal(isNonProductOfficialPost({ url: f.url, title: f.title } as Article), true, f.title);
      const cat = categorize({ url: f.url, title: f.title } as Article);
      assert.equal(cat, "noticias", `${f.edition} ${f.title} → esperado noticias, veio ${cat}`);
    }
  });

  it("guard anti-falso-positivo: verbo de anúncio explícito no título NUNCA é demovido", () => {
    const keep = [
      "Introducing Gemma 4: celebrating 100 million downloads",
      "Announcing the State of AI Report launch event",
      "Launching Gemini for Education — start the semester right",
      "Now available: Claude for Excel",
      "Unveiling Omni, our most capable model",
    ];
    for (const title of keep) {
      assert.equal(isNonProductOfficialPost({ url: "https://blog.google/x/", title } as Article), false, title);
    }
    // End-to-end: verbo de anúncio + domínio oficial de launch = lancamento
    assert.equal(
      categorize({ url: "https://blog.google/technology/ai/introducing-new-model/", title: "Introducing Gemma 4: celebrating 100 million downloads" } as Article),
      "lancamento",
    );
  });

  it("título vazio → false (nunca demove sem sinal lexical)", () => {
    assert.equal(isNonProductOfficialPost({ url: "https://openai.com/index/x/" } as Article), false);
  });
});
