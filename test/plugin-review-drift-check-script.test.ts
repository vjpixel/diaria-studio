/**
 * test/plugin-review-drift-check-script.test.ts (#5311)
 *
 * Cobre as partes de I/O de `scripts/plugin-review-drift-check.ts` que não
 * exigem rede/Gmail real:
 *
 *   - `pluginAgentsDir` — resolve o path a partir de um `home` injetado
 *     (nunca hardcoded na função, pra ser testável sem depender do
 *     `$HOME` real da máquina de CI).
 *   - `loadState`/`saveState` — roundtrip de I/O em diretório temporário,
 *     mesmo padrão de `test/worker-drift-check-script.test.ts`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { pluginAgentsDir, loadState, saveState } from "../scripts/plugin-review-drift-check.ts";
import { emptyPluginReviewDriftState, type PluginReviewDriftState } from "../scripts/lib/plugin-review-drift-check.ts";

describe("pluginAgentsDir (#5311)", () => {
  it("monta o path esperado sob ~/.claude/plugins/marketplaces/...", () => {
    const dir = pluginAgentsDir("/home/fulano");
    assert.equal(
      dir,
      "/home/fulano/.claude/plugins/marketplaces/claude-plugins-official/plugins/pr-review-toolkit/agents",
    );
  });
});

describe("loadState / saveState (#5311, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-review-drift-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyPluginReviewDriftState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state: PluginReviewDriftState = {
      agents: { "code-reviewer": { signal: "Only report issues with confidence ≥ 80", capturedAt: "2026-08-15T00:00:00Z" } },
      lastAlarmedFingerprint: "code-reviewer:algo",
    };
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyPluginReviewDriftState());
  });

  it("JSON válido mas sem campo 'agents' -> estado vazio (formato inesperado, fail-soft)", () => {
    const path = resolve(tmpDir, "sem-agents.json");
    writeFileSync(path, JSON.stringify({ foo: "bar" }));
    assert.deepEqual(loadState(path), emptyPluginReviewDriftState());
  });
});
