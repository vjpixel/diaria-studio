/**
 * test/worker-reachability.test.ts (#2551)
 *
 * Testa os cenários críticos do helper worker-reachability.ts via DI (sem rede real):
 *   1. DNS local filtra (timeout) + DoH resolve + anycast 200 → up=true, local_dns_filtered=true
 *   2. DNS local filtra + DoH resolve + anycast não responde → up=false, local_dns_filtered=true
 *   3. DNS local filtra + DoH também falha → up=false, local_dns_filtered=false
 *   4. DNS local funciona normalmente → up=true, via="direct"
 *   5. DNS local funciona mas HTTP 500 → up=false, via="direct"
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWorkerReachable } from "../scripts/lib/worker-reachability.ts";

const WORKER_URL = "https://poll.diaria.workers.dev/health";

// Helper: simula DNS timeout com isDnsOrConnectError code
function makeDnsError(): Error {
  const err = Object.assign(new Error("getaddrinfo ENOTFOUND poll.diaria.workers.dev"), {
    code: "ENOTFOUND",
  });
  return err;
}

describe("isWorkerReachable (#2551)", () => {
  it("falso-down: DNS local filtra + DoH resolve + anycast 200 → up=true, local_dns_filtered=true", async () => {
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw makeDnsError(); },
      dohResolve: async () => "104.21.39.165",
      anycastFetch: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(result.up, true, "deve reportar up=true");
    assert.equal(result.local_dns_filtered, true, "deve detectar filtro DNS local");
    assert.equal(result.via, "doh_anycast");
    assert.equal(result.status, 200);
  });

  it("down real: DNS local filtra + DoH resolve + anycast recusa conexão → up=false, local_dns_filtered=true", async () => {
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw makeDnsError(); },
      dohResolve: async () => "104.21.39.165",
      anycastFetch: async () => { throw new Error("connect ECONNREFUSED"); },
    });
    assert.equal(result.up, false, "deve reportar up=false");
    assert.equal(result.local_dns_filtered, true, "DNS local filtrou mas anycast também falhou");
    assert.equal(result.via, "doh_anycast");
  });

  it("down real: DNS local filtra + DoH também falha → up=false, local_dns_filtered=false", async () => {
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw makeDnsError(); },
      dohResolve: async () => { throw new Error("DoH timeout"); },
      anycastFetch: async () => ({ ok: true, status: 200 }), // não deve ser chamado
    });
    assert.equal(result.up, false, "deve reportar up=false");
    assert.equal(result.local_dns_filtered, false, "DoH também falhou — não é só filtro local");
    assert.equal(result.via, "doh_anycast");
    assert.ok(result.error?.includes("DoH failed"), `error deve mencionar DoH: ${result.error}`);
  });

  it("DNS local funciona normalmente → up=true, via=direct, sem DoH", async () => {
    let dohCalled = false;
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => ({ ok: true, status: 200 }),
      dohResolve: async () => { dohCalled = true; return "104.21.39.165"; },
      anycastFetch: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(result.up, true);
    assert.equal(result.local_dns_filtered, false);
    assert.equal(result.via, "direct");
    assert.equal(dohCalled, false, "DoH não deve ser chamado quando DNS local funciona");
  });

  it("DNS local funciona mas HTTP 500 → up=false, via=direct", async () => {
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => ({ ok: false, status: 500 }),
      dohResolve: async () => { throw new Error("não deveria ser chamado"); },
      anycastFetch: async () => { throw new Error("não deveria ser chamado"); },
    });
    assert.equal(result.up, false);
    assert.equal(result.via, "direct");
    assert.equal(result.status, 500);
  });

  it("erro não-DNS (ex: TLS) → up=false, local_dns_filtered=false, sem tentar DoH", async () => {
    let dohCalled = false;
    const tlsErr = new Error("DEPTH_ZERO_SELF_SIGNED_CERT");
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw tlsErr; },
      dohResolve: async () => { dohCalled = true; return "104.21.39.165"; },
      anycastFetch: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(result.up, false);
    assert.equal(result.local_dns_filtered, false);
    assert.equal(result.via, "none");
    assert.equal(dohCalled, false, "DoH não deve ser tentado para erros não-DNS");
  });
});
