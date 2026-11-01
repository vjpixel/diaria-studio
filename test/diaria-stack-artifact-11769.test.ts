import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(".claude/skills/diaria-stack/SKILL.md", "utf8");
const passo5 = skill.slice(skill.indexOf("## Passo 5"), skill.indexOf("## Passo 6"));

describe("diaria-stack: prévia final em Artifact (#11769)", () => {
  it("Passo 5 publica a prévia via Artifact com caminho fixo por ciclo", () => {
    assert.match(passo5, /`Artifact`/);
    assert.match(passo5, /stack-\{cycle\}/);
    assert.match(passo5, /payload\.titulo/);
  });
  it("Passo 6 pede confirmação com o artefato já publicado", () => {
    const passo6 = skill.slice(skill.indexOf("## Passo 6"));
    assert.match(passo6, /artefato do Passo 5/);
  });
});
