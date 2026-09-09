/**
 * test/meta-capi-log-wiring-7776.test.ts (#7776, follow-up do #5504)
 *
 * Cobre a integração de `logMetaCapiSendResult` nos 3 call sites reais —
 * `workers/poll/src/subscribe.ts` (`handleJogarSubscribe`),
 * `workers/cursos/src/subscribe.ts` (`handleGateSubscribe`),
 * `workers/reativar/src/index.ts` (`handleConfirm`). Antes desta issue, os
 * 3 descartavam o `MetaCapiSendResult` em silêncio (`ctx.waitUntil(sendEvent)`/
 * `await sendEvent` sem ler o valor) — "não configurado" (esperado até o
 * secret ser setado) e "configurado mas falhou" (defeito real) eram
 * indistinguíveis de fora, porque nenhum dos dois deixava rastro.
 *
 * `console.log`/`console.error` são capturados (nunca chamados de verdade
 * fora do teste) — nenhuma chamada de rede real acontece: `fetchImpl`
 * sempre injetado, roteando por URL (mesmo padrão de
 * `test/meta-capi-wiring-5504.test.ts`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleJogarSubscribe, type SubscribeDeps as PollSubscribeDeps } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";
import { handleConfirm, type Env as ReativarEnv } from "../workers/reativar/src/index.ts";

/** Captura `console.log`/`console.error` durante `fn()`, restaurando
 * sempre (mesmo em exceção) — evita ruído real no output do test runner e
 * evita vazar o mock entre testes. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: unknown[][]; errors: unknown[][] }> {
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args);
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** Roteia por URL — Beehiiv responde sucesso fixo; Graph API da Meta
 * (graph.facebook.com) responde conforme `metaBehavior`. */
function routedFetch(metaBehavior: "ok" | "http_error" | "network_error") {
  const fn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) {
      if (metaBehavior === "network_error") throw new Error("meta network down");
      if (metaBehavior === "http_error") return new Response(JSON.stringify({ error: "bad" }), { status: 401 });
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { id: "sub_1", status: "active" } }), { status: 201 });
  }) as typeof fetch;
  return fn;
}

function findLogEvent(entries: unknown[][], eventName: string): Record<string, unknown> | undefined {
  for (const args of entries) {
    if (typeof args[0] !== "string") continue;
    try {
      const parsed = JSON.parse(args[0]);
      if (parsed?.event === eventName) return parsed;
    } catch {
      // linha que não é o JSON estruturado do meta-capi — ignora
    }
  }
  return undefined;
}

describe("#7776 — workers/poll: log estruturado do envio CAPI", () => {
  function env(over: Partial<PollEnv> = {}): PollEnv {
    return {
      POLL: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, cursor: undefined }) } as unknown as PollEnv["POLL"],
      POLL_SECRET: "s",
      ADMIN_SECRET: "s",
      ALLOWED_ORIGINS: "*",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      ...over,
    } as PollEnv;
  }
  function req(): Request {
    return new Request("https://eia.diar.ia.br/jogar/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
      body: JSON.stringify({ name: "Ana", email: "ana@example.com", optin: true, website: "" }),
    });
  }

  it("sem META_CAPI_ACCESS_TOKEN → loga meta_capi_not_configured worker:poll", async () => {
    const { logs } = await captureConsole(() =>
      handleJogarSubscribe(req(), env(), { fetchImpl: routedFetch("ok") } as PollSubscribeDeps),
    );
    const ev = findLogEvent(logs, "meta_capi_not_configured");
    assert.ok(ev, "esperava meta_capi_not_configured no console.log");
    assert.equal(ev!.worker, "poll");
    assert.ok(!JSON.stringify(logs).includes("ana@example.com"), "log nunca contém o e-mail");
  });

  it("token presente, Meta aceita → loga meta_capi_sent worker:poll", async () => {
    const { logs } = await captureConsole(() =>
      handleJogarSubscribe(req(), env({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: routedFetch("ok") } as PollSubscribeDeps),
    );
    const ev = findLogEvent(logs, "meta_capi_sent");
    assert.ok(ev, "esperava meta_capi_sent no console.log");
    assert.equal(ev!.worker, "poll");
  });

  it("token presente, Meta rejeita (401) → loga meta_capi_send_failed via console.error, reason:meta_error", async () => {
    const { errors } = await captureConsole(() =>
      handleJogarSubscribe(req(), env({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: routedFetch("http_error") } as PollSubscribeDeps),
    );
    const ev = findLogEvent(errors, "meta_capi_send_failed");
    assert.ok(ev, "esperava meta_capi_send_failed no console.error");
    assert.equal(ev!.worker, "poll");
    assert.equal(ev!.reason, "meta_error");
  });

  it("token presente, rede da Meta cai → loga meta_capi_send_failed reason:network_error", async () => {
    const { errors } = await captureConsole(() =>
      handleJogarSubscribe(req(), env({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: routedFetch("network_error") } as PollSubscribeDeps),
    );
    const ev = findLogEvent(errors, "meta_capi_send_failed");
    assert.equal(ev?.reason, "network_error");
  });
});

describe("#7776 — workers/cursos: log estruturado do envio CAPI", () => {
  function env(over: Partial<CursosEnv> = {}): CursosEnv {
    return {
      ASSETS: {} as CursosEnv["ASSETS"],
      CURSOS_SUBSCRIBERS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, cursor: undefined }) } as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
      COOKIE_HMAC_SECRET: "cookie-secret",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      ...over,
    } as CursosEnv;
  }
  function req(): Request {
    return new Request("https://cursos.diar.ia.br/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ana", email: "ana@example.com", optin: true, website: "" }),
    });
  }

  it("sem token → loga meta_capi_not_configured worker:cursos", async () => {
    const { logs } = await captureConsole(() => handleGateSubscribe(req(), env(), { fetchImpl: routedFetch("ok") }));
    const ev = findLogEvent(logs, "meta_capi_not_configured");
    assert.equal(ev?.worker, "cursos");
  });

  it("token presente, sucesso → loga meta_capi_sent worker:cursos", async () => {
    const { logs } = await captureConsole(() =>
      handleGateSubscribe(req(), env({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: routedFetch("ok") }),
    );
    const ev = findLogEvent(logs, "meta_capi_sent");
    assert.equal(ev?.worker, "cursos");
  });
});

describe("#7776 — workers/reativar: log estruturado do envio CAPI", () => {
  function env(over: Partial<ReativarEnv> = {}): ReativarEnv {
    return {
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      ...over,
    } as ReativarEnv;
  }
  function url(): URL {
    return new URL("https://reativar.diar.ia.br/confirmar?email=ana%40example.com");
  }

  /** GET/POST distintos (mesmo padrão de `reativarFetch` em
   * `test/meta-capi-wiring-5504.test.ts`) — `handleConfirm` faz GET (não
   * encontra) + POST (cria já `active`) na Beehiiv antes de sequer
   * considerar a CAPI. */
  function reativarFetch(metaBehavior: "ok" | "http_error" | "network_error") {
    return (async (u: string | URL, init?: RequestInit) => {
      const s = String(u);
      if (s.includes("graph.facebook.com")) {
        if (metaBehavior === "network_error") throw new Error("meta network down");
        if (metaBehavior === "http_error") return new Response(JSON.stringify({ error: "bad" }), { status: 401 });
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 404 });
      if (method === "POST") return new Response(JSON.stringify({ data: { id: "s1", status: "active" } }), { status: 201 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  }

  it("sem token → loga meta_capi_not_configured worker:reativar", async () => {
    const { logs } = await captureConsole(() => handleConfirm(url(), env(), reativarFetch("ok")));
    const ev = findLogEvent(logs, "meta_capi_not_configured");
    assert.equal(ev?.worker, "reativar");
  });

  it("token presente, sucesso → loga meta_capi_sent worker:reativar", async () => {
    const { logs } = await captureConsole(() => handleConfirm(url(), env({ META_CAPI_ACCESS_TOKEN: "tok" }), reativarFetch("ok")));
    const ev = findLogEvent(logs, "meta_capi_sent");
    assert.equal(ev?.worker, "reativar");
  });

  it("token presente, Meta rejeita → loga meta_capi_send_failed via console.error", async () => {
    const { errors } = await captureConsole(() =>
      handleConfirm(url(), env({ META_CAPI_ACCESS_TOKEN: "tok" }), reativarFetch("http_error")),
    );
    const ev = findLogEvent(errors, "meta_capi_send_failed");
    assert.equal(ev?.worker, "reativar");
    assert.equal(ev?.reason, "meta_error");
  });
});
