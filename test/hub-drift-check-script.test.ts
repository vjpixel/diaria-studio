/**
 * test/hub-drift-check-script.test.ts (#4750)
 *
 * Cobre as partes de I/O de `scripts/hub-drift-check.ts` que não exigem rede
 * real nem `data/.credentials.json` (guard de #573/CLAUDE.md — sem
 * credencial Gmail real neste worktree; a checagem HTTP em si é mockada, não
 * bate na URL de produção real, ver instrução do dispatch):
 *
 *   - `checkHub` com `fetchFn` mockado — 200, não-200, e exceção de rede
 *     (nunca lança, sempre resolve pra `{ httpStatus, fetchError }`).
 *   - `loadState`/`saveState` — roundtrip de I/O em diretório temporário,
 *     mesmo padrão de `test/worker-drift-check-script.test.ts`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkHub, loadState, saveState } from "../scripts/hub-drift-check.ts";
import { emptyHubDriftAlarmState, advanceHubDriftState } from "../scripts/lib/hub-drift-check.ts";

describe("checkHub (#4750) — fetch mockado, sem rede real", () => {
  it("200 -> httpStatus 200, fetchError null", async () => {
    const mockFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await checkHub("https://arquivo.diar.ia.br/temas/anthropic-claude", mockFetch);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.fetchError, null);
  });

  it("404 -> httpStatus 404, fetchError null (não é exceção, é resposta HTTP)", async () => {
    const mockFetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const r = await checkHub("https://arquivo.diar.ia.br/temas/inexistente", mockFetch);
    assert.equal(r.httpStatus, 404);
    assert.equal(r.fetchError, null);
  });

  it("500 -> httpStatus 500", async () => {
    const mockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await checkHub("https://arquivo.diar.ia.br/temas/quebrado", mockFetch);
    assert.equal(r.httpStatus, 500);
  });

  it("fetch lança (rede indisponível) -> fetchError preenchido, httpStatus null, nunca propaga a exceção", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await checkHub("https://arquivo.diar.ia.br/temas/x", mockFetch);
    assert.equal(r.httpStatus, null);
    assert.match(r.fetchError ?? "", /ECONNREFUSED/);
  });

  it("timeout (AbortError) -> fetchError preenchido, nunca propaga", async () => {
    const mockFetch = (async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    const r = await checkHub("https://arquivo.diar.ia.br/temas/lento", mockFetch);
    assert.equal(r.httpStatus, null);
    assert.match(r.fetchError ?? "", /abort/i);
  });
});

describe("loadState / saveState (#4750, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hub-drift-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyHubDriftAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceHubDriftState("anthropic-claude:broken:404:-", new Date("2026-08-08T12:00:00Z"));
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyHubDriftAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (drift limpo/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceHubDriftState(null, new Date("2026-08-08T12:00:00Z"));
    saveState(state, path);
    assert.equal(loadState(path).lastAlarmedFingerprint, null);
  });
});
