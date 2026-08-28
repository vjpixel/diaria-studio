/**
 * test/subscribe-redirect-drift-check-script.test.ts (#6365)
 *
 * Cobre as partes de I/O de `scripts/subscribe-redirect-drift-check.ts` que
 * não exigem rede real nem `data/.credentials.json` (guard de #573/CLAUDE.md
 * — sem credencial Gmail real neste worktree; a checagem HTTP em si é
 * mockada, não bate na URL de produção real):
 *
 *   - `checkTarget` com `fetchFn` mockado — 200 com body, não-200, e
 *     exceção de rede (nunca lança, sempre resolve pra
 *     `{ httpStatus, fetchError, body }`).
 *   - `loadState`/`saveState` — roundtrip de I/O em diretório temporário,
 *     mesmo padrão de `test/hub-drift-check-script.test.ts`.
 *   - `toAlarmFinding` — family/priority.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkTarget, loadState, saveState, toAlarmFinding } from "../scripts/subscribe-redirect-drift-check.ts";
import {
  emptySubscribeDriftAlarmState,
  advanceSubscribeDriftState,
  type DriftCheckResult,
} from "../scripts/lib/subscribe-redirect-drift-check.ts";

describe("checkTarget (#6365) — fetch mockado, sem rede real", () => {
  it("200 -> httpStatus 200, fetchError null, body preenchido", async () => {
    const mockFetch = (async () => new Response("<html>ok</html>", { status: 200 })) as unknown as typeof fetch;
    const r = await checkTarget("https://diar-ia-br.kit.com/", mockFetch);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.fetchError, null);
    assert.equal(r.body, "<html>ok</html>");
  });

  it("404 -> httpStatus 404, fetchError null (não é exceção, é resposta HTTP)", async () => {
    const mockFetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const r = await checkTarget("https://diar-ia-br.kit.com/", mockFetch);
    assert.equal(r.httpStatus, 404);
    assert.equal(r.fetchError, null);
  });

  it("500 -> httpStatus 500", async () => {
    const mockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await checkTarget("https://diar-ia-br.kit.com/", mockFetch);
    assert.equal(r.httpStatus, 500);
  });

  it("fetch lança (rede indisponível) -> fetchError preenchido, httpStatus null, body null, nunca propaga a exceção", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await checkTarget("https://diar-ia-br.kit.com/", mockFetch);
    assert.equal(r.httpStatus, null);
    assert.equal(r.body, null);
    assert.match(r.fetchError ?? "", /ECONNREFUSED/);
  });

  it("timeout (AbortError) -> fetchError preenchido, nunca propaga", async () => {
    const mockFetch = (async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    const r = await checkTarget("https://diar-ia-br.kit.com/", mockFetch);
    assert.equal(r.httpStatus, null);
    assert.match(r.fetchError ?? "", /abort/i);
  });

  it("chama fetch com User-Agent de navegador (destino Kit exige, senão a Cloudflare devolve challenge)", async () => {
    let capturedInit: RequestInit | undefined;
    const mockFetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await checkTarget("https://diar-ia-br.kit.com/", mockFetch);
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    assert.ok(headers?.["User-Agent"]?.includes("Mozilla"));
  });
});

describe("loadState / saveState (#6365, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "subscribe-redirect-drift-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptySubscribeDriftAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceSubscribeDriftState("kit-subscribe:broken:404:-", new Date("2026-08-08T12:00:00Z"));
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptySubscribeDriftAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (drift limpo/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceSubscribeDriftState(null, new Date("2026-08-08T12:00:00Z"));
    saveState(state, path);
    assert.equal(loadState(path).lastAlarmedFingerprint, null);
  });
});

describe("toAlarmFinding (#6365)", () => {
  const RESULT: DriftCheckResult = {
    key: "kit-subscribe",
    label: "Destino do redirect /subscribe (perfil hospedado Kit)",
    url: "https://diar-ia-br.kit.com/",
    status: "broken",
    httpStatus: 500,
    fetchError: null,
    message: "HTTP 500",
  };

  it("family é 'estado' — alvo volta a responder, resolve sozinho", () => {
    assert.equal(toAlarmFinding(RESULT).family, "estado");
  });

  it("priority é P1 — única porta de cadastro do apex pós-cutover, sem workaround", () => {
    assert.equal(toAlarmFinding(RESULT).priority, "P1");
  });

  it("check é a key do alvo", () => {
    assert.equal(toAlarmFinding(RESULT).check, "kit-subscribe");
  });
});
