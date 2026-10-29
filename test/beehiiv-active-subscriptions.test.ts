/**
 * test/beehiiv-active-subscriptions.test.ts (#11225, herdado do #6311)
 *
 * (a) `computeRetryWaitMs` — o backoff de 429 respeita `Retry-After` nas
 *     duas formas da RFC 7231 (segundos e data HTTP) e nunca produz `NaN`.
 *     Os casos vieram de `test/reconcile-beehiiv-kit.test.ts`, apagado junto
 *     com o CLI aposentado no #11225.
 * (b) Aposentadoria (#11225): os CLIs que só serviam ao envio pela Beehiiv
 *     não voltam, e os consumidores vivos de `fetchActiveBeehiivEmails`
 *     importam da lib, nunca do CLI removido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { computeRetryWaitMs, fetchActiveBeehiivEmails } from "../scripts/lib/beehiiv-active-subscriptions.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("computeRetryWaitMs (#6311a)", () => {
  it("Retry-After em segundos, acima do piso de 30s — respeitado", () => {
    assert.equal(computeRetryWaitMs(new Headers({ "Retry-After": "120" })), 120_000);
  });

  it("Retry-After em segundos, abaixo do piso de 30s — piso aplicado", () => {
    assert.equal(computeRetryWaitMs(new Headers({ "Retry-After": "5" })), 30_000);
  });

  it("Retry-After em forma de DATA HTTP (RFC 7231) — nunca NaN, cai no default de 60s", () => {
    const waitMs = computeRetryWaitMs(new Headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }));
    assert.equal(Number.isNaN(waitMs), false);
    assert.equal(waitMs, 60_000);
  });

  it("Retry-After ausente — default de 60s", () => {
    assert.equal(computeRetryWaitMs(new Headers()), 60_000);
  });

  it("Retry-After negativo (lixo) — nunca NaN, cai no default de 60s", () => {
    const waitMs = computeRetryWaitMs(new Headers({ "Retry-After": "-5" }));
    assert.equal(Number.isNaN(waitMs), false);
    assert.equal(waitMs, 60_000);
  });
});

describe("fetchActiveBeehiivEmails — paginação (#11225, comportamento preservado na mudança de módulo)", () => {
  it("drena por total_results e falha loud em !res.ok", async () => {
    const origFetch = globalThis.fetch;
    const pages = [
      { data: [{ email: "a@x.com" }, { email: "b@x.com" }], total_results: 3, limit: 2 },
      { data: [{ email: "c@x.com" }], total_results: 3, limit: 2 },
    ];
    let call = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify(pages[call++]), { status: 200 })) as typeof fetch;
    try {
      assert.deepEqual(await fetchActiveBeehiivEmails("k", "pub"), ["a@x.com", "b@x.com", "c@x.com"]);
      globalThis.fetch = (async () => new Response("x", { status: 500 })) as typeof fetch;
      await assert.rejects(fetchActiveBeehiivEmails("k", "pub"), /Beehiiv API 500/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("aposentadoria dos CLIs de envio Beehiiv (#11225)", () => {
  for (const retired of ["scripts/reconcile-beehiiv-kit.ts", "scripts/fetch-beehiiv-poll-stats.ts"]) {
    it(`${retired} não existe mais`, () => {
      assert.equal(existsSync(resolve(ROOT, retired)), false, `${retired} voltou — foi aposentado no #11225`);
    });
  }

  for (const consumer of [
    "scripts/reconcile-send-audiences.ts",
    "scripts/audit-kit-diaria-exclusivity.ts",
    "scripts/kit-gmail-warmup-ramp.ts",
  ]) {
    it(`${consumer} importa fetchActiveBeehiivEmails da lib`, () => {
      const src = readFileSync(resolve(ROOT, consumer), "utf8");
      assert.match(src, /from "\.\/lib\/beehiiv-active-subscriptions\.ts"/);
      assert.doesNotMatch(src, /from "\.\/reconcile-beehiiv-kit\.ts"/);
    });
  }
});
