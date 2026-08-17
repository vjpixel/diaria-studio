/**
 * test/meta-capi-5504.test.ts (#5504)
 *
 * Unidade pura + fail-soft de `scripts/lib/shared/meta-capi.ts` — mesmo
 * padrão de `test/poll-token-4487.test.ts` pro módulo irmão. Cobre os 3
 * pontos exigidos explicitamente pela issue: normalização/hash de e-mail
 * (maiúsculas, espaços), determinismo do `event_id`, e o fail-soft (sem
 * token, no-op, NUNCA lança).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmailForMeta,
  hashEmailForMeta,
  computeCompleteRegistrationEventId,
  buildCompleteRegistrationEvent,
  sendMetaCapiEvent,
  sendCompleteRegistrationEvent,
  META_CAPI_DEFAULT_DATASET_ID,
  META_CAPI_DEFAULT_API_VERSION,
} from "../scripts/lib/shared/meta-capi.ts";

const NOW = 1_755_000_000; // fixo, pra determinismo do teste

describe("#5504 — normalizeEmailForMeta / hashEmailForMeta", () => {
  it("normaliza trim + lowercase", () => {
    assert.equal(normalizeEmailForMeta("  Foo@Bar.COM  "), "foo@bar.com");
    assert.equal(normalizeEmailForMeta("foo@bar.com"), "foo@bar.com");
  });

  it("hash é determinístico — mesma entrada, mesmo hash", async () => {
    const a = await hashEmailForMeta("leitor@example.com");
    const b = await hashEmailForMeta("leitor@example.com");
    assert.equal(a, b);
  });

  it("hash é invariante a maiúsculas/espaços (normaliza ANTES de hashear)", async () => {
    const a = await hashEmailForMeta("Foo@Bar.com");
    const b = await hashEmailForMeta("  foo@bar.com  ");
    const c = await hashEmailForMeta("foo@bar.com");
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("hash tem forma de SHA-256 hex (64 chars minúsculos)", async () => {
    const h = await hashEmailForMeta("leitor@example.com");
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("e-mails diferentes produzem hashes diferentes", async () => {
    const a = await hashEmailForMeta("a@example.com");
    const b = await hashEmailForMeta("b@example.com");
    assert.notEqual(a, b);
  });

  it("o e-mail em claro nunca aparece no hash resultante", async () => {
    const email = "leitor-secreto@example.com";
    const h = await hashEmailForMeta(email);
    assert.ok(!h.includes(email), "o hash não pode conter o e-mail original");
  });
});

describe("#5504 — computeCompleteRegistrationEventId", () => {
  it("é determinístico — mesmo (email, event_time no mesmo dia), mesmo event_id", async () => {
    const a = await computeCompleteRegistrationEventId("leitor@example.com", NOW);
    const b = await computeCompleteRegistrationEventId("leitor@example.com", NOW);
    assert.equal(a, b);
  });

  it("é invariante a maiúsculas/espaços do e-mail (normaliza antes)", async () => {
    const a = await computeCompleteRegistrationEventId("Leitor@Example.com", NOW);
    const b = await computeCompleteRegistrationEventId("  leitor@example.com  ", NOW);
    assert.equal(a, b);
  });

  it("é invariante a diferenças de HORÁRIO dentro do MESMO dia UTC (dedup por dia, não por segundo)", async () => {
    const startOfDay = Date.UTC(2026, 7, 16, 0, 0, 1) / 1000;
    const endOfDay = Date.UTC(2026, 7, 16, 23, 59, 59) / 1000;
    const a = await computeCompleteRegistrationEventId("leitor@example.com", startOfDay);
    const b = await computeCompleteRegistrationEventId("leitor@example.com", endOfDay);
    assert.equal(a, b, "mesmo dia UTC deveria produzir o mesmo event_id (retry/reprocessamento no mesmo dia)");
  });

  it("dias diferentes produzem event_id diferente", async () => {
    const day1 = Date.UTC(2026, 7, 16, 12, 0, 0) / 1000;
    const day2 = Date.UTC(2026, 7, 17, 12, 0, 0) / 1000;
    const a = await computeCompleteRegistrationEventId("leitor@example.com", day1);
    const b = await computeCompleteRegistrationEventId("leitor@example.com", day2);
    assert.notEqual(a, b);
  });

  it("e-mails diferentes no mesmo dia produzem event_id diferente", async () => {
    const a = await computeCompleteRegistrationEventId("a@example.com", NOW);
    const b = await computeCompleteRegistrationEventId("b@example.com", NOW);
    assert.notEqual(a, b);
  });
});

describe("#5504 — buildCompleteRegistrationEvent", () => {
  it("monta o payload com event_name fixo, action_source default 'website', e user_data.em com o HASH (nunca o e-mail cru)", async () => {
    const event = await buildCompleteRegistrationEvent({
      email: "Leitor@Example.com",
      eventSourceUrl: "https://eia.diar.ia.br/jogar/subscribe",
      eventTimeSeconds: NOW,
    });
    assert.equal(event.event_name, "CompleteRegistration");
    assert.equal(event.action_source, "website");
    assert.equal(event.event_time, NOW);
    assert.equal(event.event_source_url, "https://eia.diar.ia.br/jogar/subscribe");
    assert.equal(event.user_data.em.length, 1);
    assert.match(event.user_data.em[0], /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(event).includes("Leitor@Example.com"), "o payload não pode conter o e-mail em claro");
    const expectedId = await computeCompleteRegistrationEventId("Leitor@Example.com", NOW);
    assert.equal(event.event_id, expectedId);
  });

  it("action_source é override-ável (batch usa 'system_generated')", async () => {
    const event = await buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/",
      eventTimeSeconds: NOW,
      actionSource: "system_generated",
    });
    assert.equal(event.action_source, "system_generated");
  });

  it("sem eventTimeSeconds explícito, usa 'agora' (event_time é um Unix epoch plausível)", async () => {
    const before = Math.floor(Date.now() / 1000);
    const event = await buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/",
    });
    const after = Math.floor(Date.now() / 1000);
    assert.ok(event.event_time >= before && event.event_time <= after);
  });
});

describe("#5504 — sendMetaCapiEvent (fail-soft de rede)", () => {
  async function fakeEvent() {
    return buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/",
      eventTimeSeconds: NOW,
    });
  }

  it("sem access token → not_configured (503), NUNCA chama fetch", async () => {
    const event = await fakeEvent();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendMetaCapiEvent(event, { accessToken: undefined, fetchImpl });
    assert.deepEqual(result, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(called, false, "sem token, a chamada de rede NUNCA deveria acontecer");
  });

  it("token vazio ('') também é tratado como not_configured", async () => {
    const event = await fakeEvent();
    const result = await sendMetaCapiEvent(event, { accessToken: "" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "not_configured");
  });

  it("token presente → POSTa pra {dataset_id}/events com access_token no corpo e o evento em data[]", async () => {
    const event = await fakeEvent();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body as string) });
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendMetaCapiEvent(event, { accessToken: "tok123", fetchImpl });
    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://graph.facebook.com/${META_CAPI_DEFAULT_API_VERSION}/${META_CAPI_DEFAULT_DATASET_ID}/events`);
    assert.equal(calls[0].body.access_token, "tok123");
    assert.deepEqual(calls[0].body.data, [event]);
    assert.equal(calls[0].body.test_event_code, undefined);
  });

  it("testEventCode, quando passado, viaja no corpo", async () => {
    const event = await fakeEvent();
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await sendMetaCapiEvent(event, { accessToken: "tok123", fetchImpl, testEventCode: "TEST12345" });
    assert.equal(sentBody.test_event_code, "TEST12345");
  });

  it("datasetId/apiVersion/apiBaseUrl são override-áveis", async () => {
    const event = await fakeEvent();
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await sendMetaCapiEvent(event, {
      accessToken: "tok",
      fetchImpl,
      datasetId: "999",
      apiBaseUrl: "https://mock.test/vX",
    });
    assert.equal(calls[0], "https://mock.test/vX/999/events");
  });

  it("resposta não-2xx da Meta → ok:false, reason meta_error, com o status HTTP real", async () => {
    const event = await fakeEvent();
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "bad token" }), { status: 401 })) as unknown as typeof fetch;
    const result = await sendMetaCapiEvent(event, { accessToken: "expired", fetchImpl });
    assert.deepEqual(result, { ok: false, status: 401, reason: "meta_error" });
  });

  it("fetch lançando (rede caída) → ok:false, network_error, NUNCA propaga a exceção", async () => {
    const event = await fakeEvent();
    const fetchImpl = (async () => {
      throw new Error("DNS falhou");
    }) as unknown as typeof fetch;
    const result = await sendMetaCapiEvent(event, { accessToken: "tok", fetchImpl });
    assert.deepEqual(result, { ok: false, status: 502, reason: "network_error" });
  });
});

describe("#5504 — sendCompleteRegistrationEvent (wrapper fail-soft ponta-a-ponta, exigência explícita da issue)", () => {
  it("sem accessToken → not_configured, e NUNCA sequer monta o evento (nenhuma chamada de rede)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendCompleteRegistrationEvent(
      { email: "leitor@example.com", eventSourceUrl: "https://diar.ia.br/" },
      { accessToken: undefined, fetchImpl },
    );
    assert.deepEqual(result, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(called, false);
  });

  it("caminho feliz — token presente, Meta aceita → ok:true", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 })) as unknown as typeof fetch;
    const result = await sendCompleteRegistrationEvent(
      { email: "leitor@example.com", eventSourceUrl: "https://diar.ia.br/", eventTimeSeconds: NOW },
      { accessToken: "tok", fetchImpl },
    );
    assert.deepEqual(result, { ok: true, status: 200 });
  });

  it("qualquer exceção inesperada durante a montagem/envio é engolida — NUNCA lança pro caller (exigência da issue: telemetria de anúncio não pode derrubar cadastro)", async () => {
    // fetchImpl que lança um erro NÃO-Error (caso adversarial, ex: string
    // rejeitada) — o try/catch do wrapper precisa cobrir qualquer forma de
    // exceção, não só instâncias de Error.
    const fetchImpl = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "não é um Error de verdade";
    }) as unknown as typeof fetch;
    await assert.doesNotReject(
      sendCompleteRegistrationEvent(
        { email: "leitor@example.com", eventSourceUrl: "https://diar.ia.br/" },
        { accessToken: "tok", fetchImpl },
      ),
    );
    const result = await sendCompleteRegistrationEvent(
      { email: "leitor@example.com", eventSourceUrl: "https://diar.ia.br/" },
      { accessToken: "tok", fetchImpl },
    );
    assert.equal(result.ok, false);
  });
});
