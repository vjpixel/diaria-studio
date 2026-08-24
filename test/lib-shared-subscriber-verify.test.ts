/**
 * lib-shared-subscriber-verify.test.ts (#4052)
 *
 * Cobre `scripts/lib/shared/subscriber-verify.ts` (verificação KV primária +
 * by_email secundária, endpoint confirmado ao vivo no #4305/#4322) e
 * `scripts/lib/shared/rate-limit.ts`. Os 4
 * estados exigidos pelo briefing: ativo / inativo / inexistente / KV-miss
 * (API indisponível trata igual a "unknown" — fail-soft, nunca lança).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sha256Hex,
  subscriberKvKey,
  verifySubscriberViaBeehiivByEmail,
  verifySubscriberViaKitByEmail,
  verifySubscriberViaKv,
} from "../scripts/lib/shared/subscriber-verify.ts";
import { checkKvRateLimit, clientIpFromRequest } from "../scripts/lib/shared/rate-limit.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
  } as unknown as KVNamespace;
}

describe("subscriber-verify (#4052)", () => {
  it("sha256Hex é determinístico e normaliza case/whitespace", async () => {
    const a = await sha256Hex("Leitor@Example.com");
    const b = await sha256Hex("  leitor@example.com  ");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("subscriberKvKey usa o prefixo subscriber:", async () => {
    const key = await subscriberKvKey("leitor@example.com");
    assert.match(key, /^subscriber:[0-9a-f]{64}$/);
  });

  describe("verifySubscriberViaKv — 4 estados", () => {
    it("ATIVO: chave presente no KV", async () => {
      const email = "ativo@example.com";
      const key = await subscriberKvKey(email);
      const kv = makeMapKV({ [key]: "1" });
      assert.equal(await verifySubscriberViaKv(kv, email), "active");
    });

    it("INEXISTENTE: e-mail nunca sincronizado — chave ausente", async () => {
      const kv = makeMapKV();
      assert.equal(await verifySubscriberViaKv(kv, "nunca-existiu@example.com"), "unknown");
    });

    it("KV-MISS geral (namespace vazio) — trata como unknown, nunca lança", async () => {
      const kv = makeMapKV({});
      assert.equal(await verifySubscriberViaKv(kv, "qualquer@example.com"), "unknown");
    });

    it("case/whitespace do e-mail não afeta o lookup (mesma normalização do sync)", async () => {
      const key = await subscriberKvKey("normalizado@example.com");
      const kv = makeMapKV({ [key]: "1" });
      assert.equal(await verifySubscriberViaKv(kv, "  Normalizado@Example.com  "), "active");
    });
  });

  describe("verifySubscriberViaBeehiivByEmail — secundário (confirmado ao vivo #4305), fail-soft", () => {
    it("INATIVO: API responde status inactive", async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ data: { status: "inactive" } }), { status: 200 })) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "inactive");
    });

    it("ATIVO: API responde status active", async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ data: { status: "active" } }), { status: 200 })) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "active");
    });

    it("INEXISTENTE (404): trata como unknown", async () => {
      const fetchImpl = (async () => new Response("{}", { status: 404 })) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "unknown");
    });

    it("API DOWN (fetch lança): fail-soft, nunca propaga a exceção — verification_failed desde #4321 (era unknown)", async () => {
      const fetchImpl = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    it("resposta 500: verification_failed desde #4321 (era unknown)", async () => {
      const fetchImpl = (async () => new Response("err", { status: 500 })) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });
  });

  // #4321: separa "verificado negativo" (404 — a pessoa não existe) de "não
  // conseguimos verificar" (401/403/429/5xx/exceção de rede — a pessoa PODE
  // ser assinante, só não dá pra confirmar). Antes desta issue os 2 casos
  // colapsavam no mesmo "unknown" e nada a jusante conseguia distinguir uma
  // rotação de key não sincronizada de "não é assinante".
  describe("verifySubscriberViaBeehiivByEmail — verification_failed (#4321)", () => {
    it("401 (key rotacionada/inválida): verification_failed, distinto de 404", async () => {
      const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    it("429 (rate-limit da Beehiiv): verification_failed", async () => {
      const fetchImpl = (async () => new Response("too many requests", { status: 429 })) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    it("5xx (Beehiiv fora do ar): verification_failed", async () => {
      const fetchImpl = (async () => new Response("internal error", { status: 503 })) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    // Exceção de rede já coberta acima ("API DOWN (fetch lança)"); mantida lá
    // pra não duplicar. 404 continua "unknown" — resposta legítima, não é
    // falha de verificação:
    it("404 continua unknown — resposta legítima, não é falha de verificação", async () => {
      const fetchImpl = (async () => new Response("{}", { status: 404 })) as typeof fetch;
      const r = await verifySubscriberViaBeehiivByEmail("key", "pub", "x@example.com", { fetchImpl });
      assert.equal(r, "unknown");
    });
  });

  describe("verifySubscriberViaKitByEmail — secundário (#6048, migração Beehiiv → Kit), fail-soft", () => {
    it("ATIVO: subscribers[0].state === active", async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ subscribers: [{ state: "active" }] }), { status: 200 })) as typeof fetch;
      const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
      assert.equal(r, "active");
    });

    it("INATIVO: cada um dos 4 estados não-active mapeia pra inactive (cancelled/bounced/complained/inactive)", async () => {
      for (const state of ["cancelled", "bounced", "complained", "inactive"]) {
        const fetchImpl = (async () =>
          new Response(JSON.stringify({ subscribers: [{ state }] }), { status: 200 })) as typeof fetch;
        const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
        assert.equal(r, "inactive", `state=${state}`);
      }
    });

    it("INEXISTENTE: 200 com subscribers:[] — achado ao vivo #6048, Kit NÃO usa 404 pra 'não encontrado' (diferente da Beehiiv)", async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ subscribers: [] }), { status: 200 })) as typeof fetch;
      const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
      assert.equal(r, "unknown");
    });

    it("API DOWN (fetch lança): verification_failed, nunca propaga a exceção", async () => {
      const fetchImpl = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    it("401 (key rotacionada/inválida): verification_failed", async () => {
      const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
      const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    it("429 (rate-limit do Kit): verification_failed", async () => {
      const fetchImpl = (async () => new Response("too many requests", { status: 429 })) as typeof fetch;
      const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    it("5xx (Kit fora do ar): verification_failed", async () => {
      const fetchImpl = (async () => new Response("internal error", { status: 503 })) as typeof fetch;
      const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    it("resposta 2xx com JSON malformado: verification_failed, não lança", async () => {
      const fetchImpl = (async () => new Response("not json{", { status: 200 })) as typeof fetch;
      const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
      assert.equal(r, "verification_failed");
    });

    it("state ausente/desconhecido no subscriber encontrado: unknown", async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ subscribers: [{}] }), { status: 200 })) as typeof fetch;
      const r = await verifySubscriberViaKitByEmail("key", "x@example.com", { fetchImpl });
      assert.equal(r, "unknown");
    });
  });
});

describe("rate-limit (#4052)", () => {
  it("permite até o limite, bloqueia a partir daí", async () => {
    const kv = makeMapKV();
    for (let i = 0; i < 3; i++) {
      const r = await checkKvRateLimit(kv, "rl:test:1.2.3.4", 3, 3600);
      assert.equal(r.allowed, true);
    }
    const blocked = await checkKvRateLimit(kv, "rl:test:1.2.3.4", 3, 3600);
    assert.equal(blocked.allowed, false);
  });

  it("chave vazia (sem IP) sempre permite", async () => {
    const kv = makeMapKV();
    const r = await checkKvRateLimit(kv, "", 1, 3600);
    assert.equal(r.allowed, true);
  });

  it("clientIpFromRequest lê CF-Connecting-IP com prioridade sobre X-Forwarded-For", () => {
    const req = new Request("https://x.test", {
      headers: { "CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "2.2.2.2" },
    });
    assert.equal(clientIpFromRequest(req), "1.1.1.1");
  });

  it("clientIpFromRequest cai pra X-Forwarded-For sem CF-Connecting-IP", () => {
    const req = new Request("https://x.test", { headers: { "X-Forwarded-For": "2.2.2.2" } });
    assert.equal(clientIpFromRequest(req), "2.2.2.2");
  });

  it("clientIpFromRequest retorna string vazia sem nenhum header", () => {
    const req = new Request("https://x.test");
    assert.equal(clientIpFromRequest(req), "");
  });
});
