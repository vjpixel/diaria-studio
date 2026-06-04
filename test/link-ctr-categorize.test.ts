/**
 * test/link-ctr-categorize.test.ts (#1844)
 *
 * Characterization tests do classificador `categorize` — extraído de
 * build-link-ctr.ts pra scripts/lib/link-ctr-categorize.ts e ANTES sem teste
 * direto (era função não-exportada). Trava o comportamento atual (golden) pra
 * que a extração seja segura e futuras mudanças sejam intencionais.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorize } from "../scripts/lib/link-ctr-categorize.ts";

describe("categorize (#1844 — golden / characterization)", () => {
  const cases: Array<{ url: string; anchor?: string; section?: string; expected: string }> = [
    { url: "https://openai.com/index/gpt-5", anchor: "GPT-5", section: "LANÇAMENTOS", expected: "Lançamento" },
    { url: "https://arxiv.org/abs/2506.001", anchor: "novo paper", expected: "Pesquisa" },
    { url: "https://github.com/foo/bar", anchor: "repo", expected: "Ferramenta" },
    { url: "https://www.youtube.com/watch?v=abc", anchor: "vídeo", section: "VÍDEOS", expected: "Curiosidade" },
    { url: "https://techcrunch.com/2026/06/01/startup-raises", anchor: "startup levanta", expected: "Mercado" },
    { url: "https://example.com/random", expected: "Outro" },
  ];

  for (const c of cases) {
    it(`${c.url} → ${c.expected}`, () => {
      assert.equal(
        categorize(c.url, c.anchor ?? "", c.section ?? "", "", ""),
        c.expected,
      );
    });
  }

  it("retorna sempre uma string não-vazia (nunca undefined)", () => {
    assert.equal(typeof categorize("https://a.com/x"), "string");
    assert.ok(categorize("https://a.com/x").length > 0);
  });
});
