/**
 * test/subscribe-backend-single-entrypoint-6291.test.ts (#6291)
 *
 * Substitui `test/subscribe-backend-branching-guard-6048.test.ts` (removido
 * junto com este PR) — aquele guard era um teste de REGEX que detectava um
 * 6º call site desguardado sem IMPEDI-lo (o próprio docstring dele admitia:
 * "um teste por call site só protege os call sites que já existem").
 *
 * A correção do #6291 é estrutural: `subscribeToBeehiiv`/`subscribeToKit`
 * (workers `poll` e `cursos`) deixaram de ser `export`adas — só
 * `subscribeViaConfiguredBackend` (que ramifica por `SUBSCRIBE_BACKEND`
 * internamente) é exportada. Um 6º call site que tentasse importar as
 * funções cruas direto não compila mais — o erro deixou de ser detectável
 * (por teste) e passou a ser inexprimível (por tipo). `npx tsc --noEmit`
 * limpo nos dois workers (rodado manualmente na revisão desta PR, com
 * `--allowImportingTsExtensions` no caso de `poll`, cujo `tsconfig.json` já
 * carecia dessa flag antes desta mudança — gap pré-existente, fora de
 * escopo) já é a prova primária disso.
 *
 * Este teste cobre o que o compilador NÃO prova sozinho — a superfície de
 * exports em runtime (sanity que a "promoção" de export não regride) e o
 * comportamento do parser tolerante de `SUBSCRIBE_BACKEND` (item menor 1 da
 * issue, mesma classe de bug do #6048 por outra porta: `"Kit"`/`"kit "`/
 * `"beehiv"` caindo em Beehiiv em silêncio).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

type FetchMock = typeof fetch & { calls: Array<{ url: string; init: RequestInit | undefined }> };
function makeFetchMock(status = 201): FetchMock {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: { id: "sub_1" }, subscriber: { id: 1 } }), { status });
  }) as FetchMock;
  fn.calls = calls;
  return fn;
}

function captureConsoleError(): { logged: string[]; restore: () => void } {
  const logged: string[] = [];
  const original = console.error;
  console.error = (msg: string) => logged.push(msg);
  return { logged, restore: () => (console.error = original) };
}

describe("workers/poll/src/subscribe.ts — função única, backend cru inalcançável (#6291)", () => {
  it("NÃO exporta subscribeToBeehiiv/subscribeToKit; exporta subscribeViaConfiguredBackend", async () => {
    const mod = await import("../workers/poll/src/subscribe.ts");
    assert.equal((mod as Record<string, unknown>).subscribeToBeehiiv, undefined);
    assert.equal((mod as Record<string, unknown>).subscribeToKit, undefined);
    assert.equal(typeof mod.subscribeViaConfiguredBackend, "function");
  });

  it("SUBSCRIBE_BACKEND ausente → Beehiiv", async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock(201);
    const env = { BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "p" } as any;
    await subscribeViaConfiguredBackend(env, { name: "", email: "a@b.com" }, fetchMock);
    assert.match(fetchMock.calls[0].url, /beehiiv\.com|publications/);
  });

  it('SUBSCRIBE_BACKEND: "Kit" (capitalização) → Kit, tolerante (item menor 1)', async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock(201);
    const env = { SUBSCRIBE_BACKEND: "Kit", KIT_API_KEY: "kk" } as any;
    await subscribeViaConfiguredBackend(env, { name: "", email: "a@b.com" }, fetchMock);
    assert.equal(fetchMock.calls[0].url, "https://api.kit.com/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: " kit " (espaço) → Kit, tolerante (item menor 1)', async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock(201);
    const env = { SUBSCRIBE_BACKEND: " kit ", KIT_API_KEY: "kk" } as any;
    await subscribeViaConfiguredBackend(env, { name: "", email: "a@b.com" }, fetchMock);
    assert.equal(fetchMock.calls[0].url, "https://api.kit.com/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: "beehiv" (typo) → cai em Beehiiv, mas LOGA o valor desconhecido (item menor 1)', async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock(201);
    const env = { SUBSCRIBE_BACKEND: "beehiv", BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "p" } as any;
    const { logged, restore } = captureConsoleError();
    try {
      await subscribeViaConfiguredBackend(env, { name: "", email: "a@b.com" }, fetchMock);
    } finally {
      restore();
    }
    assert.match(fetchMock.calls[0].url, /publications/);
    assert.ok(logged.some((l) => l.includes("SUBSCRIBE_BACKEND desconhecido") && l.includes("beehiv")), JSON.stringify(logged));
  });
});

describe("workers/cursos/src/subscribe.ts — função única, backend cru inalcançável (#6291)", () => {
  it("NÃO exporta subscribeToBeehiiv/subscribeToKit; exporta subscribeViaConfiguredBackend", async () => {
    const mod = await import("../workers/cursos/src/subscribe.ts");
    assert.equal((mod as Record<string, unknown>).subscribeToBeehiiv, undefined);
    assert.equal((mod as Record<string, unknown>).subscribeToKit, undefined);
    assert.equal(typeof mod.subscribeViaConfiguredBackend, "function");
  });

  it('SUBSCRIBE_BACKEND: "Kit" (capitalização) → Kit, tolerante (item menor 1)', async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/cursos/src/subscribe.ts");
    const fetchMock = makeFetchMock(201);
    const env = { SUBSCRIBE_BACKEND: "Kit", KIT_API_KEY: "kk" } as any;
    await subscribeViaConfiguredBackend(env, { name: "", email: "a@b.com" }, fetchMock);
    assert.equal(fetchMock.calls[0].url, "https://api.kit.com/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: "beehiv" (typo) → cai em Beehiiv, mas LOGA o valor desconhecido (item menor 1)', async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/cursos/src/subscribe.ts");
    const fetchMock = makeFetchMock(201);
    const env = { SUBSCRIBE_BACKEND: "beehiv", BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "p" } as any;
    const { logged, restore } = captureConsoleError();
    try {
      await subscribeViaConfiguredBackend(env, { name: "", email: "a@b.com" }, fetchMock);
    } finally {
      restore();
    }
    assert.match(fetchMock.calls[0].url, /publications/);
    assert.ok(logged.some((l) => l.includes("SUBSCRIBE_BACKEND desconhecido") && l.includes("beehiv")), JSON.stringify(logged));
  });
});

describe("identify.ts/magic-link.ts logam 'subscribe_error' (não 'beehiiv_error') em falha do Kit (item menor 2)", () => {
  it("SubscribeResult.reason usa 'subscribe_error' — não confunde falha do Kit com falha da Beehiiv nos logs", async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const throwingFetch = (async () => {
      throw new Error("kit down");
    }) as typeof fetch;
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "kk" } as any;
    const { restore } = captureConsoleError();
    let result: Awaited<ReturnType<typeof subscribeViaConfiguredBackend>>;
    try {
      result = await subscribeViaConfiguredBackend(env, { name: "", email: "a@b.com" }, throwingFetch);
    } finally {
      restore();
    }
    assert.equal(result.reason, "subscribe_error");
  });
});
