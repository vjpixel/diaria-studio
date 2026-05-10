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
  type DispatchContext,
  type DispatchInput,
} from "../scripts/publish-linkedin.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
