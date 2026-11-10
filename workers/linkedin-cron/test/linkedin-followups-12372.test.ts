/**
 * linkedin-followups-12372.test.ts (#12372)
 *
 * Follow-ups do documento PDF no LinkedIn (#8055 / PR #12371):
 *   - item 1: `POST /rest/posts` do carrossel de imagens com 5xx ou timeout é
 *     AMBÍGUO (o post pode ter saído) → `send_unknown`, nunca `dlq` (com `dlq`
 *     o alarm do DO só libera o claim e o cron refaz o disparo, duplicando).
 *     4xx continua `dlq`. O mesmo vale quando o carrossel é o fallback do
 *     documento: `send_unknown` do carrossel não pode virar `dlq`.
 *   - item 2: fallback do documento pro carrossel volta `fired` com
 *     `documentFallback`, e o caller (alarm do DO) manda o alerta pelo
 *     `ALERT_WEBHOOK_URL`.
 *   - item 4: teto do PDF em 20 MB, inclusive quando o servidor não manda
 *     `content-length` (leitura do corpo interrompida no teto).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fireQueueEntry, type LinkedInCreds } from "../src/dispatch.ts";
import { LINKEDIN_DOCUMENT_MAX_BYTES, type QueueEntry } from "../src/index.ts";
import { alertLinkedInDocumentFallback } from "../src/maintenance.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";

const CREDS: LinkedInCreds = {
  accessToken: "test-li-token",
  authorUrn: "urn:li:organization:12345",
  apiVersion: "202609",
};
const CONFIG = { webhookUrl: "https://make.test/diaria", linkedin: CREDS };
const PDF_URL = "https://eia.test/img/weekly-carousel-12372.pdf";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake\n");
const IMAGES = ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg"];
const ALERT_URL = "https://hook.test/alert";

type Call = { url: string; method: string; body: string };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Route = Response | "throw";
type Override = Partial<Record<"pdf" | "docInit" | "post", (n: number) => Route>>;

/** LinkedIn saudável; `override` troca rotas. `post` recebe o nº do POST /rest/posts (1, 2...). */
function installLinkedIn(override: Override = {}): Call[] {
  const calls: Call[] = [];
  let imgN = 0;
  let postN = 0;
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : init?.body ? "<binary>" : "";
    calls.push({ url, method, body });
    let r: Route;
    if (url === PDF_URL) r = override.pdf ? override.pdf(0) : new Response(PDF_BYTES, { status: 200 });
    else if (url.startsWith("https://api.linkedin.com/rest/documents?action=initializeUpload")) {
      r = override.docInit
        ? override.docInit(0)
        : new Response(JSON.stringify({ value: { uploadUrl: "https://upload.linkedin.test/doc", document: "urn:li:document:D1" } }), { status: 200 });
    } else if (url === "https://upload.linkedin.test/doc") r = new Response("", { status: 201 });
    else if (url.startsWith("https://api.linkedin.com/rest/images?action=initializeUpload")) {
      imgN++;
      r = new Response(JSON.stringify({ value: { uploadUrl: `https://upload.linkedin.test/img${imgN}`, image: `urn:li:image:I${imgN}` } }), { status: 200 });
    } else if (url.startsWith("https://upload.linkedin.test/img")) r = new Response("", { status: 201 });
    else if (url.startsWith("https://x.test/")) r = new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
    else if (url === "https://api.linkedin.com/rest/posts") {
      postN++;
      r = override.post ? override.post(postN) : new Response("", { status: 201 });
    } else if (url === ALERT_URL) r = new Response("ok", { status: 200 });
    else r = new Response("unexpected", { status: 599 });
    if (r === "throw") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return r;
  }) as typeof fetch;
  return calls;
}

function carouselEntry(): QueueEntry {
  return {
    text: "legenda",
    image_url: null,
    image_urls: IMAGES,
    scheduled_at: "2026-11-08T22:00:00.000Z",
    destaque: "weekly-highlights",
    created_at: "2026-11-07T12:00:00.000Z",
    channel: "linkedin",
  };
}

function docEntry(): QueueEntry {
  return { ...carouselEntry(), document_url: PDF_URL, document_title: "Os destaques da semana" };
}

const posts = (calls: Call[]) => calls.filter((c) => c.url === "https://api.linkedin.com/rest/posts");

describe("#12372 item 1 — POST /rest/posts do carrossel", () => {
  it("5xx → send_unknown (o post pode ter saído), nunca dlq", async () => {
    installLinkedIn({ post: () => new Response("upstream", { status: 502 }) });
    const outcome = await fireQueueEntry(carouselEntry(), CONFIG);
    assert.equal(outcome.status, "send_unknown");
    assert.match((outcome as { reason: string }).reason, /^send_unknown: LinkedIn carrossel: .*HTTP 502/);
  });

  it("timeout → send_unknown", async () => {
    installLinkedIn({ post: () => "throw" });
    const outcome = await fireQueueEntry(carouselEntry(), CONFIG);
    assert.equal(outcome.status, "send_unknown");
    assert.match((outcome as { reason: string }).reason, /^send_unknown: .*timeout/);
  });

  it("4xx continua dlq (rejeição definitiva, nada publicado)", async () => {
    installLinkedIn({ post: () => new Response("bad", { status: 422 }) });
    const outcome = await fireQueueEntry(carouselEntry(), CONFIG);
    assert.equal(outcome.status, "dlq");
    assert.match((outcome as { reason: string }).reason, /HTTP 422/);
  });

  it("fallback do documento cujo POST do carrossel dá 5xx → send_unknown, não dlq", async () => {
    // documento recusado antes do post (403) → fallback → POST do carrossel 503
    const calls = installLinkedIn({
      docInit: () => new Response(JSON.stringify({ message: "no scope" }), { status: 403 }),
      post: () => new Response("upstream", { status: 503 }),
    });
    const outcome = await fireQueueEntry(docEntry(), CONFIG);
    assert.equal(outcome.status, "send_unknown");
    const reason = (outcome as { reason: string }).reason;
    assert.match(reason, /^send_unknown: LinkedIn documento: /);
    assert.match(reason, /no scope/);
    assert.match(reason, /HTTP 503/);
    assert.equal(reason.match(/send_unknown:/g)?.length, 1, "prefixo uma vez só");
    assert.equal(posts(calls).length, 1, "só o POST do carrossel (o documento nem chegou ao post)");
  });
});

describe("#12372 item 2 — fallback do documento vira alerta", () => {
  it("fallback publicado → fired com documentFallback (motivo)", async () => {
    installLinkedIn({ docInit: () => new Response(JSON.stringify({ message: "no doc scope" }), { status: 403 }) });
    const outcome = await fireQueueEntry(docEntry(), CONFIG);
    assert.equal(outcome.status, "fired");
    assert.match((outcome as { documentFallback?: string }).documentFallback ?? "", /no doc scope/);
  });

  it("documento publicado → fired sem documentFallback", async () => {
    installLinkedIn();
    assert.deepEqual(await fireQueueEntry(docEntry(), CONFIG), { status: "fired" });
  });

  it("alertLinkedInDocumentFallback manda pro ALERT_WEBHOOK_URL com key, destaque e motivo", async () => {
    const calls = installLinkedIn();
    const ok = await alertLinkedInDocumentFallback({ ALERT_WEBHOOK_URL: ALERT_URL }, "queue:k1", docEntry(), "initializeUpload falhou: HTTP 403");
    assert.equal(ok, true);
    const hook = calls.filter((c) => c.url === ALERT_URL);
    assert.equal(hook.length, 1);
    const body = JSON.parse(hook[0].body);
    assert.equal(body.kind, "linkedin-document-fallback");
    assert.equal(body.key, "queue:k1");
    assert.match(body.text, /carrossel de imagens/);
    assert.match(body.text, /HTTP 403/);
  });

  it("alerta nunca lança, mesmo com o webhook fora do ar", async () => {
    globalThis.fetch = (async () => {
      throw new Error("rede caiu");
    }) as typeof fetch;
    const ok = await alertLinkedInDocumentFallback({ ALERT_WEBHOOK_URL: ALERT_URL }, "queue:k1", docEntry(), "x");
    assert.equal(ok, false);
  });

  it("alarm() do DO: fallback publicado grava fired e manda o alerta", async () => {
    const calls = installLinkedIn({ docInit: () => new Response(JSON.stringify({ message: "no doc scope" }), { status: 403 }) });
    const values = new Map<string, unknown>();
    let tail = Promise.resolve();
    const state = {
      storage: {
        async get(k: string) { return values.get(k); },
        async put(k: string, v: unknown) { values.set(k, v); },
        async delete(k: string) { values.delete(k); },
        async setAlarm() {},
      },
      blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
        const r = tail.then(fn);
        tail = r.then(() => {}, () => {});
        return r;
      },
    };
    values.set("payload", { key: "queue:doc", webhookUrl: "https://make.test/diaria", linkedin: CREDS, entry: docEntry() } as DoStoredPayload);
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState, { ALERT_WEBHOOK_URL: ALERT_URL });
    await scheduler.alarm();
    assert.equal(values.get("fired"), true);
    const hook = calls.filter((c) => c.url === ALERT_URL);
    assert.equal(hook.length, 1, "um alerta");
    assert.match(JSON.parse(hook[0].body).text, /no doc scope/);
  });
});

describe("#12372 item 4 — teto do PDF", () => {
  it("teto é 20 MB (folga sobre o isolate de ~128 MB)", () => {
    assert.equal(LINKEDIN_DOCUMENT_MAX_BYTES, 20 * 1024 * 1024);
  });

  it("content-length acima do teto → fallback sem baixar nem chamar a Documents API", async () => {
    const calls = installLinkedIn({
      pdf: () => new Response(PDF_BYTES, { status: 200, headers: { "content-length": String(LINKEDIN_DOCUMENT_MAX_BYTES + 1) } }),
    });
    const outcome = await fireQueueEntry(docEntry(), CONFIG);
    assert.equal(outcome.status, "fired");
    assert.match((outcome as { documentFallback?: string }).documentFallback ?? "", /teto/);
    assert.equal(calls.filter((c) => c.url.includes("/rest/documents")).length, 0);
  });

  it("sem content-length e corpo acima do teto → leitura interrompida no teto, fallback", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(PDF_BYTES);
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 200) controller.close(); // 200 MB se ninguém parasse
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const calls = installLinkedIn({ pdf: () => new Response(stream, { status: 200 }) });
    const outcome = await fireQueueEntry(docEntry(), CONFIG);
    assert.equal(outcome.status, "fired");
    assert.match((outcome as { documentFallback?: string }).documentFallback ?? "", /passou de \d+ bytes/);
    assert.ok(pulled <= 22, `leu ${pulled} MB, deveria parar perto de 20`);
    assert.equal(cancelled, true, "stream cancelado");
    assert.equal(calls.filter((c) => c.url.includes("/rest/documents")).length, 0);
  });
});
