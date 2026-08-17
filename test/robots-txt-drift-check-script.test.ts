/**
 * test/robots-txt-drift-check-script.test.ts (#4910 item 3)
 *
 * Cobre as partes de I/O de `scripts/robots-txt-drift-check.ts` que não
 * exigem rede real nem `data/.credentials.json` (mesma disciplina de
 * `test/hub-drift-check-script.test.ts` — a checagem HTTP em si é mockada,
 * nunca bate em host de produção real):
 *
 *   - `checkRobotsTxt` com `fetchFn` mockado — 200 (com corpo), não-200 (sem
 *     corpo, defensivo), e exceção de rede (nunca lança).
 *   - `loadState`/`saveState` — roundtrip de I/O em diretório temporário.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkRobotsTxt, loadState, saveState, toAlarmFinding } from "../scripts/robots-txt-drift-check.ts";
import { emptyRobotsDriftAlarmState, advanceRobotsDriftState, type RobotsDriftResult } from "../scripts/lib/robots-txt-drift-check.ts";

describe("checkRobotsTxt (#4910) — fetch mockado, sem rede real", () => {
  it("200 -> httpStatus 200, robotsTxt com o corpo, fetchError null", async () => {
    const mockFetch = (async () => new Response("User-agent: *\nAllow: /\n", { status: 200 })) as unknown as typeof fetch;
    const r = await checkRobotsTxt("https://arquivo.diar.ia.br/robots.txt", mockFetch);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.robotsTxt, "User-agent: *\nAllow: /\n");
    assert.equal(r.fetchError, null);
  });

  it("404 -> httpStatus 404, robotsTxt null (não tenta ler corpo de erro), fetchError null", async () => {
    const mockFetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const r = await checkRobotsTxt("https://arquivo.diar.ia.br/robots.txt", mockFetch);
    assert.equal(r.httpStatus, 404);
    assert.equal(r.robotsTxt, null);
    assert.equal(r.fetchError, null);
  });

  it("500 -> httpStatus 500, robotsTxt null", async () => {
    const mockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await checkRobotsTxt("https://arquivo.diar.ia.br/robots.txt", mockFetch);
    assert.equal(r.httpStatus, 500);
    assert.equal(r.robotsTxt, null);
  });

  it("fetch lança (rede indisponível) -> fetchError preenchido, httpStatus null, nunca propaga a exceção", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await checkRobotsTxt("https://arquivo.diar.ia.br/robots.txt", mockFetch);
    assert.equal(r.httpStatus, null);
    assert.equal(r.robotsTxt, null);
    assert.match(r.fetchError ?? "", /ECONNREFUSED/);
  });

  it("timeout (AbortError) -> fetchError preenchido, nunca propaga", async () => {
    const mockFetch = (async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    const r = await checkRobotsTxt("https://arquivo.diar.ia.br/robots.txt", mockFetch);
    assert.equal(r.httpStatus, null);
    assert.match(r.fetchError ?? "", /abort/i);
  });

  it("envia User-Agent identificável (não curl cru)", async () => {
    let capturedUa: string | null = null;
    const mockFetch = (async (_url: string, init?: RequestInit) => {
      capturedUa = (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? null;
      return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    }) as unknown as typeof fetch;
    await checkRobotsTxt("https://arquivo.diar.ia.br/robots.txt", mockFetch);
    assert.match(capturedUa ?? "", /DiariaBot/);
  });
});

describe("loadState / saveState (#4910, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "robots-txt-drift-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyRobotsDriftAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceRobotsDriftState("arquivo.diar.ia.br:drift:reason", new Date("2026-08-10T12:00:00Z"));
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyRobotsDriftAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (drift limpo/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceRobotsDriftState(null, new Date("2026-08-10T12:00:00Z"));
    saveState(state, path);
    assert.equal(loadState(path).lastAlarmedFingerprint, null);
  });
});

describe("toAlarmFinding — family (#5558)", () => {
  it("é sempre 'estado' — robots.txt volta a bater com o esperado, resolve sozinho", () => {
    const r: RobotsDriftResult = {
      host: "diar.ia.br",
      url: "https://diar.ia.br/robots.txt",
      status: "drift",
      httpStatus: 200,
      fetchError: null,
      reasons: ["bloco gerenciado da Cloudflare reapareceu"],
      message: "bloco gerenciado da Cloudflare reapareceu",
    };
    assert.equal(toAlarmFinding(r).family, "estado");
  });
});
