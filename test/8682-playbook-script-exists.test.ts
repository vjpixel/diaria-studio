import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// #8682: o pedido da issue é um teste que valide que scripts citados no
// playbook existem. O primeiro rascunho varria TODO o `.claude/agents/*.md`
// e falhou por referências preexistentes não relacionadas (check-repeat-theme.ts,
// archive-inbox.ts) que já estavam quebradas antes de #8682 — o teste acusava
// o refactor em vez de apontar o que #8682 de fato tocou. O escopo aqui é
// restrito à seção alterada por #8682 (§1t/1u/1u-bis/1u-ter), cobrindo
// exatamente as referências efetivamente removidas/substituídas.
const PLAYBOOK = ".claude/agents/orchestrator-stage-1-research.md";
const SECTION_START = "### 1t / 1u / 1u-bis / 1u-ter";

/** Extrai o trecho do playbook coberto por #8682: da seção 1t até o próximo
 * cabeçalho `### ` (1u-quat), que não foi alterado. */
function section8682(): string {
  const t = readFileSync(PLAYBOOK, "utf-8");
  const start = t.indexOf(SECTION_START);
  assert.ok(start >= 0, `seção #8682 não encontrada em ${PLAYBOOK}`);
  const after = t.slice(start + SECTION_START.length);
  const next = after.search(/\n### /);
  return next === -1 ? after : after.slice(0, next);
}

describe("#8682", () => {
  it("scripts mortos não aparecem como comando npx tsx na seção #8682", () => {
    const t = section8682();
    for (const s of ["check-min-sections.ts","strip-verifier.ts","dedupe-intra-edition.ts","filter-evergreen.ts"]) {
      assert.strictEqual(t.indexOf("npx tsx scripts/" + s), -1);
    }
  });
  it("fase post-select-render documentada na seção #8682", () => {
    assert.ok(section8682().indexOf("post-select-render") > -1);
  });
  it("scripts citados na seção #8682 existem diretamente em scripts/", () => {
    const t = section8682();
    const missing: string[] = [];
    let i = t.indexOf("npx tsx scripts/");
    while (i !== -1) {
      const rest = t.slice(i + 13);
      const end = rest.search(/[\s\n`\)]/);
      const f = end === -1 ? rest.trim() : rest.slice(0, end).trim();
      if (!f.includes("/") && f.endsWith(".ts") && !existsSync(join("scripts", f))) missing.push(f);
      i = t.indexOf("npx tsx scripts/", i + 1);
    }
    assert.deepStrictEqual(missing, []);
  });
});
