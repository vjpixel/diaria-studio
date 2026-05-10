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

describe("parseInlineLink — strip de **...** dentro do título (regression: ** vazando no HTML)", () => {
  // Bug: source `02-reviewed.md` usa formato `[**Título**](url)` (bold dentro
  // dos colchetes do markdown link). parseInlineLink retornava `**Título**`
  // como title, e render-newsletter-html embeddava esse texto literal em
  // <a> tag — assinante via `**asteriscos**` na newsletter.
  // Fix: strip wrapping `**...**` quando balanceados.

  it("strippa **...** no título: [**Título**](URL) → 'Título'", () => {
    const r = parseInlineLink("[**Modelos se replicam sozinhos**](https://example.com)");
    assert.deepEqual(r, { title: "Modelos se replicam sozinhos", url: "https://example.com" });
  });

  it("strippa com whitespace interno preservado", () => {
    const r = parseInlineLink("[**  Modelos se replicam  **](https://example.com)");
    assert.equal(r?.title, "Modelos se replicam");
  });

  it("strippa em combinação com wrap **negrito** externo (#590)", () => {
    const r = parseInlineLink("**[**Título duplo**](https://example.com)**");
    assert.equal(r?.title, "Título duplo");
  });

  it("não toca em ** unbalanced (só na abertura): preserva literal", () => {
    const r = parseInlineLink("[**Título sem fechar](https://example.com)");
    assert.equal(r?.title, "**Título sem fechar");
  });

  it("não toca em ** unbalanced (só no fim): preserva literal", () => {
    const r = parseInlineLink("[Título sem abrir**](https://example.com)");
    assert.equal(r?.title, "Título sem abrir**");
  });

  it("título 'apenas ****': após strip vira string vazia → retorna null", () => {
    assert.equal(parseInlineLink("[****](https://example.com)"), null);
  });

  it("título com ** internos não afetados (só strippa wrap)", () => {
    const r = parseInlineLink("[**Antes **bold** depois**](https://example.com)");
    assert.equal(r?.title, "Antes **bold** depois");
  });

  it("source real da Diar.ia (260508 d1)", () => {
    const r = parseInlineLink(
      "[**Modelos se replicam sozinhos, diz estudo inédito**](https://www.theguardian.com/technology/2026/may/07/no-one-has-done-this-in-the-wild-study-observes-ai-replicate-itself)",
    );
    assert.equal(r?.title, "Modelos se replicam sozinhos, diz estudo inédito");
  });
});
