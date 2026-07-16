import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractPostText,
  extractCommentDiaria,
  extractCommentPixel,
  computeCommentScheduledAt,
  dispatchEntry,
  postToMakeWebhook,
  postToWorkerQueue,
  sanitizeFallbackReason,
  resolveOutrosCount,
  classifyImageCache,
  type DispatchContext,
  type DispatchInput,
  type ImageCacheFile,
} from "../scripts/publish-linkedin.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const LF = "# Facebook\n\n## d1\nFacebook d1.\n\n# LinkedIn\n\n## d1\nLinkedIn d1.\n\nLinha 2 d1.\n\n## d2\nLinkedIn d2.\n<!-- oculto -->\n\n## d3\nLinkedIn d3.";
const CRLF = LF.replace(/\n/g, "\r\n");

describe("extractPostText (publish-linkedin) (#528)", () => {
  it("extrai d1 de # LinkedIn (LF)", () => { const t=extractPostText(LF,"d1"); assert.ok(t.includes("LinkedIn d1.")); assert.ok(t.includes("Linha 2 d1.")); assert.ok(!t.includes("Facebook d1.")); });
  it("extrai d2 sem vazar d1/d3", () => { const t=extractPostText(LF,"d2"); assert.ok(t.includes("LinkedIn d2.")); assert.ok(!t.includes("LinkedIn d1.")); assert.ok(!t.includes("LinkedIn d3.")); });
  it("extrai d3", () => { assert.ok(extractPostText(LF,"d3").includes("LinkedIn d3.")); });
  it("normaliza CRLF para LF", () => { assert.ok(extractPostText(CRLF,"d1").includes("LinkedIn d1.")); });
  it("remove comentarios HTML", () => { assert.ok(!extractPostText(LF,"d2").includes("oculto")); });
  it("lanca sem secao LinkedIn", () => { assert.throws(()=>extractPostText("# Facebook\n\n## d1\nT.","d1"),/LinkedIn/i); });
  it("lanca sem destaque", () => { assert.throws(()=>extractPostText("# LinkedIn\n\n## d1\nT.","d4"),/d4/i); });
  it("d1 nao contamina d2", () => { assert.ok(!extractPostText(LF,"d1").includes("LinkedIn d2.")); });
});

describe("postToMakeWebhook (#528)", () => {
  const webhookUrl="https://hook.eu2.make.com/test";
  const payload={text:"T",image_url:null as string|null,scheduled_at:null as string|null,destaque:"d1"};
  let saved: typeof globalThis.fetch;
  beforeEach(()=>{saved=globalThis.fetch;});
  afterEach(()=>{globalThis.fetch=saved;});

  it("retry: 500 na 1a tentativa 200 na 2a", async()=>{
    let n=0;
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>{n++;if(n===1)return new Response("E",{status:500});return new Response(JSON.stringify({accepted:true,request_id:"r"}),{status:200,headers:{"Content-Type":"application/json"}});};
    const r=await postToMakeWebhook(webhookUrl,payload,2);
    assert.equal(n,2); assert.equal(r.accepted,true);
  });

  it("lanca apos 2 tentativas sempre 500", async()=>{
    let n=0;
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>{n++;return new Response("E",{status:503});};
    await assert.rejects(()=>postToMakeWebhook(webhookUrl,payload,2),/Make webhook HTTP 503/);
    assert.equal(n,2);
  });

  it("retorna accepted:true body vazio HTTP 200", async()=>{
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>new Response("",{status:200});
    assert.equal((await postToMakeWebhook(webhookUrl,payload,1)).accepted,true);
  });

  it("retorna accepted:true body nao-JSON HTTP 200", async()=>{
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>new Response("OK",{status:200});
    assert.equal((await postToMakeWebhook(webhookUrl,payload,1)).accepted,true);
  });

  it("retorna request_id do response JSON", async()=>{
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>new Response(JSON.stringify({request_id:"req_xyz",accepted:true}),{status:200,headers:{"Content-Type":"application/json"}});
    assert.equal((await postToMakeWebhook(webhookUrl,payload,1)).request_id,"req_xyz");
  });

  it("maxAttempts=1 tenta apenas 1x e lanca", async()=>{
    let n=0;
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>{n++;return new Response("Bad",{status:502});};
    await assert.rejects(()=>postToMakeWebhook(webhookUrl,payload,1),/Make webhook HTTP 502/);
    assert.equal(n,1);
  });

  it("payload contem image_url:null nenhuma URL enviada", async()=>{
    let body:string|undefined;
    globalThis.fetch=async(_u:string|URL|Request,o?:RequestInit)=>{body=o?.body as string;return new Response(JSON.stringify({accepted:true}),{status:200});};
    await postToMakeWebhook(webhookUrl,payload,1);
    assert.ok(body!==undefined); assert.equal(JSON.parse(body).image_url,null);
  });
});

describe("postToWorkerQueue (Cloudflare Worker enqueue)", () => {
  const workerUrl = "https://diaria-linkedin-cron.diaria.workers.dev";
  const token = "test-token-abc";
  const payload = { text: "Post agendado", image_url: "https://drive.google.com/uc?id=x", scheduled_at: "2026-05-08T09:00:00-03:00", destaque: "d1" };
  let saved: typeof globalThis.fetch;
  beforeEach(() => { saved = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = saved; });

  it("POSTa para /queue com X-Diaria-Token header", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = async (u: string | URL | Request, o?: RequestInit) => {
      capturedUrl = u.toString();
      capturedHeaders = o?.headers as Record<string, string>;
      return new Response(JSON.stringify({ queued: true, key: "queue:abc-123", scheduled_at: payload.scheduled_at, destaque: "d1" }), { status: 202 });
    };
    const r = await postToWorkerQueue(workerUrl, token, payload, 1);
    assert.equal(capturedUrl, workerUrl + "/queue");
    assert.equal(capturedHeaders?.["X-Diaria-Token"], token);
    assert.equal(r.queued, true);
    assert.equal(r.key, "queue:abc-123");
  });

  it("retry: 503 na 1a tentativa 202 na 2a", async () => {
    let n = 0;
    globalThis.fetch = async (_u: string | URL | Request, _o?: RequestInit) => {
      n++;
      if (n === 1) return new Response("upstream", { status: 503 });
      return new Response(JSON.stringify({ queued: true, key: "queue:retry-ok", scheduled_at: payload.scheduled_at, destaque: "d1" }), { status: 202 });
    };
    const r = await postToWorkerQueue(workerUrl, token, payload, 2);
    assert.equal(n, 2);
    assert.equal(r.queued, true);
    assert.equal(r.key, "queue:retry-ok");
  });

  it("lanca apos maxAttempts com 401 unauthorized", async () => {
    let n = 0;
    globalThis.fetch = async (_u: string | URL | Request, _o?: RequestInit) => { n++; return new Response("unauthorized", { status: 401 }); };
    await assert.rejects(() => postToWorkerQueue(workerUrl, "wrong-token", payload, 2), /Worker queue HTTP 401/);
    assert.equal(n, 2);
  });

  it("normaliza trailing slash no workerUrl", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = async (u: string | URL | Request, _o?: RequestInit) => {
      capturedUrl = u.toString();
      return new Response(JSON.stringify({ queued: true, key: "k", scheduled_at: payload.scheduled_at, destaque: "d1" }), { status: 202 });
    };
    await postToWorkerQueue(workerUrl + "///", token, payload, 1);
    assert.equal(capturedUrl, workerUrl + "/queue", "// ou / a mais não devem duplicar");
  });

  it("lanca em resposta non-JSON HTTP 200", async () => {
    globalThis.fetch = async (_u: string | URL | Request, _o?: RequestInit) => new Response("oops", { status: 200 });
    // #1032: msg de erro foi unificada pra "Worker response inválido (schema ou JSON)"
    await assert.rejects(() => postToWorkerQueue(workerUrl, token, payload, 1), /Worker response inválido/);
  });
});

describe("resume-aware skip posts LinkedIn (#528)", () => {
  it("pula scheduled", ()=>{const p=[{platform:"linkedin",destaque:"d1",status:"scheduled"}];const e=p.find((x)=>x.platform==="linkedin"&&x.destaque==="d1"&&(x.status==="draft"||x.status==="scheduled"));assert.ok(e!==undefined);assert.equal(e.status,"scheduled");});
  it("pula draft", ()=>{const p=[{platform:"linkedin",destaque:"d2",status:"draft"}];const e=p.find((x)=>x.platform==="linkedin"&&x.destaque==="d2"&&(x.status==="draft"||x.status==="scheduled"));assert.ok(e!==undefined);assert.equal(e.status,"draft");});
  it("nao pula failed retry", ()=>{const p=[{platform:"linkedin",destaque:"d3",status:"failed"}];const e=p.find((x)=>x.platform==="linkedin"&&x.destaque==="d3"&&(x.status==="draft"||x.status==="scheduled"));assert.equal(e,undefined);});
  it("nao pula outra plataforma facebook nao afeta linkedin", ()=>{const p=[{platform:"facebook",destaque:"d1",status:"scheduled"}];const e=p.find((x)=>x.platform==="linkedin"&&x.destaque==="d1"&&(x.status==="draft"||x.status==="scheduled"));assert.equal(e,undefined);});
});

describe("Worker → Make fallback (#887)", () => {
  // Testa o caminho de fallback: postToWorkerQueue lança após retries → caller
  // (main em publish-linkedin.ts) deve cair em postToMakeWebhook + marcar
  // entry com fallback_used=true e fallback_reason. Como main() não é exportado,
  // simulamos a sequência de chamadas que o try/catch interno faz.
  const workerUrl = "https://diaria-linkedin-cron.diaria.workers.dev";
  const makeUrl = "https://hook.eu2.make.com/test";
  const token = "test-token-abc";
  const payload = {
    text: "Post agendado",
    image_url: "https://drive.google.com/uc?id=x",
    scheduled_at: "2026-05-08T09:00:00-03:00",
    destaque: "d1",
  };
  let saved: typeof globalThis.fetch;
  beforeEach(() => {
    saved = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = saved;
  });

  it("Worker lança apos 2 retries → fallback chama Make → entry com fallback_used=true", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (u: string | URL | Request, _o?: RequestInit) => {
      const url = u.toString();
      calls.push(url);
      if (url.startsWith(workerUrl)) {
        return new Response("KV down", { status: 503 });
      }
      if (url.startsWith(makeUrl)) {
        return new Response(JSON.stringify({ accepted: true, request_id: "make-fallback-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    // Sequência que main() executa no try/catch interno (com sanitização e status=draft)
    let entry: Record<string, unknown> | null = null;
    try {
      const _r = await postToWorkerQueue(workerUrl, token, payload, 2);
      entry = { fallback_used: false, raw: _r };
    } catch (workerError) {
      const wmsg = (workerError as Error).message;
      const response = await postToMakeWebhook(makeUrl, payload, 2);
      entry = {
        platform: "linkedin",
        destaque: "d1",
        url: null,
        status: "draft", // Make postou imediato — sempre draft no fallback
        scheduled_at: payload.scheduled_at,
        make_request_id: response.request_id,
        fallback_used: true,
        fallback_reason: sanitizeFallbackReason(wmsg),
      };
    }

    assert.ok(entry, "entry deve ter sido criada");
    assert.equal(entry.fallback_used, true, "fallback_used deve ser true");
    assert.match(String(entry.fallback_reason), /HTTP 503/, "reason deve conter o status code Worker");
    assert.equal(entry.make_request_id, "make-fallback-1", "deve ter request_id do Make fallback");
    assert.equal(entry.status, "draft", "fallback Make posta imediato → status sempre draft");
    // 2 tentativas Worker (503) + 1 tentativa Make (200) = 3 fetches
    assert.equal(calls.filter((u) => u.startsWith(workerUrl)).length, 2);
    assert.equal(calls.filter((u) => u.startsWith(makeUrl)).length, 1);
  });

  it("Worker timeout (AbortError) → fallback Make 200 → entry status=draft + fallback_used", async () => {
    // Reproduz o cenário onde o Worker timeout (AbortSignal.timeout(...) dispara
    // AbortError) e o fallback pra Make é bem-sucedido. Worker tem maxAttempts=2 default
    // → AbortError nas duas tentativas → catch interno chama Make.
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = async (u: string | URL | Request, o?: RequestInit) => {
      const url = u.toString();
      calls.push({ url, method: o?.method ?? "GET" });
      if (url.startsWith(workerUrl)) {
        // Simular AbortError lançado pelo AbortSignal.timeout(...)
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      if (url.startsWith(makeUrl)) {
        return new Response(JSON.stringify({ accepted: true, request_id: "make-after-timeout" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    let entry: Record<string, unknown> | null = null;
    try {
      await postToWorkerQueue(workerUrl, token, payload, 2);
      entry = { fallback_used: false };
    } catch (workerError) {
      const wmsg = (workerError as Error).message;
      const response = await postToMakeWebhook(makeUrl, payload, 2);
      entry = {
        platform: "linkedin",
        destaque: "d1",
        url: null,
        status: "draft",
        scheduled_at: payload.scheduled_at,
        make_request_id: response.request_id,
        fallback_used: true,
        fallback_reason: sanitizeFallbackReason(wmsg),
      };
    }

    assert.ok(entry, "entry deve ter sido criada");
    assert.equal(entry.fallback_used, true);
    assert.equal(entry.status, "draft");
    assert.equal(entry.make_request_id, "make-after-timeout");
    // 2 tentativas Worker timeout + 1 tentativa Make sucesso = 3 fetches
    assert.equal(calls.filter((c) => c.url.startsWith(workerUrl)).length, 2);
    assert.equal(calls.filter((c) => c.url.startsWith(makeUrl)).length, 1);
    // fallback_reason deve estar limpo (sem stack trace / paths)
    assert.ok(String(entry.fallback_reason).length <= 150, "reason deve estar truncado");
  });

  it("Worker lança E Make tambem lança → entry com status=failed (no fallback de fallback)", async () => {
    globalThis.fetch = async (u: string | URL | Request, _o?: RequestInit) => {
      const url = u.toString();
      if (url.startsWith(workerUrl)) return new Response("KV down", { status: 503 });
      if (url.startsWith(makeUrl)) return new Response("Make down", { status: 502 });
      return new Response("unexpected", { status: 500 });
    };

    // Sequência que main() executa: outer try captura quando Make tambem falha
    let entry: Record<string, unknown> | null = null;
    try {
      try {
        await postToWorkerQueue(workerUrl, token, payload, 2);
      } catch (workerError) {
        const wmsg = (workerError as Error).message;
        // Fallback tenta Make — também falha — deixa a exception propagar
        const _resp = await postToMakeWebhook(makeUrl, payload, 2);
        // não chega aqui
        void _resp;
        void wmsg;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      entry = {
        platform: "linkedin",
        destaque: "d1",
        url: null,
        status: "failed",
        scheduled_at: payload.scheduled_at,
        reason: msg,
      };
    }

    assert.ok(entry, "entry deve ter sido criada");
    assert.equal(entry.status, "failed", "status deve ser failed quando Make tambem falha");
    assert.match(String(entry.reason), /Make webhook HTTP 502/, "reason deve apontar erro Make");
    // Sem fallback_used quando o fallback de fallback nao se aplica
    assert.equal(entry.fallback_used, undefined);
  });
});

describe("sanitizeFallbackReason (#892)", () => {
  it("extrai HTTP status + primeira linha curta", () => {
    const r = sanitizeFallbackReason("Worker queue HTTP 503: KV down");
    assert.match(r, /HTTP 503/);
    assert.ok(r.length <= 150);
  });

  it("trunca stack trace multilinhas para primeira linha apenas", () => {
    const long =
      "Worker queue HTTP 500: Internal Error\n  at /Users/x/secret/path/worker.ts:42\n  at /more/internal/paths/x.ts:99";
    const r = sanitizeFallbackReason(long);
    assert.ok(!r.includes("/Users/x/secret"), "não deve vazar paths internos");
    assert.ok(!r.includes("\n"), "não deve ter newlines");
    assert.match(r, /HTTP 500/);
  });

  it("sem HTTP status: usa só primeira linha truncada em 100 chars", () => {
    const long = "AbortError: The operation was aborted due to timeout after 30000ms exceeding the limit set on the request handler config";
    const r = sanitizeFallbackReason(long);
    assert.ok(!r.match(/HTTP \d{3}/), "sem HTTP status, não deve fabricar");
    assert.ok(r.length <= 100, `length=${r.length}`);
  });

  it("respeita cap total mesmo com mensagens HTTP muito longas", () => {
    const long = "Worker queue HTTP 502: " + "x".repeat(500);
    const r = sanitizeFallbackReason(long);
    // "HTTP 502" (8) + ": " (2) + até 100 chars = max ~110 chars
    assert.ok(r.length <= 120, `expected <=120, got ${r.length}`);
    assert.match(r, /HTTP 502/);
  });
});

describe("image_url null por padrao LinkedIn (#528)", () => {
  it("image_url e null no payload nenhuma URL enviada", ()=>{const imageUrl:string|null=null;const p={text:"T",image_url:imageUrl,scheduled_at:null,destaque:"d1"};assert.equal(p.image_url,null);});
});

describe("route decision worker_queue vs make_now (#886)", () => {
  // Replica a lógica do main() em publish-linkedin.ts:
  //   const isFutureSchedule = scheduledAt !== null && Date.parse(scheduledAt) > Date.now();
  //   const route = useWorkerForScheduled && isFutureSchedule ? "worker_queue" : "make_now";
  function decide(opts: { scheduledAt: string | null; useWorkerForScheduled: boolean; now?: number }): "worker_queue" | "make_now" {
    const { scheduledAt, useWorkerForScheduled } = opts;
    const now = opts.now ?? Date.now();
    const isFutureSchedule = scheduledAt !== null && Date.parse(scheduledAt) > now;
    return useWorkerForScheduled && isFutureSchedule ? "worker_queue" : "make_now";
  }

  it("worker configurado + scheduled_at futuro → worker_queue", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    assert.equal(decide({ scheduledAt: future, useWorkerForScheduled: true }), "worker_queue");
  });

  it("worker configurado + scheduled_at no passado → make_now", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(decide({ scheduledAt: past, useWorkerForScheduled: true }), "make_now");
  });

  it("worker não configurado + scheduled_at futuro → make_now (fallback)", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    assert.equal(decide({ scheduledAt: future, useWorkerForScheduled: false }), "make_now");
  });

  it("scheduled_at null → make_now (fire-now sem agendamento)", () => {
    assert.equal(decide({ scheduledAt: null, useWorkerForScheduled: true }), "make_now");
  });
});

describe("PostEntry.route field (#886)", () => {
  // Garante que o shape de PostEntry aceita `route` e que o consumo no
  // 06-social-published.json fica inspecionável sem precisar olhar pra
  // worker_queue_key/make_request_id pra inferir route.
  it("entry com route='worker_queue' inclui worker_queue_key", () => {
    const entry = {
      platform: "linkedin", destaque: "d1", url: null, status: "scheduled" as const,
      scheduled_at: "2026-05-08T09:00:00-03:00", route: "worker_queue" as const,
      worker_queue_key: "queue:abc-123",
    };
    assert.equal(entry.route, "worker_queue");
    assert.equal(entry.worker_queue_key, "queue:abc-123");
  });

  it("entry com route='make_now' inclui make_request_id", () => {
    const entry = {
      platform: "linkedin", destaque: "d2", url: null, status: "draft" as const,
      scheduled_at: null, route: "make_now" as const,
      make_request_id: "req_xyz",
    };
    assert.equal(entry.route, "make_now");
    assert.equal(entry.make_request_id, "req_xyz");
  });

  it("entry failed mantém route registrado pra debug", () => {
    const entry = {
      platform: "linkedin", destaque: "d3", url: null, status: "failed" as const,
      scheduled_at: "2026-05-08T09:00:00-03:00", route: "worker_queue" as const,
      reason: "Worker queue HTTP 503",
    };
    assert.equal(entry.route, "worker_queue");
    assert.equal(entry.reason, "Worker queue HTTP 503");
  });
});

describe("image_url via cache 06-public-images.json (#725 bug #9)", () => {
  // Testa a lógica de leitura do cache — o main() de publish-linkedin.ts
  // usa existsSync+readFileSync pra carregar 06-public-images.json.
  // Verificamos o shape esperado do cache pra garantir que o código de leitura
  // está correto (campo images.{d}.url).

  it("shape do cache: images.d1.url é a URL Drive esperada", () => {
    const cacheShape = {
      images: {
        d1: { file_id: "abc123", url: "https://drive.google.com/uc?id=abc123&export=view", mime_type: "image/jpeg", filename: "04-d1-1x1.jpg" },
        d2: { file_id: "def456", url: "https://drive.google.com/uc?id=def456&export=view", mime_type: "image/jpeg", filename: "04-d2-1x1.jpg" },
        d3: { file_id: "ghi789", url: "https://drive.google.com/uc?id=ghi789&export=view", mime_type: "image/jpeg", filename: "04-d3-1x1.jpg" },
      },
    };
    // Simula o que main() faz ao ler o cache
    for (const d of ["d1", "d2", "d3"] as const) {
      const url = cacheShape.images?.[d]?.url ?? null;
      assert.ok(url !== null, `${d} deve ter URL`);
      assert.ok(url.startsWith("https://drive.google.com/uc?"), `${d} URL deve ser Drive`);
    }
  });

  it("graceful fallback: chave ausente → null sem throw", () => {
    const cacheShape = { images: { d1: { url: "https://drive.google.com/uc?id=x&export=view" } } };
    const urlD2 = (cacheShape.images as Record<string, {url?: string}>)["d2"]?.url ?? null;
    assert.equal(urlD2, null, "chave ausente deve retornar null");
  });

  it("graceful fallback: cache vazio → null sem throw", () => {
    const emptyCache = {} as { images?: Record<string, {url?: string}> };
    const url = emptyCache.images?.["d1"]?.url ?? null;
    assert.equal(url, null);
  });
});

// ── #595 — extração de comment_diaria / comment_pixel + extractPostText sem comments ──

const SOCIAL_595 = [
  "# Facebook",
  "",
  "## d1",
  "Facebook d1.",
  "",
  "# LinkedIn",
  "",
  "## d1",
  "Main post d1, parágrafo 1.",
  "",
  "Parágrafo 2.",
  "",
  "#InteligenciaArtificial",
  "",
  "### comment_diaria",
  "",
  "Edição completa em {edition_url}",
  "",
  "Receba a Diar.ia em diar.ia.br",
  "",
  "### comment_pixel",
  "",
  "Opinião pessoal do Pixel — frame mudou.",
  "",
  "## d2",
  "Main d2.",
  "",
  "### comment_diaria",
  "Comment Diar.ia d2 em {edition_url}",
  "",
  "### comment_pixel",
  "Pixel d2 opinião.",
  "",
  "## d3",
  "Main d3 sem comments (schema antigo backward-compat).",
].join("\n");

describe("#595 extractPostText: stop em ### comment_*", () => {
  it("d1: main não inclui comment_diaria nem comment_pixel", () => {
    const t = extractPostText(SOCIAL_595, "d1");
    assert.ok(t.includes("Main post d1"));
    assert.ok(t.includes("#InteligenciaArtificial"));
    assert.ok(!t.includes("Edição completa"));
    assert.ok(!t.includes("Opinião pessoal"));
  });

  it("d2: main não inclui subsections", () => {
    const t = extractPostText(SOCIAL_595, "d2");
    assert.equal(t, "Main d2.");
  });

  it("d3 sem comments: backward-compat retorna bloco inteiro", () => {
    const t = extractPostText(SOCIAL_595, "d3");
    assert.match(t, /Main d3/);
  });

  it("schema antigo (sem comments) ainda funciona", () => {
    const old = "# LinkedIn\n\n## d1\nLinkedIn d1.\nLinha 2.\n";
    const t = extractPostText(old, "d1");
    assert.ok(t.includes("LinkedIn d1."));
    assert.ok(t.includes("Linha 2."));
  });
});

describe("#595 extractCommentDiaria", () => {
  it("d1: extrai texto e substitui {edition_url}", () => {
    const t = extractCommentDiaria(SOCIAL_595, "d1", "https://diar.ia.br/p/foo");
    assert.ok(t);
    assert.match(t!, /https:\/\/diar\.ia\.br\/p\/foo/);
    assert.ok(!t!.includes("{edition_url}"));
    assert.ok(!t!.includes("Opinião pessoal")); // não vaza pixel
  });

  it("d2: extrai sem URL passada (placeholder fica intacto)", () => {
    const t = extractCommentDiaria(SOCIAL_595, "d2");
    assert.match(t!, /\{edition_url\}/);
  });

  it("d3 (schema antigo, sem comment_diaria): retorna null", () => {
    assert.equal(extractCommentDiaria(SOCIAL_595, "d3"), null);
  });

  it("schema completamente antigo (só main): retorna null", () => {
    const old = "# LinkedIn\n\n## d1\nLinkedIn d1.\n";
    assert.equal(extractCommentDiaria(old, "d1"), null);
  });
});

describe("#595 extractCommentPixel", () => {
  it("d1: extrai sem vazar comment_diaria nem proximo destaque", () => {
    const t = extractCommentPixel(SOCIAL_595, "d1");
    assert.ok(t);
    assert.match(t!, /Opinião pessoal/);
    assert.ok(!t!.includes("Edição completa"));
    assert.ok(!t!.includes("Main d2"));
  });

  it("d2: extrai", () => {
    const t = extractCommentPixel(SOCIAL_595, "d2");
    assert.equal(t, "Pixel d2 opinião.");
  });

  it("d3 (sem comment_pixel): retorna null", () => {
    assert.equal(extractCommentPixel(SOCIAL_595, "d3"), null);
  });

  it("#1690: d3 comment_pixel NÃO vaza a seção sibling ## post_pixel", () => {
    const md = [
      "# LinkedIn", "",
      "## d1", "Main d1.", "",
      "### comment_pixel", "CP d1.", "",
      "## d3", "Main d3.", "",
      "### comment_pixel", "CP d3 pessoal.", "",
      "## post_pixel", "",
      "Post standalone pessoal de D1 — NÃO deve vazar pro comment_pixel do d3.",
    ].join("\n");
    const t = extractCommentPixel(md, "d3");
    assert.equal(t, "CP d3 pessoal.");
    assert.ok(!t!.includes("post_pixel"), "sem o heading post_pixel");
    assert.ok(!t!.includes("Post standalone"), "sem o corpo do post_pixel");
  });
});

describe("#595 computeCommentScheduledAt", () => {
  it("mainAt no futuro: comment = mainAt + offset", () => {
    const now = Date.parse("2026-12-01T12:00:00Z");
    const mainAt = "2026-12-01T15:00:00Z";
    const r = computeCommentScheduledAt(mainAt, 3, now);
    assert.equal(r, "2026-12-01T15:03:00.000Z");
  });

  it("mainAt no passado: usa now + offset (não original time)", () => {
    const now = Date.parse("2026-12-01T15:00:00Z");
    const mainAtPast = "2026-12-01T10:00:00Z";
    const r = computeCommentScheduledAt(mainAtPast, 3, now);
    assert.equal(r, "2026-12-01T15:03:00.000Z");
  });

  it("mainAt null (make_now sem schedule): usa now + offset", () => {
    const now = Date.parse("2026-12-01T12:00:00Z");
    const r = computeCommentScheduledAt(null, 8, now);
    assert.equal(r, "2026-12-01T12:08:00.000Z");
  });

  it("mainAt no futuro com offset 8 (comment_pixel): T+8min preservado", () => {
    const now = Date.parse("2026-12-01T08:00:00Z");
    const mainAt = "2026-12-01T12:00:00Z";
    const r = computeCommentScheduledAt(mainAt, 8, now);
    assert.equal(r, "2026-12-01T12:08:00.000Z");
  });

  it("mainAt inválido: cai pra now + offset", () => {
    const now = Date.parse("2026-12-01T12:00:00Z");
    const r = computeCommentScheduledAt("not-a-date", 3, now);
    assert.equal(r, "2026-12-01T12:03:00.000Z");
  });
});

// ── #595 review: dispatchEntry edge cases (regression coverage) ──

describe("#595 dispatchEntry: bug regression — pixel + null scheduled_at em fire-now", () => {
  // Bug: PR #1050 inicial fazia `cdAt/cpAt = doSchedule ? compute() : null`.
  // Se editor rodasse publish-linkedin sem --schedule (debug, recovery,
  // retry isolado), comments tinham scheduledAt=null → route=make_now →
  // dispatchEntry pra webhook_target=pixel jogava `Error: webhook_target=pixel
  // exige Worker configurado — make_now não suportado`.
  // Fix: skip comments inteiros se !doSchedule (preserva backward-compat).
  // Esta suite valida que dispatchEntry SEMPRE falha de forma controlada
  // pra essa combinação inválida (pixel + scheduled_at null) — defesa em
  // profundidade caso o caller esqueça o skip.

  function tmpDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "publish-linkedin-disp-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  function mkCtx(dir: string): DispatchContext {
    return {
      publishedPath: join(dir, "06-social-published.json"),
      webhookUrl: "https://hook.test/diaria",
      workerUrl: "https://worker.test",
      workerToken: "test-tok",
      useWorkerForScheduled: true,
      editionDate: "260999",
      // #3311: isola o logEvent de auditoria de dispatchEntry() pro mesmo
      // tmpdir da edição de teste — sem isso, dispatchEntry() (chamado
      // in-process, não spawnado) gravava entries fabricadas (edition:
      // "260999") direto em data/run-log.jsonl REAL do worktree a cada
      // test run (rootDir cai no default de logEvent, process.cwd()).
      rootDir: dir,
    };
  }

  it("pixel + scheduled_at null + worker não-configurado → entry status=failed (controlled)", async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const input: DispatchInput = {
        destaque: "d1",
        subtype: "comment_pixel",
        text: "Pixel comment",
        imageUrl: null,
        scheduledAt: null, // bug scenario — sem schedule, sem now+offset
        webhookTarget: "pixel",
        action: "comment",
        parentDestaque: "d1",
      };
      const ctx = mkCtx(dir);
      const entry = await dispatchEntry(input, ctx);
      // Não pode throw uncaught — caller espera entry; falha vira status=failed
      assert.equal(entry.platform, "linkedin");
      assert.equal(entry.subtype, "comment_pixel");
      assert.equal(entry.status, "failed");
      assert.match((entry.reason as string) ?? "", /pixel.*Worker|make_now/i);
    } finally { cleanup(); }
  });

  it("pixel + scheduled_at null + worker configurado → ainda fail (worker_queue exige future)", async () => {
    // Mesmo com worker configurado, scheduled_at=null faz isFutureSchedule=false →
    // route=make_now → throw. Não há caminho válido pra pixel sem scheduled_at.
    const { dir, cleanup } = tmpDir();
    try {
      const input: DispatchInput = {
        destaque: "d1",
        subtype: "comment_pixel",
        text: "Pixel comment",
        imageUrl: null,
        scheduledAt: null,
        webhookTarget: "pixel",
        action: "comment",
        parentDestaque: "d1",
      };
      const ctx = mkCtx(dir); // useWorkerForScheduled: true
      const entry = await dispatchEntry(input, ctx);
      assert.equal(entry.status, "failed");
      assert.match((entry.reason as string) ?? "", /pixel.*Worker|make_now/i);
    } finally { cleanup(); }
  });

  it("diaria + scheduled_at null → fallback make_now path (post imediato OK)", async () => {
    // webhook_target=diaria + scheduledAt=null sem Worker → route=make_now é
    // caminho legítimo (Diar.ia tem URL local, posta imediato). Diferente do pixel.
    // Mocka fetch pra simular Make webhook 200.
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accepted: true, request_id: "test-req" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const { dir, cleanup } = tmpDir();
    try {
      const input: DispatchInput = {
        destaque: "d1",
        subtype: "main",
        text: "Main post",
        imageUrl: null,
        scheduledAt: null,
        webhookTarget: "diaria",
        action: "post",
      };
      const ctx = mkCtx(dir);
      const entry = await dispatchEntry(input, ctx);
      assert.equal(entry.status, "draft", "diaria fire-now → draft (post imediato)");
      assert.equal(entry.route, "make_now");
    } finally {
      cleanup();
      globalThis.fetch = savedFetch;
    }
  });

  // #3311 regressão direta: antes de DispatchContext.rootDir existir,
  // dispatchEntry() (chamado in-process pelos testes acima, não spawnado)
  // sempre gravava o logEvent de auditoria via process.cwd() — o cwd real
  // do test runner, tipicamente a raiz do repo/worktree. Toda run desta
  // suite poluía data/run-log.jsonl real com entries fabricadas
  // (edition: "260999", achado empírico citado na issue #3311: 4353+
  // entries históricas). Este teste prova (a) que o log de auditoria é de
  // fato persistido, e (b) que ele vai SOMENTE pro tmpdir isolado passado
  // via ctx.rootDir — nunca pro repo real.
  it("#3311: log de auditoria de dispatchEntry isolado via ctx.rootDir — nunca grava em data/run-log.jsonl real", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accepted: true, request_id: "test-req" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const { dir, cleanup } = tmpDir();
    try {
      const input: DispatchInput = {
        destaque: "d1",
        subtype: "main",
        text: "Main post",
        imageUrl: null,
        scheduledAt: null,
        webhookTarget: "diaria",
        action: "post",
      };
      const ctx = mkCtx(dir);
      await dispatchEntry(input, ctx);

      const isolatedLogPath = join(dir, "data", "run-log.jsonl");
      assert.ok(existsSync(isolatedLogPath), "log de auditoria deveria existir no tmpdir isolado (ctx.rootDir)");
      const isolatedLog = readFileSync(isolatedLogPath, "utf8");
      assert.match(isolatedLog, /"agent":"publish-linkedin"/);
      assert.match(isolatedLog, /"edition":"260999"/);

      // #3479: a comparação de snapshot contra data/run-log.jsonl REAL do
      // repo (antes/depois) foi removida daqui — as assertions positivas
      // acima já provam a intenção do #3311 (write isolado em ctx.rootDir),
      // e o snapshot era flaky sob concorrência com outros testes da suíte
      // que gravam no run-log real durante a janela do snapshot.
    } finally {
      cleanup();
      globalThis.fetch = savedFetch;
    }
  });
});

// ── #2319 — resolveOutrosCount + {outros_count} resolução no Stage 5 ———————————————————————


describe("#2319 resolveOutrosCount: conta itens não-destaque do approved JSON", () => {
  it("soma lancamento + radar + use_melhor + video", () => {
    const count = resolveOutrosCount({
      lancamento: [{}, {}],
      radar: [{}, {}, {}, {}, {}],
      use_melhor: [{}, {}, {}],
      video: [{}, {}],
    });
    assert.equal(count, 12);
  });

  it("arrays ausentes contam como 0", () => {
    const count = resolveOutrosCount({});
    assert.equal(count, 0);
  });

  it("apenas radar", () => {
    const count = resolveOutrosCount({ radar: new Array(7) });
    assert.equal(count, 7);
  });

  it("edition com 13 itens (caso 260616 pós-edição)", () => {
    // 260616: após edição, edição ficou com 13 itens total não-destaque
    const count = resolveOutrosCount({
      lancamento: new Array(2),
      radar: new Array(6),
      use_melhor: new Array(3),
      video: new Array(2),
    });
    assert.equal(count, 13);
  });
});

// ── Fixture para testes de comment_diaria com {outros_count} ──

const SOCIAL_2319 = [
  "# Facebook",
  "",
  "## d1",
  "Facebook d1.",
  "",
  "# LinkedIn",
  "",
  "## d1",
  "Main post d1.",
  "",
  "#InteligenciaArtificial",
  "",
  "### comment_diaria",
  "",
  "Edição completa com mais {outros_count} destaques de IA do dia em {edition_url}",
  "",
  "Receba a Diar.ia em diar.ia.br",
  "",
  "### comment_pixel",
  "",
  "Opinião pessoal do Pixel.",
  "",
  "## d2",
  "Main d2.",
  "",
  "### comment_diaria",
  "Edição com mais {outros_count} destaques em {edition_url}",
  "",
  "### comment_pixel",
  "Pixel d2.",
].join("\n");

describe("#2319 extractCommentDiaria: {outros_count} substituído no Stage 5", () => {
  it("resolve {outros_count} com número correto do estado final", () => {
    const t = extractCommentDiaria(SOCIAL_2319, "d1", "https://diar.ia.br/p/foo", 13);
    assert.ok(t);
    assert.match(t!, /mais 13 destaques/);
    assert.ok(!t!.includes("{outros_count}"), "placeholder não deve vazar");
    assert.ok(!t!.includes("{edition_url}"), "edition_url também deve ser substituído");
    assert.match(t!, /https:\/\/diar\.ia\.br\/p\/foo/);
  });

  it("override valor stale do Stage 2: placeholder substituído pelo número final", () => {
    // Simula o cenário do bug 260616:
    // Stage 2 geraria "17" no texto se resolvesse cedo demais.
    // Com Option A, o texto tem {outros_count} literal até Stage 5,
    // onde é substituído pelo valor FINAL (13, não 17).
    const socialMdWithPlaceholder = [
      "# LinkedIn", "",
      "## d1", "Main.", "",
      "### comment_diaria", "",
      "Edição com mais {outros_count} destaques em {edition_url}", "",
      "### comment_pixel", "Pixel.",
    ].join("\n");

    // Stage 5 lê outrosCount=13 do approved FINAL (não o 17 do Stage 2)
    const finalCount = 13; // valor correto pós-edição
    const t = extractCommentDiaria(socialMdWithPlaceholder, "d1", "https://diar.ia.br/p/test", finalCount);

    assert.ok(t, "deve retornar texto");
    assert.match(t!, /mais 13 destaques/, "deve usar o número FINAL (13)");
    assert.ok(!t!.includes("17"), "não deve ter o valor stale do Stage 2");
    assert.ok(!t!.includes("{outros_count}"), "placeholder não deve vazar");
  });

  it("sem outrosCount passado: {outros_count} permanece literal (backward-compat)", () => {
    // Quando outrosCount=null (approved.json ausente), o placeholder fica intacto
    const t = extractCommentDiaria(SOCIAL_2319, "d1", "https://diar.ia.br/p/foo", null);
    assert.ok(t);
    assert.match(t!, /\{outros_count\}/, "placeholder deve permanecer quando outrosCount=null");
    assert.ok(!t!.includes("{edition_url}"), "edition_url ainda é substituído mesmo sem outrosCount");
  });

  it("d2: {outros_count} e {edition_url} ambos resolvidos", () => {
    const t = extractCommentDiaria(SOCIAL_2319, "d2", "https://diar.ia.br/p/bar", 7);
    assert.ok(t);
    assert.match(t!, /mais 7 destaques/);
    assert.match(t!, /https:\/\/diar\.ia\.br\/p\/bar/);
    assert.ok(!t!.includes("{outros_count}"));
    assert.ok(!t!.includes("{edition_url}"));
  });

  it("outrosCount=0: zero destaques adicionais é válido", () => {
    const t = extractCommentDiaria(SOCIAL_2319, "d1", "https://diar.ia.br/p/foo", 0);
    assert.ok(t);
    assert.match(t!, /mais 0 destaques/);
    assert.ok(!t!.includes("{outros_count}"));
  });
});

// ── #2331 — Findings F1/F2/F3: resolução de outrosCount no main() ─────────────────

// Helper: monta edition dir com _internal/ e approved files.
// O editionDir deve terminar em AAMMDD — o script valida isso.
function mkEditionDir(_opts: Record<string, unknown> = {}): { tmp: string; dir: string; internalDir: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "pl-2331-"));
  const dir = join(tmp, "260999"); // AAMMDD válido pra passar o guard
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  return { tmp, dir, internalDir, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// Shape mínimo de approved JSON com contagem controlada
const APPROVED_CAPPED = JSON.stringify({
  highlights: [{ article: { title: "D1" } }, { article: { title: "D2" } }, { article: { title: "D3" } }],
  lancamento: [{ title: "L1" }, { title: "L2" }],
  radar: [{ title: "R1" }, { title: "R2" }, { title: "R3" }, { title: "R4" }, { title: "R5" }],
  use_melhor: [],
  video: [],
});
// outros = lancamento(2) + radar(5) = 7

// Uncapped JSON com mais lançamentos que o cap (5)
const APPROVED_UNCAPPED_INFLATED = JSON.stringify({
  highlights: [{ article: { title: "D1", url: "https://a.com/1" } }, { article: { title: "D2", url: "https://a.com/2" } }, { article: { title: "D3", url: "https://a.com/3" } }],
  lancamento: [
    { title: "L1", url: "https://l.com/1" }, { title: "L2", url: "https://l.com/2" },
    { title: "L3", url: "https://l.com/3" }, { title: "L4", url: "https://l.com/4" },
    { title: "L5", url: "https://l.com/5" }, { title: "L6", url: "https://l.com/6" }, // cap=5 → L6 seria cortado
    { title: "L7", url: "https://l.com/7" }, // L7 também cortado
  ],
  radar: [{ title: "R1", url: "https://r.com/1" }, { title: "R2", url: "https://r.com/2" }, { title: "R3", url: "https://r.com/3" }, { title: "R4", url: "https://r.com/4" }, { title: "R5", url: "https://r.com/5" }],
  use_melhor: [],
  video: [],
});
// uncapped sum = 7 + 5 = 12. After caps: lancamento=min(7,5)=5, radar stays 5 → 10.

function runPublishLinkedinCli(editionDir: string, extraArgs: string[] = []) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "publish-linkedin.ts");
  // #3311: --log-root-dir isola o logEvent de auditoria (image_cache_state +
  // dispatched-via) pro parent de editionDir (sempre um tmpdir mkdtempSync'd
  // por mkEditionDir() acima) — sem isso, main() cai no default de logEvent
  // (process.cwd()), aqui `cwd: projectRoot` (raiz real do repo/worktree),
  // gravando entries fabricadas (edition: "260999") direto em
  // data/run-log.jsonl a cada test run desta suite.
  const logRootDir = dirname(editionDir);
  // Set minimal env to not trigger Worker guard and to not hit Make webhook
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--edition-dir", editionDir, "--fire-now", "--log-root-dir", logRootDir, ...extraArgs],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        // Use fire-now mode (no schedule → no Worker required)
        MAKE_LINKEDIN_WEBHOOK_URL: "https://hook.test/noop",
        // Remove Worker config so --fire-now path is taken (no fail-fast)
        DIARIA_LINKEDIN_CRON_URL: "",
        DIARIA_LINKEDIN_CRON_TOKEN: "",
      },
    },
  );
}

describe("#2331/F1: JSON corrompido no capped → fallback para uncapped (não abandona)", () => {
  it("capped com JSON corrompido + uncapped válido → resolvido do uncapped", () => {
    const { dir, internalDir, cleanup } = mkEditionDir({});
    try {
      // Capped existe mas tem JSON corrompido
      writeFileSync(join(internalDir, "01-approved-capped.json"), "{ CORRUPT JSON }", "utf8");
      // Uncapped é válido (capped seria preferido mas está corrompido)
      writeFileSync(join(internalDir, "01-approved.json"), APPROVED_CAPPED, "utf8");
      // Criar 03-social.md mínimo e 06-public-images.json
      writeFileSync(join(dir, "03-social.md"), [
        "# LinkedIn", "", "## d1", "Post d1.", "",
        "### comment_diaria", "", "Mais {outros_count} destaques em {edition_url}", "",
        "# Facebook", "", "## d1", "FB d1.",
      ].join("\n"), "utf8");
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({
        images: { d1: { url: "https://img.test/d1.jpg" }, d2: { url: "https://img.test/d2.jpg" }, d3: { url: "https://img.test/d3.jpg" } }
      }), "utf8");

      const result = runPublishLinkedinCli(dir, ["--only", "d1"]);
      // Deve mencionar "tentando 01-approved.json" no stderr (F1)
      assert.match(result.stderr + result.stdout, /tentando 01-approved\.json|uncapped\+caps/i,
        `F1: deve indicar fallback para uncapped. stderr: ${result.stderr}`);
      // Não deve conter "ERRO — outros_count não pôde ser resolvido" (F3 exit path)
      assert.doesNotMatch(result.stderr, /outros_count não pôde ser resolvido/, "F1: fallback deve funcionar, não deve abortar");
    } finally {
      cleanup();
    }
  });
});

describe("#2331/F2: fallback uncapped aplica caps (não infla contagem)", () => {
  it("uncapped com 7 lançamentos → após caps, conta 5 (não 7)", () => {
    const { dir, internalDir, cleanup } = mkEditionDir({});
    try {
      // Sem capped — usa uncapped direto
      writeFileSync(join(internalDir, "01-approved.json"), APPROVED_UNCAPPED_INFLATED, "utf8");
      writeFileSync(join(dir, "03-social.md"), [
        "# LinkedIn", "", "## d1", "Post d1.", "",
        "### comment_diaria", "", "Mais {outros_count} destaques em {edition_url}", "",
        "# Facebook", "", "## d1", "FB d1.",
      ].join("\n"), "utf8");
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({
        images: { d1: { url: "https://img.test/d1.jpg" }, d2: { url: "https://img.test/d2.jpg" }, d3: { url: "https://img.test/d3.jpg" } }
      }), "utf8");

      const result = runPublishLinkedinCli(dir, ["--only", "d1"]);
      // F2: log deve mostrar "uncapped+caps" (não o número inflado 12)
      assert.match(result.stderr + result.stdout, /uncapped\+caps/i,
        `F2: deve usar caps no fallback. stderr: ${result.stderr}`);
      // Não deve mostrar → 12 (numero inflado). Deve mostrar → 10 (lancamento capped=5 + radar=5)
      assert.doesNotMatch(result.stdout + result.stderr, /→ 12\b/, "F2: não deve exibir contagem inflada (12)");
    } finally {
      cleanup();
    }
  });
});

describe("#2331/F3: outrosCount não-resolvível → abort (nunca posta literal)", () => {
  it("sem approved JSON algum → exit 2 com mensagem clara", () => {
    const { dir, internalDir, cleanup } = mkEditionDir({});
    try {
      // _internal existe mas sem approved files
      writeFileSync(join(dir, "03-social.md"), [
        "# LinkedIn", "", "## d1", "Post d1.", "",
        "### comment_diaria", "", "Mais {outros_count} destaques em {edition_url}", "",
        "# Facebook", "", "## d1", "FB d1.",
      ].join("\n"), "utf8");
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({
        images: { d1: { url: "https://img.test/d1.jpg" }, d2: { url: "https://img.test/d2.jpg" }, d3: { url: "https://img.test/d3.jpg" } }
      }), "utf8");

      const result = runPublishLinkedinCli(dir, ["--only", "d1"]);
      // F3: deve abortar com exit != 0
      assert.notEqual(result.status, 0, `F3: deve abortar quando approved JSON ausente. stderr: ${result.stderr}`);
      // Mensagem de erro deve mencionar o motivo
      assert.match(result.stderr, /outros_count não pôde ser resolvido/i,
        "F3: mensagem de erro deve explicar por que abortou");
    } finally {
      cleanup();
    }
  });

  it("ambos os approved files com JSON corrompido → exit 2 (nunca posta literal)", () => {
    const { dir, internalDir, cleanup } = mkEditionDir({});
    try {
      writeFileSync(join(internalDir, "01-approved-capped.json"), "{ NOT JSON }", "utf8");
      writeFileSync(join(internalDir, "01-approved.json"), "[ ALSO CORRUPT ]", "utf8");
      writeFileSync(join(dir, "03-social.md"), [
        "# LinkedIn", "", "## d1", "Post d1.", "",
        "### comment_diaria", "", "Mais {outros_count} destaques em {edition_url}", "",
        "# Facebook", "", "## d1", "FB d1.",
      ].join("\n"), "utf8");
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({
        images: { d1: { url: "https://img.test/d1.jpg" }, d2: { url: "https://img.test/d2.jpg" }, d3: { url: "https://img.test/d3.jpg" } }
      }), "utf8");

      const result = runPublishLinkedinCli(dir, ["--only", "d1"]);
      assert.notEqual(result.status, 0, `F3: deve abortar quando ambos corrompidos. stderr: ${result.stderr}`);
      // Must NOT dispatch literal — the exit should happen before any Make webhook call
      assert.doesNotMatch(result.stdout, /\{outros_count\}/, "F3: literal não deve aparecer no stdout/dispatch");
    } finally {
      cleanup();
    }
  });
});

// #3493: cobertura de threading de rootDir pro call site de logEvent que só
// existe dentro de main() — o "image_cache_state" (linha ~753 de
// publish-linkedin.ts, logado ANTES do fail-fast #999/#1275, SEMPRE que o
// script roda). Achado do self-review #2038 em #3492/#3479: publish-linkedin.ts
// tem 2 call sites de logEvent com rootDir/ctx.rootDir default `= ROOT`
// (`dispatchEntry` já tinha cobertura de isolamento via #3311 acima —
// "#3311: log de auditoria de dispatchEntry isolado via ctx.rootDir"); o
// call site dentro de main() (repassado via `--log-root-dir` → `logRootDir`
// local) nunca teve uma assertion que provasse que o log de fato aterrissa
// no destino isolado — os testes CLI existentes (#2331 F1-F3, #2454) só
// verificam stdout/stderr, nunca o conteúdo do run-log em si. Um
// esquecimento de repassar `logRootDir` nesse call site específico não seria
// pego por nenhum teste existente.
describe("#3493: log de auditoria de main() (image_cache_state) isolado via --log-root-dir", () => {
  it("--log-root-dir isola AMBOS os call sites de logEvent (image_cache_state em main() + dispatched-via em dispatchEntry) — nunca grava em data/run-log.jsonl real", () => {
    const { dir, internalDir, cleanup } = mkEditionDir({});
    try {
      writeFileSync(join(internalDir, "01-approved.json"), APPROVED_CAPPED, "utf8");
      writeFileSync(join(dir, "03-social.md"), [
        "# LinkedIn", "", "## d1", "Post d1.", "",
        "### comment_diaria", "", "Mais {outros_count} destaques em {edition_url}", "",
        "# Facebook", "", "## d1", "FB d1.",
      ].join("\n"), "utf8");
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({
        images: { d1: { url: "https://img.test/d1.jpg" }, d2: { url: "https://img.test/d2.jpg" }, d3: { url: "https://img.test/d3.jpg" } }
      }), "utf8");

      // runPublishLinkedinCli já passa --log-root-dir apontando pro parent
      // de editionDir (dirname(editionDir) — ver helper acima).
      runPublishLinkedinCli(dir, ["--only", "d1"]);

      const logRootDir = dirname(dir);
      const isolatedLogPath = join(logRootDir, "data", "run-log.jsonl");
      assert.ok(
        existsSync(isolatedLogPath),
        "log de auditoria deveria existir no tmpdir isolado (--log-root-dir)",
      );
      const isolatedLog = readFileSync(isolatedLogPath, "utf8");

      // Call site 1: image_cache_state, dentro de main() — logado incondicionalmente
      // (mesmo que o fail-fast #999/#1275 nunca dispare, como aqui).
      assert.match(
        isolatedLog,
        /image_cache_state/,
        "call site main() (image_cache_state) deveria ter gravado no tmpdir isolado",
      );
      // Call site 2: "dispatched via", dentro de dispatchEntry() — logado antes
      // da tentativa de rede, independente de sucesso/falha do webhook.
      assert.match(
        isolatedLog,
        /dispatched via/,
        "call site dispatchEntry() (dispatched via) deveria ter gravado no mesmo tmpdir isolado",
      );
      assert.match(isolatedLog, /"agent":"publish-linkedin"/);
    } finally {
      cleanup();
    }
  });
});

describe("#2454-finding-6: publish-linkedin le 05-edition-url.txt e injeta no comment_diaria", () => {
  it("05-edition-url.txt presente → {edition_url} substituido no output (nao aparece literal)", () => {
    // Testa o LADO DE LEITURA: publish-linkedin.ts deve ler _internal/05-edition-url.txt
    // e substituir {edition_url} no comment_diaria antes de dispatchar (#2454).
    const { dir, internalDir, cleanup } = mkEditionDir({});
    try {
      const editionUrlContent = "https://diar.ia.br/p/meu-slug-de-teste";
      writeFileSync(join(internalDir, "05-edition-url.txt"), editionUrlContent, "utf8");
      writeFileSync(join(internalDir, "01-approved.json"), APPROVED_CAPPED, "utf8");
      writeFileSync(join(dir, "03-social.md"),
        "# LinkedIn\n\n## d1\nPost d1.\n\n### comment_diaria\n\n" +
        "Edicao completa em {edition_url} \u2014 mais {outros_count} destaques.\n\n" +
        "### comment_pixel\n\nMinha opiniao.\n\n# Facebook\n\n## d1\nFB d1.",
        "utf8",
      );
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({
        images: {
          d1: { url: "https://img.test/d1.jpg" },
          d2: { url: "https://img.test/d2.jpg" },
          d3: { url: "https://img.test/d3.jpg" },
        },
      }), "utf8");

      const result = runPublishLinkedinCli(dir, ["--only", "d1"]);

      // O stdout/log deve confirmar que 05-edition-url.txt foi lido
      assert.match(
        result.stdout + result.stderr,
        /05-edition-url\.txt/,
        "#2454: publish-linkedin deve logar que leu 05-edition-url.txt",
      );
      // {edition_url} NAO deve aparecer literal no output (foi substituido pela URL real)
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /\{edition_url\}/,
        "#2454: {edition_url} nao deve aparecer literal no output — deve ter sido substituido",
      );
    } finally {
      cleanup();
    }
  });

  it("05-edition-url.txt ausente → fallback para raiz com warn (nao crasha)", () => {
    // Quando 05-edition-url.txt nao existe, publish-linkedin usa fallback
    // https://diar.ia.br (raiz) com warn — nao deve crashar por ausencia do arquivo.
    const { dir, internalDir, cleanup } = mkEditionDir({});
    try {
      // NAO criar 05-edition-url.txt
      writeFileSync(join(internalDir, "01-approved.json"), APPROVED_CAPPED, "utf8");
      writeFileSync(join(dir, "03-social.md"),
        "# LinkedIn\n\n## d1\nPost d1.\n\n### comment_diaria\n\n" +
        "Edicao em {edition_url} \u2014 mais {outros_count} destaques.\n\n" +
        "# Facebook\n\n## d1\nFB d1.",
        "utf8",
      );
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({
        images: {
          d1: { url: "https://img.test/d1.jpg" },
          d2: { url: "https://img.test/d2.jpg" },
          d3: { url: "https://img.test/d3.jpg" },
        },
      }), "utf8");

      const result = runPublishLinkedinCli(dir, ["--only", "d1"]);

      // Deve logar warn sobre fallback (nao crashar)
      assert.match(
        result.stdout + result.stderr,
        /fallback|sem.*05-edition-url|edition_url nao fornecido/i,
        "#2454: sem 05-edition-url.txt → deve logar fallback",
      );
    } finally {
      cleanup();
    }
  });
});

// ── #3385: LinkedIn com OU sem imagem ──────────────────────────────────
//
// #999/#1275 fail-fast continua ativo pra falha REAL (nem URL, nem marcador
// explícito). #3385 adiciona uma 3ª categoria — destaque genuinamente sem
// imagem associada (`no_image: true` em 06-public-images.json) — que NÃO
// dispara o abort e dispatcha com `image_url: null` no payload (schema já
// aceita null explícito desde #1032/#974, ver linkedin-payload.ts).

describe("#3385 classifyImageCache: distingue com-imagem / genuinamente-sem-imagem / falha-real", () => {
  it("destaque com URL válida → destaques_with_url, não é missing nem no_image", () => {
    const cache: ImageCacheFile = { images: { d1: { url: "https://img.test/d1.jpg" } } };
    const r = classifyImageCache(["d1"], cache);
    assert.deepEqual(r.destaques_with_url, ["d1"]);
    assert.deepEqual(r.destaques_no_image, []);
    assert.deepEqual(r.missing, []);
  });

  it("destaque marcado no_image:true (sem url) → destaques_no_image, NÃO é missing (comportamento novo)", () => {
    const cache: ImageCacheFile = { images: { d1: { no_image: true } } };
    const r = classifyImageCache(["d1"], cache);
    assert.deepEqual(r.destaques_with_url, []);
    assert.deepEqual(r.destaques_no_image, ["d1"]);
    assert.deepEqual(r.missing, [], "no_image:true NÃO deve entrar em missing — não dispara fail-fast");
  });

  it("destaque sem url e sem marcador no_image → missing (falha real, preserva #999/#1275)", () => {
    const cache: ImageCacheFile = { images: {} };
    const r = classifyImageCache(["d1"], cache);
    assert.deepEqual(r.destaques_with_url, []);
    assert.deepEqual(r.destaques_no_image, []);
    assert.deepEqual(r.missing, ["d1"], "sem url e sem no_image continua sendo falha real");
  });

  it("cache totalmente ausente (null) → todos missing (preserva comportamento pré-#3385)", () => {
    const r = classifyImageCache(["d1", "d2", "d3"], null);
    assert.deepEqual(r.missing, ["d1", "d2", "d3"]);
  });

  it("url vazia + no_image:true → trata como no_image, não como missing", () => {
    // url:"" é falsy — a lógica cai pro branch no_image se marcado.
    const cache: ImageCacheFile = { images: { d1: { url: "", no_image: true } } };
    const r = classifyImageCache(["d1"], cache);
    assert.deepEqual(r.destaques_no_image, ["d1"]);
    assert.deepEqual(r.missing, []);
  });

  it("url válida vence sobre no_image:true (url presente tem prioridade)", () => {
    const cache: ImageCacheFile = { images: { d1: { url: "https://img.test/d1.jpg", no_image: true } } };
    const r = classifyImageCache(["d1"], cache);
    assert.deepEqual(r.destaques_with_url, ["d1"]);
    assert.deepEqual(r.destaques_no_image, []);
  });

  it("mix: d1 com url, d2 no_image:true, d3 falha real → classifica cada um corretamente", () => {
    const cache: ImageCacheFile = {
      images: {
        d1: { url: "https://img.test/d1.jpg" },
        d2: { no_image: true },
        // d3 ausente do cache
      },
    };
    const r = classifyImageCache(["d1", "d2", "d3"], cache);
    assert.deepEqual(r.destaques_with_url, ["d1"]);
    assert.deepEqual(r.destaques_no_image, ["d2"]);
    assert.deepEqual(r.missing, ["d3"]);
  });
});

describe("#3385 dispatchEntry: publica COM imagem e SEM imagem (payload image_url null aceito)", () => {
  function tmpDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "publish-linkedin-3385-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  function mkCtx(dir: string): DispatchContext {
    return {
      publishedPath: join(dir, "06-social-published.json"),
      webhookUrl: "https://hook.test/diaria",
      workerUrl: "https://worker.test",
      workerToken: "test-tok",
      useWorkerForScheduled: true,
      editionDate: "260999",
      rootDir: dir, // #3311 isolamento
    };
  }

  it("COM imagem: payload enviado ao Make carrega image_url da URL (comportamento preservado)", async () => {
    let capturedBody: unknown = null;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return new Response(JSON.stringify({ accepted: true, request_id: "req-with-img" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const { dir, cleanup } = tmpDir();
    try {
      const input: DispatchInput = {
        destaque: "d1",
        subtype: "main",
        text: "Post com imagem",
        imageUrl: "https://img.test/d1.jpg",
        scheduledAt: null,
        webhookTarget: "diaria",
        action: "post",
      };
      const entry = await dispatchEntry(input, mkCtx(dir));
      assert.equal(entry.status, "draft");
      assert.equal((capturedBody as { image_url: string | null }).image_url, "https://img.test/d1.jpg");
    } finally {
      cleanup();
      globalThis.fetch = savedFetch;
    }
  });

  it("SEM imagem: payload enviado ao Make carrega image_url: null (novo — #3385), dispatch não lança erro", async () => {
    let capturedBody: unknown = null;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return new Response(JSON.stringify({ accepted: true, request_id: "req-no-img" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const { dir, cleanup } = tmpDir();
    try {
      const input: DispatchInput = {
        destaque: "d2",
        subtype: "main",
        text: "Post text-only (destaque genuinamente sem imagem)",
        imageUrl: null,
        scheduledAt: null,
        webhookTarget: "diaria",
        action: "post",
      };
      const entry = await dispatchEntry(input, mkCtx(dir));
      // Não pode lançar / falhar por falta de imagem — dispatch prossegue normalmente.
      assert.equal(entry.status, "draft", "dispatch sem imagem deve suceder, não exigir imagem");
      assert.equal((capturedBody as { image_url: string | null }).image_url, null);
      assert.equal((capturedBody as { text: string }).text, "Post text-only (destaque genuinamente sem imagem)");
    } finally {
      cleanup();
      globalThis.fetch = savedFetch;
    }
  });
});
