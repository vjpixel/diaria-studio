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
  decideThreadsPersonalRefresh,
  runThreadsPersonalTokenRefresh,
} from "../scripts/lib/threads-personal-token.ts";
import { buildShortSocialText } from "../scripts/lib/diaria/short-video.ts";
import { THREADS_TEXT_MAX_CHARS } from "../scripts/lib/threads-api.ts";

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

  it("5xx ou rede no threads_publish vira send_unknown (não re-posta vídeo duplicado)", async () => {
    for (const publish of [() => json({ error: { message: "boom" } }, 503), () => Promise.reject(new Error("socket hang up"))]) {
      const f = fakeFetch(happyApi({ publish }));
      const out = await publishThreadsProfileVideo({ creds: CREDS, videoUrl: VIDEO, text: "x", deps: deps(f.fn) });
      assert.equal(out.entry.status, "send_unknown");
      assert.equal(out.entry.destination, THREADS_PROFILE_DESTINATION);
      assert.match(out.warnings?.[0] ?? "", /--mark threads_profile=URL/);
    }
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

describe("buildShortSocialText — threads (#10772)", () => {
  const EDITION = "https://diar.ia.br/p/edicao-261025";
  it("título, gancho, vídeo e edição com utm_source=threads", () => {
    const t = buildShortSocialText({
      platform: "threads",
      aammdd: "261025",
      d1: { title: "Título do D1", body: "Primeira frase. Segunda." },
      editionUrl: EDITION,
      videoUrl: "https://youtu.be/abc",
    });
    assert.match(t, /^Título do D1\n\nPrimeira frase\./);
    assert.match(t, /Vídeo completo no YouTube: https:\/\/youtu\.be\/abc/);
    assert.match(t, /utm_source=threads&utm_medium=video&utm_campaign=261025/);
    assert.ok(!t.includes("#IA"), "sem hashtags no Threads");
  });

  it("texto longo cabe em 500 (tira o gancho, depois corta o título)", () => {
    const t = buildShortSocialText({
      platform: "threads",
      aammdd: "261025",
      d1: { title: "palavra ".repeat(80), body: "frase longa ".repeat(30) + "." },
      editionUrl: EDITION,
      videoUrl: null,
    });
    assert.ok(Array.from(t).length <= THREADS_TEXT_MAX_CHARS, `tamanho ${Array.from(t).length}`);
    assert.match(t, /Edição completa: /);
  });
});

describe("refresh do token do Threads pessoal (#10772)", () => {
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

  it("decisão: sem token pula; >30 dias pula; ≤30 renova; desconhecido renova; vencido não renova", () => {
    assert.deepEqual(decideThreadsPersonalRefresh({ accessToken: undefined, expiresAt: undefined, now: NOW }), { action: "skip_no_token" });
    assert.equal(decideThreadsPersonalRefresh({ accessToken: "t", expiresAt: iso(40 * DAY), now: NOW }).action, "skip_fresh");
    assert.equal(decideThreadsPersonalRefresh({ accessToken: "t", expiresAt: iso(THREADS_PERSONAL_REFRESH_WHEN_REMAINING_MS), now: NOW }).action, "refresh");
    assert.deepEqual(decideThreadsPersonalRefresh({ accessToken: "t", expiresAt: "lixo", now: NOW }), { action: "refresh", remainingMs: null });
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
