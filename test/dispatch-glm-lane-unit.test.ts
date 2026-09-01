/**
 * test/dispatch-glm-lane-unit.test.ts (#6930)
 *
 * Trava as propriedades MECÂNICAS que `docs/lane-glm.md` exige da condição
 * (b) — produtor apenas, imposto por `--tools`, nunca por instrução de
 * prompt (mesma disciplina do #6864/#6849 já aplicada a
 * `continuo-pr-review.sh`) — e (c) — `--model z-ai/glm-5.3-flash` sempre
 * explícito. Lê o SOURCE do script (mesmo padrão de
 * `test/continuo-pr-review-never-merges.test.ts`), não o executa.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = resolve(ROOT, "scripts/dispatch-glm-lane-unit.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

function extractToolsValue(src: string): string {
  const m = src.match(/--tools\s+"([^"]+)"/);
  assert.ok(m, 'não encontrou --tools "..." no script');
  return m![1];
}

const FORBIDDEN_TOOL_SUBSTRINGS = ["gh pr merge", "gh pr review", "gh issue close", "gh issue edit"];

describe("dispatch-glm-lane-unit.sh — condição (b) do docs/lane-glm.md, produtor apenas", () => {
  it("--tools nunca contém gh pr merge/review nem gh issue close/edit", () => {
    const value = extractToolsValue(readScript());
    for (const forbidden of FORBIDDEN_TOOL_SUBSTRINGS) {
      assert.ok(!value.includes(forbidden), `--tools contém '${forbidden}' — condição (b) do lane-glm.md violada`);
    }
  });

  it("--tools não usa 'Bash' genérico/irrestrito (teria que ser Bash(cmd:*) escopado)", () => {
    const value = extractToolsValue(readScript());
    const parts = value.split(",");
    assert.ok(!parts.includes("Bash"), "--tools inclui 'Bash' sem escopo — reabre exatamente o que o #6864 fechou");
  });

  it("--tools inclui gh pr create (o produtor PRECISA poder abrir PR)", () => {
    const value = extractToolsValue(readScript());
    assert.ok(value.includes("gh pr create"), "--tools deveria permitir 'gh pr create' — sem isso o lane não produz nada");
  });
});

describe("dispatch-glm-lane-unit.sh — condição (c), --model sempre explícito", () => {
  it("invocação do claude-openrouter.sh sempre passa --model z-ai/glm-5.3-flash", () => {
    const src = readScript();
    assert.match(src, /--model\s+z-ai\/glm-5\.3-flash/);
  });
});

describe("dispatch-glm-lane-unit.sh — ordem de operações", () => {
  it("o gate de critérios de morte é checado ANTES de claim-issue", () => {
    const src = readScript();
    const gateIdx = src.indexOf("check-glm-lane-gate.ts");
    const claimIdx = src.indexOf("claim-issue");
    assert.ok(gateIdx !== -1, "script deveria chamar check-glm-lane-gate.ts");
    assert.ok(claimIdx !== -1, "script deveria chamar claim-issue");
    assert.ok(gateIdx < claimIdx, "o gate deveria ser checado ANTES do claim-issue");
  });

  it("claim-issue é chamado ANTES de criar o worktree (git worktree add)", () => {
    const src = readScript();
    const claimIdx = src.indexOf("claim-issue");
    const worktreeIdx = src.indexOf("git worktree add");
    assert.ok(worktreeIdx !== -1, "script deveria chamar 'git worktree add'");
    assert.ok(claimIdx < worktreeIdx, "claim-issue deveria vir ANTES de git worktree add");
  });

  it("claim-issue é chamado como comando STANDALONE (nunca encadeado com && antes dele)", () => {
    // #6626/CLAUDE.md: --session-id só é injetado em comando não-composto.
    // Checa que a linha que contém 'claim-issue' não tem '&&' na mesma
    // linha lógica antes da chamada (heurística simples: a linha inteira
    // não deve conter '&&').
    const src = readScript();
    const lines = src.split("\n");
    const claimLine = lines.find((l) => l.includes("claim-issue"));
    assert.ok(claimLine, "não encontrou a linha de claim-issue");
    assert.ok(!claimLine!.includes("&&"), `linha de claim-issue não deveria ser encadeada com &&: ${claimLine}`);
  });

  it("gate recusado (rc != 0) sai o script com erro ANTES de reivindicar/despachar (exit 1 na condicional)", () => {
    const src = readScript();
    const gateIdx = src.indexOf("check-glm-lane-gate.ts");
    const claimIdx = src.indexOf("claim-issue");
    const afterGate = src.slice(gateIdx, claimIdx);
    assert.match(afterGate, /GATE_RC.*-ne 0/);
    assert.match(afterGate, /exit 1/);
  });
});

describe("dispatch-glm-lane-unit.sh — snapshot de custo por unidade (condição (d))", () => {
  it("snapshot de crédito é tirado ANTES e DEPOIS da chamada ao claude-openrouter.sh", () => {
    const src = readScript();
    const beforeIdx = src.indexOf("CREDITS_BEFORE_JSON=");
    // busca a invocação REAL (com aspas do path), não a menção em comentário
    const dispatchIdx = src.indexOf('"$REPO/hermes/scripts/claude-openrouter.sh"');
    const afterIdx = src.indexOf("CREDITS_AFTER_JSON=");
    assert.ok(beforeIdx !== -1 && dispatchIdx !== -1 && afterIdx !== -1, "não encontrou um dos 3 marcadores no script");
    assert.ok(beforeIdx < dispatchIdx, "snapshot 'before' deveria vir antes do dispatch");
    assert.ok(dispatchIdx < afterIdx, "snapshot 'after' deveria vir depois do dispatch");
  });

  it("registra a unidade via record-glm-lane-unit.ts (append-only, nunca sobrescreve)", () => {
    const src = readScript();
    assert.match(src, /record-glm-lane-unit\.ts/);
  });
});
