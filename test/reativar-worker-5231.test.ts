/**
 * test/reativar-worker-5231.test.ts (#5231)
 *
 * `activateSubscription` já busca o corpo inteiro da subscription via
 * `GET .../subscriptions/by_email/{email}` antes do DELETE+CREATE (#4488) —
 * este teste cobre que o CREATE passa a carregar a origem lida do GET num
 * `custom_fields`, em vez de deixar o DELETE+CREATE apagá-la em silêncio, e
 * que a ausência dela (fail-soft, item 4 da issue) nunca bloqueia a
 * ativação nem muda o comportamento pré-#5231 (sem `custom_fields` na
 * ausência de origem).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activateSubscription, type Env } from "../workers/reativar/src/index.ts";
import { BREVO_DIARIA_REATIVAR_CLIQUE_UTM } from "../scripts/lib/shared/utm-registry.ts";
import { ORIGEM_ORIGINAL_FIELD_NAME } from "../scripts/lib/shared/beehiiv-origem-original.ts";

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
    return handlers.get ? handlers.get() : jsonRes(404, {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("activateSubscription — preservação de origem original (#5231 item 2/3)", () => {
  it("GET traz utm_source/medium/campaign/referring_site/created → CREATE carrega custom_fields com a origem lida (não a constante)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () =>
        jsonRes(200, {
          data: {
            id: "sub_old",
            status: "pending",
            utm_source: "instagram",
            utm_medium: "social",
            utm_campaign: "bio-link",
            referring_site: "https://instagram.com",
            created: 1690000000,
          },
        }),
      post: () => jsonRes(201, { data: { id: "sub_new", status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key123", BEEHIIV_PUBLICATION_ID: "pub_1" };

    await activateSubscription(env, "a@b.com", fetchImpl);

    const postCall = calls.find((c) => c.method === "POST");
    assert.ok(postCall, "POST deveria ter sido chamado");
    const body = postCall!.body as Record<string, unknown>;

    // O CREATE continua mandando a UTM constante de reativação — este teste
    // é sobre o custom_fields ADICIONAL, não uma substituição.
    assert.equal(body.utm_source, BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source);

    assert.deepEqual(body.custom_fields, [
      {
        name: ORIGEM_ORIGINAL_FIELD_NAME,
        value: JSON.stringify({
          utm_source: "instagram",
          utm_medium: "social",
          utm_campaign: "bio-link",
          referring_site: "https://instagram.com",
          created: 1690000000,
        }),
      },
    ]);
  });

  it("fail-soft: GET sem nenhum campo de origem (só id/status) → CREATE segue igual, SEM custom_fields (comportamento pré-#5231 preservado)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { data: { id: "sub_sem_origem", status: "pending" } }),
      post: () => jsonRes(201, { data: { id: "sub_new", status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key123", BEEHIIV_PUBLICATION_ID: "pub_1" };

    await activateSubscription(env, "a@b.com", fetchImpl);

    const postCall = calls.find((c) => c.method === "POST");
    const body = postCall!.body as Record<string, unknown>;
    assert.ok(!("custom_fields" in body), "sem origem no GET, o CREATE não deve ganhar a chave custom_fields");
  });

  it("fail-soft: GET 404 (nunca existiu) → pula direto pro CREATE, sem custom_fields, ativação não bloqueada", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => new Response(null, { status: 404 }),
      post: () => jsonRes(201, { data: { id: "sub_new", status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key123", BEEHIIV_PUBLICATION_ID: "pub_1" };

    const result = await activateSubscription(env, "a@b.com", fetchImpl);

    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "POST"],
    );
    assert.equal(result.ok, true);
    const postCall = calls.find((c) => c.method === "POST");
    const body = postCall!.body as Record<string, unknown>;
    assert.ok(!("custom_fields" in body));
  });
});
