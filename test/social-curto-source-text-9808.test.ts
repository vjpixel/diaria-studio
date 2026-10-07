/**
 * Guard de prompt (#9808, #9810): o `social-curto` (X/Threads) recebe o texto
 * BRUTO da fonte (`source_text_paths`) com a regra "texto da fonte vence o
 * summary" — a mesma do `social-writer` desde #9794 — e escreve a lista do
 * `## um` no formato `1)`, igual ao `social-writer`.
 *
 * Sem isso, o `# Curto` escrevia do `summary` (meta-description do site, edição
 * 261007, D2 Mistral) e contradizia o `# Social` do mesmo destaque.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("#9808 — social-curto recebe source_text_paths", () => {
  it("social-curto.md declara o input e a regra de precedência da fonte", () => {
    const md = read(".claude/agents/social-curto.md");
    assert.match(md, /`source_text_paths` \(opcional, #9808\)/);
    assert.match(md, /vale o texto da fonte/);
  });

  it("orchestrator-stage-2.md passa source_text_paths ao social-curto (passo 3)", () => {
    const md = read(".claude/agents/orchestrator-stage-2.md");
    const passo3 = md.split("\n").find((l) => l.startsWith("3. `Agent` → `social-curto` (#3992, mesmo input que social-writer"));
    assert.ok(passo3, "passo 3 do dispatch paralelo não encontrado");
    assert.match(passo3!, /source_text_paths/);
  });

  it("orchestrator-stage-4.md §e espelha source_text_paths no re-dispatch do curto", () => {
    const md = read(".claude/agents/orchestrator-stage-4.md");
    const e = md.split("\n").find((l) => l.startsWith("**e. Dispatchar `social-writer`"));
    assert.ok(e, "§e não encontrado");
    assert.match(e!, /social-curto[^\n]*source_text_paths/);
  });
});

describe("#9810 — lista do USE MELHOR no formato `1)` nos dois social agents", () => {
  for (const agent of ["social-curto", "social-writer"]) {
    it(`${agent}.md usa \`1)\` e não manda \`1.\``, () => {
      const md = read(`.claude/agents/${agent}.md`);
      assert.match(md, /`1\) \.\.\.`/);
      assert.doesNotMatch(md, /`1\. [A-ZÀ-Ú]/);
    });
  }
});
