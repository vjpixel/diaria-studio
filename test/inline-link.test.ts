import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseInlineLink,
  isInlineLinkLine,
  parseInlineLinkWithTrailing,
} from "../scripts/lib/inline-link.ts";

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

describe("parseInlineLinkWithTrailing (#1581)", () => {
  // Drive round-trip (#1582) reformata `**[Title](url)**  \nsummary` pra
  // `[**Title**](url) summary` (title + summary inline). parseInlineLink
  // rejeita; este helper captura o trailing text.

  it("extrai title + url + trailing summary inline", () => {
    const r = parseInlineLinkWithTrailing(
      "[**NVIDIA Research avança robótica**](https://blogs.nvidia.com/blog/x) Robótica entra em nova fase.",
    );
    assert.deepEqual(r, {
      title: "NVIDIA Research avança robótica",
      url: "https://blogs.nvidia.com/blog/x",
      trailing: "Robótica entra em nova fase.",
    });
  });

  it("strippa **...** balanceado no título (mesma normalização que parseInlineLink)", () => {
    const r = parseInlineLinkWithTrailing(
      "[**Título em bold**](https://example.com) descrição",
    );
    assert.equal(r?.title, "Título em bold");
  });

  it("retorna null quando link consome a linha toda (sem trailing)", () => {
    assert.equal(
      parseInlineLinkWithTrailing("[Título](https://example.com)"),
      null,
    );
  });

  it("retorna null quando linha começa com texto antes do link", () => {
    assert.equal(
      parseInlineLinkWithTrailing("Texto antes [Título](https://example.com) depois"),
      null,
    );
  });

  it("retorna null quando link malformado", () => {
    assert.equal(
      parseInlineLinkWithTrailing("[Título](example.com) trailing"),
      null,
    );
  });

  it("trailing preserva pontuação e caracteres acentuados", () => {
    const r = parseInlineLinkWithTrailing(
      "[**Título**](https://x.com) Frase com vírgulas, pontos, e mais.",
    );
    assert.equal(r?.trailing, "Frase com vírgulas, pontos, e mais.");
  });
});

describe("parseInlineLink — URL com parênteses balanceados (#1662)", () => {
  // Bug: o regex antigo `(https?:\/\/[^\s)]+)` cortava a URL no PRIMEIRO `)`,
  // então URLs com parênteses literais (Wikipedia, PDFs do Drive com `(1)`)
  // caíam no fallback (link morto + markdown cru no email). Mesmo defeito que
  // o #1634 corrigiu em processInlineLinks; este helper (#1581) ficou pra trás.

  it("URL com parênteses literais não é cortada no 1º ')'", () => {
    const r = parseInlineLink("[GPT](https://en.wikipedia.org/wiki/GPT_(modelo))");
    assert.deepEqual(r, {
      title: "GPT",
      url: "https://en.wikipedia.org/wiki/GPT_(modelo)",
    });
  });

  it("URL com (1) literal — caso #1634 (PDF do Drive)", () => {
    const r = parseInlineLink("[**Founders Playbook**](https://x.com/file%20(1).pdf)");
    assert.deepEqual(r, {
      title: "Founders Playbook",
      url: "https://x.com/file%20(1).pdf",
    });
  });

  it("isInlineLinkLine: true mesmo com parênteses na URL", () => {
    assert.equal(
      isInlineLinkLine("[GPT](https://en.wikipedia.org/wiki/GPT_(modelo))"),
      true,
    );
  });

  it("parênteses aninhados (2 níveis) balanceiam corretamente", () => {
    const r = parseInlineLink("[Foo](https://x.com/a_(b_(c)))");
    assert.equal(r?.url, "https://x.com/a_(b_(c))");
  });

  it("parseInlineLinkWithTrailing: URL com parênteses + summary inline (#1582 round-trip)", () => {
    const r = parseInlineLinkWithTrailing(
      "[Doc](https://x.com/file%20(1).pdf) resumo do item aqui",
    );
    assert.deepEqual(r, {
      title: "Doc",
      url: "https://x.com/file%20(1).pdf",
      trailing: "resumo do item aqui",
    });
  });
});

describe("inline-link — contrato preservado vs regex antigo (#1662 review)", () => {
  // A reescrita pro scan balanceado é cirúrgica: SÓ muda o tratamento de
  // parênteses. Estes locks garantem que ela não afrouxou outros gates.

  it("URL com espaço cru → null (gate [^\\s)] do regex antigo preservado)", () => {
    assert.equal(parseInlineLink("[T](https://x.com/a b)"), null);
    assert.equal(parseInlineLinkWithTrailing("[T](https://x.com/a b) x"), null);
  });

  it("trailing colado em pontuação (sem espaço) → null (\\s+ do regex antigo preservado)", () => {
    assert.equal(parseInlineLinkWithTrailing("[T](https://x.com)."), null);
    assert.equal(parseInlineLinkWithTrailing("[T](https://x.com),"), null);
    // separado por espaço continua funcionando
    assert.equal(parseInlineLinkWithTrailing("[T](https://x.com) ok")?.trailing, "ok");
  });

  it("isInlineLinkLine([****](url)) → false (consistente com parseInlineLink; corrige inconsistência antiga)", () => {
    assert.equal(isInlineLinkLine("[****](https://x.com)"), false);
  });
});
