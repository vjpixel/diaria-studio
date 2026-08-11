/**
 * test/beehiiv-home-meta-check-script.test.ts (#4557)
 *
 * Cobre as partes de I/O de `scripts/beehiiv-home-meta-check.ts` que não
 * exigem rede real nem `data/.credentials.json` (guard de #573/CLAUDE.md —
 * sem credencial Gmail real neste worktree; a regra de dispatch overnight
 * também proíbe qualquer chamada de rede real nesta sessão, mesmo sendo GET
 * público de leitura). Mesmo molde de `test/hub-drift-check-script.test.ts`:
 *
 *   - `fetchHomeHtml` com `fetchFn` mockado — 200, não-ok, e exceção de rede
 *     (nunca lança, sempre resolve pra `{ html, fetchError }`).
 *   - `loadState`/`saveState` — roundtrip de I/O em diretório temporário.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fetchHomeHtml, loadState, saveState } from "../scripts/beehiiv-home-meta-check.ts";
import { emptyHomeMetaAlarmState, advanceHomeMetaAlarmState } from "../scripts/lib/beehiiv-home-meta-check.ts";

describe("fetchHomeHtml (#4557) — fetch mockado, sem rede real", () => {
  it("200 -> html preenchido, fetchError null", async () => {
    const mockFetch = (async () => new Response("<html>ok</html>", { status: 200 })) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, "<html>ok</html>");
    assert.equal(r.fetchError, null);
  });

  it("404 -> html null, fetchError com o status (não é exceção, é resposta HTTP não-ok)", async () => {
    const mockFetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, null);
    assert.match(r.fetchError ?? "", /404/);
  });

  it("500 -> html null, fetchError com o status", async () => {
    const mockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, null);
    assert.match(r.fetchError ?? "", /500/);
  });

  it("fetch lança (rede indisponível) -> fetchError preenchido, html null, nunca propaga a exceção", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, null);
    assert.match(r.fetchError ?? "", /ECONNREFUSED/);
  });

  it("timeout (AbortError) -> fetchError preenchido, nunca propaga", async () => {
    const mockFetch = (async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, null);
    assert.match(r.fetchError ?? "", /abort/i);
  });
});

describe("loadState / saveState (#4557, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "beehiiv-home-meta-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyHomeMetaAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceHomeMetaAlarmState("og-title-brand:x", new Date("2026-08-11T12:00:00Z"));
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyHomeMetaAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (drift limpo/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceHomeMetaAlarmState(null, new Date("2026-08-11T12:00:00Z"));
    saveState(state, path);
    assert.equal(loadState(path).lastAlarmedFingerprint, null);
  });
});
