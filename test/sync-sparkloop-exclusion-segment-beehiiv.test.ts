/**
 * test/sync-sparkloop-exclusion-segment-beehiiv.test.ts (#5095)
 *
 * Testa as funções PURAS de `scripts/sync-sparkloop-exclusion-segment-
 * beehiiv.ts` (identificação de contatos SparkLoop Upscribe via custom field
 * `RH_SOURCE`, montagem do corpo de criação do segmento, checagem de
 * idempotência) e as funções de I/O com `fetchImpl` mockado (paginação de
 * `/subscriptions` e `/segments`, criação via `POST /segments`) — nenhum
 * teste bate na API real da Beehiiv.
 *
 * Caso central da issue (#5095, corpo): burst de 24 cadastros desde 09/08,
 * dos quais 17 (71%) vêm de `RH_SOURCE = "sparkloop-upscribe"` — o teste
 * "regressão do burst" replica essa proporção com uma fixture explícita.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCustomFieldValue,
  isSparkloopUpscribeSource,
  filterSparkloopContacts,
  buildCreateSegmentBody,
  findExistingExclusionSegment,
  fetchActiveSubscriptions,
  fetchExistingSegments,
  createExclusionSegment,
  EXCLUSION_SEGMENT_NAME,
  RH_SOURCE_FIELD_NAME,
  RH_SOURCE_SPARKLOOP_UPSCRIBE_VALUE,
  type BeehiivSubscriptionSnapshot,
} from "../scripts/sync-sparkloop-exclusion-segment-beehiiv.ts";

// ── mock de fetch sequencial (mesmo padrão de test/sync-apoio-nivel-beehiiv.test.ts) ──

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function mockFetchSeq(responses: Array<{ status: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      text: async () => (r.body !== undefined ? JSON.stringify(r.body) : ""),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function sub(email: string, rhSource: string | undefined): { id: string; email: string; status: string; custom_fields: Array<{ name: string; value: unknown }> } {
  return {
    id: `sub-${email}`,
    email,
    status: "active",
    custom_fields: rhSource !== undefined ? [{ name: "RH_SOURCE", value: rhSource }] : [],
  };
}

// ── extractCustomFieldValue ──────────────────────────────────────────────

describe("extractCustomFieldValue", () => {
  it("extrai o valor quando o campo existe", () => {
    assert.equal(extractCustomFieldValue([{ name: "RH_SOURCE", value: "sparkloop-upscribe" }], "RH_SOURCE"), "sparkloop-upscribe");
  });

  it("devolve string vazia quando o campo não existe", () => {
    assert.equal(extractCustomFieldValue([{ name: "outro_campo", value: "x" }], "RH_SOURCE"), "");
  });

  it("devolve string vazia quando custom_fields é undefined/não-array", () => {
    assert.equal(extractCustomFieldValue(undefined, "RH_SOURCE"), "");
    assert.equal(extractCustomFieldValue([], "RH_SOURCE"), "");
  });

  it("devolve string vazia quando o valor não é string (nunca lança)", () => {
    assert.equal(extractCustomFieldValue([{ name: "RH_SOURCE", value: 123 }], "RH_SOURCE"), "");
    assert.equal(extractCustomFieldValue([{ name: "RH_SOURCE", value: null }], "RH_SOURCE"), "");
  });
});

// ── isSparkloopUpscribeSource ────────────────────────────────────────────

describe("isSparkloopUpscribeSource", () => {
  it("casa o valor exato observado no burst (#5095)", () => {
    assert.equal(isSparkloopUpscribeSource("sparkloop-upscribe"), true);
  });

  it("tolerante a espaço e caixa", () => {
    assert.equal(isSparkloopUpscribeSource(" SparkLoop-Upscribe "), true);
    assert.equal(isSparkloopUpscribeSource("SPARKLOOP-UPSCRIBE"), true);
  });

  it("não casa outras origens", () => {
    assert.equal(isSparkloopUpscribeSource(""), false);
    assert.equal(isSparkloopUpscribeSource("beehiiv-boost"), false);
    assert.equal(isSparkloopUpscribeSource("sparkloop-other-product"), false);
  });
});

// ── filterSparkloopContacts (regressão do burst #5095) ───────────────────

describe("filterSparkloopContacts — regressão do burst investigado em #5095", () => {
  it("identifica exatamente os contatos com RH_SOURCE = sparkloop-upscribe, ignora o resto", () => {
    // Replica a proporção do corpo da issue: 24 cadastros, 17 SparkLoop
    // Upscribe (71%), 7 de outras origens (orgânico, beehiiv-boost, etc).
    const sparkloopEmails = Array.from({ length: 17 }, (_, i) => `us-corp-${i}@coffinpump.com`);
    const otherEmails = [
      { email: "leitor1@gmail.com", rhSource: undefined },
      { email: "leitor2@gmail.com", rhSource: "" },
      { email: "leitor3@gmail.com", rhSource: "beehiiv-boost" },
      { email: "leitor4@gmail.com", rhSource: undefined },
      { email: "leitor5@gmail.com", rhSource: undefined },
      { email: "leitor6@gmail.com", rhSource: undefined },
      { email: "leitor7@gmail.com", rhSource: undefined },
    ];

    const subscriptions: BeehiivSubscriptionSnapshot[] = [
      ...sparkloopEmails.map((email) => ({ subscriptionId: `sub-${email}`, email, rhSource: "sparkloop-upscribe" })),
      ...otherEmails.map((o) => ({ subscriptionId: `sub-${o.email}`, email: o.email, rhSource: o.rhSource ?? "" })),
    ];

    const matches = filterSparkloopContacts(subscriptions);

    assert.equal(matches.length, 17);
    assert.deepEqual(
      matches.map((m) => m.email).sort(),
      [...sparkloopEmails].sort(),
    );
    // Nenhum leitor orgânico/Boost entrou na lista de exclusão.
    for (const o of otherEmails) {
      assert.ok(!matches.some((m) => m.email === o.email), `${o.email} não deveria casar`);
    }
  });

  it("lista vazia quando nenhum assinante casa", () => {
    const subscriptions: BeehiivSubscriptionSnapshot[] = [
      { subscriptionId: "s1", email: "a@x.com", rhSource: "" },
      { subscriptionId: "s2", email: "b@x.com", rhSource: "beehiiv-boost" },
    ];
    assert.deepEqual(filterSparkloopContacts(subscriptions), []);
  });
});

// ── buildCreateSegmentBody ───────────────────────────────────────────────

describe("buildCreateSegmentBody", () => {
  it("corpo exato — nome de exibição do custom field (não ID), operator equal/and", () => {
    assert.deepEqual(buildCreateSegmentBody(), {
      name: EXCLUSION_SEGMENT_NAME,
      input: {
        type: "custom_fields",
        custom_fields: [{ name: RH_SOURCE_FIELD_NAME, operator: "equal", value: RH_SOURCE_SPARKLOOP_UPSCRIBE_VALUE }],
        operator: "and",
      },
    });
  });
});

// ── findExistingExclusionSegment (idempotência) ──────────────────────────

describe("findExistingExclusionSegment", () => {
  it("encontra por nome exato", () => {
    const found = findExistingExclusionSegment([
      { id: "seg-1", name: "Apoio — Todos", totalResults: 10 },
      { id: "seg-2", name: EXCLUSION_SEGMENT_NAME, totalResults: 17 },
    ]);
    assert.deepEqual(found, { id: "seg-2", name: EXCLUSION_SEGMENT_NAME, totalResults: 17 });
  });

  it("null quando o segmento ainda não existe", () => {
    const found = findExistingExclusionSegment([{ id: "seg-1", name: "Apoio — Todos", totalResults: 10 }]);
    assert.equal(found, null);
  });

  it("null quando a lista está vazia", () => {
    assert.equal(findExistingExclusionSegment([]), null);
  });
});

// ── fetchActiveSubscriptions (I/O mockado — paginação + custom field) ────

describe("fetchActiveSubscriptions", () => {
  it("extrai RH_SOURCE de cada assinante numa única página", async () => {
    const { fetchImpl } = mockFetchSeq([
      {
        status: 200,
        body: {
          data: [sub("spark@corp.com", "sparkloop-upscribe"), sub("organico@gmail.com", undefined)],
          total_results: 2,
          limit: 100,
        },
      },
    ]);
    const result = await fetchActiveSubscriptions("pub-1", "key", fetchImpl);
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.find((r) => r.email === "spark@corp.com"),
      { subscriptionId: "sub-spark@corp.com", email: "spark@corp.com", rhSource: "sparkloop-upscribe" },
    );
    assert.equal(result.find((r) => r.email === "organico@gmail.com")?.rhSource, "");
  });

  it("pagina até esgotar (hasMorePages)", async () => {
    const { fetchImpl, calls } = mockFetchSeq([
      { status: 200, body: { data: [sub("a@x.com", "sparkloop-upscribe")], total_results: 2, limit: 1 } },
      { status: 200, body: { data: [sub("b@x.com", undefined)], total_results: 2, limit: 1 } },
    ]);
    const result = await fetchActiveSubscriptions("pub-1", "key", fetchImpl);
    assert.equal(result.length, 2);
    assert.equal(calls.length, 2);
  });

  it("falha loud (nunca break silencioso) quando a API responde não-ok", async () => {
    const { fetchImpl } = mockFetchSeq([{ status: 500 }]);
    await assert.rejects(fetchActiveSubscriptions("pub-1", "key", fetchImpl), /Beehiiv API 500/);
  });

  it("falha loud quando a paginação termina cedo (total_results reportado > coletado)", async () => {
    const { fetchImpl } = mockFetchSeq([{ status: 200, body: { data: [], total_results: 5, limit: 100 } }]);
    await assert.rejects(fetchActiveSubscriptions("pub-1", "key", fetchImpl), /leitura truncada/);
  });
});

// ── fetchExistingSegments (I/O mockado — paginação) ──────────────────────

describe("fetchExistingSegments", () => {
  it("lê e mapeia id/name/total_results de uma página", async () => {
    const { fetchImpl } = mockFetchSeq([
      {
        status: 200,
        body: { data: [{ id: "seg-1", name: "Apoio — Todos", total_results: 10 }], total_results: 1, limit: 100 },
      },
    ]);
    const result = await fetchExistingSegments("pub-1", "key", fetchImpl);
    assert.deepEqual(result, [{ id: "seg-1", name: "Apoio — Todos", totalResults: 10 }]);
  });

  it("ignora entradas malformadas (sem id ou name string)", async () => {
    const { fetchImpl } = mockFetchSeq([
      {
        status: 200,
        body: { data: [{ id: "seg-1", name: "ok", total_results: 1 }, { name: "sem-id" }, { id: 42, name: "id-nao-string" }], total_results: 3, limit: 100 },
      },
    ]);
    const result = await fetchExistingSegments("pub-1", "key", fetchImpl);
    assert.deepEqual(result, [{ id: "seg-1", name: "ok", totalResults: 1 }]);
  });

  it("falha loud quando a API responde não-ok", async () => {
    const { fetchImpl } = mockFetchSeq([{ status: 403 }]);
    await assert.rejects(fetchExistingSegments("pub-1", "key", fetchImpl), /Beehiiv API 403/);
  });
});

// ── createExclusionSegment (I/O mockado — POST) ──────────────────────────

describe("createExclusionSegment", () => {
  it("POST bem-sucedido — envia o corpo exato e devolve id/status", async () => {
    const { fetchImpl, calls } = mockFetchSeq([
      { status: 201, body: { data: { id: "seg-new", name: EXCLUSION_SEGMENT_NAME, type: "dynamic", status: "pending", total_results: 0, active: true } } },
    ]);
    const created = await createExclusionSegment("pub-1", "key", fetchImpl);
    assert.deepEqual(created, { id: "seg-new", status: "pending" });
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, buildCreateSegmentBody());
    assert.match(calls[0].url, /\/publications\/pub-1\/segments$/);
  });

  it("falha loud quando a API responde não-ok — nunca reporta sucesso", async () => {
    const { fetchImpl } = mockFetchSeq([{ status: 422 }]);
    await assert.rejects(createExclusionSegment("pub-1", "key", fetchImpl), /POST \/segments falhou.*422/);
  });

  it("falha loud quando o 201 vem sem data.id (resposta inesperada)", async () => {
    const { fetchImpl } = mockFetchSeq([{ status: 201, body: {} }]);
    await assert.rejects(createExclusionSegment("pub-1", "key", fetchImpl), /POST \/segments falhou/);
  });
});
