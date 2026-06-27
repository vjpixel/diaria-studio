/**
 * test/worker-reachability.test.ts (#2551)
 *
 * Testa os cenários críticos do helper worker-reachability.ts via DI (sem rede real):
 *   1. DNS local filtra (timeout) + DoH resolve + anycast 200 → up=true, local_dns_filtered=true
 *   2. DNS local filtra + DoH resolve + anycast não responde → up=false, local_dns_filtered=true
 *   3. DNS local filtra + DoH também falha → up=false, local_dns_filtered=false
 *   4. DNS local funciona normalmente → up=true, via="direct"
 *   5. DNS local funciona mas HTTP 500 → up=false, via="direct"
 *   6. (#2574) AbortError (timeout do AbortController) → trata como DNS-filter candidate → aciona DoH
 *   7. (#2577) resolvedIp passado ao anycastFetch — DI confirma que o IP resolvido é reusado
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

  // Regressão #2574: AbortError (do AbortController de timeout) deve acionar DoH fallback,
  // não declarar down. DNS filtrado por drop de pacotes UDP/53 (silent hang) chega aqui —
  // é o cenário real que o módulo deveria cobrir mas não cobria antes do fix.
  // #2592: AbortError NÃO deve setar local_dns_filtered=true (seria enganoso quando
  // o servidor está apenas lento). Deve setar abort_timeout=true para label honesto.
  it("#2574/#2592: AbortError (timeout nativo) → aciona DoH → up=true, abort_timeout=true, local_dns_filtered=false", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    let dohCalled = false;
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw abortErr; },
      dohResolve: async () => { dohCalled = true; return "104.21.39.165"; },
      anycastFetch: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(result.up, true, "AbortError de timeout deve acionar DoH e retornar up=true quando anycast responde 200");
    // #2592: local_dns_filtered deve ser false — AbortError pode ser servidor lento,
    // não é evidência suficiente para afirmar filtro DNS.
    assert.equal(result.local_dns_filtered, false, "#2592: local_dns_filtered deve ser false para AbortError (servidor lento ou DNS drop — não sabemos)");
    assert.equal(result.abort_timeout, true, "#2592: abort_timeout deve ser true para sinalizar o caso ambíguo");
    assert.equal(result.via, "doh_anycast");
    assert.equal(dohCalled, true, "DoH deve ser chamado (antes do fix #2574 não era)");
  });

  // Regressão #2574: DOMException com code numérico 20 (variante de AbortError) também
  // deve acionar DoH — cobre o caso de DOMException legado.
  // #2592: mesmo label honesto (abort_timeout=true, local_dns_filtered=false).
  it("#2574/#2592: erro com code numérico 20 (AbortError numérico) → aciona DoH, abort_timeout=true", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError", code: 20 });
    let dohCalled = false;
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw abortErr; },
      dohResolve: async () => { dohCalled = true; return "104.21.39.165"; },
      anycastFetch: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(result.up, true, "AbortError (code 20) deve acionar DoH");
    assert.equal(result.local_dns_filtered, false, "#2592: local_dns_filtered=false para AbortError");
    assert.equal(result.abort_timeout, true, "#2592: abort_timeout=true para AbortError");
    assert.equal(dohCalled, true, "DoH deve ser chamado");
  });

  // #2592: Regressão — hard DNS error (ENOTFOUND) DEVE continuar setando local_dns_filtered=true.
  // O fix de #2592 só muda o label para AbortError, não para erros hard de DNS.
  it("#2592: hard DNS error (ENOTFOUND) → local_dns_filtered=true, abort_timeout=undefined", async () => {
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw makeDnsError(); },
      dohResolve: async () => "104.21.39.165",
      anycastFetch: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(result.up, true);
    assert.equal(result.local_dns_filtered, true, "ENOTFOUND é evidência forte de filtro DNS — deve setar local_dns_filtered=true");
    assert.equal(result.abort_timeout, undefined, "abort_timeout deve ser undefined para hard DNS error");
    assert.equal(result.via, "doh_anycast");
  });

  // #2592: AbortError com anycast também down → up=false, abort_timeout=true, local_dns_filtered=false
  it("#2592: AbortError + anycast down → up=false, abort_timeout=true, local_dns_filtered=false", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw abortErr; },
      dohResolve: async () => "104.21.39.165",
      anycastFetch: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(result.up, false);
    assert.equal(result.local_dns_filtered, false, "#2592: local_dns_filtered=false para AbortError mesmo quando anycast down");
    assert.equal(result.abort_timeout, true, "#2592: abort_timeout=true para AbortError");
  });

  // Regressão #2577: no caminho DoH, o IP resolvido deve ser passado ao anycastFetch.
  // Verifica via DI spy que anycastFetch recebe o IP correto (sem 3ª resolução redundante).
  it("#2577: resolvedIp do DoH é passado ao anycastFetch (sem re-resolução redundante)", async () => {
    const EXPECTED_IP = "104.21.39.165";
    let capturedIp: string | undefined;

    const result = await isWorkerReachable(WORKER_URL, {
      nativeFetch: async () => { throw makeDnsError(); },
      dohResolve: async () => EXPECTED_IP,
      anycastFetch: async (u, ip) => {
        capturedIp = ip;
        return { ok: true, status: 200 };
      },
    });

    assert.equal(result.up, true);
    assert.equal(result.local_dns_filtered, true);
    assert.equal(capturedIp, EXPECTED_IP, `anycastFetch deve receber o IP resolvido pelo DoH (${EXPECTED_IP}), recebeu: ${capturedIp}`);
  });
});
