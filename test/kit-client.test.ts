/**
 * test/kit-client.test.ts (#463)
 *
 * Sem rede real: `globalThis.fetch` é monkeypatchado (mesmo padrão de
 * `test/apoia-se-probe.test.ts`). Cobre o wrapper genérico (`kitFetch`,
 * auth header, retry em 429, erro tipado) e os 3 endpoints de leitura
 * (`listBroadcasts`, `getBroadcastClicks`, `getBroadcastStats`) contra os
 * shapes REAIS confirmados ao vivo em 260824 (ver docstring de
 * `scripts/lib/kit-client.ts`).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  kitFetch,
  KitApiError,
  listBroadcasts,
  getBroadcast,
  getBroadcastClicks,
  getBroadcastStats,
} from "../scripts/lib/kit-client.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TEST_CONFIG = { apiKey: "kit_test_key" };

describe("kitFetch", () => {
  let origFetch: typeof fetch;
  let calls: { url: string; init?: RequestInit }[];

  beforeEach(() => {
    origFetch = globalThis.fetch;
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("envia X-Kit-Api-Key e Content-Type, monta a URL com kitApiBase()", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const result = await kitFetch("/account", { config: TEST_CONFIG });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.kit.com/v4/account");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["X-Kit-Api-Key"], "kit_test_key");
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("status não-2xx lança KitApiError com path/status/body", async () => {
    globalThis.fetch = (async () => jsonResponse(404, { error: "Not Found" })) as typeof fetch;

    await assert.rejects(
      () => kitFetch("/broadcasts/999999", { config: TEST_CONFIG }),
      (e: unknown) => {
        assert.ok(e instanceof KitApiError);
        assert.equal(e.path, "/broadcasts/999999");
        assert.equal(e.status, 404);
        assert.match(e.body, /Not Found/);
        return true;
      },
    );
  });

  it("429 é retentado e sucede na 2ª tentativa (fetchWithRetry cobre rate limit)", async () => {
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt++;
      if (attempt === 1) return jsonResponse(429, {});
      return jsonResponse(200, { ok: true, attempt });
    }) as typeof fetch;

    const result = await kitFetch<{ ok: boolean; attempt: number }>("/account", {
      config: TEST_CONFIG,
    });
    assert.equal(attempt, 2);
    assert.deepEqual(result, { ok: true, attempt: 2 });
  });

  it("resposta vazia (204-like, sem corpo) devolve undefined em vez de lançar no JSON.parse", async () => {
    globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;
    const result = await kitFetch("/broadcasts/1", { config: TEST_CONFIG });
    assert.equal(result, undefined);
  });

  it("sem config explícita e sem KIT_API_KEY no env, lança erro claro (fail-fast)", async () => {
    const orig = process.env.KIT_API_KEY;
    delete process.env.KIT_API_KEY;
    try {
      await assert.rejects(() => kitFetch("/account"), /KIT_API_KEY não definida/);
    } finally {
      if (orig !== undefined) process.env.KIT_API_KEY = orig;
    }
  });
});

describe("listBroadcasts", () => {
  let origFetch: typeof fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("monta query string com status/per_page/after, devolve broadcasts+pagination", async () => {
    origFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return jsonResponse(200, {
        broadcasts: [{ id: 1, subject: "Teste", status: "draft" }],
        pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 10 },
      });
    }) as typeof fetch;

    const result = await listBroadcasts({ status: "completed", perPage: 20, after: "cursor123", config: TEST_CONFIG });
    assert.match(capturedUrl, /status=completed/);
    assert.match(capturedUrl, /per_page=20/);
    assert.match(capturedUrl, /after=cursor123/);
    assert.equal(result.broadcasts.length, 1);
    assert.equal(result.broadcasts[0].subject, "Teste");
  });

  it("sem opções, não adiciona query string", async () => {
    origFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return jsonResponse(200, {
        broadcasts: [],
        pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 10 },
      });
    }) as typeof fetch;

    await listBroadcasts({ config: TEST_CONFIG });
    assert.equal(capturedUrl, "https://api.kit.com/v4/broadcasts");
  });
});

describe("getBroadcast", () => {
  it("desembrulha o campo broadcast do envelope", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        broadcast: { id: 42, subject: "Assunto", content: "<p>oi</p>", status: "draft" },
      })) as typeof fetch;
    try {
      const result = await getBroadcast(42, TEST_CONFIG);
      assert.equal(result.id, 42);
      assert.equal(result.content, "<p>oi</p>");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("getBroadcastClicks", () => {
  it("desembrulha broadcast.clicks (shape real confirmado 260824 — clicks NÃO é top-level)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        broadcast: { id: 7, clicks: [{ url: "https://exemplo.com", unique_clicks: 3, click_to_delivery_rate: 1.2, click_to_open_rate: 4.5 }] },
        pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
      })) as typeof fetch;
    try {
      const result = await getBroadcastClicks(7, { config: TEST_CONFIG });
      assert.equal(result.clicks.length, 1);
      assert.equal(result.clicks[0].url, "https://exemplo.com");
      assert.equal(result.clicks[0].unique_clicks, 3);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("lista vazia (broadcast sem clique ainda) não lança", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        broadcast: { id: 7, clicks: [] },
        pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
      })) as typeof fetch;
    try {
      const result = await getBroadcastClicks(7, { config: TEST_CONFIG });
      assert.deepEqual(result.clicks, []);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("getBroadcastStats", () => {
  it("desembrulha broadcast.stats com o shape real confirmado 260824", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        broadcast: {
          id: 99,
          stats: {
            recipients: 585,
            open_rate: 33.79,
            emails_opened: 197,
            click_rate: 14.7,
            unsubscribe_rate: 0.1,
            unsubscribes: 1,
            total_clicks: 86,
            show_total_clicks: true,
            status: "completed",
            progress: 100,
            open_tracking_disabled: false,
            click_tracking_disabled: false,
          },
        },
      })) as typeof fetch;
    try {
      const result = await getBroadcastStats(99, TEST_CONFIG);
      assert.equal(result.recipients, 585);
      assert.equal(result.emails_opened, 197);
      assert.equal(result.total_clicks, 86);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
