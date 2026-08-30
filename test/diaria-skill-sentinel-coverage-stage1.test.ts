/**
 * test/diaria-skill-sentinel-coverage-stage1.test.ts (#6827)
 *
 * Garante que `.claude/skills/diaria-1-pesquisa/SKILL.md` escreve o sentinel de
 * conclusão do Stage 1 (`pipeline-sentinel.ts write --step 1`) em TODO caminho
 * de finalização — gate humano aprovado e `--no-gates`.
 *
 * O mesmo padrão de `test/diaria-skill-sentinel-coverage.test.ts` (#5792/#5793)
 * para os Stages 2 e 3. O Stage 1 ficou de fora desses testes (#5792 cobria
 * só Stage 2, #5793 só Stage 3) e, sem teste, o sentinel write depended de
 * prosa no orchestrator playbook (§1y) que o LLM headless esquecia —
 * resultando em `.step-1-done.json` ausente e edição presa em "pending"
 * (#6827).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_1 = resolve(ROOT, ".claude/skills/diaria-1-pesquisa/SKILL.md");

describe("diaria-1-pesquisa/SKILL.md escreve o sentinel do Stage 1 (#6827)", () => {
  const skill = readFileSync(SKILL_1, "utf8");

  it("referencia pipeline-sentinel.ts write --step 1", () => {
    assert.match(skill, /pipeline-sentinel\.ts write[\s\S]*?--step 1/);
  });

  it("referencia a issue #6827", () => {
    assert.match(skill, /#6827/);
  });

  it("o sentinel write está no Passo 5 (depois do Output, antes do Passo 4)", () => {
    const outputIdx = skill.indexOf("## Output");
    const passo5Idx = skill.indexOf("## Passo 5");
    const passo4Idx = skill.indexOf("## Passo 4");
    assert.ok(outputIdx !== -1, "seção Output deve existir");
    assert.ok(passo5Idx !== -1, "Passo 5 deve existir");
    assert.ok(passo4Idx !== -1, "Passo 4 deve existir");
    assert.ok(
      outputIdx < passo5Idx && passo5Idx < passo4Idx,
      "ordem correta: Output < Passo 5 (sentinel) < Passo 4 (task tracking) — sentinel nunca depois do task tracking",
    );
  });

  it("o caminho --no-gates leva explicitamente ao sentinel (Passo 5)", () => {
    const marker = skill.indexOf("Se `--no-gates` (auto_approve)");
    assert.ok(marker !== -1, "Passo 5 deve descrever o caminho --no-gates");
    // O bloco completo do Passo 5 (código + lista numerada) — o --step 1
    // está no bloco de código no topo, os branches numerados referenciam
    // "pipeline-sentinel.ts write acima". Cobrir os dois.
    const around = skill.slice(marker - 400, marker + 600);
    assert.match(around, /pipeline-sentinel\.ts write/);
    assert.match(around, /--step 1/);
  });

  it("o caminho gate humano aprovado leva explicitamente ao sentinel (Passo 5)", () => {
    const marker = skill.indexOf("Se o editor editou o MD no gate");
    assert.ok(marker !== -1, "Passo 5 deve descrever o caminho com gate humano");
    const around = skill.slice(marker - 400, marker + 600);
    assert.match(around, /pipeline-sentinel\.ts write/);
    assert.match(around, /--step 1/);
  });

  it("a chamada do sentinel usa a lista correta de outputs", () => {
    const passo5Idx = skill.indexOf("## Passo 5");
    assert.ok(passo5Idx !== -1);
    const block = skill.slice(passo5Idx, passo5Idx + 1200);
    for (const file of [
      "01-categorized.md",
      "_internal/01-categorized.json",
      "_internal/01-approved.json",
    ]) {
      assert.match(
        block,
        new RegExp(`--outputs\\s+"[^"]*${file.replace(/\./g, "\\.")}`),
        `chamada do sentinel deve incluir ${file}`,
      );
    }
  });
});