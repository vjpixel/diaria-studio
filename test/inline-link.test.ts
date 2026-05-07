import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInlineLink, isInlineLinkLine } from "../scripts/lib/inline-link.ts";

describe("parseInlineLink (#599)", () => {
  it("extrai título e URL de markdown link bem-formado", () => {
    const r = parseInlineLink("[Título exemplo](https://example.com/x)");
    assert.deepEqual(r, { title: "Título exemplo", url: "https://example.com/x" });
  });

  it("aceita whitespace antes/depois", () => {
    const r = parseInlineLink("  [Título](https://x.com)  ");
    assert.deepEqual(r, { title: "Título", url: "https://x.com" });
  });

  it("aceita URL com query params e path complexo", () => {
    const r = parseInlineLink(
      "[Título](https://exame.com/inteligencia-artificial/x?utm_source=newsletter)",
    );
    assert.equal(r?.url, "https://exame.com/inteligencia-artificial/x?utm_source=newsletter");
  });

  it("retorna null pra URL malformada (sem http)", () => {
    assert.equal(parseInlineLink("[Título](example.com)"), null);
  });

  it("retorna null pra texto antes do link", () => {
    assert.equal(parseInlineLink("Texto [Título](https://x.com)"), null);
  });

  it("retorna null pra texto depois do link", () => {
    assert.equal(parseInlineLink("[Título](https://x.com) texto"), null);
  });

  it("retorna null pra URL solo (sem link)", () => {
    assert.equal(parseInlineLink("https://example.com"), null);
  });

  it("retorna null pra link com texto vazio", () => {
    assert.equal(parseInlineLink("[](https://x.com)"), null);
  });

  it("retorna null pra link com URL vazia", () => {
    assert.equal(parseInlineLink("[Título]()"), null);
  });
});

describe("isInlineLinkLine (#599)", () => {
  it("true pra linha com markdown link válido", () => {
    assert.equal(isInlineLinkLine("[Título](https://x.com)"), true);
  });

  it("false pra texto regular", () => {
    assert.equal(isInlineLinkLine("Apenas texto"), false);
  });

  it("false pra URL solo", () => {
    assert.equal(isInlineLinkLine("https://example.com"), false);
  });
});

describe("parseInlineLink — suporte a **negrito** (#590)", () => {
  it("aceita **[Título](URL)** e extrai title+url corretamente", () => {
    const r = parseInlineLink("**[Título em negrito](https://example.com)**");
    assert.deepEqual(r, { title: "Título em negrito", url: "https://example.com" });
  });

  it("aceita **[Título](URL)** com whitespace ao redor", () => {
    const r = parseInlineLink("  **[Título](https://example.com)**  ");
    assert.deepEqual(r, { title: "Título", url: "https://example.com" });
  });

  it("isInlineLinkLine retorna true pra wrap em **negrito**", () => {
    assert.equal(isInlineLinkLine("**[Título](https://example.com)**"), true);
  });

  it("backwards-compat: linha plain sem negrito continua funcionando", () => {
    const r = parseInlineLink("[Título](https://example.com)");
    assert.deepEqual(r, { title: "Título", url: "https://example.com" });
  });
});
