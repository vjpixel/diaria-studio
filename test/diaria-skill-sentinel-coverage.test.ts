/**
 * test/diaria-skill-sentinel-coverage.test.ts (#5793, #5792)
 *
 * Grep tests pra garantir que `.claude/skills/diaria-2-escrita/SKILL.md` e
 * `.claude/skills/diaria-3-imagens/SKILL.md` de fato escrevem o sentinel de
 * conclusão do próprio stage (`pipeline-sentinel.ts write --step N`) em TODO
 * caminho de finalização do playbook — gate humano aprovado E `--no-gate`/
 * `--no-gates`.
 *
 * Achado ao vivo (#5792/#5793): as duas skills completavam o trabalho de
 * verdade mas nunca escreviam `_internal/.step-N-done.json`, então qualquer
 * consumidor que depende do sentinel (run-edition-stages.ts, o runner
 * AGENDADO #5738, resume-aware do /diaria-edicao) tratava um stage COMPLETO
 * como incompleto. Não executa a skill de verdade (isso exigiria uma sessão
 * Claude Code real) — só confirma que o comando está presente no texto do
 * playbook, nos pontos certos, mesmo padrão de
 * `test/orchestrator-stage-6-wiring.test.ts` (#4574).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_2 = resolve(ROOT, ".claude/skills/diaria-2-escrita/SKILL.md");
const SKILL_3 = resolve(ROOT, ".claude/skills/diaria-3-imagens/SKILL.md");

describe("diaria-2-escrita/SKILL.md escreve o sentinel do Stage 2 (#5792)", () => {
  const skill = readFileSync(SKILL_2, "utf8");

  it("referencia pipeline-sentinel.ts write --step 2", () => {
    assert.match(skill, /pipeline-sentinel\.ts write[\s\S]*?--step 2/);
  });

  it("referencia a issue #5792", () => {
    assert.match(skill, /#5792/);
  });

  it("o caminho --no-gate/--no-gates (Passo 6) leva explicitamente ao sentinel (Passo 7c)", () => {
    const marker = skill.indexOf("pular este passo. Ir direto pro Passo 7");
    assert.ok(marker !== -1, "Passo 6 deve descrever o caminho --no-gate/--no-gates");
    const around = skill.slice(marker, marker + 300);
    assert.match(around, /7c/, "Passo 6 deve apontar para o Passo 7c (sentinel) no caminho --no-gate/--no-gates");
  });

  it("o caminho COM gate ('sim' do editor) leva explicitamente ao sentinel (Passo 7c)", () => {
    const marker = skill.indexOf('Aguardar resposta. Se "sim"');
    assert.ok(marker !== -1, "Passo 6 deve descrever a resposta 'sim' do editor");
    const around = skill.slice(marker, marker + 300);
    assert.match(around, /7c/, "resposta 'sim' deve apontar para o Passo 7c (sentinel)");
  });

  it("Passo 7c (sentinel) vem depois do Passo 7 (title-picker) e 7b (título/subtítulo) no arquivo", () => {
    const idx7 = skill.indexOf("## Passo 7 —");
    const idx7b = skill.indexOf("## Passo 7b —");
    const idx7c = skill.indexOf("## Passo 7c —");
    assert.ok(idx7 !== -1 && idx7b !== -1 && idx7c !== -1, "Passos 7, 7b e 7c devem existir");
    assert.ok(idx7 < idx7b && idx7b < idx7c, "ordem correta: 7 < 7b < 7c — sentinel nunca antes do title-picker");
  });

  it("a chamada do sentinel usa os outputs 02-reviewed.md e 03-social.md", () => {
    const idx = skill.indexOf("## Passo 7c —");
    assert.ok(idx !== -1);
    const block = skill.slice(idx, idx + 900);
    assert.match(block, /--outputs\s+"02-reviewed\.md,03-social\.md"/);
  });
});

describe("diaria-3-imagens/SKILL.md escreve o sentinel do Stage 3 (#5793)", () => {
  const skill = readFileSync(SKILL_3, "utf8");

  it("referencia a issue #5793", () => {
    assert.match(skill, /#5793/);
  });

  it("referencia pipeline-sentinel.ts write --step 3 pelo menos 2x (caminho --no-gate e caminho gate/--no-gates)", () => {
    const matches = skill.match(/pipeline-sentinel\.ts write[\s\S]*?--step 3/g) ?? [];
    assert.ok(
      matches.length >= 2,
      `esperado >=2 ocorrências (--no-gate isolado + gate/--no-gates), achou ${matches.length}`,
    );
  });

  it("o caminho `--no-gate` (early skip) escreve o sentinel antes de finalizar", () => {
    const marker = skill.indexOf("**Se `--no-gate`:** pular. Emitir `[AUTO] Etapa 3 auto-aprovada`");
    assert.ok(marker !== -1, "deve haver o branch --no-gate no Passo 2d");
    const around = skill.slice(marker, marker + 400);
    assert.match(around, /pipeline-sentinel\.ts write/);
    assert.match(around, /--step 3/);
  });

  it("o caminho `--no-gates` (dentro do gate apresentado) e o 'sim' orgânico escrevem o sentinel", () => {
    // Há 2 ocorrências de "--no-gates" no arquivo — a do gate do É IA? (Parte 1,
    // não relevante aqui) e a do gate de imagens (Parte 2, "### 2d."). Localizar
    // especificamente a de imagens pelo texto único desse branch.
    const marker = skill.indexOf('assumir "sim", finalizar direto');
    assert.ok(marker !== -1, "deve haver o branch --no-gates do gate de imagens (2d)");
    const around = skill.slice(marker, marker + 700);
    assert.match(around, /pipeline-sentinel\.ts write/);
    assert.match(around, /--step 3/);
  });

  it("a chamada do sentinel usa a lista correta de outputs (conforme seção Outputs do arquivo)", () => {
    const outputsIdx = skill.indexOf("## Outputs");
    assert.ok(outputsIdx !== -1);
    const outputsSection = skill.slice(outputsIdx, outputsIdx + 700);
    // Confere que os arquivos citados na chamada do sentinel batem com o que
    // a seção "## Outputs" realmente lista — nunca copiar cegamente a lista
    // errada do workaround da issue (que citava 04-d2-2x1.jpg/04-d3-2x1.jpg,
    // arquivos que não existem).
    assert.doesNotMatch(skill, /--outputs\s+"[^"]*04-d2-2x1\.jpg/);
    assert.doesNotMatch(skill, /--outputs\s+"[^"]*04-d3-2x1\.jpg/);
    for (const file of [
      "01-eia.md",
      "01-eia-A.jpg",
      "01-eia-B.jpg",
      "04-d1-2x1.jpg",
      "04-d1-1x1.jpg",
      "04-d2-1x1.jpg",
      "04-d3-1x1.jpg",
    ]) {
      assert.match(outputsSection, new RegExp(file.replace(/\./g, "\\.")), `Outputs deve listar ${file}`);
      assert.match(
        skill,
        new RegExp(`--outputs\\s+"[^"]*${file.replace(/\./g, "\\.")}`),
        `chamada do sentinel deve incluir ${file}`,
      );
    }
  });
});
