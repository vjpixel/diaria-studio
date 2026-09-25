/**
 * Testes (#8555): módulo de envio sobre a Data Manager API
 * (`scripts/lib/google-data-manager-sender.ts`). Nenhum teste toca a API
 * real — `fetch` é sempre mock.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  authConfigFromEnv,
  buildDataManagerEvent,
  buildDataManagerIngestPayload,
  chunkDataManagerEvents,
  conversionDateTimeToRfc3339,
  DATA_MANAGER_INGEST_URL,
  DATA_MANAGER_MAX_EVENTS_PER_REQUEST,
  sendDataManagerIngest,
  type DataManagerEvent,
} from "../scripts/lib/google-data-manager-sender.ts";
import { hashEmailForEnhancedConversions, type ValidatedConversion } from "../scripts/lib/google-ads-enhanced-conversions.ts";

const CONV: ValidatedConversion = {
  email: "leitor@example.com",
  hashedEmail: hashEmailForEnhancedConversions("leitor@example.com"),
  conversionDateTime: "2026-09-24 12:00:00-03:00",
  pastCutoff: false,
  orderId: "diaria-confirmacao-kit-1",
};

describe("#8555 — conversionDateTimeToRfc3339", () => {
  it("converte o formato espaço+offset pra RFC 3339", () => {
    assert.equal(conversionDateTimeToRfc3339("2026-09-24 12:00:00-03:00"), "2026-09-24T12:00:00-03:00");
    assert.equal(conversionDateTimeToRfc3339("2026-09-24 12:00:00+00:00"), "2026-09-24T12:00:00+00:00");
  });

  it("formato inesperado devolve null (nunca lança)", () => {
    assert.equal(conversionDateTimeToRfc3339("lixo"), null);
    assert.equal(conversionDateTimeToRfc3339("2026-09-24T12:00:00-03:00"), null); // já com T, não o formato de entrada
    assert.equal(conversionDateTimeToRfc3339(""), null);
  });
});

describe("#8555 — buildDataManagerEvent", () => {
  it("monta o evento sem gclid — só userData", () => {
    const r = buildDataManagerEvent(CONV);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.event.transactionId, "diaria-confirmacao-kit-1");
    assert.equal(r.event.eventTimestamp, "2026-09-24T12:00:00-03:00");
    assert.equal(r.event.eventSource, "WEB");
    assert.deepEqual(r.event.userData.userIdentifiers, [{ emailAddress: CONV.hashedEmail }]);
    assert.equal(r.event.adIdentifiers, undefined);
  });

  it("gclid vira adIdentifiers, JUNTO com userData (nunca substitui)", () => {
    const r = buildDataManagerEvent({ ...CONV, gclid: "Cj0KABC" });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.event.adIdentifiers, { gclid: "Cj0KABC" });
    assert.ok(r.event.userData.userIdentifiers.length > 0);
  });

  it("sem orderId: erro (transactionId é obrigatório para Data Manager)", () => {
    const r = buildDataManagerEvent({ ...CONV, orderId: undefined });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /orderId/);
  });

  it("conversionDateTime em formato inesperado: erro", () => {
    const r = buildDataManagerEvent({ ...CONV, conversionDateTime: "lixo" });
    assert.equal(r.ok, false);
  });
});

describe("#8555 — buildDataManagerIngestPayload", () => {
  it("monta destinations com a conta anunciante, SEM loginAccount", () => {
    const r = buildDataManagerEvent(CONV);
    assert.ok(r.ok);
    if (!r.ok) return;
    const payload = buildDataManagerIngestPayload([r.event], {
      customerId: "236-921-9639",
      productDestinationId: "7762768203",
      validateOnly: true,
    });
    assert.deepEqual(payload.destinations, [
      { operatingAccount: { accountType: "GOOGLE_ADS", accountId: "2369219639" }, productDestinationId: "7762768203" },
    ]);
    assert.equal(payload.encoding, "HEX");
    assert.equal(payload.validateOnly, true);
    assert.equal(payload.events.length, 1);
    assert.ok(!("loginAccount" in payload.destinations[0]));
  });

  it("#8555 (fleet review item 2) — hash de e-mail pinado contra vetor conhecido, dentro do payload HEX", () => {
    // Vetor fixo: normalização é trim + lowercase (hashEmailForEnhancedConversions),
    // hash SHA-256 hex calculado independentemente (node:crypto, fora deste módulo) e
    // colado aqui como constante — se a normalização OU o algoritmo de hash mudarem
    // sem intenção, este teste pega a divergência.
    const rawEmail = "Leitor.Teste+tag@Example.COM ";
    const KNOWN_SHA256_HEX = "687785ff3f40aea56ac49bbc4f593b131d50dd9e7a99e5f90064bdc4bc8471f0";
    assert.equal(hashEmailForEnhancedConversions(rawEmail), KNOWN_SHA256_HEX);
    assert.equal(KNOWN_SHA256_HEX.length, 64);

    const conv: ValidatedConversion = { ...CONV, email: rawEmail, hashedEmail: hashEmailForEnhancedConversions(rawEmail) };
    const built = buildDataManagerEvent(conv);
    assert.ok(built.ok);
    if (!built.ok) return;
    const payload = buildDataManagerIngestPayload([built.event], {
      customerId: "2369219639",
      productDestinationId: "7762768203",
      validateOnly: true,
    });
    assert.equal(payload.encoding, "HEX");
    assert.equal(payload.events[0].userData.userIdentifiers[0].emailAddress, KNOWN_SHA256_HEX);
  });
});

describe("#8555 — chunkDataManagerEvents", () => {
  const ev = (id: number): DataManagerEvent => ({
    transactionId: `t${id}`,
    eventTimestamp: "2026-09-24T12:00:00-03:00",
    eventSource: "WEB",
    userData: { userIdentifiers: [{ emailAddress: "hash" }] },
  });

  it("corta em lotes do tamanho pedido; último lote pode ser menor", () => {
    const events = [1, 2, 3, 4, 5].map(ev);
    const chunks = chunkDataManagerEvents(events, 2);
    assert.deepEqual(chunks.map((c) => c.length), [2, 2, 1]);
    assert.deepEqual(chunks.flat(), events);
  });

  it("default é DATA_MANAGER_MAX_EVENTS_PER_REQUEST (2000) — 1 lote pra volumes pequenos", () => {
    const events = [1, 2, 3].map(ev);
    assert.equal(DATA_MANAGER_MAX_EVENTS_PER_REQUEST, 2000);
    assert.equal(chunkDataManagerEvents(events).length, 1);
  });

  it("array vazio -> 0 chunks; size <= 0 lança", () => {
    assert.deepEqual(chunkDataManagerEvents([]), []);
    assert.throws(() => chunkDataManagerEvents([ev(1)], 0));
    assert.throws(() => chunkDataManagerEvents([ev(1)], -1));
  });
});

describe("#8555 — authConfigFromEnv", () => {
  it("lista as variáveis ausentes — nunca exige developer token/login customer id", () => {
    const r = authConfigFromEnv({ GOOGLE_ADS_CLIENT_ID: "a" });
    assert.ok("missing" in r);
    if (!("missing" in r)) return;
    assert.deepEqual(r.missing, ["GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"]);
  });

  it("completo: devolve auth", () => {
    const r = authConfigFromEnv({ GOOGLE_ADS_CLIENT_ID: "a", GOOGLE_ADS_CLIENT_SECRET: "b", GOOGLE_ADS_REFRESH_TOKEN: "c" });
    assert.ok("auth" in r);
  });
});

describe("#8555 — sendDataManagerIngest", () => {
  const payload = buildDataManagerIngestPayload([], { customerId: "1", productDestinationId: "2", validateOnly: true });

  it("sem env: stage 'env', não chama fetch", async () => {
    const fetchFn = mock.fn(async () => {
      throw new Error("fetch NÃO deveria ser chamado");
    });
    const r = await sendDataManagerIngest({ fetchFn: fetchFn as unknown as typeof fetch, env: {}, payload });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, "env");
    assert.equal(fetchFn.mock.callCount(), 0);
  });

  const ENV = { GOOGLE_ADS_CLIENT_ID: "id", GOOGLE_ADS_CLIENT_SECRET: "secret", GOOGLE_ADS_REFRESH_TOKEN: "refresh" };

  it("falha ao renovar token: stage 'token', nunca chega a events:ingest", async () => {
    const fetchFn = mock.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const r = await sendDataManagerIngest({ fetchFn: fetchFn as unknown as typeof fetch, env: ENV, payload });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, "token");
    assert.equal(fetchFn.mock.callCount(), 1); // só o token endpoint
  });

  it("2xx com requestId: ok, requestId propagado", async () => {
    const fetchFn = mock.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ requestId: "req-abc" }), { status: 200 });
    });
    const r = await sendDataManagerIngest({ fetchFn: fetchFn as unknown as typeof fetch, env: ENV, payload });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.requestId, "req-abc");
  });

  it("segunda chamada usa authorization Bearer + content-type, SEM developer-token", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = mock.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      calls.push(init!);
      return new Response(JSON.stringify({ requestId: "req-1" }), { status: 200 });
    });
    await sendDataManagerIngest({ fetchFn: fetchFn as unknown as typeof fetch, env: ENV, payload });
    const headers = calls[0].headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer tok");
    assert.equal(headers["content-type"], "application/json");
    assert.ok(!("developer-token" in headers));
    assert.ok(!("login-customer-id" in headers));
  });

  it("2xx SEM requestId: tratado como falha (não dá pra rastrear diagnóstico depois)", async () => {
    const fetchFn = mock.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const r = await sendDataManagerIngest({ fetchFn: fetchFn as unknown as typeof fetch, env: ENV, payload });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, "ingest");
  });

  it("HTTP não-2xx (ex: CUSTOMER_NOT_ALLOWLISTED em UploadClickConversions não se aplica aqui, mas 400 genérico): stage 'ingest'", async () => {
    const fetchFn = mock.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "REQUIRED_FIELD_MISSING" } }), { status: 400 });
    });
    const r = await sendDataManagerIngest({ fetchFn: fetchFn as unknown as typeof fetch, env: ENV, payload });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, "ingest");
    assert.match(r.error, /400/);
  });

  it("corpo não-JSON: stage 'ingest', nunca lança", async () => {
    const fetchFn = mock.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response("<html>não é json</html>", { status: 200 });
    });
    const r = await sendDataManagerIngest({ fetchFn: fetchFn as unknown as typeof fetch, env: ENV, payload });
    assert.equal(r.ok, false);
  });

  it("falha de rede: stage 'ingest', nunca lança", async () => {
    const fetchFn = mock.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      throw new Error("ECONNRESET");
    });
    const r = await sendDataManagerIngest({ fetchFn: fetchFn as unknown as typeof fetch, env: ENV, payload });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, "ingest");
    assert.match(r.error, /ECONNRESET/);
  });

  it("URL do endpoint é exatamente a verificada ao vivo", () => {
    assert.equal(DATA_MANAGER_INGEST_URL, "https://datamanager.googleapis.com/v1/events:ingest");
  });
});
