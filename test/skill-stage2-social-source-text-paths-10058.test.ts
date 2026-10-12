/**
 * #10058 (regressão #633): prompts social-writer/social-curto da skill
 * diaria-2-escrita (bloco paralelo e Fallback) leem 01-approved-capped.json e
 * recebem source_text_paths (paridade com orchestrator-stage-2.md, #9794/#9808).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const md = readFileSync(join(ROOT, ".claude", "skills", "diaria-2-escrita", "SKILL.md"), "utf8");

describe("#10058 — social da skill diaria-2-escrita", () => {
  const prompts = md.split("\n").filter((l) => /prompt: "Gera 1 texto/.test(l));

  it("4 prompts social (2 paralelo + 2 fallback)", () => {
    assert.equal(prompts.length, 4);
  });

  it("cada um lê 01-approved-capped.json e recebe source_text_paths", () => {
    for (const p of prompts) {
      assert.match(p, /01-approved-capped\.json/);
      assert.doesNotMatch(p, /01-approved\.json/);
      assert.match(p, /source_text_paths=/);
    }
  });

  it("cabeçalho do Fallback cobre fora de {2,3}, não !== 3", () => {
    assert.doesNotMatch(md, /highlights\.length !== 3/);
    assert.match(md, /highlights\.length < 2 \|\| highlights\.length > 3` ou falha/);
  });
});
