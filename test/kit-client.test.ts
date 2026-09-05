/**
 * test/kit-client.test.ts (#463)
 *
 * Sem rede real: `globalThis.fetch` é monkeypatchado (mesmo padrão de
 * `test/apoia-se-probe.test.ts`). Cobre o wrapper genérico (`kitFetch`,
 * auth header, retry em 429/exaustão, JSON inválido, erro tipado) e os 3
 * endpoints de leitura (`listBroadcasts`, `getBroadcastClicks`,
 * `getBroadcastStats`) contra os shapes REAIS confirmados ao vivo em 260824
 * (ver docstring de `scripts/lib/kit-client.ts`).
 *
 * Testes de retry usam `sleep` fake (nunca esperam de verdade) — mesmo
 * padrão de `test/fetch-retry.test.ts`, achado do review do #6074 (a 1ª
 * versão pagava ~1s real por teste de 429).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  kitFetch,
  KitApiError,
  listBroadcasts,
  getBroadcast,
  getBroadcastClicks,
  getBroadcastStats,
  kitBroadcastCtrPct,
  getKitAccount,
  type KitBroadcastStats,
} from "../scripts/lib/kit-client.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TEST_CONFIG = { apiKey: "kit_test_key" };
/** Nunca espera de verdade — injetado em `opts.retry` de qualquer teste que
 *  exercite um caminho de retry. */
const NO_REAL_SLEEP = async () => {};

/** Troca `globalThis.fetch` pra rodar `fn`, sempre restaurando depois —
 *  centraliza o save/restore repetido em cada `describe` (achado do review
 *  do #6074). */
async function withMockFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("kitFetch", () => {
  it("envia X-Kit-Api-Key e Content-Type, monta a URL com kitApiBase()", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, { ok: true });
      }) as typeof fetch,
      async () => {
        const result = await kitFetch("/account", { config: TEST_CONFIG });
        assert.deepEqual(result, { ok: true });
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.kit.com/v4/account");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["X-Kit-Api-Key"], "kit_test_key");
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("method/body são repassados ao fetch (POST/PATCH genérico)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(201, { created: true });
      }) as typeof fetch,
      async () => {
        const result = await kitFetch("/broadcasts", {
          config: TEST_CONFIG,
          method: "POST",
          body: { subject: "Novo" },
        });
        assert.deepEqual(result, { created: true });
      },
    );
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, JSON.stringify({ subject: "Novo" }));
  });

  it("status não-2xx lança KitApiError com path/status/body", async () => {
    await withMockFetch(
      (async () => jsonResponse(404, { error: "Not Found" })) as typeof fetch,
      () =>
        assert.rejects(
          () => kitFetch("/broadcasts/999999", { config: TEST_CONFIG }),
          (e: unknown) => {
            assert.ok(e instanceof KitApiError);
            assert.equal(e.path, "/broadcasts/999999");
            assert.equal(e.status, 404);
            assert.match(e.body, /Not Found/);
            return true;
          },
        ),
    );
  });

  it("429 é retentado e sucede na 2ª tentativa (fetchWithRetry cobre rate limit)", async () => {
    let attempt = 0;
    await withMockFetch(
      (async () => {
        attempt++;
        if (attempt === 1) return jsonResponse(429, {});
        return jsonResponse(200, { ok: true, attempt });
      }) as typeof fetch,
      async () => {
        const result = await kitFetch<{ ok: boolean; attempt: number }>("/account", {
          config: TEST_CONFIG,
          retry: { sleep: NO_REAL_SLEEP },
        });
        assert.equal(attempt, 2);
        assert.deepEqual(result, { ok: true, attempt: 2 });
      },
    );
  });

  it("429 persistente até esgotar as tentativas ainda lança KitApiError (não engole a falha)", async () => {
    let attempt = 0;
    await withMockFetch(
      (async () => {
        attempt++;
        return jsonResponse(429, { error: "rate limited" });
      }) as typeof fetch,
      () =>
        assert.rejects(
          () =>
            kitFetch("/account", {
              config: TEST_CONFIG,
              retry: { sleep: NO_REAL_SLEEP, attempts: 2 },
            }),
          (e: unknown) => {
            assert.ok(e instanceof KitApiError);
            assert.equal(e.status, 429);
            return true;
          },
        ),
    );
    assert.equal(attempt, 2, "deveria ter tentado exatamente `attempts` vezes, nunca mais nem menos");
  });

  it("resposta vazia (204-like, sem corpo) devolve undefined em vez de lançar no JSON.parse", async () => {
    await withMockFetch(
      (async () => new Response("", { status: 200 })) as typeof fetch,
      async () => {
        const result = await kitFetch("/broadcasts/1", { config: TEST_CONFIG });
        assert.equal(result, undefined);
      },
    );
  });

  it("2xx com body não-JSON lança erro com contexto (path + trecho do body), nunca um SyntaxError cru", async () => {
    await withMockFetch(
      (async () => new Response("<html>não é json</html>", { status: 200 })) as typeof fetch,
      () =>
        assert.rejects(() => kitFetch("/broadcasts/1", { config: TEST_CONFIG }), (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.match(e.message, /\/broadcasts\/1/);
          assert.match(e.message, /não é json/);
          assert.ok(!(e instanceof SyntaxError), "não deveria vazar o SyntaxError cru sem contexto");
          return true;
        }),
    );
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
  it("monta query string com status/per_page/after, devolve broadcasts+pagination", async () => {
    let capturedUrl = "";
    await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, {
          broadcasts: [{ id: 1, subject: "Teste", status: "draft" }],
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 10 },
        });
      }) as typeof fetch,
      async () => {
        const result = await listBroadcasts({ status: "completed", perPage: 20, after: "cursor123", config: TEST_CONFIG });
        assert.equal(result.broadcasts.length, 1);
        assert.equal(result.broadcasts[0].subject, "Teste");
      },
    );
    assert.match(capturedUrl, /status=completed/);
    assert.match(capturedUrl, /per_page=20/);
    assert.match(capturedUrl, /after=cursor123/);
  });

  it("includeContent adiciona include[]=content na query string", async () => {
    let capturedUrl = "";
    await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, {
          broadcasts: [],
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 10 },
        });
      }) as typeof fetch,
      () => listBroadcasts({ includeContent: true, config: TEST_CONFIG }),
    );
    assert.match(capturedUrl, /include(%5B%5D|\[\])=content/);
  });

  it("sem opções, não adiciona query string", async () => {
    let capturedUrl = "";
    await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, {
          broadcasts: [],
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 10 },
        });
      }) as typeof fetch,
      () => listBroadcasts({ config: TEST_CONFIG }),
    );
    assert.equal(capturedUrl, "https://api.kit.com/v4/broadcasts");
  });
});

describe("getBroadcast", () => {
  it("desembrulha o campo broadcast do envelope", async () => {
    await withMockFetch(
      (async () =>
        jsonResponse(200, {
          broadcast: { id: 42, subject: "Assunto", content: "<p>oi</p>", status: "draft" },
        })) as typeof fetch,
      async () => {
        const result = await getBroadcast(42, TEST_CONFIG);
        assert.equal(result.id, 42);
        assert.equal(result.content, "<p>oi</p>");
      },
    );
  });

  it("2xx sem o envelope 'broadcast' lança erro nomeando o id, nunca um TypeError opaco", async () => {
    await withMockFetch(
      (async () => new Response("", { status: 200 })) as typeof fetch,
      () =>
        assert.rejects(() => getBroadcast(42, TEST_CONFIG), (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.ok(!(e instanceof TypeError), "não deveria degradar pra TypeError de destructuring");
          assert.match(e.message, /getBroadcast\(42\)/);
          return true;
        }),
    );
  });
});

describe("getBroadcastClicks", () => {
  it("desembrulha broadcast.clicks (shape real confirmado 260824 — clicks NÃO é top-level)", async () => {
    await withMockFetch(
      (async () =>
        jsonResponse(200, {
          broadcast: { id: 7, clicks: [{ url: "https://exemplo.com", unique_clicks: 3, click_to_delivery_rate: 1.2, click_to_open_rate: 4.5 }] },
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
        })) as typeof fetch,
      async () => {
        const result = await getBroadcastClicks(7, { config: TEST_CONFIG });
        assert.equal(result.clicks.length, 1);
        assert.equal(result.clicks[0].url, "https://exemplo.com");
        assert.equal(result.clicks[0].unique_clicks, 3);
      },
    );
  });

  it("perPage/after chegam na query string", async () => {
    let capturedUrl = "";
    await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, {
          broadcast: { id: 7, clicks: [] },
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
        });
      }) as typeof fetch,
      () => getBroadcastClicks(7, { perPage: 100, after: "cursorABC", config: TEST_CONFIG }),
    );
    assert.match(capturedUrl, /per_page=100/);
    assert.match(capturedUrl, /after=cursorABC/);
  });

  it("lista vazia (broadcast sem clique ainda) não lança", async () => {
    await withMockFetch(
      (async () =>
        jsonResponse(200, {
          broadcast: { id: 7, clicks: [] },
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
        })) as typeof fetch,
      async () => {
        const result = await getBroadcastClicks(7, { config: TEST_CONFIG });
        assert.deepEqual(result.clicks, []);
      },
    );
  });

  it("2xx sem o envelope 'broadcast' lança erro nomeando o id, nunca um TypeError opaco", async () => {
    await withMockFetch(
      (async () => new Response("", { status: 200 })) as typeof fetch,
      () =>
        assert.rejects(() => getBroadcastClicks(7, { config: TEST_CONFIG }), (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.ok(!(e instanceof TypeError));
          assert.match(e.message, /getBroadcastClicks\(7\)/);
          return true;
        }),
    );
  });
});

describe("getBroadcastStats", () => {
  it("desembrulha broadcast.stats com o shape real confirmado 260824", async () => {
    await withMockFetch(
      (async () =>
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
        })) as typeof fetch,
      async () => {
        const result = await getBroadcastStats(99, TEST_CONFIG);
        assert.equal(result.recipients, 585);
        assert.equal(result.emails_opened, 197);
        assert.equal(result.total_clicks, 86);
      },
    );
  });

  it("2xx sem o envelope 'broadcast.stats' lança erro nomeando o id, nunca um TypeError opaco", async () => {
    await withMockFetch(
      (async () => jsonResponse(200, { broadcast: { id: 99 } })) as typeof fetch,
      () =>
        assert.rejects(() => getBroadcastStats(99, TEST_CONFIG), (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.ok(!(e instanceof TypeError));
          assert.match(e.message, /getBroadcastStats\(99\)/);
          return true;
        }),
    );
  });
});

describe("kitBroadcastCtrPct (#6186 — semântica confirmada contra envio real 26/08/2026)", () => {
  /** Números REAIS medidos no broadcast `25609304` (piloto Patronos,
   *  `status: completed`), do comentário de desbloqueio da #6186 — não
   *  inventados. Ver a tabela de confirmação na docstring de
   *  `KitBroadcastStats` em `scripts/lib/kit-client.ts`. */
  const MEASURED_STATS_25609304: KitBroadcastStats = {
    recipients: 5,
    open_rate: 60.0,
    emails_opened: 3,
    click_rate: 40.0,
    unsubscribe_rate: 0,
    unsubscribes: 0,
    total_clicks: 3,
    show_total_clicks: true,
    status: "completed",
    progress: 100,
    open_tracking_disabled: false,
    click_tracking_disabled: false,
  };

  it("lê click_rate diretamente — é CTR sobre entregas, não click-to-open", () => {
    assert.equal(kitBroadcastCtrPct(MEASURED_STATS_25609304), 40.0);
  });

  it("trava a semântica: NÃO bate com a fórmula click-to-open da Beehiiv (total_clicks/emails_opened)", () => {
    const clickToOpen =
      (MEASURED_STATS_25609304.total_clicks / MEASURED_STATS_25609304.emails_opened) * 100;
    assert.equal(clickToOpen, 100.0); // a armadilha da Beehiiv, se aplicada aqui, daria 100%
    assert.notEqual(
      kitBroadcastCtrPct(MEASURED_STATS_25609304),
      clickToOpen,
      "kitBroadcastCtrPct nunca pode coincidir com a fórmula click-to-open — se coincidir, alguém trocou a semântica",
    );
  });

  it("trava a semântica: NÃO bate com total_clicks/recipients (CTR ingênuo por cliques, não por clicadores)", () => {
    const naiveClicksOverRecipients =
      (MEASURED_STATS_25609304.total_clicks / MEASURED_STATS_25609304.recipients) * 100;
    assert.equal(naiveClicksOverRecipients, 60.0);
    assert.notEqual(
      kitBroadcastCtrPct(MEASURED_STATS_25609304),
      naiveClicksOverRecipients,
      "click_rate do Kit conta CLICADORES únicos, não CLIQUES — total_clicks/recipients não é a fórmula certa",
    );
  });

  it("bate com unique_clicked/delivered (2 clicadores distintos / 5 destinatários)", () => {
    const uniqueClickedOverDelivered = (2 / MEASURED_STATS_25609304.recipients) * 100;
    assert.equal(kitBroadcastCtrPct(MEASURED_STATS_25609304), uniqueClickedOverDelivered);
  });
});

describe("getKitAccount (#7362)", () => {
  it("envelope { account: {...} } — extrai subscriber_limit/plan_type/renews_at", async () => {
    const account = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          account: {
            name: "diar.ia.br",
            plan_type: "creator",
            subscriber_limit: 1000,
            renews_at: "2026-09-07T17:30:58Z",
          },
        })) as typeof fetch,
      () => getKitAccount(TEST_CONFIG),
    );
    assert.equal(account.subscriber_limit, 1000);
    assert.equal(account.plan_type, "creator");
    assert.equal(account.renews_at, "2026-09-07T17:30:58Z");
  });

  it("subscriber_limit/renews_at aninhados em account.plan (#7411) — shape REST real confirmado ao vivo 05/09/2026", async () => {
    // Payload real capturado em produção (kit-subscriber-limit-alarm.service,
    // exit 1 silencioso): subscriber_limit e renews_at NÃO estão soltos em
    // `account`, estão um nível abaixo em `account.plan`. `account.plan_type`
    // existe solto também (redundante com `account.plan.plan_type`).
    const account = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          user: { id: 2963623, email: "vjpixel@gmail.com" },
          account: {
            id: 2873431,
            name: "diar.ia.br",
            plan_type: "creator",
            primary_email_address: "vjpixel@gmail.com",
            created_at: "2026-08-24T17:30:57Z",
            plan: {
              plan_type: "creator",
              interval: "month",
              subscriber_limit: 1000,
              on_trial: false,
              trial_lapse_date: "2026-09-07T17:30:58Z",
              renews_at: null,
              cancels_at: "2026-09-07T17:30:58Z",
            },
          },
        })) as typeof fetch,
      () => getKitAccount(TEST_CONFIG),
    );
    assert.equal(account.subscriber_limit, 1000);
    assert.equal(account.plan_type, "creator");
    assert.equal(account.renews_at, null);
  });

  it("envelope FLAT (sem chave account) — mesmo resultado, shape REST não confirmado ao vivo", async () => {
    const account = await withMockFetch(
      (async () =>
        jsonResponse(200, { name: "diar.ia.br", plan_type: "creator", subscriber_limit: 1000, renews_at: null })) as typeof fetch,
      () => getKitAccount(TEST_CONFIG),
    );
    assert.equal(account.subscriber_limit, 1000);
    assert.equal(account.renews_at, null);
  });

  it("subscriber_limit ausente/não-numérico → lança (nunca fabrica um teto)", async () => {
    await assert.rejects(
      () =>
        withMockFetch(
          (async () => jsonResponse(200, { account: { plan_type: "creator" } })) as typeof fetch,
          () => getKitAccount(TEST_CONFIG),
        ),
      /subscriber_limit/,
    );
  });

  it("chama GET /account com a mesma auth de kitFetch", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, { account: { subscriber_limit: 1000 } });
      }) as typeof fetch,
      () => getKitAccount(TEST_CONFIG),
    );
    assert.equal(calls[0].url, "https://api.kit.com/v4/account");
    assert.equal((calls[0].init?.headers as Record<string, string>)["X-Kit-Api-Key"], "kit_test_key");
  });
});
