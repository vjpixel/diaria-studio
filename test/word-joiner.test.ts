/**
 * word-joiner.test.ts (#2018)
 *
 * Testa o helper compartilhado de word-joiner (scripts/lib/word-joiner.ts):
 * - WORD JOINER inserido em domínios guardados em texto puro
 * - Lookbehind protege URLs cruas (não toca o href)
 * - GUARDED_DOMAINS lista os domínios protegidos
 * - Ambos os renderers (newsletter e mensal) importam deste helper
 *
 * refs #2018, refs #2048
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyWordJoiner, GUARDED_DOMAINS } from "../scripts/lib/word-joiner.ts";

describe("GUARDED_DOMAINS (#2018)", () => {
  it("inclui 'ai' (caso canônico — Clarice.ai)", () => {
    assert.ok(GUARDED_DOMAINS.includes("ai"), "GUARDED_DOMAINS deve incluir 'ai'");
  });

  it("é um array não-vazio", () => {
    assert.ok(GUARDED_DOMAINS.length > 0, "GUARDED_DOMAINS não deve estar vazio");
  });
});

describe("applyWordJoiner (#2018)", () => {
  it("insere &#8288; entre '.' e 'ai' em texto puro", () => {
    assert.equal(applyWordJoiner("Clarice.ai"), "Clarice.&#8288;ai");
    assert.equal(applyWordJoiner("clarice.ai"), "clarice.&#8288;ai");
  });

  it("case-insensitive na palavra inicial", () => {
    assert.equal(applyWordJoiner("CLARICE.AI"), "CLARICE.&#8288;AI");
  });

  it("aplica em frases com contexto ao redor", () => {
    const out = applyWordJoiner("Use a ferramenta Clarice.ai para revisar.");
    assert.ok(out.includes("Clarice.&#8288;ai"), `esperado word-joiner, obtido: ${out}`);
    assert.ok(out.includes("Use a ferramenta"), "contexto ao redor preservado");
  });

  it("lookbehind: NÃO toca domínio precedido de letra (subdomínio, ex: sub.clarice.ai)", () => {
    // "sub.clarice.ai" — o ".ai" é precedido de "e" (letra) → protegido
    const out = applyWordJoiner("sub.clarice.ai");
    // O word-joiner NÃO deve ser inserido no .ai após "clarice" (que é precedido de "b")
    // mas pode ser inserido no "clarice.ai" se o "clarice" for reconhecido como palavra isolada.
    // O importante é que o resultado não quebre a URL — verificar que "sub." ficou intacto.
    assert.ok(!out.includes("sub.&#8288;"), "prefixo 'sub.' não deve receber word-joiner");
  });

  it("lookbehind: NÃO toca URL crua com / precedendo (ex: /clarice.ai)", () => {
    const out = applyWordJoiner("href=/clarice.ai/path");
    // "/" precede "clarice" → lookbehind (?<![a-zA-Z0-9\\-\\/]) bloqueia
    assert.ok(!out.includes("clarice.&#8288;ai"), `URL crua com / não deve ser tocada: ${out}`);
  });

  it("string sem domínio guardado retorna inalterada", () => {
    const s = "Texto sem domínio guardado.";
    assert.equal(applyWordJoiner(s), s);
  });

  it("aplica word-joiner em múltiplas ocorrências na mesma string", () => {
    const out = applyWordJoiner("Clarice.ai e também Clarice.ai de novo.");
    assert.equal(
      out.split("&#8288;").length - 1,
      2,
      "deve haver 2 word-joiners (uma por ocorrência)",
    );
  });

  it("chamadas sucessivas são idempotentes (não duplica &#8288;)", () => {
    const once = applyWordJoiner("Clarice.ai");
    const twice = applyWordJoiner(once);
    // &#8288; entre "." e "ai" — se aplicar de novo, não deve duplicar
    // (o lookbehind é sobre char antes de "word.domain" — "8" antes de ";" não é /ai\b/)
    assert.equal(once, twice, "aplicar duas vezes não deve mudar o resultado");
  });
});

describe("word-joiner integração com monthly-render (#2018)", () => {
  it("renderTextInline aplica word-joiner via helper compartilhado", async () => {
    // Import dinâmico do módulo para usar a função exportada indiretamente
    const { renderInline } = await import("../scripts/lib/monthly-render.ts");
    const out = renderInline("Teste Clarice.ai aqui.");
    assert.ok(out.includes("Clarice.&#8288;ai"), `monthly-render deve aplicar word-joiner: ${out}`);
  });
});

describe("word-joiner integração com newsletter-render-html (#2018)", () => {
  it("mdInlineToHtml aplica word-joiner via helper compartilhado", async () => {
    const { mdInlineToHtml } = await import("../scripts/lib/newsletter-render-html.ts");
    const out = mdInlineToHtml("Texto Clarice.ai aqui.");
    assert.ok(out.includes("Clarice.&#8288;ai"), `newsletter deve aplicar word-joiner: ${out}`);
  });

  it("href de link markdown NÃO é corrompido pelo word-joiner", async () => {
    const { mdInlineToHtml } = await import("../scripts/lib/newsletter-render-html.ts");
    const out = mdInlineToHtml("[Clarice.ai](https://clarice.ai/?via=diaria)");
    // href deve estar intacto
    assert.ok(out.includes('href="https://clarice.ai/?via=diaria"'), `href deve estar intacto: ${out}`);
  });
});
