/**
 * test/hub-staleness-check-script.test.ts (#5123)
 *
 * Cobre a parte de I/O de `scripts/hub-staleness-check.ts` que não exige
 * `data/beehiiv-cache/` real nem credencial Gmail (guard de #573/CLAUDE.md
 * — sem envio de e-mail real neste worktree): `loadState`/`saveState`
 * (roundtrip de I/O em diretório temporário, mesmo padrão de
 * `test/hub-drift-check-script.test.ts`).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadState, saveState } from "../scripts/hub-staleness-check.ts";
import { emptyStalenessAlarmState, advanceStalenessState } from "../scripts/lib/hub-staleness-check.ts";

describe("loadState / saveState (#5123, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hub-staleness-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), {
      alarm: emptyStalenessAlarmState(),
      firstSeen: {},
    });
  });

  it("roundtrip: save + load preserva alarm + firstSeen", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = {
      alarm: advanceStalenessState("anthropic-claude:edicao-x", new Date("2026-08-10T09:30:00Z")),
      firstSeen: { "anthropic-claude:edicao-x": "2026-08-06" },
    };
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), { alarm: emptyStalenessAlarmState(), firstSeen: {} });
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = { alarm: advanceStalenessState(null, new Date("2026-08-10T09:30:00Z")), firstSeen: {} };
    saveState(state, path);
    assert.equal(loadState(path).alarm.lastAlarmedFingerprint, null);
  });

  it("firstSeen malformado (não-objeto) no JSON cai em {} — nunca propaga tipo inválido", () => {
    const path = resolve(tmpDir, "bad-firstseen.json");
    writeFileSync(path, JSON.stringify({ alarm: emptyStalenessAlarmState(), firstSeen: "não é objeto" }));
    assert.deepEqual(loadState(path).firstSeen, {});
  });
});
