/**
 * test/single-gate-test-email-review-8205.test.ts (#8205, 17/09/2026)
 *
 * A issue #8205 tornou a revisão visual do e-mail de teste pelo editor a
 * ÚNICA parada de `/diaria-5-publicacao` (Etapas 5+6 fundidas, #7983).
 * Antes desta issue, o playbook parava em vários pontos: §6b2 (pedidos
 * editoriais registrados), §6d (guard de slug do bloco WhatsApp — halt
 * banner + "responda 'corrigido'") e o gate do auto-reporter — nenhum
 * deles pedia ao editor que olhasse o e-mail de teste em si.
 *
 * Este arquivo trava, em código, as duas garantias centrais da issue:
 *   1. O playbook do Stage 6 tem exatamente UMA parada aguardando resposta
 *      do editor no caminho default (o gate único de §6c) — sem isso, um
 *      refactor futuro pode reintroduzir uma 2ª parada em prosa sem
 *      nenhum teste acusando.
 *   2. `review-test-email.md` não lista mais nenhuma ferramenta
 *      `mcp__claude-in-chrome__*` — o fallback via Chrome saiu (#8205): a
 *      checagem visual definitiva passou a ser do editor no gate único,
 *      então abrir o Gmail no browser só pra um agente ler duplicava
 *      trabalho.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_6 = resolve(ROOT, ".claude/agents/orchestrator-stage-6.md");
const REVIEW_TEST_EMAIL = resolve(ROOT, ".claude/agents/review-test-email.md");
const AUTO_REPORTER = resolve(ROOT, ".claude/agents/auto-reporter.md");

describe("#8205 — parada única: orchestrator-stage-6.md tem exatamente 1 gate no caminho default", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");

  it("só existe 1 bloco `### 6c.` (o gate único) — não reapareceu como 2 seções distintas", () => {
    const matches = stage6.match(/^### 6c\./gm) ?? [];
    assert.equal(matches.length, 1, `esperava exatamente 1 header "### 6c." (gate único), achei ${matches.length}`);
  });

  it("nenhuma outra seção do arquivo contém a string \"Aguardar resposta do editor\" fora de §6c", () => {
    const sixCIdx = stage6.indexOf("### 6c.");
    const sixDIdx = stage6.indexOf("### 6d.");
    assert.ok(sixCIdx !== -1 && sixDIdx !== -1);
    const before = stage6.slice(0, sixCIdx);
    const after = stage6.slice(sixDIdx);
    assert.ok(!before.includes("Aguardar resposta do editor"), "seção ANTES de §6c não deve esperar resposta do editor");
    assert.ok(!after.includes("Aguardar resposta do editor"), "seção DEPOIS de §6c não deve esperar resposta do editor");
  });

  it("§6b2 (pedidos editoriais) nunca pede confirmação — aceita e loga direto, em qualquer modo", () => {
    const idx = stage6.indexOf("### 6b2.");
    const idxNext = stage6.indexOf("### 6b-slug.");
    assert.ok(idx !== -1 && idxNext !== -1);
    const section = stage6.slice(idx, idxNext);
    assert.ok(!/Se modo interativo/.test(section), "§6b2 não deve mais bifurcar por modo interativo");
    assert.match(section, /sempre, em QUALQUER modo/);
  });

  it("§6b-3 (auto-reporter) não bifurca mais 'gate auto-aprovado' vs 'gate normal' por modo", () => {
    const idx = stage6.indexOf("### 6b-3.");
    const idxNext = stage6.indexOf("### 6b-4.");
    assert.ok(idx !== -1 && idxNext !== -1);
    const section = stage6.slice(idx, idxNext);
    assert.ok(!/gate do auto-reporter e auto-aprovado/i.test(section));
    assert.ok(!/Modo interativo.*gate normal/i.test(section));
  });

  it("o gate único (§6c) menciona explicitamente a revisão do e-mail de teste, não só o Schedule", () => {
    const idx = stage6.indexOf("### 6c.");
    const idxNext = stage6.indexOf("### 6d.");
    const section = stage6.slice(idx, idxNext);
    assert.match(section, /REVISE O E-MAIL DE TESTE|Confira o e-mail de teste/i);
  });
});

describe("#8205 — review-test-email.md não lista mais ferramentas mcp__claude-in-chrome__*", () => {
  const content = readFileSync(REVIEW_TEST_EMAIL, "utf8");
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

  it("frontmatter existe e tem um bloco `tools:`", () => {
    assert.ok(frontmatterMatch, "frontmatter YAML não encontrado");
    assert.match(frontmatterMatch![1], /tools:/);
  });

  it("a linha `tools:` do frontmatter não contém mcp__claude-in-chrome__*", () => {
    const toolsLine = frontmatterMatch![1]
      .split("\n")
      .find((l) => l.trim().startsWith("tools:"));
    assert.ok(toolsLine, "linha tools: não encontrada no frontmatter");
    assert.ok(!/mcp__claude-in-chrome__/.test(toolsLine!), `tools: ainda referencia Chrome: ${toolsLine}`);
  });

  it("nenhuma chamada mcp__claude-in-chrome__* aparece no corpo do arquivo (fallback removido, #8205)", () => {
    const bodyMatches = content.match(/mcp__claude-in-chrome__\w+/g) ?? [];
    assert.equal(bodyMatches.length, 0, `esperava 0 referências a mcp__claude-in-chrome__*, achei: ${JSON.stringify(bodyMatches)}`);
  });

  it("o corpo do arquivo documenta que o Gmail MCP é o único caminho (sem fallback via Chrome)", () => {
    assert.match(content, /sem fallback via Chrome|não há.*fallback via Chrome|não há mais fallback via Chrome/i);
  });
});

describe("#8205 — auto-reporter.md não exige gate humano", () => {
  const content = readFileSync(AUTO_REPORTER, "utf8");

  it("não contém mais a frase 'Gate humano obrigatório'", () => {
    assert.ok(!/Gate humano obrigatório/.test(content));
  });

  it("documenta execução sem gate (#8205)", () => {
    assert.match(content, /#8205/);
    assert.match(content, /[Ss]em gate/);
  });
});
