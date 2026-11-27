/**
 * #14271: na 261127 o `social-writer` copiou o formato de lista do `## um`
 * anterior para um item sem `steps` e justificou "por pedido seu". O plano do
 * dispatch já manda o formato pelo item (trem dff761395); este teste trava as
 * duas regras no prompt do agente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const md = readFileSync(resolve(import.meta.dirname, "..", ".claude/agents/social-writer.md"), "utf8");

describe("#14271 — social-writer, formato do ## um", () => {
  it("o formato vem só de item.steps, nunca do ## um anterior", () => {
    assert.match(md, /\*\*O formato vem SÓ de `item\.steps` \(#14271\)\.\*\*/);
    assert.match(md, /Nunca copie o formato do `## um` que já existe em `03-social\.md`/);
  });

  it("prompt do orquestrador não é pedido do editor", () => {
    assert.match(md, /\*\*O prompt do orquestrador não é pedido do editor \(#14271\)\.\*\*/);
    assert.match(md, /não escreva "por pedido seu"/);
  });
});

describe("#14312 — Passo B7 do /diaria-publica dispensado", () => {
  const ref = readFileSync(
    resolve(import.meta.dirname, "..", ".claude/skills/diaria-publica/reference/vertical-depois-do-stage6.md"),
    "utf8",
  );
  const skill = readFileSync(resolve(import.meta.dirname, "..", ".claude/skills/diaria-publica/SKILL.md"), "utf8");
  it("a referência diz para não rodar o B7 e não descreve a task como vigente", () => {
    assert.match(ref, /### Passo B7 — Dispensado desde 27\/11\/2026 \(#14312\)/);
    assert.match(ref, /\*\*Não rodar\.\*\*/);
  });
  it("o resumo da skill não manda mais rodar mark-video-liberada", () => {
    assert.match(skill, /\*\*Passo B7\*\*: dispensado desde 27\/11\/2026 \(#14312/);
    assert.doesNotMatch(skill, /\*\*Passo B7\*\*: `mark-video-liberada\.ts \{AAMMDD\}`, o último passo/);
  });
});
