import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkAprofundeFormat } from "../scripts/lib/lint-checks/aprofunde-format.ts";

const wrap = (destaqueBody: string) =>
  [
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    "**[Título](https://canonico.com/x)**",
    "",
    "Corpo.",
    "",
    "Por que isso importa:",
    "",
    "Impacto.",
    "",
    destaqueBody,
    "",
    "---",
    "DESTAQUE 2 | PESQUISA",
    "Título d2",
    "https://example.com/d2",
    "",
    "Corpo d2.",
    "",
    "Por que isso importa:",
    "Impacto d2.",
  ].join("\n");

describe("checkAprofundeFormat (#3920)", () => {
  it("bloco bem-formado passa", () => {
    const md = wrap(
      [
        "Aprofunde:",
        "",
        "* [Cobertura A](https://a.com/x) - Fonte A",
        "* [Cobertura B](https://b.com/x) - Fonte B",
      ].join("\n"),
    );
    const r = checkAprofundeFormat(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("destaque SEM Aprofunde nunca dispara erro (bloco opcional)", () => {
    const md = wrap("(nada aqui)".replace("(nada aqui)", ""));
    const r = checkAprofundeFormat(md);
    assert.equal(r.ok, true);
  });

  it("item malformado (sem link) → erro", () => {
    const md = wrap(
      ["Aprofunde:", "", "* Só texto sem link nenhum"].join("\n"),
    );
    const r = checkAprofundeFormat(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.type === "malformed_item"));
  });

  it("bloco Aprofunde vazio (header sem itens) → erro", () => {
    const md = wrap(["Aprofunde:", ""].join("\n"));
    const r = checkAprofundeFormat(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.type === "empty_block"));
  });

  it("Aprofunde antes do 'Por que importa' → erro before_why", () => {
    const md = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "**[Título](https://canonico.com/x)**",
      "",
      "Corpo.",
      "",
      "Aprofunde:",
      "",
      "* [A](https://a.com/x) - A",
      "",
      "Por que isso importa:",
      "Impacto.",
    ].join("\n");
    const r = checkAprofundeFormat(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.type === "before_why"));
  });

  it("bullet com traço (-) também é aceito", () => {
    const md = wrap(
      ["Aprofunde:", "", "- [Cobertura A](https://a.com/x) - Fonte A"].join("\n"),
    );
    const r = checkAprofundeFormat(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("#4907: 'Saiba mais:' (link de hub) DEPOIS de Aprofunde bem-formado não gera malformed_item", () => {
    // Regressão: sem o closeBlock() no encontro de HUB_LINK_HEADER_RE, a
    // linha "Saiba mais:" e o link seguinte seriam avaliados (e rejeitados)
    // como itens do Aprofunde ainda aberto.
    const md = wrap(
      [
        "Aprofunde:",
        "",
        "* [Cobertura A](https://a.com/x) - Fonte A",
        "",
        "Saiba mais:",
        "",
        "[Anthropic e Claude](https://arquivo.diar.ia.br/temas/anthropic-claude)",
      ].join("\n"),
    );
    const r = checkAprofundeFormat(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("#4907: 'Saiba mais:' sem Aprofunde nunca dispara erro (nada pra fechar)", () => {
    const md = wrap(
      ["Saiba mais:", "", "[Anthropic e Claude](https://arquivo.diar.ia.br/temas/anthropic-claude)"].join("\n"),
    );
    const r = checkAprofundeFormat(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });
});
