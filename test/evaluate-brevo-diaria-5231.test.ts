/**
 * test/evaluate-brevo-diaria-5231.test.ts (#5231)
 *
 * `promoteBeehiivSubscription` já busca o corpo inteiro da subscription via
 * `GET .../subscriptions/by_email/{email}` antes do DELETE+CREATE (#4488) —
 * este teste cobre que o CREATE passa a carregar a origem lida do GET num
 * `custom_fields`, em vez de deixar o DELETE+CREATE apagá-la em silêncio, e
 * que a ausência dela (fail-soft, item 4 da issue) nunca bloqueia a
 * promoção nem muda o comportamento pré-#5231 (sem `custom_fields` na
 * ausência de origem).
 *
 * Achado crítico do review dedicado (14/08/2026): o gate `BEEHIIV_ORIGEM_ORIGINAL_FIELD`
 * (env var opcional, ver docstring de `beehiiv-origem-original.ts`) precisa
 * estar ON pra estes testes originais continuarem válidos — o describe
 * "gate OFF" abaixo cobre o estado padrão (env var ausente), que é o estado
 * real de produção até o editor criar o custom field na Beehiiv (#5231
 * item 1) e ligar o gate.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promoteBeehiivSubscription } from "../scripts/evaluate-brevo-diaria.ts";
import { BREVO_DIARIA_PROMOCAO_SCORE_UTM } from "../scripts/lib/shared/utm-registry.ts";
import { ORIGEM_ORIGINAL_FIELD_NAME } from "../scripts/lib/shared/beehiiv-origem-original.ts";

const ENV_KEY = "BEEHIIV_ORIGEM_ORIGINAL_FIELD";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routedFetch(handlers: {
  get?: () => Response | Promise<Response>;
  del?: () => Response | Promise<Response>;
  post?: (body: unknown) => Response | Promise<Response>;
}): { fetchImpl: typeof fetch; calls: { method: string; url: string; body?: unknown }[] } {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: String(url), body });
    if (method === "DELETE") return handlers.del ? handlers.del() : new Response(null, { status: 204 });
    if (method === "POST") return handlers.post ? handlers.post(body) : jsonRes(200, {});
    return handlers.get ? handlers.get() : new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("promoteBeehiivSubscription — preservação de origem original (#5231 item 2/3), gate ON", () => {
  const original = process.env[ENV_KEY];
  beforeEach(() => {
    process.env[ENV_KEY] = ORIGEM_ORIGINAL_FIELD_NAME;
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("GET traz utm_source/medium/campaign/referring_site/created → CREATE carrega custom_fields com a origem lida (não a constante)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () =>
        jsonRes(200, {
          data: {
            id: "sub_atual",
            status: "pending",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "brand-2026",
            referring_site: "https://google.com",
            created: 1700000000,
          },
        }),
      post: () => jsonRes(200, {}),
    });

    await promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);

    const postCall = calls.find((c) => c.method === "POST");
    assert.ok(postCall, "POST deveria ter sido chamado");
    const body = postCall!.body as Record<string, unknown>;

    // O CREATE continua mandando a UTM constante de reativação — este teste
    // é sobre o custom_fields ADICIONAL, não uma substituição.
    assert.equal(body.utm_source, BREVO_DIARIA_PROMOCAO_SCORE_UTM.source);

    assert.deepEqual(body.custom_fields, [
      {
        name: ORIGEM_ORIGINAL_FIELD_NAME,
        value: JSON.stringify({
          utm_source: "google",
          utm_medium: "cpc",
          utm_campaign: "brand-2026",
          referring_site: "https://google.com",
          created: 1700000000,
        }),
      },
    ]);
  });

  it("fail-soft: GET sem nenhum campo de origem (só id/status) → CREATE segue igual, SEM custom_fields (comportamento pré-#5231 preservado)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { data: { id: "sub_sem_origem", status: "pending" } }),
      post: () => jsonRes(200, {}),
    });

    await promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);

    const postCall = calls.find((c) => c.method === "POST");
    const body = postCall!.body as Record<string, unknown>;
    assert.ok(!("custom_fields" in body), "sem origem no GET, o CREATE não deve ganhar a chave custom_fields");
  });

  it("fail-soft: GET 404 (nunca existiu) → pula direto pro CREATE, sem custom_fields, promoção não bloqueada", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => new Response(null, { status: 404 }),
      post: () => jsonRes(200, {}),
    });

    await promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);

    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
    const postCall = calls.find((c) => c.method === "POST");
    const body = postCall!.body as Record<string, unknown>;
    assert.ok(!("custom_fields" in body));
  });
});

describe("promoteBeehiivSubscription — gate OFF (#5231 fixer, achado do review dedicado)", () => {
  const original = process.env[ENV_KEY];
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("BEEHIIV_ORIGEM_ORIGINAL_FIELD ausente (estado padrão de produção) → CREATE NUNCA carrega custom_fields, mesmo com origem completa no GET", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () =>
        jsonRes(200, {
          data: {
            id: "sub_atual",
            status: "pending",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "brand-2026",
            referring_site: "https://google.com",
            created: 1700000000,
          },
        }),
      post: () => jsonRes(200, {}),
    });

    await promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);

    const postCall = calls.find((c) => c.method === "POST");
    assert.ok(postCall, "POST deveria ter sido chamado");
    const body = postCall!.body as Record<string, unknown>;
    assert.ok(!("custom_fields" in body), "gate OFF: custom_fields nunca deve aparecer, independente da origem lida no GET");
    // A promoção segue normalmente — o gate desligado nunca bloqueia.
    assert.equal(body.utm_source, BREVO_DIARIA_PROMOCAO_SCORE_UTM.source);
  });
});
