/**
 * test/clarice-audit-overlap-5697.test.ts (#5697)
 *
 * Cobertura de `scripts/clarice-audit-overlap.ts::main` — critério de
 * aceitação #3 (custo de cota constante, testável) e a checagem de reserva
 * ANTES do sweep (consumidor read-only nunca gasta cota se já estiver
 * abaixo da reserva).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { main, renderOverlapReport } from "../scripts/clarice-audit-overlap.ts";
import { DEFAULT_RATE_STATE_PATH, recordCampaignQuotaRemaining } from "../scripts/lib/brevo-rate-state.ts";

const stateDir = dirname(DEFAULT_RATE_STATE_PATH);
let dirPreexisted: boolean;
let origApiKey: string | undefined;

beforeEach(() => {
  dirPreexisted = existsSync(stateDir);
  if (existsSync(DEFAULT_RATE_STATE_PATH)) rmSync(DEFAULT_RATE_STATE_PATH);
  origApiKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "fake-key-teste-5697";
});

afterEach(() => {
  if (existsSync(DEFAULT_RATE_STATE_PATH)) rmSync(DEFAULT_RATE_STATE_PATH);
  if (!dirPreexisted && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
  else process.env.BREVO_CLARICE_API_KEY = origApiKey;
});

function makeJsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response);
}

describe("clarice-audit-overlap main() (#5697)", () => {
  it("BREVO_CLARICE_API_KEY ausente => lança sem fazer nenhuma chamada", async () => {
    delete process.env.BREVO_CLARICE_API_KEY;
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(() => main([]), /BREVO_CLARICE_API_KEY/);
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("cota abaixo da reserva => recusa ANTES do sweep, zero chamadas HTTP (critério de aceitação #1)", async () => {
    recordCampaignQuotaRemaining(5, 100); // abaixo do default de 30
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(() => main([]), /Cota da família/);
      assert.equal(calls, 0, "não deveria ter feito NENHUMA chamada — recusou antes do sweep");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("custo de cota CONSTANTE: 483 campanhas sent paginadas custam só 10 chamadas HTTP (limit=50), não 483", async () => {
    const total = 483; // não-múltiplo de 50 de propósito: a última página incompleta encerra a paginação sem 1 GET extra.
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls++;
      const u = String(url);
      const offsetMatch = u.match(/offset=(\d+)/);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      const remaining = Math.max(0, total - offset);
      const pageSize = Math.min(50, remaining);
      const campaigns = Array.from({ length: pageSize }, (_, i) => ({
        id: offset + i,
        name: `campanha ${offset + i}`,
        status: "sent",
        sentDate: "2026-08-05T00:00:00Z",
        recipients: { lists: [1000 + offset + i] }, // listas distintas => sem overlap
      }));
      return makeJsonResponse({ campaigns });
    }) as unknown as typeof fetch;
    try {
      await main([]);
      const expectedCalls = Math.ceil(total / 50);
      assert.equal(calls, expectedCalls, `custo deve escalar com PÁGINAS (50/página), não com campanhas: esperado ${expectedCalls}, obtido ${calls}`);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("sobreposição encontrada => process.exitCode = 2 (mesmo padrão de clarice-plan-wave.ts)", async () => {
    const orig = globalThis.fetch;
    const origExitCode = process.exitCode;
    globalThis.fetch = (async () =>
      makeJsonResponse({
        campaigns: [
          { id: 1, name: "d1-seg", status: "sent", sentDate: "2026-08-01T00:00:00Z", recipients: { lists: [72] } },
          { id: 2, name: "d1-seg-2", status: "sent", sentDate: "2026-08-02T00:00:00Z", recipients: { lists: [72] } },
        ],
      })) as unknown as typeof fetch;
    try {
      process.exitCode = undefined;
      await main([]);
      assert.equal(process.exitCode, 2);
    } finally {
      globalThis.fetch = orig;
      process.exitCode = origExitCode;
    }
  });

  it("sem sobreposição => process.exitCode permanece intocado (sucesso limpo)", async () => {
    const orig = globalThis.fetch;
    const origExitCode = process.exitCode;
    globalThis.fetch = (async () => makeJsonResponse({ campaigns: [] })) as unknown as typeof fetch;
    try {
      process.exitCode = undefined;
      await main([]);
      assert.equal(process.exitCode, undefined);
    } finally {
      globalThis.fetch = orig;
      process.exitCode = origExitCode;
    }
  });
});

describe("renderOverlapReport (#5697)", () => {
  it("sem overlaps: mensagem de sucesso com contagem verificada", () => {
    const text = renderOverlapReport(42, []);
    assert.match(text, /✅/);
    assert.match(text, /42/);
  });

  it("com overlaps: lista cada lista/campanhas envolvidas", () => {
    const text = renderOverlapReport(10, [
      { listId: "72", campaigns: [{ id: 1, name: "a", sentDate: "2026-08-01" }, { id: 2, name: "b", sentDate: "2026-08-02" }] },
    ]);
    assert.match(text, /⚠️/);
    assert.match(text, /lista 72/);
    assert.match(text, /#1 "a"/);
    assert.match(text, /#2 "b"/);
  });
});
