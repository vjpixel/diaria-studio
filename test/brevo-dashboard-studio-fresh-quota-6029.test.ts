/**
 * test/brevo-dashboard-studio-fresh-quota-6029.test.ts (#6029)
 *
 * Cobre o mecanismo do fix do incidente 260824: `?fresh=1` do painel Clarice
 * do Studio gastava a hora inteira de quota da família /v3/emailCampaigns*
 * (100 RPH por CONTA, #5215) num clique, pendurando até o 502.
 *
 * Três peças:
 * 1. Observer em brevo-api.ts (`setCampaignQuotaStateObserver` +
 *    `notifyCampaignQuotaState` via brevoFetchWithApiKey) — ponte sem acoplamento
 *    node↔Worker (brevo-api roda nos dois; brevo-rate-state.ts é node-only).
 * 2. Guard no Studio: fonte inspecionada (mesmo padrão do #4186 — montar o
 *    pipeline completo do Studio exige Brevo real + SQLite real).
 * 3. `secsUntilTopOfHour` pura (estimativa de retry-after no recuso).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  brevoFetchWithApiKey,
  isCampaignsFamilyPath,
  setCampaignQuotaStateObserver,
} from "../workers/brevo-dashboard/src/brevo-api.ts";
import { secsUntilTopOfHour } from "../scripts/studio-ui/dashboard-clarice.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.join(HERE, "..", "scripts", "studio-ui", "dashboard-clarice.ts");

function jsonResponse(status: number, headers: Record<string, string>, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("#6029 observer em brevo-api.ts", () => {
  it("isCampaignsFamilyPath: só a família /v3/emailCampaigns* conta pra cota horária", () => {
    assert.equal(isCampaignsFamilyPath("/v3/emailCampaigns"), true);
    assert.equal(isCampaignsFamilyPath("/v3/emailCampaigns/123"), true);
    assert.equal(isCampaignsFamilyPath("/v3/account"), false);
    assert.equal(isCampaignsFamilyPath("/v3/contacts"), false);
  });

  it("resposta 200 da família campaigns alimenta o observador com remaining/limit", async () => {
    const seen: Array<{ remaining: number | null; limit: number | null }> = [];
    const unset = setCampaignQuotaStateObserver((remaining, limit) => {
      seen.push({ remaining, limit });
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, { "x-sib-ratelimit-remaining": "7", "x-sib-ratelimit-limit": "100" }, { items: [] })) as typeof fetch;
    try {
      await brevoFetchWithApiKey("/v3/emailCampaigns?limit=1", "stub-key");
    } finally {
      globalThis.fetch = realFetch;
      unset();
    }
    assert.deepEqual(seen, [{ remaining: 7, limit: 100 }]);
  });

  it("resposta 200 FORA da família NÃO alimenta o observador", async () => {
    const seen: unknown[] = [];
    const unset = setCampaignQuotaStateObserver((r, l) => seen.push([r, l]));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, { "x-sib-ratelimit-remaining": "7" }, {})) as typeof fetch;
    try {
      await brevoFetchWithApiKey("/v3/account", "stub-key");
    } finally {
      globalThis.fetch = realFetch;
      unset();
    }
    assert.deepEqual(seen, []);
  });

  it("429 na família campaigns TAMBÉM observa (remaining≈0 é o sinal mais importante)", async () => {
    const seen: Array<number | null> = [];
    const unset = setCampaignQuotaStateObserver((remaining) => seen.push(remaining));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(429, { "retry-after": "60", "x-sib-ratelimit-remaining": "0" }, {})) as typeof fetch;
    try {
      await assert.rejects(
        brevoFetchWithApiKey("/v3/emailCampaigns", "stub-key"),
        /rate limit/i,
      );
    } finally {
      globalThis.fetch = realFetch;
      unset();
    }
    assert.deepEqual(seen, [0]);
  });

  it("observer que lança é engolido fail-soft (nunca derruba a chamada real)", async () => {
    const unset = setCampaignQuotaStateObserver(() => {
      throw new Error("disco cheio (simulado)");
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, { "x-sib-ratelimit-remaining": "50" }, { ok: true })) as typeof fetch;
    try {
      const out = await brevoFetchWithApiKey<{ ok: boolean }>("/v3/emailCampaigns", "stub-key");
      assert.equal(out.ok, true);
    } finally {
      globalThis.fetch = realFetch;
      unset();
    }
  });

  it("sem observador registrado (Worker) → zero mudança de comportamento", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse(200, {}, { v: 1 })) as typeof fetch;
    try {
      const out = await brevoFetchWithApiKey<{ v: number }>("/v3/emailCampaigns", "stub-key");
      assert.equal(out.v, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("#6029 guard do fresh no dashboard-clarice.ts (inspeção de fonte, padrão #4186)", () => {
  const src = readFileSync(DASH, "utf8");

  it("renderClariceDashboardLiveUncached chama o guard ANTES dos fetches ao vivo", () => {
    const fnStart = src.indexOf("async function renderClariceDashboardLiveUncached");
    const body = src.slice(fnStart, src.indexOf("catch (e) {\n    if (e instanceof BrevoRateLimitError)"));
    const guardPos = body.indexOf("assertCampaignQuotaHeadroom(CAMPAIGNS_FETCH_RESERVE)");
    const firstFetchPos = body.indexOf("fetchPlanCredits(");
    assert.ok(guardPos > -1, "guard ausente no caminho live");
    assert.ok(firstFetchPos > guardPos, "fetch acontece antes do guard — curto-circuito inócuo");
  });

  it("recusa por cota baixa cai no buildRateLimitFallback (não no errorHtml)", () => {
    const fnStart = src.indexOf("async function renderClariceDashboardLiveUncached");
    const guardBlock = src.slice(fnStart, fnStart + 3000);
    assert.match(guardBlock, /BrevoCampaignQuotaLowError/);
    assert.match(guardBlock, /buildRateLimitFallback\(env, retryAfterSecs/);
  });

  it("módulo registra o observer que grava recordCampaignQuotaRemaining", () => {
    assert.match(src, /setCampaignQuotaStateObserver\(/);
    assert.match(src, /recordCampaignQuotaRemaining\(remaining, limit/);
  });
});

describe("#6029 secsUntilTopOfHour", () => {
  it("no segundo 0 da hora → 3600", () => {
    assert.equal(secsUntilTopOfHour(Date.UTC(2026, 7, 24, 14, 0, 0)), 3600);
  });
  it("um segundo antes do topo → 1", () => {
    assert.equal(secsUntilTopOfHour(Date.UTC(2026, 7, 24, 14, 59, 59)), 1);
  });
});
