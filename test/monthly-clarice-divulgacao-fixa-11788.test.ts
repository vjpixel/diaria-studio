/**
 * test/monthly-clarice-divulgacao-fixa-11788.test.ts (#11788)
 *
 * A seção CLARICE — DIVULGAÇÃO da mensal é idêntica nos ciclos 2607-08 a
 * 2610-11, mas o template e o writer-monthly emitiam placeholder e o gate da
 * Etapa 4 dizia que a Clarice preenchia. Agora é texto FIXO, em DUAS cópias
 * que andam juntas (template + passo 5 do prompt — mesma lição do #9591: trocar
 * só o template não muda o que o writer emite). O CLARICE — TUTORIAL segue
 * placeholder (muda a cada ciclo) apontando para o Doc "Laboratório Clarice", e
 * o gate só avisa sobre ele.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const TEMPLATE = read("context/templates/newsletter-monthly.md");
const PROMPT = read(".claude/agents/writer-monthly.md");
const SKILL = read(".claude/skills/diaria-mensal/SKILL.md");

const LABEL = "**CLARICE — DIVULGAÇÃO**";
const TUTORIAL_LABEL = "**CLARICE — TUTORIAL**";
const DOC_ID = "1KiuwIGyUP3JDhxoCPxV_EgWINWc-osIsSZ_Y1ZCjIIY";

function normalize(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/** Template: do rótulo até o próximo separador `---`. */
function templateBlock(md: string, label: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === label);
  assert.ok(start >= 0, `template sem ${label}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === "---");
  return normalize(lines.slice(start, end < 0 ? undefined : end));
}

/** Prompt: dentro do code fence que abre com o rótulo. */
function promptBlock(md: string, label: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l, i) => l.trim() === label && i > 0 && lines[i - 1].trim() === "```");
  assert.ok(start >= 0, `prompt sem bloco cercado de ${label}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === "```");
  return normalize(lines.slice(start, end < 0 ? undefined : end));
}

describe("#11788 — CLARICE — DIVULGAÇÃO é texto fixo; só o TUTORIAL é placeholder", () => {
  const tpl = templateBlock(TEMPLATE, LABEL);
  const prompt = promptBlock(PROMPT, LABEL);

  it("template e prompt do writer-monthly trazem o MESMO texto fixo", () => {
    assert.equal(prompt, tpl);
  });

  it("o texto fixo é o publicado nos ciclos 2607-08 a 2610-11, sem placeholder", () => {
    assert.ok(!/placeholder/i.test(tpl), "DIVULGAÇÃO não pode voltar a ser placeholder");
    assert.ok(tpl.includes("Escreva melhor em português com a Clarice"));
    assert.ok(tpl.includes("A única IA criada por brasileiros para brasileiros."));
    assert.ok(tpl.includes("acumulando até 63% de desconto."));
    assert.ok(tpl.includes("→ [Acesse e use os cupons NEWS25 ou NEWS50](https://clarice.ai/precos-planos?via=diaria)"));
  });

  it("CLARICE — TUTORIAL segue placeholder nas duas cópias, apontando para o Doc 'Laboratório Clarice'", () => {
    for (const block of [templateBlock(TEMPLATE, TUTORIAL_LABEL), promptBlock(PROMPT, TUTORIAL_LABEL)]) {
      assert.match(block, /\[Placeholder/);
      assert.ok(block.includes(DOC_ID));
    }
  });

  it("gate da Etapa 4 avisa só sobre o TUTORIAL (nunca mais chama a DIVULGAÇÃO de placeholder)", () => {
    assert.ok(!/DIVULGAÇÃO e CLARICE — TUTORIAL são PLACEHOLDERS/.test(SKILL));
    assert.match(SKILL, /CLARICE — TUTORIAL é PLACEHOLDER/);
    assert.ok(!/preenchidas manualmente pela Clarice/.test(SKILL));
  });
});
