/**
 * instagram-carousel.test.ts (#4153)
 *
 * Testa o carrossel do Instagram no Worker `diaria-linkedin-cron` — fluxo de
 * 3 passos da Graph API (N containers filhos → 1 container pai → publish),
 * disparado quando `entry.image_urls` tem mais de 1 item. Ver
 * `src/dispatch.ts` (fireInstagram, fireInstagramSingle, fireInstagramCarousel,
 * resolveImageUrls) e `src/index.ts` (QueueEntry.image_urls, validação em
 * handleEnqueue).
 *
 * Mesmo padrão de mocks de test/instagram-channel.test.ts (#3817).
 *
 * Cobertura:
 *   - happy path: carrossel de 5 — 5 containers filhos + 1 pai + 1 publish,
 *     na ordem certa, com ids encadeados corretamente
 *   - 1 imagem só via `image_urls` (length 1) — caminho single-image antigo,
 *     intocado (sem is_carousel_item, sem children)
 *   - entry legada (só `image_url`, sem `image_urls`) — continua publicando
 *     como antes
 *   - falha no meio (child container 3 de 5): DLQ com motivo legível, NENHUMA
 *     chamada de media_publish do pai é feita, containers 4 e 5 nunca criados
 *   - validação de limites (2-10 itens) rejeitando no enqueue
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, {
  buildQueueKey,
  CAROUSEL_MAX_ITEMS,
  __test__,
  type Env,
  type QueueEntry,
} from "../src/index.ts";
import { fireQueueEntry } from "../src/dispatch.ts";

// ── In-memory KV mock (mesmo padrão de test/instagram-channel.test.ts) ─────

type KVValue = string;
type PutOptions = { expirationTtl?: number };
class MockKV {
  store = new Map<string, KVValue>();
  putOptions = new Map<string, PutOptions>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  async put(key: string, value: string, options?: PutOptions): Promise<void> {
    this.store.set(key, value);
    if (options) this.putOptions.set(key, options);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.putOptions.delete(key);
  }
  async list(opts: { prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: true }> {
    const prefix = opts.prefix ?? "";
    const names = Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
    names.sort();
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
}

function mkEnv(overrides: Partial<Env> = {}): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    ...overrides,
  } as Env;
  return { env, kv };
}

function authedRequest(url: string, init?: RequestInit, token = "secret-token"): Request {
  const headers = new Headers(init?.headers);
  headers.set("X-Diaria-Token", token);
  return new Request(url, { ...init, headers });
}

function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
}

// ── Happy path: carrossel de 5 ──────────────────────────────────────────────

describe("#4153 Instagram carrossel: 5 containers filhos + 1 pai + 1 publish, na ordem certa", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("cron dispara channel=instagram com image_urls[5]: cria 5 filhos, 1 pai (children encadeados) e publica", async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    let childCounter = 0;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = bodyOf(init);
      calls.push({ url: u, method: init?.method, body });
      if (u.endsWith("/media_publish")) {
        return new Response(JSON.stringify({ id: "parent-published-id" }), { status: 200 });
      }
      if (u.endsWith("/media") && body.includes("media_type=CAROUSEL")) {
        return new Response(JSON.stringify({ id: "parent-container-id" }), { status: 200 });
      }
      if (u.endsWith("/media")) {
        childCounter++;
        return new Response(JSON.stringify({ id: `child-${childCounter}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv({
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "17841422721183309",
      INSTAGRAM_ACCESS_TOKEN: "test-token",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-ig-carousel-happy");
    const imageUrls = [
      "https://poll.diaria.workers.dev/img/seg.jpg",
      "https://poll.diaria.workers.dev/img/ter.jpg",
      "https://poll.diaria.workers.dev/img/qua.jpg",
      "https://poll.diaria.workers.dev/img/qui.jpg",
      "https://poll.diaria.workers.dev/img/sex.jpg",
    ];
    const entry: QueueEntry = {
      text: "Legenda da semana #ia",
      image_url: null,
      image_urls: imageUrls,
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
      channel: "instagram",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(result.dlq, 0);
      assert.equal(result.errors, 0);

      const childCalls = calls.filter(
        (c) => c.url.endsWith("/media") && c.method === "POST" && c.body.includes("is_carousel_item=true"),
      );
      assert.equal(childCalls.length, 5, "deve criar exatamente 5 containers filhos");
      childCalls.forEach((c, i) => {
        const params = new URLSearchParams(c.body);
        assert.equal(params.get("image_url"), imageUrls[i], `child ${i + 1} deve levar a imagem certa, na ordem`);
        assert.ok(!c.body.includes("caption="), "child container não deve levar caption");
      });

      const parentCall = calls.find((c) => c.url.endsWith("/media") && c.body.includes("media_type=CAROUSEL"));
      assert.ok(parentCall, "deve ter criado o container pai");
      assert.match(parentCall!.body, /children=child-1%2Cchild-2%2Cchild-3%2Cchild-4%2Cchild-5/, "children deve listar os ids na ordem certa");
      assert.match(parentCall!.body, /caption=/, "container pai deve levar a legenda");

      const publishCall = calls.find((c) => c.url.endsWith("/media_publish"));
      assert.ok(publishCall, "deve ter chamado media_publish");
      assert.match(publishCall!.body, /creation_id=parent-container-id/, "publish deve usar o creation_id do container PAI");

      // Ordem: os 5 filhos vêm antes do pai, que vem antes do publish.
      const childIdxs = calls
        .map((c, idx) => (c.body.includes("is_carousel_item=true") ? idx : -1))
        .filter((i) => i >= 0);
      const parentIdx = calls.findIndex((c) => c.body.includes("media_type=CAROUSEL"));
      const publishIdx = calls.findIndex((c) => c.url.endsWith("/media_publish"));
      assert.ok(Math.max(...childIdxs) < parentIdx, "todos os filhos devem vir antes do pai");
      assert.ok(parentIdx < publishIdx, "o pai deve vir antes do publish");

      assert.equal(kv.store.has(key), false, "item disparado com sucesso deve sair do KV");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 1 imagem só (via image_urls[1] OU image_url legado): caminho antigo ────

describe("#4153 regressão: 1 imagem só continua no caminho single-image antigo", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("image_urls com 1 item só: NÃO entra no fluxo de carrossel (sem is_carousel_item, sem children)", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push({ url: u, body: bodyOf(init) });
      if (u.endsWith("/media_publish")) {
        return new Response(JSON.stringify({ id: "published-1" }), { status: 200 });
      }
      if (u.includes("status_code")) {
        return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
      }
      if (u.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "container-solo" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "Legenda única",
      image_url: null,
      image_urls: ["https://x.test/only.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      channel: "instagram",
    };

    try {
      const outcome = await fireQueueEntry(entry, {
        webhookUrl: "https://make.test/diaria",
        instagram: { igUserId: "acc", accessToken: "tok", apiVersion: "v25.0" },
      });
      assert.deepEqual(outcome, { status: "fired" });
      // Só 1 /media (container único) + 1 /media_publish — nunca is_carousel_item/children.
      const mediaCalls = calls.filter((c) => c.url.endsWith("/media"));
      assert.equal(mediaCalls.length, 1);
      assert.ok(!mediaCalls[0].body.includes("is_carousel_item"));
      assert.ok(!mediaCalls[0].body.includes("children"));
      assert.match(mediaCalls[0].body, /caption=/, "caminho single-image mantém caption no único container");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("entry legada (só image_url, sem image_urls) continua publicando como antes", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push(u);
      if (u.endsWith("/media_publish")) {
        return new Response(JSON.stringify({ id: "published-legacy" }), { status: 200 });
      }
      if (u.includes("status_code")) {
        return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
      }
      if (u.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "container-legacy" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    // image_urls OMITIDO de propósito — simula entry já em produção antes do #4153.
    const entry: QueueEntry = {
      text: "Legenda legada",
      image_url: "https://x.test/legacy.jpg",
      scheduled_at: new Date().toISOString(),
      destaque: "d2",
      created_at: new Date().toISOString(),
      channel: "instagram",
    };

    try {
      const outcome = await fireQueueEntry(entry, {
        webhookUrl: "https://make.test/diaria",
        instagram: { igUserId: "acc", accessToken: "tok", apiVersion: "v25.0" },
      });
      assert.deepEqual(outcome, { status: "fired" });
      assert.equal(calls.filter((u) => u.endsWith("/media")).length, 1);
      assert.equal(calls.filter((u) => u.endsWith("/media_publish")).length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Falha parcial: child N de M falha → aborta tudo, DLQ ───────────────────

describe("#4153 Instagram carrossel: falha parcial aborta o post inteiro e vai pra DLQ", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("child container 3 de 5 falha: DLQ com motivo legível, NENHUMA chamada de media_publish do pai é feita", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let childAttempt = 0;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = bodyOf(init);
      calls.push({ url: u, body });
      if (u.endsWith("/media_publish")) {
        // Não deveria NUNCA ser chamado neste teste — se for, o teste abaixo falha.
        return new Response(JSON.stringify({ id: "should-not-happen" }), { status: 200 });
      }
      if (u.endsWith("/media") && body.includes("media_type=CAROUSEL")) {
        // Também não deveria ser chamado — o pai só é criado se todos os filhos vingarem.
        return new Response(JSON.stringify({ id: "should-not-happen-parent" }), { status: 200 });
      }
      if (u.endsWith("/media")) {
        childAttempt++;
        if (childAttempt === 3) {
          return new Response(JSON.stringify({ error: { message: "Invalid image URL" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ id: `child-${childAttempt}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv({
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "acc",
      INSTAGRAM_ACCESS_TOKEN: "tok",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-ig-carousel-partial-fail");
    const entry: QueueEntry = {
      text: "Legenda da semana",
      image_url: null,
      image_urls: [
        "https://x.test/1.jpg",
        "https://x.test/2.jpg",
        "https://x.test/3-bad.jpg",
        "https://x.test/4.jpg",
        "https://x.test/5.jpg",
      ],
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
      channel: "instagram",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      // Falha parcial de carrossel é SEMPRE dlq direto (nunca failed/retriable) — decisão #4153.
      assert.equal(result.fired, 0);
      assert.equal(result.dlq, 1);

      // Exatamente 3 tentativas de container filho — nunca chegou no 4º ou 5º.
      const childCalls = calls.filter((c) => c.url.endsWith("/media") && !c.body.includes("media_type=CAROUSEL"));
      assert.equal(childCalls.length, 3, "não deve tentar criar o 4º/5º container após a falha no 3º");

      // NENHUMA chamada de container pai nem de publish.
      assert.ok(!calls.some((c) => c.body.includes("media_type=CAROUSEL")), "não deve criar o container pai");
      assert.ok(!calls.some((c) => c.url.endsWith("/media_publish")), "não deve publicar — critério de aceite central da issue");

      // Item foi pra DLQ com motivo legível mencionando a posição da falha.
      const dlqKeys = Array.from(kv.store.keys()).filter((k) => k.startsWith("dlq:"));
      assert.equal(dlqKeys.length, 1);
      const dlqEntry = JSON.parse(kv.store.get(dlqKeys[0]) as string) as QueueEntry;
      assert.equal(dlqEntry.destaque, "d1");
      assert.equal(kv.store.has(key), false, "entry original deve sair da queue");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fireQueueEntry (unit): reason menciona '3/5' e quantos containers já tinham sido criados", async () => {
    let childAttempt = 0;
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.endsWith("/media")) {
        childAttempt++;
        if (childAttempt === 3) {
          return new Response(JSON.stringify({ error: { message: "Invalid image URL" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ id: `child-${childAttempt}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "t",
      image_url: null,
      image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg", "https://x.test/4.jpg", "https://x.test/5.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      channel: "instagram",
    };

    const originalFetch2 = globalThis.fetch;
    try {
      const outcome = await fireQueueEntry(entry, {
        webhookUrl: "https://make.test/diaria",
        instagram: { igUserId: "acc", accessToken: "tok", apiVersion: "v25.0" },
      });
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /3\/5/);
      assert.match((outcome as { reason: string }).reason, /containers já criados: 2/);
    } finally {
      globalThis.fetch = originalFetch2;
    }
  });

  it("falha no container PAI (após todos os filhos OK) também aborta sem publicar — dlq", async () => {
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = bodyOf(init);
      if (u.endsWith("/media_publish")) {
        return new Response(JSON.stringify({ id: "should-not-happen" }), { status: 200 });
      }
      if (u.endsWith("/media") && body.includes("media_type=CAROUSEL")) {
        return new Response(JSON.stringify({ error: { message: "Invalid children" } }), { status: 400 });
      }
      if (u.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "child-ok" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "t",
      image_url: null,
      image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg"],
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      channel: "instagram",
    };

    const originalFetch2 = globalThis.fetch;
    try {
      const outcome = await fireQueueEntry(entry, {
        webhookUrl: "https://make.test/diaria",
        instagram: { igUserId: "acc", accessToken: "tok", apiVersion: "v25.0" },
      });
      assert.equal(outcome.status, "dlq");
      assert.match((outcome as { reason: string }).reason, /container pai/);
    } finally {
      globalThis.fetch = originalFetch2;
    }
  });
});

// ── handleEnqueue: validação de limites (2-10 itens) ────────────────────────

describe("#4153 handleEnqueue: validação de limites do carrossel (2-10 itens)", () => {
  it("rejeita image_urls vazio ([])", async () => {
    const { env } = mkEnv();
    const body = {
      text: "x",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
      image_urls: [],
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /empty/);
  });

  it(`rejeita image_urls com ${CAROUSEL_MAX_ITEMS + 1} itens (excede o máximo)`, async () => {
    const { env } = mkEnv();
    const tooMany = Array.from({ length: CAROUSEL_MAX_ITEMS + 1 }, (_, i) => `https://x.test/${i}.jpg`);
    const body = {
      text: "x",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
      image_urls: tooMany,
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /exceeds/);
  });

  it("rejeita image_urls não-array", async () => {
    const { env } = mkEnv();
    const body = {
      text: "x",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
      image_urls: "https://x.test/a.jpg",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /array/);
  });

  it("rejeita image_urls com item não-string", async () => {
    const { env } = mkEnv();
    const body = {
      text: "x",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
      image_urls: ["https://x.test/a.jpg", 12345],
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /strings/);
  });

  it("aceita image_urls no limite mínimo (2) e persiste na entry", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "Legenda",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
      image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg"],
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    const data = (await res.json()) as { key: string };
    const parsed = JSON.parse(kv.store.get(data.key) as string) as QueueEntry;
    assert.deepEqual(parsed.image_urls, body.image_urls);
  });

  it(`aceita image_urls no limite máximo (${CAROUSEL_MAX_ITEMS})`, async () => {
    const { env, kv } = mkEnv();
    const maxUrls = Array.from({ length: CAROUSEL_MAX_ITEMS }, (_, i) => `https://x.test/${i}.jpg`);
    const body = {
      text: "Legenda",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
      image_urls: maxUrls,
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    const data = (await res.json()) as { key: string };
    const parsed = JSON.parse(kv.store.get(data.key) as string) as QueueEntry;
    assert.equal(parsed.image_urls?.length, CAROUSEL_MAX_ITEMS);
  });

  it("channel=instagram SEM image_url mas COM image_urls não-vazio: aceito (image_urls satisfaz a exigência de imagem)", async () => {
    const { env } = mkEnv();
    const body = {
      text: "Legenda",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
      image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg"],
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
  });

  it("backward-compat: entry sem image_urls não grava o campo (omitido)", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "legacy",
      image_url: "https://x.test/legacy.jpg",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d2",
      channel: "instagram",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    const data = (await res.json()) as { key: string };
    const parsed = JSON.parse(kv.store.get(data.key) as string) as QueueEntry;
    assert.ok(!("image_urls" in parsed), "campo image_urls não deve nem existir na entry legada");
  });
});
