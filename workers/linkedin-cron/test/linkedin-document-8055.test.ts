/**
 * linkedin-document-8055.test.ts (#8055)
 *
 * Post de DOCUMENTO (PDF) no LinkedIn via API direta — `fireLinkedInDocument`
 * em `dispatch.ts` e a validação de `document_url`/`document_title` no
 * enqueue (`index.ts`).
 *
 * Cobertura:
 *   - caminho feliz: baixa o PDF → `POST /rest/documents?action=initializeUpload`
 *     (owner = authorUrn) → PUT no uploadUrl → `POST /rest/posts` com
 *     `content.media = { title, id }`; mesmos headers REST do carrossel.
 *   - sem credencial → dlq sem nenhum fetch.
 *   - falha antes do post (initializeUpload 403, conteúdo que não é PDF) COM
 *     `image_urls` → fallback pro carrossel de imagens (fired).
 *   - mesma falha SEM fallback → dlq.
 *   - `POST /rest/posts` 4xx → fallback; 5xx/timeout → send_unknown, NUNCA
 *     carrossel por cima (o post pode ter saído).
 *   - enqueue: validação dos campos novos + `linkedin_creds_missing`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fireQueueEntry, type LinkedInCreds } from "../src/dispatch.ts";
import workerDefault, { validateDocumentFields, type Env, type QueueEntry } from "../src/index.ts";

const CREDS: LinkedInCreds = {
  accessToken: "test-li-token",
  authorUrn: "urn:li:organization:12345",
  apiVersion: "202609",
};

const PDF_URL = "https://eia.test/img/img-unknown-weekly-261107-highlights-carousel-abcd1234.pdf";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake\n");

type Call = { url: string; method: string; headers: Headers; body: string };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Mock de fetch roteado por URL. `routes` decide a resposta; todo pedido fica
 * em `calls` (com o corpo JSON legível, binário vira "<binary>").
 */
function installFetch(routes: (url: string, method: string) => Response | Promise<Response> | "throw"): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : init?.body ? "<binary>" : "";
    calls.push({ url, method, headers: new Headers(init?.headers), body });
    const r = await routes(url, method);
    if (r === "throw") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return r;
  }) as typeof fetch;
  return calls;
}

function jsonRes(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Rotas de um LinkedIn saudável; `override` troca uma rota específica. */
function linkedInRoutes(override: Partial<Record<"pdf" | "docInit" | "docPut" | "post", () => Response | "throw">> = {}) {
  let imgN = 0;
  return (url: string, method: string): Response | "throw" => {
    if (url === PDF_URL) return override.pdf ? override.pdf() : new Response(PDF_BYTES, { status: 200 });
    if (url.startsWith("https://api.linkedin.com/rest/documents?action=initializeUpload")) {
      return override.docInit
        ? override.docInit()
        : jsonRes(200, { value: { uploadUrl: "https://upload.linkedin.test/doc", document: "urn:li:document:D1" } });
    }
    if (url === "https://upload.linkedin.test/doc") return override.docPut ? override.docPut() : new Response("", { status: 201 });
    if (url.startsWith("https://api.linkedin.com/rest/images?action=initializeUpload")) {
      imgN++;
      return jsonRes(200, { value: { uploadUrl: `https://upload.linkedin.test/img${imgN}`, image: `urn:li:image:I${imgN}` } });
    }
    if (url.startsWith("https://upload.linkedin.test/img")) return new Response("", { status: 201 });
    if (url.startsWith("https://x.test/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
    if (url === "https://api.linkedin.com/rest/posts" && method === "POST") {
      return override.post ? override.post() : new Response("", { status: 201 });
    }
    return new Response("unexpected", { status: 599 });
  };
}

function docEntry(extra: Partial<QueueEntry> = {}): QueueEntry {
  return {
    text: "legenda semanal",
    image_url: null,
    scheduled_at: "2026-11-08T12:00:00.000Z",
    destaque: "weekly-highlights",
    created_at: "2026-11-07T12:00:00.000Z",
    channel: "linkedin",
    document_url: PDF_URL,
    document_title: "Os principais destaques de IA da semana (2–6 nov)",
    ...extra,
  };
}

const FALLBACK_IMAGES = ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg"];

function postsCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.url === "https://api.linkedin.com/rest/posts");
}

describe("#8055 fireLinkedInDocument — caminho feliz", () => {
  it("PDF → initializeUpload (owner) → PUT → POST /rest/posts com content.media", async () => {
    const calls = installFetch(linkedInRoutes());
    const outcome = await fireQueueEntry(docEntry(), { webhookUrl: "https://make.test/diaria", linkedin: CREDS });
    assert.deepEqual(outcome, { status: "fired" });

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.split("?")[0]}`),
      [
        `GET ${PDF_URL}`,
        "POST https://api.linkedin.com/rest/documents",
        "PUT https://upload.linkedin.test/doc",
        "POST https://api.linkedin.com/rest/posts",
      ],
    );
    const init = calls[1];
    assert.match(init.url, /action=initializeUpload/);
    assert.deepEqual(JSON.parse(init.body), { initializeUploadRequest: { owner: CREDS.authorUrn } });
    // Mesmos headers REST do carrossel de imagens.
    assert.equal(init.headers.get("Authorization"), `Bearer ${CREDS.accessToken}`);
    assert.equal(init.headers.get("LinkedIn-Version"), CREDS.apiVersion);
    assert.equal(init.headers.get("X-Restli-Protocol-Version"), "2.0.0");
    assert.equal(calls[2].body, "<binary>");
    assert.equal(calls[2].headers.get("Authorization"), `Bearer ${CREDS.accessToken}`);

    const post = JSON.parse(calls[3].body);
    assert.equal(post.author, CREDS.authorUrn);
    assert.equal(post.commentary, "legenda semanal");
    assert.equal(post.lifecycleState, "PUBLISHED");
    assert.deepEqual(post.content, {
      media: { title: "Os principais destaques de IA da semana (2–6 nov)", id: "urn:li:document:D1" },
    });
    assert.equal(calls[3].headers.get("LinkedIn-Version"), CREDS.apiVersion);
  });

  it("com image_urls junto, o documento tem prioridade (nenhuma chamada à Images API)", async () => {
    const calls = installFetch(linkedInRoutes());
    const outcome = await fireQueueEntry(docEntry({ image_urls: FALLBACK_IMAGES }), {
      webhookUrl: "https://make.test/diaria",
      linkedin: CREDS,
    });
    assert.deepEqual(outcome, { status: "fired" });
    assert.equal(calls.filter((c) => c.url.includes("/rest/images")).length, 0);
    assert.ok(JSON.parse(postsCalls(calls)[0].body).content.media);
  });
});

describe("#8055 fireLinkedInDocument — sem credencial", () => {
  it("dlq antes de qualquer fetch", async () => {
    const calls = installFetch(linkedInRoutes());
    const outcome = await fireQueueEntry(docEntry(), { webhookUrl: "https://make.test/diaria" });
    assert.equal(outcome.status, "dlq");
    assert.match((outcome as { reason: string }).reason, /LINKEDIN_ACCESS_TOKEN/);
    assert.equal(calls.length, 0);
  });
});

describe("#8055 fireLinkedInDocument — fallback pro carrossel de imagens", () => {
  it("initializeUpload 403 → carrossel (multiImage) publicado, outcome fired", async () => {
    const calls = installFetch(linkedInRoutes({ docInit: () => jsonRes(403, { message: "Not enough permissions" }) }));
    const outcome = await fireQueueEntry(docEntry({ image_urls: FALLBACK_IMAGES }), {
      webhookUrl: "https://make.test/diaria",
      linkedin: CREDS,
    });
    assert.equal(outcome.status, "fired");
    // #12372 item 2 — o fallback avisa o caller, com o motivo.
    assert.match((outcome as { documentFallback?: string }).documentFallback ?? "", /Not enough permissions/);
    const posts = postsCalls(calls);
    assert.equal(posts.length, 1, "um post só — o carrossel");
    assert.deepEqual(JSON.parse(posts[0].body).content, {
      multiImage: { images: [{ id: "urn:li:image:I1" }, { id: "urn:li:image:I2" }, { id: "urn:li:image:I3" }] },
    });
  });

  it("conteúdo da URL não é PDF (página HTML com 200) → fallback, sem chamar a Documents API", async () => {
    const calls = installFetch(linkedInRoutes({ pdf: () => new Response("<html>erro</html>", { status: 200 }) }));
    const outcome = await fireQueueEntry(docEntry({ image_urls: FALLBACK_IMAGES }), {
      webhookUrl: "https://make.test/diaria",
      linkedin: CREDS,
    });
    assert.equal(outcome.status, "fired");
    // #12372 item 2 — o fallback avisa o caller, com o motivo.
    assert.match((outcome as { documentFallback?: string }).documentFallback ?? "", /não é PDF/);
    assert.equal(calls.filter((c) => c.url.includes("/rest/documents")).length, 0);
    assert.ok(JSON.parse(postsCalls(calls)[0].body).content.multiImage);
  });

  it("PDF 404 sem image_urls → dlq com o motivo, sem post", async () => {
    const calls = installFetch(linkedInRoutes({ pdf: () => new Response("nope", { status: 404 }) }));
    const outcome = await fireQueueEntry(docEntry(), { webhookUrl: "https://make.test/diaria", linkedin: CREDS });
    assert.equal(outcome.status, "dlq");
    assert.match((outcome as { reason: string }).reason, /HTTP 404.*sem carrossel de fallback/);
    assert.equal(postsCalls(calls).length, 0);
  });

  it("POST /rest/posts 422 (rejeição definitiva) → fallback pro carrossel", async () => {
    let postN = 0;
    const base = linkedInRoutes();
    const calls = installFetch((url, method) => {
      if (url === "https://api.linkedin.com/rest/posts") {
        postN++;
        return postN === 1 ? new Response("bad media", { status: 422 }) : new Response("", { status: 201 });
      }
      return base(url, method);
    });
    const outcome = await fireQueueEntry(docEntry({ image_urls: FALLBACK_IMAGES }), {
      webhookUrl: "https://make.test/diaria",
      linkedin: CREDS,
    });
    assert.equal(outcome.status, "fired");
    // #12372 item 2 — o fallback avisa o caller, com o motivo.
    assert.match((outcome as { documentFallback?: string }).documentFallback ?? "", /HTTP 422/);
    const posts = postsCalls(calls);
    assert.equal(posts.length, 2);
    assert.ok(JSON.parse(posts[0].body).content.media);
    assert.ok(JSON.parse(posts[1].body).content.multiImage);
  });

  it("fallback que também falha → dlq com os dois motivos", async () => {
    const base = linkedInRoutes({ docInit: () => jsonRes(403, { message: "no doc scope" }) });
    installFetch((url, method) => (url.startsWith("https://x.test/") ? new Response("gone", { status: 410 }) : base(url, method)));
    const outcome = await fireQueueEntry(docEntry({ image_urls: FALLBACK_IMAGES }), {
      webhookUrl: "https://make.test/diaria",
      linkedin: CREDS,
    });
    assert.equal(outcome.status, "dlq");
    const reason = (outcome as { reason: string }).reason;
    assert.match(reason, /no doc scope/);
    assert.match(reason, /fallback carrossel também falhou/);
  });
});

describe("#8055 fireLinkedInDocument — POST /rest/posts ambíguo nunca duplica", () => {
  it("5xx → send_unknown, nenhuma chamada ao carrossel", async () => {
    const calls = installFetch(linkedInRoutes({ post: () => new Response("upstream", { status: 503 }) }));
    const outcome = await fireQueueEntry(docEntry({ image_urls: FALLBACK_IMAGES }), {
      webhookUrl: "https://make.test/diaria",
      linkedin: CREDS,
    });
    assert.equal(outcome.status, "send_unknown");
    assert.match((outcome as { reason: string }).reason, /^send_unknown:/);
    assert.equal(calls.filter((c) => c.url.includes("/rest/images")).length, 0);
    assert.equal(postsCalls(calls).length, 1);
  });

  it("timeout → send_unknown", async () => {
    installFetch(linkedInRoutes({ post: () => "throw" }));
    const outcome = await fireQueueEntry(docEntry({ image_urls: FALLBACK_IMAGES }), {
      webhookUrl: "https://make.test/diaria",
      linkedin: CREDS,
    });
    assert.equal(outcome.status, "send_unknown");
    assert.match((outcome as { reason: string }).reason, /timeout/);
  });
});

// ── enqueue ────────────────────────────────────────────────────────────────

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string }) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    return { keys: names.map((name) => ({ name })), list_complete: true as const };
  }
}

function mkEnv(withCreds: boolean): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env: Env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/webhook",
    ...(withCreds ? { LINKEDIN_ACCESS_TOKEN: "li-token", LINKEDIN_AUTHOR_URN: "urn:li:organization:12345" } : {}),
  };
  return { env, kv };
}

function enqueue(env: Env, body: unknown): Promise<Response> {
  return workerDefault.fetch(
    new Request("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
    }),
    env,
  );
}

const BASE_BODY = {
  text: "legenda semanal",
  scheduled_at: "2026-12-05T12:00:00Z",
  destaque: "weekly-highlights",
  channel: "linkedin",
  document_url: PDF_URL,
  document_title: "Os principais destaques de IA da semana",
  image_urls: FALLBACK_IMAGES,
};

describe("#8055 enqueue — document_url/document_title", () => {
  it("aceita (202) e grava os dois campos na entry", async () => {
    const { env, kv } = mkEnv(true);
    const res = await enqueue(env, BASE_BODY);
    assert.equal(res.status, 202);
    assert.equal(kv.store.size, 1);
    const entry = JSON.parse([...kv.store.values()][0]) as QueueEntry;
    assert.equal(entry.document_url, PDF_URL);
    assert.equal(entry.document_title, BASE_BODY.document_title);
    assert.deepEqual(entry.image_urls, FALLBACK_IMAGES);
  });

  it("sem credencial → 400 com code linkedin_creds_missing, nada gravado", async () => {
    const { env, kv } = mkEnv(false);
    const { image_urls: _drop, ...noImages } = BASE_BODY;
    const res = await enqueue(env, noImages);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { code?: string; error: string };
    assert.equal(data.code, "linkedin_creds_missing");
    assert.match(data.error, /document_url/);
    assert.equal(kv.store.size, 0);
  });

  const invalid: Array<[string, Record<string, unknown>, RegExp]> = [
    ["URL http", { document_url: "http://eia.test/x.pdf" }, /https/],
    ["URL longa demais", { document_url: `https://eia.test/${"a".repeat(2_100)}` }, /exceeds/],
    ["sem título", { document_title: undefined }, /document_title is required/],
    ["título vazio", { document_title: "   " }, /document_title is required/],
    ["título longo demais", { document_title: "t".repeat(401) }, /document_title exceeds/],
    ["título sem URL", { document_url: undefined }, /document_url is required/],
    ["canal instagram", { channel: "instagram" }, /channel='linkedin'/],
    ["comment", { action: "comment" }, /not compatible/],
  ];
  for (const [name, patch, re] of invalid) {
    it(`rejeita (400): ${name}`, async () => {
      const { env, kv } = mkEnv(true);
      const body: Record<string, unknown> = { ...BASE_BODY, ...patch };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      const res = await enqueue(env, body);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, re);
      assert.equal(kv.store.size, 0);
    });
  }

  it("validateDocumentFields: corpo sem os campos novos passa intacto (caminho antigo)", () => {
    const { env } = mkEnv(false);
    assert.equal(validateDocumentFields({ text: "x", channel: "linkedin" }, env), null);
  });
});
