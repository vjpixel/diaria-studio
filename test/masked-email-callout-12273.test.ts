import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processInlineLinks, renderIntroCallout } from "../scripts/lib/newsletter-render-html.ts";

describe("e-mail mascarado nos callouts (#12273)", () => {
  it("protege ganhadores no título, corpo e lista sem mudar o texto visível", () => {
    for (const input of [
      "🎉 Ganhador: vitor•••@gmail.com",
      "🎉 Ganhadores\n\nParabéns a vitor•••@gmail.com!",
      "🎉 Ganhadores\n\n- vitor•••@gmail.com\n- ana•••@hotmail.com.br",
    ]) {
      const html = renderIntroCallout(input);
      assert.ok(html.includes("vitor•••@gmail\u200B.com"));
      assert.ok(!html.includes("gmail.com"));
      assert.ok(html.replace(/\u200B/g, "").includes("vitor•••@gmail.com"));
      assert.ok(!html.includes("mailto:"));
      if (input.includes("hotmail")) assert.ok(html.includes("hotmail\u200B.com\u200B.br"));
    }
  });

  it("preserva workaround existente, e-mails reais e links explícitos", () => {
    const protectedEmail = "vitor•••@gmail\u200B.com";
    assert.equal(processInlineLinks(protectedEmail), protectedEmail);
    assert.equal(processInlineLinks("vitor@gmail.com"), "vitor@gmail.com");
    const html = processInlineLinks("[vitor•••@gmail.com](https://gmail.com)");
    assert.ok(html.includes('href="https://gmail.com"'));
    assert.ok(html.includes(">vitor•••@gmail.com</a>"));
  });
});
