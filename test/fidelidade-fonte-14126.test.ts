/**
 * test/fidelidade-fonte-14126.test.ts (#14126)
 *
 * As regras de fidelidade à fonte (#9692 superlativo/atribuição, #13313
 * "mais novo") vivem numa redação só em `context/editorial-rules.md` §11, e
 * cada writer que escreve a partir de uma fonte aponta para lá e traz o resumo
 * das duas regras. Antes da #14126 a #9692 só existia nos sociais e a #13313
 * só nos writers da newsletter, com duas redações diferentes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const WRITERS = [
  "writer",
  "writer-destaque",
  "writer-pool",
  "social-writer",
  "social-curto",
  "weekly-summary-writer",
  "stack-writer",
];

describe("fidelidade à fonte numa seção só (#14126)", () => {
  const rules = read("context/editorial-rules.md");
  const start = rules.indexOf("## 11. Fidelidade à fonte");
  const section = rules.slice(start, rules.indexOf("\n---", start));

  it("editorial-rules.md tem a §11 com as duas regras", () => {
    assert.ok(start >= 0, "seção '## 11. Fidelidade à fonte' ausente");
    assert.match(section, /#9692/);
    assert.match(section, /#13313/);
    assert.match(section, /a empresa que mais fala em segurança/);
    assert.match(section, /Update on September 29, 2026/);
    assert.match(section, /highlight-source-stale-date/);
    for (const agent of WRITERS) assert.ok(section.includes(`\`${agent}\``), `§11 não lista ${agent}`);
  });

  for (const agent of WRITERS) {
    it(`${agent}.md aponta para a §11 e cita as duas regras`, () => {
      const md = read(`.claude/agents/${agent}.md`);
      assert.match(md, /editorial-rules\.md` §11/);
      assert.match(md, /#9692/);
      assert.match(md, /#13313/);
      assert.match(md, /mais novo/i);
      assert.match(md, /um dos mais/);
    });
  }
});
