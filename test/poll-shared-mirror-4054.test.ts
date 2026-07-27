/**
 * test/poll-shared-mirror-4054.test.ts (#4054, regressão #633)
 *
 * `workers/poll/src/session-cookie.ts`, `subscriber-verify.ts` e
 * `rate-limit.ts` são CÓPIAS locais de `scripts/lib/shared/*` — o bundle do
 * Worker `poll` não alcança `scripts/**` (mesmo motivo/mecanismo já em
 * produção pra `utm-registry.ts`/`ds-tokens.generated.ts`, ver
 * `test/utm-registry-4041.test.ts`). Este teste trava a divergência
 * comportamental entre o espelho e a fonte — editar um lado sem o outro
 * quebra o CI.
 *
 * Comparação por COMPORTAMENTO (as funções são assíncronas/usam crypto, então
 * `assert.deepEqual` de referência de função não faz sentido) — chama as duas
 * implementações com a mesma entrada e compara a saída.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as sharedCookie from "../scripts/lib/shared/session-cookie.ts";
import * as mirrorCookie from "../workers/poll/src/session-cookie.ts";
import * as sharedSubscriber from "../scripts/lib/shared/subscriber-verify.ts";
import * as mirrorSubscriber from "../workers/poll/src/subscriber-verify.ts";
import * as sharedRateLimit from "../scripts/lib/shared/rate-limit.ts";
import * as mirrorRateLimit from "../workers/poll/src/rate-limit.ts";

describe("#4054 — espelho de session-cookie.ts não pode driftar", () => {
  it("assina e verifica idêntico (mesmo secret/email/ttl/now fixo)", async () => {
    const now = () => 1_700_000_000_000;
    const sharedValue = await sharedCookie.signSessionCookie("s3cr3t", "leitor@example.com", 3600, now);
    const mirrorValue = await mirrorCookie.signSessionCookie("s3cr3t", "leitor@example.com", 3600, now);
    assert.equal(mirrorValue, sharedValue, "o valor assinado deve ser byte-idêntico entre shared/ e o espelho");

    const sharedResult = await sharedCookie.verifySessionCookie("s3cr3t", sharedValue, now);
    const mirrorResult = await mirrorCookie.verifySessionCookie("s3cr3t", mirrorValue, now);
    assert.deepEqual(mirrorResult, sharedResult);
  });

  it("Set-Cookie / Clear-Cookie / parse — mesma saída pros dois lados", () => {
    assert.equal(
      mirrorCookie.buildSetCookieHeader("x", "v", 100),
      sharedCookie.buildSetCookieHeader("x", "v", 100),
    );
    assert.equal(mirrorCookie.buildClearCookieHeader("x"), sharedCookie.buildClearCookieHeader("x"));
    assert.equal(
      mirrorCookie.parseCookieHeader("x=1; y=2", "y"),
      sharedCookie.parseCookieHeader("x=1; y=2", "y"),
    );
  });

  it("assinatura cross-implementação: cookie assinado pelo shared é verificável pelo espelho e vice-versa", async () => {
    const now = () => 1_700_000_000_000;
    const bySh = await sharedCookie.signSessionCookie("cross", "a@b.com", 60, now);
    const byMi = await mirrorCookie.signSessionCookie("cross", "a@b.com", 60, now);
    assert.deepEqual(await mirrorCookie.verifySessionCookie("cross", bySh, now), { ok: true, email: "a@b.com" });
    assert.deepEqual(await sharedCookie.verifySessionCookie("cross", byMi, now), { ok: true, email: "a@b.com" });
  });
});

describe("#4054 — espelho de subscriber-verify.ts não pode driftar", () => {
  it("sha256Hex / subscriberKvKey — mesmo digest hex pros dois lados", async () => {
    assert.equal(await mirrorSubscriber.sha256Hex("Leitor@Example.com"), await sharedSubscriber.sha256Hex("Leitor@Example.com"));
    assert.equal(
      await mirrorSubscriber.subscriberKvKey("leitor@example.com"),
      await sharedSubscriber.subscriberKvKey("leitor@example.com"),
    );
  });

  it("verifySubscriberViaKv — mesmo resultado pra chave presente/ausente", async () => {
    const key = await sharedSubscriber.subscriberKvKey("ativo@example.com");
    const kv = {
      async get(k: string) {
        return k === key ? "1" : null;
      },
    } as unknown as KVNamespace;
    assert.equal(
      await mirrorSubscriber.verifySubscriberViaKv(kv, "ativo@example.com"),
      await sharedSubscriber.verifySubscriberViaKv(kv, "ativo@example.com"),
    );
    assert.equal(
      await mirrorSubscriber.verifySubscriberViaKv(kv, "ninguem@example.com"),
      await sharedSubscriber.verifySubscriberViaKv(kv, "ninguem@example.com"),
    );
  });

  it("verifySubscriberViaBeehiivByEmail — mesmo resultado pros 3 estados (active/inactive/unknown) e pra erro de rede", async () => {
    const mkFetch = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

    for (const [status, body] of [
      [200, { data: { status: "active" } }],
      [200, { data: { status: "cancelled" } }],
      [404, {}],
    ] as const) {
      const sharedRes = await sharedSubscriber.verifySubscriberViaBeehiivByEmail("k", "p", "x@example.com", {
        fetchImpl: mkFetch(status, body),
      });
      const mirrorRes = await mirrorSubscriber.verifySubscriberViaBeehiivByEmail("k", "p", "x@example.com", {
        fetchImpl: mkFetch(status, body),
      });
      assert.equal(mirrorRes, sharedRes);
    }

    const failFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    assert.equal(
      await mirrorSubscriber.verifySubscriberViaBeehiivByEmail("k", "p", "x@example.com", { fetchImpl: failFetch }),
      await sharedSubscriber.verifySubscriberViaBeehiivByEmail("k", "p", "x@example.com", { fetchImpl: failFetch }),
    );
  });
});

describe("#4054 — espelho de rate-limit.ts não pode driftar", () => {
  function makeMapKV() {
    const m = new Map<string, string>();
    return {
      async get(k: string) {
        return m.get(k) ?? null;
      },
      async put(k: string, v: string) {
        m.set(k, v);
      },
    } as unknown as KVNamespace;
  }

  it("checkKvRateLimit — mesma sequência allowed/count pros dois lados, janelas independentes", async () => {
    const kvShared = makeMapKV();
    const kvMirror = makeMapKV();
    for (let i = 0; i < 5; i++) {
      const rShared = await sharedRateLimit.checkKvRateLimit(kvShared, "k", 3, 60);
      const rMirror = await mirrorRateLimit.checkKvRateLimit(kvMirror, "k", 3, 60);
      assert.deepEqual(rMirror, rShared, `iteração ${i}`);
    }
  });

  it("clientIpFromRequest — mesmo resultado (CF-Connecting-IP, fallback X-Forwarded-For, ausente)", () => {
    const withCf = new Request("https://x.test", { headers: { "CF-Connecting-IP": "1.2.3.4" } });
    assert.equal(mirrorRateLimit.clientIpFromRequest(withCf), sharedRateLimit.clientIpFromRequest(withCf));

    const withXff = new Request("https://x.test", { headers: { "X-Forwarded-For": "5.6.7.8" } });
    assert.equal(mirrorRateLimit.clientIpFromRequest(withXff), sharedRateLimit.clientIpFromRequest(withXff));

    const withNeither = new Request("https://x.test");
    assert.equal(mirrorRateLimit.clientIpFromRequest(withNeither), sharedRateLimit.clientIpFromRequest(withNeither));
  });
});
