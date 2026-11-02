/**
 * instagram-comment-scope-11750.test.ts (#11750)
 *
 * No `--schedule` quem publica o 1º comentário do 4º post (USE MELHOR) é o
 * Worker, com o PRÓPRIO secret `INSTAGRAM_ACCESS_TOKEN`. O publish agora
 * pergunta ao Worker (`GET /instagram/comment-scope`) se ESSE token tem
 * `instagram_manage_comments`, em vez de inferir pelo token do `.env` local.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env } from "../src/index.ts";
import { probeInstagramCommentScope } from "../src/dispatch.ts";

function mkEnv(extra: Partial<Env> = {}): Env {
  return {
    LINKEDIN_QUEUE: {} as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "17841422721183309",
    INSTAGRAM_ACCESS_TOKEN: "worker-ig-token",
    ...extra,
  } as Env;
}

type Call = { url: string; method?: string; headers?: Record<string, string> };

function mockPermissions(calls: Call[], respond: () => Response | Promise<Response>): typeof fetch {
  return (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    calls.push({ url: u, method: init?.method, headers: init?.headers as Record<string, string> | undefined });
    return respond();
  }) as typeof fetch;
}

const GRANTED = { data: [{ permission: "instagram_basic", status: "granted" }, { permission: "instagram_manage_comments", status: "granted" }] };
const NOT_GRANTED = { data: [{ permission: "instagram_basic", status: "granted" }, { permission: "instagram_manage_comments", status: "declined" }] };

function req(token?: string): Request {
  return new Request("https://worker.test/instagram/comment-scope", {
    method: "GET",
    headers: token ? { "X-Diaria-Token": token } : {},
  });
}

describe("#11750 Worker: GET /instagram/comment-scope", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sem X-Diaria-Token → 401, sem sondar a Graph API", async () => {
    const calls: Call[] = [];
    globalThis.fetch = mockPermissions(calls, () => new Response(JSON.stringify(GRANTED)));
    const res = await workerDefault.fetch(req(), mkEnv());
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it("token do Worker com instagram_manage_comments → { ok: true, granted: true }, sonda com o token DO WORKER no header", async () => {
    const calls: Call[] = [];
    globalThis.fetch = mockPermissions(calls, () => new Response(JSON.stringify(GRANTED), { status: 200 }));
    const res = await workerDefault.fetch(req("secret-token"), mkEnv());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, granted: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/graph\.facebook\.com\/v25\.0\/me\/permissions$/);
    assert.equal(calls[0].headers?.Authorization, "Bearer worker-ig-token");
    assert.ok(!calls[0].url.includes("worker-ig-token"), "token fora da URL (#7779)");
  });

  it("escopo declinado → granted: false", async () => {
    globalThis.fetch = mockPermissions([], () => new Response(JSON.stringify(NOT_GRANTED), { status: 200 }));
    const res = await workerDefault.fetch(req("secret-token"), mkEnv());
    assert.deepEqual(await res.json(), { ok: true, granted: false });
  });

  it("token expirado / rede caiu / JSON inválido → { ok: false, reason } sem vazar o token", async () => {
    const failures: Array<() => Response> = [
      () => new Response(JSON.stringify({ error: { message: "Error validating access token" } }), { status: 400 }),
      () => {
        throw new Error("rede caiu");
      },
      () => new Response("<html>", { status: 502 }),
    ];
    for (const fail of failures) {
      globalThis.fetch = mockPermissions([], fail);
      const res = await workerDefault.fetch(req("secret-token"), mkEnv());
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; reason?: string };
      assert.equal(body.ok, false);
      assert.ok(body.reason && !body.reason.includes("worker-ig-token"), body.reason);
    }
  });

  it("creds do Instagram ausentes no Worker → { ok: false } sem chamar a Graph API", async () => {
    const calls: Call[] = [];
    globalThis.fetch = mockPermissions(calls, () => new Response(JSON.stringify(GRANTED)));
    const res = await workerDefault.fetch(req("secret-token"), mkEnv({ INSTAGRAM_ACCESS_TOKEN: undefined }));
    const body = (await res.json()) as { ok: boolean; reason?: string };
    assert.equal(body.ok, false);
    assert.match(body.reason ?? "", /INSTAGRAM_ACCESS_TOKEN/);
    assert.equal(calls.length, 0);
  });

  it("formato inesperado da Graph API → granted: false (fail-closed)", async () => {
    for (const payload of [{}, { data: "x" }, { data: [{ permission: "instagram_manage_comments" }] }]) {
      globalThis.fetch = mockPermissions([], () => new Response(JSON.stringify(payload), { status: 200 }));
      const r = await probeInstagramCommentScope({ igUserId: "1", accessToken: "t", apiVersion: "v25.0" });
      assert.deepEqual(r, { ok: true, granted: false }, JSON.stringify(payload));
    }
  });

  it("instagram_business_manage_comments também conta", async () => {
    globalThis.fetch = mockPermissions(
      [],
      () => new Response(JSON.stringify({ data: [{ permission: "instagram_business_manage_comments", status: "granted" }] })),
    );
    const r = await probeInstagramCommentScope({ igUserId: "1", accessToken: "t", apiVersion: "v25.0" });
    assert.deepEqual(r, { ok: true, granted: true });
  });
});
