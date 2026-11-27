/**
 * #14271: na 261127 o `social-writer` copiou o formato de lista do `## um`
 * anterior para um item sem `steps` e justificou "por pedido seu". O plano do
 * dispatch já manda o formato pelo item (trem dff761395); este teste trava as
 * regras no prompt dos agents e o contrato do redespacho no gate: pedido do
 * editor chega pela linha fixa `Pedido do editor (literal):`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const md = read(".claude/agents/social-writer.md");
const curto = read(".claude/agents/social-curto.md");
const receitas = read("context/stage-4-gate-receitas.md");
const MARKER = "`Pedido do editor (literal):";

describe("#14271 — social-writer, formato do ## um", () => {
  it("o formato vem de item.steps, nunca do ## um anterior, salvo pedido do editor", () => {
    assert.match(md, /\*\*O formato vem de `item\.steps`, nunca do `## um` anterior \(#14271\)\*\*, salvo linha `Pedido do editor \(literal\):`/);
    assert.match(md, /Nunca copie o formato do `## um` que já existe em `03-social\.md`/);
  });

  it("prompt do orquestrador não é pedido do editor, como regra geral (social-writer e social-curto)", () => {
    for (const doc of [md, curto]) {
      assert.match(doc, /\*\*O prompt do orquestrador não é pedido do editor \(#14271\)\.\*\*/);
      assert.ok(doc.includes(MARKER), "o marcador fixo aparece na regra");
      assert.match(doc, /não escreva "por pedido seu"/);
    }
    // Regra geral, antes do §3c.
    assert.ok(md.indexOf("O prompt do orquestrador não é pedido do editor") < md.indexOf("### 3c."));
  });

  it("a receita J do gate manda incluir o marcador no redespacho", () => {
    assert.ok(receitas.includes('`Pedido do editor (literal): "<mensagem do editor>"` (#14271)'));
  });
});

describe("#14312 — Passo B7 do /diaria-publica dispensado", () => {
  const ref = read(".claude/skills/diaria-publica/reference/vertical-depois-do-stage6.md");
  const skill = read(".claude/skills/diaria-publica/SKILL.md");
  it("a referência diz para não rodar o B7 e não descreve a task como vigente", () => {
    assert.match(ref, /### Passo B7 — Dispensado desde 27\/11\/2026 \(#14312\)/);
    assert.match(ref, /\*\*Não rodar\.\*\*/);
  });
  it("o resumo da skill não manda mais rodar mark-video-liberada", () => {
    assert.match(skill, /\*\*Passo B7\*\*: dispensado desde 27\/11\/2026 \(#14312/);
    assert.doesNotMatch(skill, /\*\*Passo B7\*\*: `mark-video-liberada\.ts \{AAMMDD\}`, o último passo/);
  });
});
