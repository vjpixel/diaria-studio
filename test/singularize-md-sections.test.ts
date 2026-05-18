import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { singularizeMdSections } from "../scripts/singularize-md-sections.ts";

describe("singularizeMdSections (#1324)", () => {
  it("N=1 lança singulariza header + adiciona emoji", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "**[Genkit Middleware para apps agênticos](https://x.com/a)**",
      "Google lança Genkit Middleware para interceptar agentes.",
      "",
      "---",
      "",
      "**PESQUISAS**",
      "",
      "**[Item 1](https://x.com/b)**",
      "Descrição 1",
      "",
      "**[Item 2](https://x.com/c)**",
      "Descrição 2",
      "",
    ].join("\n");
    const { out, result } = singularizeMdSections(md);
    assert.ok(result.changed);
    assert.ok(out.includes("**🚀 LANÇAMENTO**"));
    // PESQUISAS tem 2 items → plural, ganha emoji
    assert.ok(out.includes("**🔬 PESQUISAS**"));
  });

  it("idempotente — segunda passada não muda nada", () => {
    const md = [
      "**🚀 LANÇAMENTO**",
      "",
      "**[Item](https://x.com)**",
      "Descrição",
      "",
    ].join("\n");
    const { out, result } = singularizeMdSections(md);
    assert.equal(result.changed, false);
    assert.equal(out, md);
  });

  it("plural com emoji existente passa por singularize quando count caiu pra 1", () => {
    const md = [
      "**🚀 LANÇAMENTOS**",
      "",
      "**[Item](https://x.com)**",
      "Descrição",
      "",
    ].join("\n");
    const { out, result } = singularizeMdSections(md);
    assert.ok(result.changed);
    assert.ok(out.includes("**🚀 LANÇAMENTO**"));
  });

  it("seção sem items é ignorada (não muda header)", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "---",
      "",
      "**PESQUISAS**",
      "",
      "**[Item](https://x.com)**",
      "Descrição",
      "",
    ].join("\n");
    const { out, result } = singularizeMdSections(md);
    // LANÇAMENTOS sem items: header inalterado
    assert.ok(out.includes("**LANÇAMENTOS**"));
    assert.ok(!out.includes("**🚀 LANÇAMENTOS**"));
    // PESQUISAS com 1 item: vira PESQUISA com emoji
    assert.ok(out.includes("**🔬 PESQUISA**"));
  });

  it("OUTRAS NOTÍCIAS singulariza pra OUTRA NOTÍCIA", () => {
    const md = [
      "**OUTRAS NOTÍCIAS**",
      "",
      "**[Item](https://x.com)**",
      "Descrição",
      "",
    ].join("\n");
    const { out } = singularizeMdSections(md);
    assert.ok(out.includes("**📰 OUTRA NOTÍCIA**"));
    assert.ok(!out.includes("**OUTRAS NOTÍCIAS**"));
  });

  it("plural com N>1 ganha emoji prefix correto", () => {
    const md = [
      "**OUTRAS NOTÍCIAS**",
      "",
      "**[Item 1](https://x.com/1)**",
      "Descrição 1",
      "",
      "**[Item 2](https://x.com/2)**",
      "Descrição 2",
      "",
      "**[Item 3](https://x.com/3)**",
      "Descrição 3",
      "",
    ].join("\n");
    const { out, result } = singularizeMdSections(md);
    assert.ok(result.changed);
    assert.ok(out.includes("**📰 OUTRAS NOTÍCIAS**"));
  });

  it("para no separator entre seções — não conta items da próxima", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "**[Item L1](https://x.com/l1)**",
      "Descrição L1",
      "",
      "---",
      "",
      "**PESQUISAS**",
      "",
      "**[Item P1](https://x.com/p1)**",
      "Descrição P1",
      "",
      "**[Item P2](https://x.com/p2)**",
      "Descrição P2",
      "",
    ].join("\n");
    const { out } = singularizeMdSections(md);
    // LANÇAMENTOS = 1 → singular
    assert.ok(out.includes("**🚀 LANÇAMENTO**"));
    // PESQUISAS = 2 → plural
    assert.ok(out.includes("**🔬 PESQUISAS**"));
  });

  it("preserva conteúdo dos items intacto", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "**[Genkit Middleware](https://example.com)**",
      "Google lança Genkit Middleware para interceptar.",
      "",
    ].join("\n");
    const { out } = singularizeMdSections(md);
    assert.ok(out.includes("**[Genkit Middleware](https://example.com)**"));
    assert.ok(out.includes("Google lança Genkit Middleware para interceptar."));
  });

  it("retorna sections array com before/after/count", () => {
    const md = [
      "**LANÇAMENTOS**",
      "",
      "**[Item](https://x.com)**",
      "Descrição",
      "",
    ].join("\n");
    const { result } = singularizeMdSections(md);
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0].count, 1);
    assert.equal(result.sections[0].before, "LANÇAMENTOS");
    assert.equal(result.sections[0].after, "🚀 LANÇAMENTO");
  });
});
