/**
 * test/threads-personal-video-10772.test.ts (#10772)
 *
 * Vertical no Threads PESSOAL + refresh do token de 60 dias, com a Threads API
 * falsa por `fetch` injetado (nenhuma chamada real, nenhum token real):
 *   - container VIDEO → poll → publish feliz, com permalink;
 *   - erro da API no container / ERROR no processamento / timeout / 4xx e 5xx no publish;
 *   - vars ausentes → skip com a mensagem nomeando as vars e o Doppler;
 *   - texto do vertical no Threads (≤500, UTM threads);
 *   - refresh: decisão por vencimento, feliz (persiste token + vencimento), erro (transitório × perto de vencer), vencido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THREADS_PERSONAL_ENV,
  THREADS_PROFILE_DESTINATION,
  THREADS_VIDEO_POLL_ATTEMPTS,
  publishThreadsProfileVideo,
  readThreadsPersonalCreds,
  type ThreadsPersonalCreds,
} from "../scripts/lib/threads-personal-video.ts";
import {
  THREADS_PERSONAL_REFRESH_WHEN_REMAINING_MS,
  THREADS_PERSONAL_STALE_WHEN_REMAINING_MS,
  THREADS_TOKEN_LIFETIME_MS,
  decideThreadsPersonalRefresh,
  runThreadsPersonalTokenRefresh,
  type DopplerOutOfSyncMarker,
} from "../scripts/lib/threads-personal-token.ts";
import { buildShortSocialText, threadsTextLength } from "../scripts/lib/diaria/short-video.ts";
import {
  THREADS_TEXT_MAX_CHARS,
  ThreadsApiError,
  createThreadsContainer,
  refreshThreadsLongLivedToken,
  waitForThreadsContainer,
} from "../scripts/lib/threads-api.ts";
import { makeDopplerSet, type DopplerSpawn } from "../scripts/lib/secret-persist.ts";

const CREDS: ThreadsPersonalCreds = { accessToken: "tok-fake", userId: "999", apiVersion: "v1.0" };
const VIDEO = "https://shorts.example.com/261025-short.mp4";
const NOW = new Date("2026-10-25T12:00:00Z");
const DAY = 86_400_000;

interface Call {
  url: string;
  method: string;
  body: URLSearchParams | null;
  auth: string | null;
}

type Responder = (c: Call) => Response | Promise<Response>;

function fakeFetch(responder: Responder) {
  const calls: Call[] = [];
  const fn = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const c: Call = {
      url: input,
      method: init?.method ?? "GET",
      body: init?.body instanceof URLSearchParams ? init.body : null,
      auth: headers.get("authorization"),
    };
    calls.push(c);
    return responder(c);
  };
  return { fn, calls };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Threads API feliz: container → N polls IN_PROGRESS → FINISHED → publish → permalink. */
function happyApi(opts: { inProgressPolls?: number; publish?: Responder } = {}): Responder {
  let polls = 0;
  return (c) => {
    if (c.method === "POST" && c.url.endsWith("/999/threads")) return json({ id: "c-1" });
    if (c.method === "GET" && c.url.includes("/c-1?fields=status")) {
      polls++;
      return json({ status: polls > (opts.inProgressPolls ?? 1) ? "FINISHED" : "IN_PROGRESS" });
    }
    if (c.method === "POST" && c.url.endsWith("/999/threads_publish")) return opts.publish ? opts.publish(c) : json({ id: "m-1" });
    if (c.method === "GET" && c.url.includes("/m-1?fields=permalink")) return json({ permalink: "https://www.threads.com/@editor/post/abc" });
    throw new Error(`chamada inesperada ${c.method} ${c.url}`);
  };
}

const noSleep = async () => {};
const deps = (fn: ReturnType<typeof fakeFetch>["fn"]) => ({ fetch: fn, sleep: noSleep, now: () => NOW });

describe("publishThreadsProfileVideo (#10772)", () => {
  it("container VIDEO → espera FINISHED → publish, com permalink no registro", async () => {
    const f = fakeFetch(happyApi({ inProgressPolls: 2 }));
    const out = await publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "olá", deps: deps(f.fn) });
    assert.deepEqual(out.entry, {
      destination: THREADS_PROFILE_DESTINATION,
      status: "published",
      id: "m-1",
      url: "https://www.threads.com/@editor/post/abc",
      scheduled_at: null,
      at: NOW.toISOString(),
    });
    assert.equal(out.warnings, undefined);
    const create = f.calls[0];
    assert.equal(create.url, "https://graph.threads.net/v1.0/999/threads");
    assert.equal(create.body?.get("media_type"), "VIDEO");
    assert.equal(create.body?.get("video_url"), VIDEO);
    assert.equal(create.body?.get("text"), "olá");
    const publish = f.calls.find((c) => c.url.endsWith("/threads_publish"));
    assert.equal(publish?.body?.get("creation_id"), "c-1");
    // 3 polls (2 IN_PROGRESS + FINISHED) antes do publish — nunca publica container em processamento.
    assert.equal(f.calls.filter((c) => c.url.includes("fields=status")).length, 3);
    // GETs com token no header, nunca na URL (#7779/#7893).
    for (const c of f.calls.filter((c) => c.method === "GET")) {
      assert.equal(c.auth, "Bearer tok-fake");
      assert.ok(!c.url.includes("tok-fake"), `token na URL: ${c.url}`);
    }
  });

  it("erro da API no container lança e nada é publicado", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/threads") ? json({ error: { message: "Invalid parameter" } }, 400) : json({})));
    await assert.rejects(publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) }), /Threads \/threads HTTP 400/);
    assert.ok(!f.calls.some((c) => c.url.endsWith("/threads_publish")));
  });

  it("processamento com status=ERROR lança com a mensagem da Meta, sem publish", async () => {
    const f = fakeFetch((c) =>
      c.url.endsWith("/threads") ? json({ id: "c-1" }) : json({ status: "ERROR", error_message: "FAILED_DOWNLOADING_VIDEO" }),
    );
    await assert.rejects(publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) }), /status=ERROR: FAILED_DOWNLOADING_VIDEO/);
    assert.ok(!f.calls.some((c) => c.url.endsWith("/threads_publish")));
  });

  it("container que nunca fica FINISHED lança depois do teto de polls (vídeo não publica às cegas)", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/threads") ? json({ id: "c-1" }) : json({ status: "IN_PROGRESS" })));
    await assert.rejects(publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) }), /não ficou FINISHED/);
    assert.equal(f.calls.filter((c) => c.url.includes("fields=status")).length, THREADS_VIDEO_POLL_ATTEMPTS);
    assert.ok(!f.calls.some((c) => c.url.endsWith("/threads_publish")));
  });

  it("4xx no threads_publish lança (nada saiu, pode tentar de novo)", async () => {
    const f = fakeFetch(happyApi({ publish: () => json({ error: { message: "Media not found" } }, 400) }));
    await assert.rejects(publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) }), /threads_publish HTTP 400/);
  });

  it("5xx (incl. 500 exato), rede ou 2xx sem id usável no threads_publish vira send_unknown (não re-posta vídeo duplicado)", async () => {
    const ambiguous: Responder[] = [
      () => json({ error: { message: "boom" } }, 503),
      () => json({ error: { message: "boom" } }, 500),
      () => Promise.reject(new Error("socket hang up")),
      () => new Response("not json", { status: 200 }),
      () => json({ error: { message: "algo" } }, 200),
      () => json({}, 200),
    ];
    for (const publish of ambiguous) {
      const f = fakeFetch(happyApi({ publish }));
      const out = await publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) });
      assert.equal(out.entry.status, "send_unknown");
      assert.equal(out.entry.destination, THREADS_PROFILE_DESTINATION);
      // #11122: o allowlist de publish-shorts aceita threads_profile — o aviso aponta o --mark.
      assert.match(out.warnings?.[0] ?? "", /--mark threads_profile=URL/);
      assert.match(out.warnings?.[0] ?? "", /confer\w+ no perfil/);
    }
  });

  it("429 no threads_publish NÃO é ambíguo: lança", async () => {
    const f = fakeFetch(happyApi({ publish: () => json({ error: { message: "rate" } }, 429) }));
    await assert.rejects(publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) }), /threads_publish HTTP 429/);
  });

  it("container já PUBLISHED no poll: send_unknown sem chamar threads_publish", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/threads") ? json({ id: "c-1" }) : json({ status: "PUBLISHED" })));
    const out = await publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) });
    assert.equal(out.entry.status, "send_unknown");
    assert.ok(!f.calls.some((c) => c.url.endsWith("/threads_publish")));
  });

  it("4xx num poll de vídeo falha na hora; 401 também, sem esgotar os polls", async () => {
    for (const status of [400, 401, 404]) {
      const f = fakeFetch((c) => (c.url.endsWith("/threads") ? json({ id: "c-1" }) : json({ error: { message: "x", code: 190 } }, status)));
      await assert.rejects(
        publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) }),
        (e: unknown) => e instanceof ThreadsApiError && e.kind === "http" && e.httpStatus === status && !e.sendMayHaveSucceeded,
      );
      assert.equal(f.calls.filter((c) => c.url.includes("fields=status")).length, 1, `status ${status}`);
    }
  });

  it("timeout do poll leva o último status HTTP e o trecho do corpo das falhas", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/threads") ? json({ id: "c-1" }) : new Response("upstream down", { status: 502 })));
    await assert.rejects(
      publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) }),
      (e: unknown) =>
        e instanceof ThreadsApiError &&
        e.kind === "container_timeout" &&
        /última falha de poll: HTTP 502: upstream down/.test(e.message) &&
        /270s entre o 1º e o último poll/.test(e.message),
    );
  });

  it("sleeps: 30 s de espera inicial e 30 s entre polls", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch((c) => (c.url.endsWith("/threads") ? json({ id: "c-1" }) : json({ status: "IN_PROGRESS" })));
    await assert.rejects(
      publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: { fetch: f.fn, sleep: async (ms: number) => void sleeps.push(ms), now: () => NOW } }),
      /não ficou FINISHED/,
    );
    assert.deepEqual(sleeps, [30_000, ...Array(THREADS_VIDEO_POLL_ATTEMPTS - 1).fill(30_000)]);
  });

  it("POST container/publish passa AbortSignal (timeout de rede)", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const f = fakeFetch(happyApi());
    const fn = async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") signals.push(init.signal);
      return f.fn(input, init);
    };
    await publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: { fetch: fn, sleep: noSleep, now: () => NOW } });
    assert.equal(signals.length, 2);
    assert.ok(signals.every((s) => s instanceof AbortSignal));
  });

  it("recusa video_url que não é https público", async () => {
    const f = fakeFetch(happyApi());
    await assert.rejects(publishThreadsProfileVideo({ creds: CREDS, videoUrl: "file:///tmp/x.mp4", text: "x", deps: deps(f.fn) }), /https público/);
    assert.equal(f.calls.length, 0);
  });
});

describe("readThreadsPersonalCreds (#10772)", () => {
  it("vars ausentes → skip nomeando as duas vars e o Doppler diaria-studio/dev", () => {
    const r = readThreadsPersonalCreds({});
    assert.equal(r.ready, false);
    if (r.ready) return;
    assert.match(r.reason, /THREADS_PERSONAL_ACCESS_TOKEN e THREADS_PERSONAL_USER_ID/);
    assert.match(r.reason, /Doppler diaria-studio\/dev/);
  });

  it("só uma ausente → nomeia só ela; o token da página (THREADS_ACCESS_TOKEN) não serve de fallback", () => {
    const r = readThreadsPersonalCreds({ THREADS_ACCESS_TOKEN: "pagina", THREADS_USER_ID: "1", [THREADS_PERSONAL_ENV.userId]: "999" });
    assert.equal(r.ready, false);
    if (!r.ready) assert.match(r.reason, /^threads_profile pulado: THREADS_PERSONAL_ACCESS_TOKEN ausente/);
  });

  it("presentes → credenciais com a versão da API", () => {
    const r = readThreadsPersonalCreds({ [THREADS_PERSONAL_ENV.accessToken]: " tok ", [THREADS_PERSONAL_ENV.userId]: "999" });
    assert.deepEqual(r, { ready: true, creds: { accessToken: "tok", userId: "999", apiVersion: "v1.0" } });
  });
});

describe("buildShortSocialText — threads (#10772, #11617)", () => {
  it("título e gancho, sem link nem hashtags", () => {
    const t = buildShortSocialText({ platform: "threads", d1: { title: "Título do D1", body: "Primeira frase. Segunda." } });
    assert.equal(t, "Título do D1\n\nPrimeira frase.");
    assert.doesNotMatch(t, /https?:\/\/|utm_|youtu/, "#11617: sem link no texto do Threads");
    assert.ok(!t.includes("#IA"), "sem hashtags no Threads");
  });

  it("texto longo cabe em 500 (tira o gancho, depois corta o título)", () => {
    const t = buildShortSocialText({
      platform: "threads",
      d1: { title: "palavra ".repeat(80), body: "frase longa ".repeat(30) + "." },
    });
    assert.ok(Array.from(t).length <= THREADS_TEXT_MAX_CHARS, `tamanho ${Array.from(t).length}`);
    assert.ok(t.startsWith("palavra palavra"));
    assert.doesNotMatch(t, /https?:\/\//);
  });
});

describe("refresh do token do Threads pessoal (#10772)", () => {
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

  it("decisão: sem token pula; >30 dias pula; ≤30 renova; desconhecido renova; vencido não renova", () => {
    assert.deepEqual(decideThreadsPersonalRefresh({ accessToken: undefined, expiresAt: undefined, now: NOW }), { action: "skip_no_token" });
    assert.equal(decideThreadsPersonalRefresh({ accessToken: "t", expiresAt: iso(40 * DAY), now: NOW }).action, "skip_fresh");
    assert.equal(decideThreadsPersonalRefresh({ accessToken: "t", expiresAt: iso(THREADS_PERSONAL_REFRESH_WHEN_REMAINING_MS), now: NOW }).action, "refresh");
    assert.deepEqual(decideThreadsPersonalRefresh({ accessToken: " t ", expiresAt: "lixo", now: NOW }), { action: "refresh", token: "t", remainingMs: null });
    assert.equal(decideThreadsPersonalRefresh({ accessToken: "t", expiresAt: iso(-DAY), now: NOW }).action, "expired");
  });

  it("feliz: chama refresh_access_token com o token no header e persiste token + vencimento", async () => {
    const f = fakeFetch(() => json({ access_token: "tok-novo", token_type: "bearer", expires_in: 5_184_000 }));
    let persisted: Record<string, string> | null = null;
    const r = await runThreadsPersonalTokenRefresh({
      env: { [THREADS_PERSONAL_ENV.accessToken]: "tok-velho", [THREADS_PERSONAL_ENV.expiresAt]: iso(20 * DAY) },
      now: () => NOW,
      fetch: f.fn,
      persist: (s) => {
        persisted = s;
        return { dopplerFailed: [], dopplerErrors: [] };
      },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.outcome, "refreshed");
    assert.equal(f.calls[0].url, "https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token");
    assert.equal(f.calls[0].auth, "Bearer tok-velho");
    assert.deepEqual(persisted, {
      THREADS_PERSONAL_ACCESS_TOKEN: "tok-novo",
      THREADS_PERSONAL_TOKEN_EXPIRES_AT: new Date(NOW.getTime() + 5_184_000_000).toISOString(),
    });
    assert.ok(!r.message.includes("tok-"), "mensagem nunca carrega o token");
  });

  it("token ainda folgado: nenhuma chamada à API", async () => {
    const f = fakeFetch(() => json({}));
    const r = await runThreadsPersonalTokenRefresh({
      env: { [THREADS_PERSONAL_ENV.accessToken]: "t", [THREADS_PERSONAL_ENV.expiresAt]: iso(50 * DAY) },
      now: () => NOW,
      fetch: f.fn,
      persist: () => assert.fail("não deveria persistir"),
    });
    assert.equal(r.outcome, "skipped");
    assert.equal(f.calls.length, 0);
  });

  it("erro com folga (≥15 dias): exit 0, nada persistido, tenta amanhã", async () => {
    const f = fakeFetch(() => json({ error: { message: "token too new" } }, 400));
    const r = await runThreadsPersonalTokenRefresh({
      env: { [THREADS_PERSONAL_ENV.accessToken]: "t", [THREADS_PERSONAL_ENV.expiresAt]: iso(25 * DAY) },
      now: () => NOW,
      fetch: f.fn,
      persist: () => assert.fail("não deveria persistir"),
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.outcome, "failed");
    assert.match(r.message, /HTTP 400: token too new/);
  });

  it("erro perto de vencer ou com idade desconhecida: exit 1 (o editor precisa agir)", async () => {
    for (const expiresAt of [iso(10 * DAY), undefined]) {
      const f = fakeFetch(() => Promise.reject(new Error("ECONNRESET")));
      const r = await runThreadsPersonalTokenRefresh({
        env: { [THREADS_PERSONAL_ENV.accessToken]: "t", [THREADS_PERSONAL_ENV.expiresAt]: expiresAt },
        now: () => NOW,
        fetch: f.fn,
        persist: () => assert.fail("não deveria persistir"),
      });
      assert.equal(r.exitCode, 1, `expiresAt=${expiresAt}`);
      assert.match(r.message, /Renove à mão/);
    }
  });

  it("vencido: exit 1 sem chamar a API", async () => {
    const f = fakeFetch(() => json({}));
    const r = await runThreadsPersonalTokenRefresh({
      env: { [THREADS_PERSONAL_ENV.accessToken]: "t", [THREADS_PERSONAL_ENV.expiresAt]: iso(-1) },
      now: () => NOW,
      fetch: f.fn,
      persist: () => assert.fail("não deveria persistir"),
    });
    assert.equal(r.exitCode, 1);
    assert.equal(r.outcome, "expired");
    assert.equal(f.calls.length, 0);
  });

  it("Doppler recusou: exit 1 mesmo com o .env gravado", async () => {
    const f = fakeFetch(() => json({ access_token: "novo", expires_in: 100 }));
    const r = await runThreadsPersonalTokenRefresh({
      env: { [THREADS_PERSONAL_ENV.accessToken]: "t" },
      now: () => NOW,
      fetch: f.fn,
      persist: () => ({ dopplerFailed: ["THREADS_PERSONAL_ACCESS_TOKEN"], dopplerErrors: ["doppler login vencido"] }),
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /Doppler recusou THREADS_PERSONAL_ACCESS_TOKEN/);
  });

  it("sem token: exit 0 nomeando a var e o Doppler", async () => {
    const r = await runThreadsPersonalTokenRefresh({ env: {}, now: () => NOW, persist: () => assert.fail("não") });
    assert.equal(r.exitCode, 0);
    assert.match(r.message, /THREADS_PERSONAL_ACCESS_TOKEN ausente.*diaria-studio\/dev/);
  });
});

describe("cliente Threads API — fleet review (#10772)", () => {
  it("waitForThreadsContainer com EXPIRED rejeita após 1 fetch, nos caminhos texto (continue) e vídeo (throw)", async () => {
    for (const onTimeout of ["continue", "throw"] as const) {
      const f = fakeFetch(() => json({ status: "EXPIRED", error_message: "expirou" }));
      await assert.rejects(
        waitForThreadsContainer("c-9", "tok", "v1.0", { maxAttempts: 10, intervalMs: 1, onTimeout, sleep: noSleep, fetchFn: f.fn }),
        (e: unknown) => e instanceof ThreadsApiError && e.kind === "container_failed" && /status=EXPIRED: expirou/.test(e.message) && !e.sendMayHaveSucceeded,
      );
      assert.equal(f.calls.length, 1, onTimeout);
    }
  });

  it("caminho texto: 4xx genérico num poll segue best-effort; 401 é fatal", async () => {
    const f404 = fakeFetch(() => json({ error: { message: "not found" } }, 404));
    assert.equal(await waitForThreadsContainer("c", "t", "v1.0", { maxAttempts: 3, intervalMs: 1, onTimeout: "continue", sleep: noSleep, fetchFn: f404.fn }), "timeout");
    assert.equal(f404.calls.length, 3);
    const f401 = fakeFetch(() => json({ error: { message: "bad token" } }, 401));
    await assert.rejects(waitForThreadsContainer("c", "t", "v1.0", { maxAttempts: 3, intervalMs: 1, onTimeout: "continue", sleep: noSleep, fetchFn: f401.fn }), /poll HTTP 401/);
    assert.equal(f401.calls.length, 1);
  });

  it("PUBLISHED é terminal no poll", async () => {
    const f = fakeFetch(() => json({ status: "PUBLISHED" }));
    assert.equal(await waitForThreadsContainer("c", "t", "v1.0", { maxAttempts: 5, intervalMs: 1, onTimeout: "throw", sleep: noSleep, fetchFn: f.fn }), "published");
    assert.equal(f.calls.length, 1);
  });

  it("createThreadsContainer TEXT: media_type=TEXT, sem video_url, reply_to_id só quando passado", async () => {
    for (const replyToId of ["p-1", null, undefined]) {
      const f = fakeFetch(() => json({ id: "c-1" }));
      const id = await createThreadsContainer("999", "tok", { mediaType: "TEXT", text: "olá", replyToId }, "v1.0", f.fn);
      assert.equal(id, "c-1");
      const body = f.calls[0].body!;
      assert.equal(f.calls[0].url, "https://graph.threads.net/v1.0/999/threads");
      assert.equal(body.get("media_type"), "TEXT");
      assert.equal(body.get("text"), "olá");
      assert.equal(body.has("video_url"), false);
      assert.equal(body.get("reply_to_id"), replyToId ?? null);
    }
  });

  it("ThreadsApiError.sendMayHaveSucceeded: só network, malformed_ok e http>=500", () => {
    assert.equal(new ThreadsApiError("x", "network").sendMayHaveSucceeded, true);
    assert.equal(new ThreadsApiError("x", "malformed_ok", 200).sendMayHaveSucceeded, true);
    assert.equal(new ThreadsApiError("x", "http", 500).sendMayHaveSucceeded, true);
    assert.equal(new ThreadsApiError("x", "http", 499).sendMayHaveSucceeded, false);
    assert.equal(new ThreadsApiError("x", "http", 429).sendMayHaveSucceeded, false);
    assert.equal(new ThreadsApiError("x", "api_error", 200).sendMayHaveSucceeded, false);
    assert.equal(new ThreadsApiError("x", "container_failed").sendMayHaveSucceeded, false);
    assert.equal(new ThreadsApiError("x", "container_timeout").sendMayHaveSucceeded, false);
  });

  it("refresh: 200 sem access_token dá ok:false (e não é '<24h')", async () => {
    const f = fakeFetch(() => json({ token_type: "bearer" }));
    const r = await refreshThreadsLongLivedToken("tok", f.fn);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 200);
      assert.equal(r.tooYoung, false);
      assert.match(r.reason, /sem access_token/);
    }
  });

  it("threadsTextLength: emoji pesa os bytes UTF-8, o resto 1 por code point", () => {
    assert.equal(threadsTextLength("abc"), 3);
    assert.equal(threadsTextLength("ação"), 4);
    assert.equal(threadsTextLength("🤖"), 4);
    assert.equal(threadsTextLength("a🤖b"), 6);
  });
});

describe("refresh do token — fleet review (#10772)", () => {
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  const okPersist = () => ({ dopplerFailed: [], dopplerErrors: [] });
  const failPersist = () => ({ dopplerFailed: ["THREADS_PERSONAL_ACCESS_TOKEN"], dopplerErrors: ["doppler: command not found"] });
  function memMarker(initial: DopplerOutOfSyncMarker | null = null) {
    let m = initial;
    return { get: () => m, dep: { read: () => m, write: (x: DopplerOutOfSyncMarker) => void (m = x), clear: () => void (m = null) } };
  }

  it("fronteira de 15 dias: exatamente 15d alerta (exit 1); 15d + 1ms não", async () => {
    for (const [remaining, exit] of [[THREADS_PERSONAL_STALE_WHEN_REMAINING_MS, 1], [THREADS_PERSONAL_STALE_WHEN_REMAINING_MS + 1, 0]] as const) {
      const f = fakeFetch(() => json({ error: { message: "erro qualquer" } }, 400));
      const r = await runThreadsPersonalTokenRefresh({
        env: { [THREADS_PERSONAL_ENV.accessToken]: "t", [THREADS_PERSONAL_ENV.expiresAt]: iso(remaining) },
        now: () => NOW,
        fetch: f.fn,
        persist: () => assert.fail("não deveria persistir"),
      });
      assert.equal(r.exitCode, exit, `remaining=${remaining}`);
    }
  });

  it("expires_in ausente, 0 ou NaN: vencimento cai no default de 60 dias", async () => {
    for (const body of [{ access_token: "novo" }, { access_token: "novo", expires_in: 0 }, { access_token: "novo", expires_in: "NaN" }]) {
      const f = fakeFetch(() => json(body));
      let persisted: Record<string, string> = {};
      await runThreadsPersonalTokenRefresh({
        env: { [THREADS_PERSONAL_ENV.accessToken]: "t" },
        now: () => NOW,
        fetch: f.fn,
        persist: (s) => {
          persisted = s;
          return okPersist();
        },
      });
      assert.equal(persisted[THREADS_PERSONAL_ENV.expiresAt], new Date(NOW.getTime() + THREADS_TOKEN_LIFETIME_MS).toISOString(), JSON.stringify(body));
    }
  });

  it("recusa '<24h' da Meta com idade desconhecida: exit 0 com aviso, sem escalar", async () => {
    const f = fakeFetch(() => json({ error: { message: "Token must be at least 24 hours old" } }, 400));
    const r = await runThreadsPersonalTokenRefresh({ env: { [THREADS_PERSONAL_ENV.accessToken]: "t" }, now: () => NOW, fetch: f.fn, persist: () => assert.fail("não") });
    assert.equal(r.exitCode, 0);
    assert.match(r.message, /menos de 24h/);
  });

  it("user id configurado sem o token neste host: exit 1; sem nenhuma das duas: exit 0", async () => {
    const r1 = await runThreadsPersonalTokenRefresh({ env: { [THREADS_PERSONAL_ENV.userId]: "999" }, now: () => NOW, persist: () => assert.fail("não") });
    assert.equal(r1.exitCode, 1);
    assert.match(r1.message, /ausente neste host/);
    const r0 = await runThreadsPersonalTokenRefresh({ env: {}, now: () => NOW, persist: () => assert.fail("não") });
    assert.equal(r0.exitCode, 0);
  });

  it("Doppler recusou: grava marcador; execuções seguintes (mesmo com token folgado) seguem exit 1 até o Doppler aceitar", async () => {
    const mk = memMarker();
    const f = fakeFetch(() => json({ access_token: "novo", expires_in: 5_184_000 }));
    const r1 = await runThreadsPersonalTokenRefresh({ env: { [THREADS_PERSONAL_ENV.accessToken]: "t" }, now: () => NOW, fetch: f.fn, persist: failPersist, marker: mk.dep });
    assert.equal(r1.exitCode, 1);
    assert.ok(mk.get(), "marcador gravado");
    assert.match(r1.message, /LocalOnlyEnvKeysError/);

    const freshEnv = { [THREADS_PERSONAL_ENV.accessToken]: "novo", [THREADS_PERSONAL_ENV.expiresAt]: iso(59 * DAY) };
    const r2 = await runThreadsPersonalTokenRefresh({ env: freshEnv, now: () => NOW, persist: failPersist, marker: mk.dep });
    assert.equal(r2.exitCode, 1);
    assert.equal(r2.outcome, "doppler_out_of_sync");
    assert.equal(mk.get()?.since, NOW.toISOString(), "since preservado");

    let resynced: Record<string, string> | null = null;
    const r3 = await runThreadsPersonalTokenRefresh({
      env: freshEnv,
      now: () => NOW,
      persist: (s) => {
        resynced = s;
        return okPersist();
      },
      marker: mk.dep,
    });
    assert.equal(r3.exitCode, 0);
    assert.equal(mk.get(), null, "marcador limpo");
    assert.deepEqual(resynced, { THREADS_PERSONAL_ACCESS_TOKEN: "novo", THREADS_PERSONAL_TOKEN_EXPIRES_AT: freshEnv[THREADS_PERSONAL_ENV.expiresAt] });
    assert.ok(!r3.message.includes("novo"), "mensagem nunca carrega o token");
  });

  it("refresh bem-sucedido limpa marcador antigo", async () => {
    const mk = memMarker({ since: "2026-10-01T00:00:00.000Z", keys: ["x"], errors: [] });
    const f = fakeFetch(() => json({ access_token: "novo", expires_in: 5_184_000 }));
    const r = await runThreadsPersonalTokenRefresh({ env: { [THREADS_PERSONAL_ENV.accessToken]: "t" }, now: () => NOW, fetch: f.fn, persist: okPersist, marker: mk.dep });
    assert.equal(r.exitCode, 0);
    assert.equal(mk.get(), null);
  });
});

describe("makeDopplerSet — resolução do binário (#10772, mesma do sync-env #8795)", () => {
  type Spawned = { bin: string; shell: boolean; input: string };
  function spawnRec(results: Record<string, ReturnType<DopplerSpawn>>) {
    const calls: Spawned[] = [];
    const spawn: DopplerSpawn = (bin, _args, opts) => {
      calls.push({ bin, shell: opts.shell, input: opts.input });
      return results[bin] ?? { status: 0, stderr: "" };
    };
    return { calls, spawn };
  }
  const enoent = { error: Object.assign(new Error("spawn doppler ENOENT"), { code: "ENOENT" }), status: null, stderr: "" };

  it("PATH ok: usa `doppler`, valor pelo stdin", () => {
    const s = spawnRec({});
    const r = makeDopplerSet({ spawn: s.spawn, env: {}, fallbackPath: "/h/.local/bin/doppler", exists: () => true, platform: "linux" })("K", "v");
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(s.calls, [{ bin: "doppler", shell: false, input: "v" }]);
  });

  it("ENOENT no PATH: cai em ~/.local/bin/doppler quando existe", () => {
    const s = spawnRec({ doppler: enoent });
    const r = makeDopplerSet({ spawn: s.spawn, env: {}, fallbackPath: "/h/.local/bin/doppler", exists: () => true, platform: "linux" })("K", "v");
    assert.equal(r.ok, true);
    assert.deepEqual(s.calls.map((c) => c.bin), ["doppler", "/h/.local/bin/doppler"]);
  });

  it("ENOENT sem fallback: falha com a mensagem do erro", () => {
    const s = spawnRec({ doppler: enoent });
    const r = makeDopplerSet({ spawn: s.spawn, env: {}, fallbackPath: "/h/.local/bin/doppler", exists: () => false, platform: "linux" })("K", "v");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /ENOENT/);
    assert.equal(s.calls.length, 1);
  });

  it("DOPPLER_BIN: só ele, sem PATH nem fallback", () => {
    const s = spawnRec({ "/opt/doppler": { status: 1, stderr: "login vencido" } });
    const r = makeDopplerSet({ spawn: s.spawn, env: { DOPPLER_BIN: "/opt/doppler" }, fallbackPath: "/h/.local/bin/doppler", exists: () => true, platform: "linux" })("K", "v");
    assert.deepEqual(r, { ok: false, error: "login vencido" });
    assert.deepEqual(s.calls.map((c) => c.bin), ["/opt/doppler"]);
  });

  it("#11415: passa --project diaria-studio --config dev explícitos (não depende do `doppler setup` do cwd)", () => {
    const seen: string[][] = [];
    const spawn: DopplerSpawn = (_bin, args) => {
      seen.push(args);
      return { status: 0, stderr: "" };
    };
    makeDopplerSet({ spawn, env: {}, exists: () => false, platform: "linux" })("THREADS_PERSONAL_ACCESS_TOKEN", "segredo");
    assert.equal(seen.length, 1);
    const args = seen[0];
    assert.deepEqual(args.slice(0, 4), ["secrets", "set", "THREADS_PERSONAL_ACCESS_TOKEN", "--silent"]);
    assert.equal(args[args.indexOf("--project") + 1], "diaria-studio");
    assert.equal(args[args.indexOf("--config") + 1], "dev");
    assert.ok(!args.includes("segredo"), "valor nunca na linha de comando");
  });

  it("Windows: `doppler` do PATH roda com shell (resolve .cmd/.exe), como antes", () => {
    const s = spawnRec({});
    makeDopplerSet({ spawn: s.spawn, env: {}, platform: "win32", exists: () => false })("K", "v");
    assert.equal(s.calls[0].shell, true);
  });
});
