/**
 * test/skill-dev-agents-fallbacks-9873-9875.test.ts
 *
 * #9873 — os degraus de fallback das rodadas autônomas (retry de CI do
 * overnight, último degrau do review consolidado da Fase 1.5 e do fleet
 * pré-merge do develop) nomeiam agents dedicados (`dev-fixer`,
 * `dev-implementador`, `dev-revisor`, `adhoc-opus-medium`). Um
 * `general-purpose` herda o effort do turno do coordenador, que é a brecha que
 * o #9081/#9530 fechou nos dispatches principais.
 *
 * #9875 — o evento `subagent_metrics` documentado nos 3 SKILL.md carrega o
 * campo `papel`, pra separar o custo do implementador do de fixer e retry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (skill: string) => readFileSync(join(ROOT, ".claude", "skills", skill, "SKILL.md"), "utf8");

const overnight = read("diaria-overnight");
const develop = read("diaria-develop");
const continuo = read("diaria-continuo");

/** Parágrafo (linha) que contém o trecho — os SKILL.md usam 1 parágrafo por linha. */
function lineWith(text: string, needle: string): string {
  const line = text.split("\n").find((l) => l.includes(needle));
  assert.ok(line, `trecho não encontrado: ${needle}`);
  return line;
}

describe("#9873 — fallbacks nomeiam agents dedicados", () => {
  it("overnight: retry de CI com agent novo usa dev-fixer (ou dev-implementador), nunca general-purpose", () => {
    const retry = lineWith(overnight, "até **2 tentativas de fix**");
    assert.match(retry, /subagent_type: "dev-fixer"/);
    assert.match(retry, /subagent_type: "dev-implementador"/);
    assert.match(retry, /fazendo checkout da branch existente/);
    assert.doesNotMatch(retry, /dispatchar um novo \*\*fazendo checkout/, "retry sem agent nomeado voltou");
  });

  for (const [name, text] of [
    ["overnight", overnight],
    ["develop", develop],
  ] as const) {
    it(`${name}: último degrau do review da Fase 1.5 é adhoc-opus-medium, não general-purpose`, () => {
      const fase15 = lineWith(text, "se o `dev-revisor` também não resolver, `adhoc-opus-medium`");
      assert.match(fase15, /`dev-revisor`/);
      assert.match(fase15, /`adhoc-opus-medium`/);
      assert.doesNotMatch(
        fase15,
        /`general-purpose` \+ o mesmo rubrico/,
        "general-purpose voltou como degrau de review (herda o effort do turno)",
      );
    });
  }

  it("develop: fleet pré-merge não cai em general-purpose quando dev-revisor falha", () => {
    const fleet = lineWith(develop, "- **REVIEW DE FLEET PRÉ-MERGE**");
    assert.match(fleet, /`adhoc-opus-medium`/);
    assert.doesNotMatch(fleet, /`general-purpose` só se o próprio `dev-revisor`/);
  });

  it("adhoc-opus-medium existe como agent do repo com model/effort no frontmatter", () => {
    const agent = readFileSync(join(ROOT, ".claude", "agents", "adhoc-opus-medium.md"), "utf8");
    assert.match(agent, /^model: claude-opus-5-5$/m);
    assert.match(agent, /^effort: medium$/m);
  });
});

describe("#9875 — subagent_metrics carrega papel", () => {
  for (const [name, text] of [
    ["overnight", overnight],
    ["develop", develop],
    ["continuo", continuo],
  ] as const) {
    it(`${name}: exemplo de details do subagent_metrics inclui papel`, () => {
      const details = lineWith(text, '"subagent_tokens": N, "tool_uses": N');
      assert.match(details, /"papel": "dev-implementador \| dev-fixer \| ci-retry"/);
    });
  }

  it("overnight e develop explicam 1 evento por invocação de Agent", () => {
    for (const text of [overnight, develop]) {
      assert.match(text, /Campo `papel` obrigatório \(#9875\):\*\* um evento por invocação de `Agent` da unidade/);
    }
  });
});
