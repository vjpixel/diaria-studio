/**
 * test/gtm-drift-check-script.test.ts (#8585, achado #2 do review da PR #8613)
 *
 * Cobre as partes de I/O do script fino `scripts/gtm-drift-check.ts` que
 * não exigem rede real: `loadState`/`saveState` (roundtrip em diretório
 * temporário) e `toAlarmFinding` — mesmo padrão de
 * `test/subscribe-redirect-drift-check-script.test.ts`/
 * `test/home-meta-check-script.test.ts`. `fetchGtmJs` já é coberto em
 * `test/gtm-drift-check.test.ts`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadState, saveState, toAlarmFinding } from "../scripts/gtm-drift-check.ts";
import { emptyGtmDriftAlarmState, advanceGtmDriftAlarmState, type GtmCheckResult } from "../scripts/lib/gtm-drift-check.ts";

describe("loadState / saveState (#8585, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gtm-drift-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyGtmDriftAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceGtmDriftAlarmState("currency:currency no gtm.js é \"USD\", esperado \"BRL\"", new Date("2026-09-21T12:00:00Z"));
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyGtmDriftAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (drift limpo/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceGtmDriftAlarmState(null, new Date("2026-09-21T12:00:00Z"));
    saveState(state, path);
    assert.equal(loadState(path).lastAlarmedFingerprint, null);
  });
});

describe("toAlarmFinding (#8585)", () => {
  const MISMATCH: GtmCheckResult = {
    check: "currency",
    status: "mismatch",
    message: 'currency no gtm.js é "USD", esperado "BRL" — divergência real entre o container publicado e o que este repo espera',
  };

  it("family é 'estado' — condição re-checável, resolve sozinha quando o container voltar a bater", () => {
    assert.equal(toAlarmFinding(MISMATCH).family, "estado");
  });

  it("priority é P2 — não é fire, mas tem histórico de custar tempo de diagnóstico (#8572)", () => {
    assert.equal(toAlarmFinding(MISMATCH).priority, "P2");
  });

  it("check é o eixo do achado", () => {
    assert.equal(toAlarmFinding(MISMATCH).check, "currency");
  });

  it("fingerprint é a mesma chave check:message (gtmDriftFindingKey)", () => {
    assert.equal(toAlarmFinding(MISMATCH).fingerprint, `${MISMATCH.check}:${MISMATCH.message}`);
  });
});
