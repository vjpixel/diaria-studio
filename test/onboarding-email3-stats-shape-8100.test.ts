/**
 * test/onboarding-email3-stats-shape-8100.test.ts (#8100)
 *
 * Regressão: `fetchSubscriberStatsKit` (scripts/onboarding-welcome-run.ts)
 * lia o campo de aberturas no nível ERRADO do JSON — direto em `subscriber`
 * (`total_unique_opens`/`total_opens`/`unique_opens`/`opens`), quando o
 * shape real de `GET /subscribers/{id}/stats` (confirmado contra
 * developers.kit.com/api-reference/subscribers/list-stats-for-a-subscriber)
 * é `{ subscriber: { stats: { opened, ... } } }` — um nível mais fundo, e
 * com o nome `opened`, não `opens`. Nenhum dos 4 nomes chutados batia, então
 * `fetchSubscriberStatsKit` devolvia `null` SEMPRE, e o e-mail 3 do
 * onboarding nunca via uma abertura de verdade (medido em 14/09/2026: 930
 * entradas, 0 `email3_state: "sent"`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchSubscriberStatsKit } from "../scripts/onboarding-welcome-run.ts";
import type { KitConfig } from "../scripts/lib/kit-config.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CONFIG: KitConfig = { apiKey: "test-key" };

describe("fetchSubscriberStatsKit — shape real da API Kit (#8100)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("lê `subscriber.stats.opened` (shape real, confirmado na doc) — não `opens` no nível do subscriber", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, {
        subscriber: {
          id: 1103,
          stats: {
            sent: 2,
            opened: 1,
            clicked: 1,
            bounced: 1,
            open_rate: 0.5,
            click_rate: 0.5,
          },
        },
      })) as typeof fetch;
    try {
      const stats = await fetchSubscriberStatsKit(1103, CONFIG);
      assert.deepEqual(stats, { total_unique_opened: 1, total_clicked: null });
    } finally {
      restore();
    }
  });

  it("zero aberturas reais → `total_unique_opened: 0` (não confundir com stats ausentes)", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, { subscriber: { id: 2, stats: { sent: 3, opened: 0 } } })) as typeof fetch;
    try {
      const stats = await fetchSubscriberStatsKit(2, CONFIG);
      assert.deepEqual(stats, { total_unique_opened: 0, total_clicked: null });
    } finally {
      restore();
    }
  });

  it("shape antigo/quebrado (`opens` no nível do subscriber, sem `stats` aninhado) → null, fail-safe preservado", async () => {
    globalThis.fetch = (async () => jsonRes(200, { subscriber: { id: 3, opens: 5 } })) as typeof fetch;
    try {
      const stats = await fetchSubscriberStatsKit(3, CONFIG);
      assert.equal(stats, null);
    } finally {
      restore();
    }
  });

  it("erro de rede/HTTP → null, nunca lança", async () => {
    globalThis.fetch = (async () => jsonRes(404, {})) as typeof fetch;
    try {
      const stats = await fetchSubscriberStatsKit(4, CONFIG);
      assert.equal(stats, null);
    } finally {
      restore();
    }
  });
});
