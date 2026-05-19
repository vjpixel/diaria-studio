/**
 * test/doh-fetch.test.ts (#1365)
 *
 * Cobre logica do helper doh-fetch.ts. Foco em parts puros + isDnsOrConnectError
 * porque o path de rede real depende de Worker + DNS state que não temos em CI.
 *
 * Live path test (dohFetch contra Cloudflare DoH) só roda quando
 * DIARIA_TEST_NETWORK=1 está setado — evita falha de CI offline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDnsOrConnectError, resolveViaDoH } from "../scripts/lib/doh-fetch.ts";

describe("isDnsOrConnectError (#1365)", () => {
  it("detecta ENOTFOUND direto", () => {
    assert.equal(isDnsOrConnectError({ code: "ENOTFOUND" }), true);
  });

  it("detecta UND_ERR_CONNECT_TIMEOUT via cause (undici)", () => {
    assert.equal(
      isDnsOrConnectError({
        message: "fetch failed",
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
      }),
      true,
    );
  });

  it("detecta ETIMEDOUT direto", () => {
    assert.equal(isDnsOrConnectError({ code: "ETIMEDOUT" }), true);
  });

  it("rejeita ENOENT (file system error, não rede)", () => {
    assert.equal(isDnsOrConnectError({ code: "ENOENT" }), false);
  });

  it("rejeita Error sem code", () => {
    assert.equal(isDnsOrConnectError(new Error("random")), false);
  });

  it("rejeita null/undefined", () => {
    assert.equal(isDnsOrConnectError(null), false);
    assert.equal(isDnsOrConnectError(undefined), false);
  });

  it("rejeita string", () => {
    assert.equal(isDnsOrConnectError("ENOTFOUND"), false);
  });
});

describe("resolveViaDoH (#1365) — live network", { skip: process.env.DIARIA_TEST_NETWORK !== "1" }, () => {
  it("resolve poll.diaria.workers.dev pra IP valido", async () => {
    const ip = await resolveViaDoH("poll.diaria.workers.dev");
    // Cloudflare workers IPs: ranges 104.x.x.x e 172.67.x.x sao comuns
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  });

  it("cacheia resoluções (2a chamada não refaz fetch)", async () => {
    const start = Date.now();
    await resolveViaDoH("poll.diaria.workers.dev");
    const elapsed1 = Date.now() - start;
    const start2 = Date.now();
    await resolveViaDoH("poll.diaria.workers.dev");
    const elapsed2 = Date.now() - start2;
    // Cache deve responder <5ms; primeira chamada >50ms (network)
    assert.ok(elapsed2 < elapsed1, `Esperava cache hit faster, 1a=${elapsed1}ms 2a=${elapsed2}ms`);
  });
});
