/**
 * cloudflare-kv-upload.test.ts (#1119, + #4165/#4173)
 *
 * Cobre validações de input de `uploadImageToWorkerKV` (sem fazer network IO).
 * Garantias: credenciais faltantes → erro claro; namespace ID obrigatório.
 *
 * #4165/#4173 adiciona cobertura de `getTextFromWorkerKV`/`putTextToWorkerKV`
 * (contraparte de leitura/escrita fetch-based, injetável) e do adaptador
 * `RemoteKvNamespace`/`createRemoteKvNamespace` que o Studio (`dashboard-clarice.ts`)
 * passa a usar no lugar do `MemoryKv` sempre-vazio — garantia central: `get`/`put`
 * NUNCA lançam (fail-soft), mesmo quando o fetch injetado rejeita.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  uploadImageToWorkerKV,
  getTextFromWorkerKV,
  putTextToWorkerKV,
  RemoteKvNamespace,
  createRemoteKvNamespace,
} from "../scripts/lib/cloudflare-kv-upload.ts";

describe("uploadImageToWorkerKV — validação de input (#1119)", () => {
  it("falha quando kvNamespaceId está vazio", async () => {
    await assert.rejects(
      async () =>
        uploadImageToWorkerKV("/tmp/fake.jpg", "key", {
          kvNamespaceId: "",
          accountId: "abc",
          token: "tok",
        }),
      /kvNamespaceId obrigatório/,
    );
  });

  it("falha quando accountId+token faltam (e env vazio)", async () => {
    // Limpa env temporariamente
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await assert.rejects(
        async () =>
          uploadImageToWorkerKV("/tmp/fake.jpg", "key", {
            kvNamespaceId: "ns",
          }),
        /CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN/,
      );
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    }
  });

  it("usa cfg.accountId/token quando passado explicitamente (não exige env)", async () => {
    // Mesmo sem env, se cfg tem accountId+token, a validação inicial passa.
    // Depois falha no fs.readFileSync (arquivo /tmp/nonexistent.jpg) — esse é
    // o erro esperado, confirmando que passou da validação de credentials.
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await assert.rejects(
        async () =>
          uploadImageToWorkerKV(
            "/tmp/diaria-test-cloudflare-nonexistent.jpg",
            "key",
            { kvNamespaceId: "ns", accountId: "abc", token: "tok" },
          ),
        (err: Error) => !/CLOUDFLARE_ACCOUNT_ID/.test(err.message),
      );
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    }
  });
});

// ---------------------------------------------------------------------------
// #4165/#4173: getTextFromWorkerKV / putTextToWorkerKV / RemoteKvNamespace /
// createRemoteKvNamespace — adaptador de KV real que o Studio (dashboard-clarice.ts)
// usa no lugar do MemoryKv sempre-vazio.
// ---------------------------------------------------------------------------

/** Fetch mock injetável — grava toda chamada (url + init) e devolve a Response
 * programada pelo `handler`. Não toca `globalThis.fetch` (as funções aqui
 * aceitam `fetchImpl` como parâmetro, então não precisa monkey-patch global). */
function makeMockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { fetchImpl, calls };
}

const CFG = { accountId: "acc123", token: "tok123", kvNamespaceId: "ns456" };

describe("getTextFromWorkerKV (#4165/#4173)", () => {
  it("falha quando kvNamespaceId está vazio", async () => {
    await assert.rejects(
      async () => getTextFromWorkerKV("k", { ...CFG, kvNamespaceId: "" }),
      /kvNamespaceId obrigatório/,
    );
  });

  it("falha quando accountId+token faltam (e env vazio)", async () => {
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await assert.rejects(
        async () => getTextFromWorkerKV("k", { kvNamespaceId: "ns" }),
        /CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN/,
      );
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    }
  });

  it("200 → retorna o texto do body", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("hello-value", { status: 200 }));
    const result = await getTextFromWorkerKV("mykey", CFG, fetchImpl);
    assert.equal(result, "hello-value");
  });

  it("404 → retorna null (miss normal, não é erro)", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("not found", { status: 404 }));
    const result = await getTextFromWorkerKV("mykey", CFG, fetchImpl);
    assert.equal(result, null);
  });

  it("500 → lança com o status e corpo no erro", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("internal error detail", { status: 500 }));
    await assert.rejects(
      async () => getTextFromWorkerKV("mykey", CFG, fetchImpl),
      /falhou \(500\).*internal error detail/,
    );
  });

  it("monta a URL correta (account/namespace/key codificados) e usa Bearer token", async () => {
    const { fetchImpl, calls } = makeMockFetch(() => new Response("v", { status: 200 }));
    await getTextFromWorkerKV("eia:engagement", CFG, fetchImpl);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.cloudflare.com/client/v4/accounts/acc123/storage/kv/namespaces/ns456/values/eia%3Aengagement",
    );
    assert.equal(calls[0].init?.method, "GET");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const headers = calls[0].init?.headers as any;
    assert.equal(headers.Authorization, "Bearer tok123");
  });
});

describe("putTextToWorkerKV (#4165/#4173)", () => {
  it("falha quando kvNamespaceId está vazio", async () => {
    await assert.rejects(
      async () => putTextToWorkerKV("k", "v", { ...CFG, kvNamespaceId: "" }),
      /kvNamespaceId obrigatório/,
    );
  });

  it("falha quando accountId+token faltam", async () => {
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await assert.rejects(
        async () => putTextToWorkerKV("k", "v", { kvNamespaceId: "ns" }),
        /CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN/,
      );
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    }
  });

  it("sem expirationTtl: URL não tem query string", async () => {
    const { fetchImpl, calls } = makeMockFetch(() => new Response("", { status: 200 }));
    await putTextToWorkerKV("k", "v", CFG, fetchImpl);
    assert.doesNotMatch(calls[0].url, /\?/);
    assert.equal(calls[0].init?.method, "PUT");
    assert.equal(calls[0].init?.body, "v");
  });

  it("com expirationTtl: URL inclui ?expiration_ttl=N", async () => {
    const { fetchImpl, calls } = makeMockFetch(() => new Response("", { status: 200 }));
    await putTextToWorkerKV("k", "v", { ...CFG, expirationTtl: 300 }, fetchImpl);
    assert.match(calls[0].url, /\?expiration_ttl=300$/);
  });

  it("resposta não-ok → lança com status e corpo", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("write denied", { status: 403 }));
    await assert.rejects(
      async () => putTextToWorkerKV("k", "v", CFG, fetchImpl),
      /falhou \(403\).*write denied/,
    );
  });
});

describe("RemoteKvNamespace — fail-soft por construção (#4165/#4173)", () => {
  it("get(): 200 com type='json' → parseia o JSON", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    const result = await kv.get("k", "json");
    assert.deepEqual(result, { a: 1 });
  });

  it("get(): 200 com type='text'/ausente → retorna string crua", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("raw-text", { status: 200 }));
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    assert.equal(await kv.get("k"), "raw-text");
    assert.equal(await kv.get("k", "text"), "raw-text");
  });

  it("get(): JSON corrompido no KV → null, não lança", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("not-json-{{{", { status: 200 }));
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    assert.equal(await kv.get("k", "json"), null);
  });

  it("get(): 404 (miss) → null", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("", { status: 404 }));
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    assert.equal(await kv.get("k", "json"), null);
  });

  it("get(): fetch rejeita (rede fora do ar) → degrada pra null, NUNCA lança (fail-soft central desta issue)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED — rede indisponível");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    await assert.doesNotReject(async () => {
      const result = await kv.get("k", "json");
      assert.equal(result, null);
    });
  });

  it("get(): resposta 500 → degrada pra null, não lança", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("boom", { status: 500 }));
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    await assert.doesNotReject(async () => {
      assert.equal(await kv.get("k", "json"), null);
    });
  });

  it("put(): repassa expirationTtl de opts pro PUT HTTP", async () => {
    const { fetchImpl, calls } = makeMockFetch(() => new Response("", { status: 200 }));
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    await kv.put("k", "v", { expirationTtl: 604800 });
    assert.match(calls[0].url, /\?expiration_ttl=604800$/);
  });

  it("put(): fetch rejeita → NUNCA lança (fail-soft), vira no-op logado", async () => {
    const fetchImpl = (async () => {
      throw new Error("timeout");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    await assert.doesNotReject(async () => kv.put("k", "v"));
  });

  it("put(): resposta não-ok → NUNCA lança", async () => {
    const { fetchImpl } = makeMockFetch(() => new Response("denied", { status: 403 }));
    const kv = new RemoteKvNamespace(CFG, fetchImpl);
    await assert.doesNotReject(async () => kv.put("k", "v"));
  });
});

describe("createRemoteKvNamespace — factory fail-soft (#4165/#4173)", () => {
  it("sem credenciais (env limpo, sem cfg) → null", () => {
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      assert.equal(createRemoteKvNamespace("ns123"), null);
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    }
  });

  it("com cfg.accountId/token explícitos (sem depender do env) → instância de RemoteKvNamespace", () => {
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      const kv = createRemoteKvNamespace("ns123", { accountId: "a", token: "t" });
      assert.ok(kv instanceof RemoteKvNamespace);
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    }
  });

  it("com env presente (sem cfg) → instância de RemoteKvNamespace", () => {
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = "env-acc";
    process.env.CLOUDFLARE_WORKERS_TOKEN = "env-tok";
    try {
      const kv = createRemoteKvNamespace("ns123");
      assert.ok(kv instanceof RemoteKvNamespace);
    } finally {
      if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount; else delete process.env.CLOUDFLARE_ACCOUNT_ID;
      if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken; else delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    }
  });
});
