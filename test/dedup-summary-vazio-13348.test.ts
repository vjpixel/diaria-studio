/**
 * Regressão #13348: mesma URL vinda do RSS sem summary e do Brave com summary —
 * o dedup mantinha a cópia vazia e verify-summary-integrity abortava depois.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedup } from "../scripts/dedup.ts";

const URL_ = "https://huggingface.co/blog/openrouter";

describe("dedup Pass 2a prefere cópia com summary (#13348)", () => {
  for (const ordem of ["vazio-primeiro", "cheio-primeiro"]) {
    it(`mantém a cópia com summary (${ordem})`, () => {
      const rss = { url: URL_, title: "Hugging Face e OpenRouter: parceria longa e detalhada", summary: "" };
      const brave = { url: URL_, title: "HF OpenRouter", summary: "Resumo real do artigo." };
      const input = ordem === "vazio-primeiro" ? [rss, brave] : [brave, rss];
      const r = dedup(input, new Set(), 0.85);
      assert.equal(r.kept.length, 1);
      assert.equal(r.kept[0].summary, "Resumo real do artigo.");
    });
  }
});
