import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNewsletterDiff } from "../scripts/derive-editor-requests.ts";

// Fixtures reduzidas da análise da #10793; data/ não está disponível no CI.
const section = (header: string, names: string[]) =>
  [header, "", ...names.map(name => `**[${name}](https://example.com/${name})**\nDescrição do item.\n`), "---", ""].join("\n");
const use = (names: string[]) => section("**🛠️ USE MELHOR**", names);
const radar = (names: string[]) => section("**📡 RADAR**", names);
const launches = (names: string[]) => section("**🚀 LANÇAMENTOS**", names);
const highlight = (n: number, name: string) => section(`**DESTAQUE ${n} | NOTÍCIAS**`, [name]);

describe("#10793 — mudanças de seleção não são link-swap", () => {
  it("troca de fonte da mesma história continua link-swap", () => {
    const before = highlight(1, "cobertura");
    const after = highlight(1, "fonte-primaria");
    const aliases = new Map([["example.com/fonte-primaria", "example.com/cobertura"]]);
    const out = classifyNewsletterDiff(before, after, aliases);
    assert.deepEqual(out.map(r => r.request_type), ["link-swap"]);
    assert.equal(out[0].context?.change_kind, "fonte-trocada");
  });

  const fixtures = [
    {
      edition: "261014",
      before: use(["copilot-excel"]),
      after: use(["promovido-a", "promovido-b"]),
      expected: [["use-melhor", "pool-cut", 1, 0], ["use-melhor", "pool-add", 0, 2]],
    },
    {
      edition: "261015",
      before: use(["ia-em-casa"]) + radar(["itau"]),
      after: use(["itau", "spec-driven-development"]) + radar([]),
      expected: [["use-melhor", "bucket-move", 0, 0], ["use-melhor", "pool-cut", 1, 0], ["use-melhor", "pool-add", 0, 1]],
    },
    {
      edition: "261022",
      before: launches(["corte-a", "corte-b", "corte-c"]) + radar(["corte-d", "corte-e"]) + highlight(1, "rebaixado-a") + highlight(2, "rebaixado-b"),
      after: launches(["claude-duet"]) + radar(["rebaixado-a", "rebaixado-b", "riemann"]),
      expected: [["lancamentos", "pool-cut", 3, 0], ["lancamentos", "pool-add", 0, 1], ["radar", "pool-cut", 2, 0], ["radar", "pool-add", 0, 1]],
    },
  ];
  for (const fixture of fixtures) {
    it(fixture.edition, () => {
      const out = classifyNewsletterDiff(fixture.before, fixture.after);
      assert.ok(out.every(r => r.request_type !== "link-swap"));
      assert.deepEqual(out.filter(r => !r.target.startsWith("d") && r.request_type !== "destaque-cut").map(r => [
        r.target, r.request_type, r.context?.items_removed ?? 0, r.context?.items_added ?? 0,
      ]), fixture.expected);
    });
  }
});
