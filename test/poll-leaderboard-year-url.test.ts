/**
 * test/poll-leaderboard-year-url.test.ts (#2114)
 *
 * Regressão para as duas correções do #2114:
 *
 * (a) monthly-render.ts renderEia emite URL anual para o leaderboard clarice
 *   (`/leaderboard/{YYYY}?brand=clarice`), não mais mensal (`/leaderboard/YYYY-MM?brand=clarice`).
 *
 * (b) Worker poll rota /leaderboard/{YYYY-MM} com brand=clarice (leaderboardPeriod="year"):
 *   retorna 301 redirect para /leaderboard/{YYYY} em vez de renderizar in-place.
 *   Query params (exceto o path) são preservados.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderEia } from "../scripts/lib/monthly-render.ts";

// ── (a) monthly-render.ts — URL anual no link do leaderboard ───────────────

describe("renderEia — link do leaderboard usa URL anual (#2114a)", () => {
  it("yymm 2605 → /leaderboard/2026?brand=clarice (ano, não mês)", () => {
    const html = renderEia(
      "É IA? — DESTAQUE DO MÊS\n[placeholder]",
      "2605",
      "https://x/A.jpg",
      "https://x/B.jpg",
      "Crédito.",
    );
    assert.match(html, /\/leaderboard\/2026\?brand=clarice/,
      "link deve usar URL anual /leaderboard/2026?brand=clarice");
    assert.doesNotMatch(html, /\/leaderboard\/2026-05/,
      "link NÃO deve usar a URL mensal antiga /leaderboard/2026-05");
  });

  it("yymm 2501 (janeiro/2025) → /leaderboard/2025?brand=clarice", () => {
    const html = renderEia(
      "É IA? — DESTAQUE DO MÊS\n[placeholder]",
      "2501",
      undefined,
      undefined,
      "Crédito.",
    );
    assert.match(html, /\/leaderboard\/2025\?brand=clarice/);
    assert.doesNotMatch(html, /\/leaderboard\/2025-01/);
  });

  it("yymm 2612 (dezembro/2026) → /leaderboard/2026?brand=clarice", () => {
    const html = renderEia(
      "É IA?\n[placeholder]",
      "2612",
      undefined,
      undefined,
    );
    assert.match(html, /\/leaderboard\/2026\?brand=clarice/);
    assert.doesNotMatch(html, /\/leaderboard\/2026-12/);
  });
});

// ── (b) Worker poll — 302 redirect para YYYY-MM com brand=clarice ──────────
// #2123: alterado de 301 para 302. 301 é cacheável permanentemente pelos
// browsers; se leaderboardPeriod mudar no futuro, leitores com cache de 301
// ficariam presos na URL anual sem autocorreção. 302 (temporário) preserva
// a flexibilidade de alterar o redirect futuramente.
// Usa o fetch handler do worker diretamente (sem wrangler unstable_dev).

import workerDefault from "../workers/poll/src/index.ts";

function makeKv(): KVNamespace {
  const data: Record<string, string> = {};
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data)
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(): import("../workers/poll/src/index.ts").Env {
  return {
    POLL: makeKv(),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

describe("worker /leaderboard/{YYYY-MM} com brand=clarice → 302 (#2114b, #2123)", () => {
  it("URL mensal com brand=clarice → 302 para URL anual (#2123: era 301)", async () => {
    const req = new Request("https://poll.diaria.workers.dev/leaderboard/2026-05?brand=clarice");
    const env = makeEnv();
    const resp = await workerDefault.fetch(req, env, {} as ExecutionContext);
    assert.equal(resp.status, 302, "deve retornar 302 redirect (temporário — não cacheável permanentemente)");
    const location = resp.headers.get("Location");
    assert.ok(location, "deve ter header Location");
    assert.match(location!, /\/leaderboard\/2026(\?|$)/,
      "Location deve apontar para /leaderboard/2026");
    assert.match(location!, /brand=clarice/,
      "Location deve preservar brand=clarice nos query params");
  });

  it("URL mensal SEM brand (diaria por default) → NÃO redireciona", async () => {
    const req = new Request("https://poll.diaria.workers.dev/leaderboard/2026-05");
    const env = makeEnv();
    const resp = await workerDefault.fetch(req, env, {} as ExecutionContext);
    // Para diaria, leaderboardPeriod="month" → renderiza in-place (não redireciona)
    assert.notEqual(resp.status, 302, "diaria NÃO deve redirecionar");
    assert.notEqual(resp.status, 301, "diaria NÃO deve redirecionar com 301 também");
  });

  it("URL anual com brand=clarice → NÃO redireciona (já é canônica)", async () => {
    const req = new Request("https://poll.diaria.workers.dev/leaderboard/2026?brand=clarice");
    const env = makeEnv();
    const resp = await workerDefault.fetch(req, env, {} as ExecutionContext);
    // URL já é canônica — deve renderizar (200), não redirecionar
    assert.notEqual(resp.status, 302, "URL anual não deve redirecionar");
    assert.notEqual(resp.status, 301, "URL anual não deve redirecionar com 301 também");
    assert.equal(resp.status, 200, "deve renderizar o leaderboard anual");
  });

  it("redirect 302 preserva o host", async () => {
    const req = new Request("https://poll.diaria.workers.dev/leaderboard/2026-05?brand=clarice");
    const env = makeEnv();
    const resp = await workerDefault.fetch(req, env, {} as ExecutionContext);
    const location = resp.headers.get("Location")!;
    assert.match(location, /^https:\/\/poll\.diaria\.workers\.dev\/leaderboard\/2026/,
      "redirect deve preservar o host original");
  });
});
