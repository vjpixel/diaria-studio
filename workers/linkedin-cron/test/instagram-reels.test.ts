/**
 * instagram-reels.test.ts (#10823)
 *
 * Reels agendado pela fila do Worker `diaria-linkedin-cron`, inclusive na 2ª
 * conta do Instagram (a vinculada à página VJ pixel, `ig_account: "vjpixel"`).
 * Ver `src/dispatch.ts` (fireInstagramReels, resolveInstagramVjpixelCreds,
 * conta por entry em fireQueueEntry) e `src/index.ts` (validateReelsFields no
 * enqueue, destaque `shorts`).
 *
 * Mesmo padrão de mocks de test/instagram-carousel.test.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, type QueueEntry, CLAIM_TTL_MS, FETCH_TIMEOUT_MS } from "../src/index.ts";
import {
  fireQueueEntry,
  resolveInstagramVjpixelCreds,
  REELS_POLL_DEADLINE_MS,
  REELS_VERIFY_FETCH_TIMEOUT_MS,
  type FireConfig,
} from "../src/dispatch.ts";

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
  async list(opts: { prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: true }> {
    const names = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
}

function mkEnv(overrides: Partial<Env> = {}): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig-diaria",
    INSTAGRAM_ACCESS_TOKEN: "token-diaria",
    ...overrides,
  } as Env;
  return { env, kv };
}

const VJPIXEL = { INSTAGRAM_VJPIXEL_ACCOUNT_ID: "ig-vjpixel", INSTAGRAM_VJPIXEL_ACCESS_TOKEN: "token-vjpixel" };

function enqueue(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const req = new Request("https://w.test/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
    body: JSON.stringify(payload),
  });
  return workerDefault.fetch(req, env) as Promise<Response>;
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const reelsPayload = (over: Record<string, unknown> = {}) => ({
  text: "O vídeo de hoje",
  scheduled_at: future(),
  destaque: "shorts",
  channel: "instagram",
  media_type: "REELS",
  video_url: "https://eia.diar.ia.br/video/261022-short.mp4",
  ...over,
});

function reelsEntry(over: Partial<QueueEntry> = {}): QueueEntry {
  const past = new Date(Date.now() - 60_000).toISOString();
  return {
    text: "O vídeo de hoje",
    image_url: null,
    scheduled_at: past,
    destaque: "shorts",
    created_at: past,
    retry_count: 0,
    channel: "instagram",
    media_type: "REELS",
    video_url: "https://eia.diar.ia.br/video/261022-short.mp4",
    ...over,
  };
}

const baseConfig = (over: Partial<FireConfig> = {}): FireConfig => ({
  webhookUrl: "https://make.test/diaria",
  instagram: { igUserId: "ig-diaria", accessToken: "token-diaria", apiVersion: "v25.0" },
  instagramVjpixel: { igUserId: "ig-vjpixel", accessToken: "token-vjpixel", apiVersion: "v25.0" },
  reelsPollIntervalMs: 0,
  ...over,
});

type Call = { url: string; body: string; headers?: Record<string, string> };

/** #10877 — URL da lista de mídias da conta (busca de dedup antes do container). */
const isMediaList = (u: string) => /\/media\?fields=/.test(u);

function mockGraph(statusSequence: string[], mediaList: unknown = { data: [] }): Call[] {
  const calls: Call[] = [];
  let poll = 0;
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    calls.push({ url: u, body, headers: init?.headers as Record<string, string> | undefined });
    if (isMediaList(u)) return new Response(JSON.stringify(mediaList), { status: 200 });
    if (u.endsWith("/media_publish")) return new Response(JSON.stringify({ id: "reel-media-id" }), { status: 200 });
    if (u.includes("status_code")) {
      const st = statusSequence[Math.min(poll++, statusSequence.length - 1)];
      return new Response(JSON.stringify({ status_code: st }), { status: 200 });
    }
    if (u.endsWith("/media")) return new Response(JSON.stringify({ id: "reel-container" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return calls;
}

describe("#10823 Reels: disparo pela fila", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("cria container REELS com video_url + collaborators, espera FINISHED e publica na conta vjpixel", async () => {
    const calls = mockGraph(["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]);
    const out = await fireQueueEntry(
      reelsEntry({ ig_account: "vjpixel", collaborators: ["diar.ia.br"], cover_url: "https://cdn.test/cover.jpg" }),
      baseConfig(),
    );
    assert.deepEqual(out, { status: "fired" });

    const create = calls.find((c) => c.url.endsWith("/media"));
    assert.ok(create, "deve criar o container");
    assert.match(create!.url, /\/ig-vjpixel\/media$/, "publica na conta vjpixel, não na diar.ia.br");
    const params = new URLSearchParams(create!.body);
    assert.equal(params.get("cover_url"), "https://cdn.test/cover.jpg");
    assert.equal(params.get("media_type"), "REELS");
    assert.equal(params.get("video_url"), "https://eia.diar.ia.br/video/261022-short.mp4");
    assert.equal(params.get("share_to_feed"), "true");
    assert.equal(params.get("collaborators"), JSON.stringify(["diar.ia.br"]));
    assert.equal(params.get("access_token"), "token-vjpixel");
    assert.equal(params.get("image_url"), null);

    const polls = calls.filter((c) => c.url.includes("status_code"));
    assert.equal(polls.length, 3, "poll até FINISHED");
    assert.ok(polls.every((c) => !c.url.includes("token-vjpixel")), "token nunca vai na query do poll (#7779)");

    const publish = calls.find((c) => c.url.endsWith("/media_publish"));
    assert.ok(publish);
    assert.match(publish!.url, /\/ig-vjpixel\/media_publish$/);
    assert.match(publish!.body, /creation_id=reel-container/);
    // publish só depois do último poll
    assert.ok(calls.indexOf(publish!) > calls.indexOf(polls[polls.length - 1]));
  });

  it("sem ig_account publica na conta da diar.ia.br (backward-compat) e sem collaborators omite o campo", async () => {
    const calls = mockGraph(["FINISHED"]);
    const out = await fireQueueEntry(reelsEntry(), baseConfig());
    assert.deepEqual(out, { status: "fired" });
    const create = calls.find((c) => c.url.endsWith("/media"))!;
    assert.match(create.url, /\/ig-diaria\/media$/);
    assert.equal(new URLSearchParams(create.body).get("collaborators"), null);
  });

  it("container ERROR → DLQ, nunca chama media_publish", async () => {
    const calls = mockGraph(["ERROR"]);
    const out = await fireQueueEntry(reelsEntry(), baseConfig());
    assert.equal(out.status, "dlq");
    assert.equal(calls.filter((c) => c.url.endsWith("/media_publish")).length, 0);
  });

  it("container que nunca fica FINISHED → failed (retry normal), nunca publica", async () => {
    const calls = mockGraph(["IN_PROGRESS"]);
    const out = await fireQueueEntry(reelsEntry(), baseConfig());
    assert.equal(out.status, "failed");
    assert.equal(calls.filter((c) => c.url.endsWith("/media_publish")).length, 0);
  });

  // #10856 self-review (P2) — sem teto TOTAL, o pior caso do poll (todo
  // fetch de status esperando o FETCH_TIMEOUT_MS) passava de 20 min, acima do
  // CLAIM_TTL_MS da fila: o claim expirava com o 1º disparo ainda no poll e
  // outra volta re-disparava o mesmo Reels. Sem o teto, os dois testes abaixo
  // estouram o timeout do próprio teste (30 s por fetch / 10 s por intervalo).
  it("teto total: status que nunca responde → failed rápido, sem publicar", { timeout: 10_000 }, async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push({ url: u, body: String(init?.body ?? "") });
      if (isMediaList(u)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.includes("status_code")) {
        // Simula a Graph pendurada: só termina quando o signal aborta.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }
      if (u.endsWith("/media_publish")) return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      return new Response(JSON.stringify({ id: "reel-container" }), { status: 200 });
    }) as typeof fetch;
    const t0 = Date.now();
    const out = await fireQueueEntry(reelsEntry(), baseConfig({ reelsPollDeadlineMs: 200 }));
    assert.equal(out.status, "failed", "estouro do teto é retentável, nunca DLQ");
    assert.match((out as { reason: string }).reason, /teto total/);
    assert.equal(calls.filter((c) => c.url.endsWith("/media_publish")).length, 0, "nunca publica");
    assert.ok(Date.now() - t0 < 5_000, `poll deveria parar no teto, levou ${Date.now() - t0}ms`);
  });

  it("teto total: a espera entre polls também respeita o teto", { timeout: 10_000 }, async () => {
    const calls = mockGraph(["IN_PROGRESS"]);
    const t0 = Date.now();
    const out = await fireQueueEntry(
      reelsEntry(),
      baseConfig({ reelsPollIntervalMs: 100, reelsPollDeadlineMs: 150 }),
    );
    assert.equal(out.status, "failed");
    assert.match((out as { reason: string }).reason, /teto total/);
    assert.equal(calls.filter((c) => c.url.endsWith("/media_publish")).length, 0);
    const polls = calls.filter((c) => c.url.includes("status_code")).length;
    assert.ok(polls < 36, `parou no teto antes de esgotar as tentativas (${polls} polls)`);
    assert.ok(Date.now() - t0 < 2_000, `levou ${Date.now() - t0}ms`);
  });

  it("teto de produção: dedup + criação + poll + publish + conferência cabem no CLAIM_TTL_MS com margem", () => {
    // #10877: busca de dedup antes do container e conferência do container
    // depois de um media_publish que falhou entram no pior caso.
    const worstCase =
      REELS_VERIFY_FETCH_TIMEOUT_MS + FETCH_TIMEOUT_MS + REELS_POLL_DEADLINE_MS + FETCH_TIMEOUT_MS + REELS_VERIFY_FETCH_TIMEOUT_MS;
    assert.ok(worstCase <= CLAIM_TTL_MS - 30_000, `pior caso ${worstCase}ms sem 30 s de margem sobre CLAIM_TTL_MS ${CLAIM_TTL_MS}ms`);
  });

  it("ig_account=vjpixel sem credencial no disparo → DLQ com motivo claro, sem nenhuma chamada", async () => {
    const calls = mockGraph(["FINISHED"]);
    const out = await fireQueueEntry(reelsEntry({ ig_account: "vjpixel" }), baseConfig({ instagramVjpixel: undefined }));
    assert.equal(out.status, "dlq");
    assert.match((out as { reason: string }).reason, /INSTAGRAM_VJPIXEL_ACCOUNT_ID/);
    assert.equal(calls.length, 0);
  });

  it("imagem na conta vjpixel usa o caminho de imagem com o token da vjpixel", async () => {
    const calls = mockGraph(["FINISHED"]);
    const out = await fireQueueEntry(
      { ...reelsEntry({ ig_account: "vjpixel" }), media_type: undefined, video_url: undefined, image_url: "https://x.test/a.jpg" },
      baseConfig(),
    );
    assert.deepEqual(out, { status: "fired" });
    const create = calls.find((c) => c.url.endsWith("/media"))!;
    assert.match(create.url, /\/ig-vjpixel\/media$/);
    assert.equal(new URLSearchParams(create.body).get("image_url"), "https://x.test/a.jpg");
  });
});

describe("#10823 Reels: validação no enqueue", () => {
  it("aceita Reels na conta vjpixel com credencial, persiste os campos e destaque=shorts", async () => {
    const { env, kv } = mkEnv(VJPIXEL);
    const res = await enqueue(env, reelsPayload({ ig_account: "vjpixel", collaborators: ["diar.ia.br"], cover_url: "https://cdn.test/cover.jpg" }));
    assert.equal(res.status, 202, await res.clone().text());
    const [stored] = [...kv.store.values()].map((v) => JSON.parse(v) as QueueEntry);
    assert.equal(stored.cover_url, "https://cdn.test/cover.jpg");
    assert.equal(stored.media_type, "REELS");
    assert.equal(stored.video_url, "https://eia.diar.ia.br/video/261022-short.mp4");
    assert.deepEqual(stored.collaborators, ["diar.ia.br"]);
    assert.equal(stored.ig_account, "vjpixel");
    assert.equal(stored.image_url, null);
  });

  it("ig_account=vjpixel sem credencial → 400 instagram_account_creds_missing, nada enfileirado", async () => {
    const { env, kv } = mkEnv();
    const res = await enqueue(env, reelsPayload({ ig_account: "vjpixel" }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "instagram_account_creds_missing");
    assert.equal(kv.store.size, 0);
  });

  const rejects: Array<[string, Record<string, unknown>, RegExp]> = [
    ["REELS fora do Instagram", { channel: "threads" }, /requires channel='instagram'/],
    ["REELS sem video_url", { video_url: undefined }, /video_url is required/],
    ["REELS com cover_url http", { cover_url: "http://x.test/c.jpg" }, /cover_url requires REELS/],
    ["REELS com video_url http", { video_url: "http://x.test/v.mp4" }, /public https URL/],
    ["REELS com image_url", { image_url: "https://x.test/a.jpg" }, /does not take image_url/],
    ["media_type desconhecido", { media_type: "VIDEO" }, /media_type must be 'REELS'/],
    ["video_url sem REELS", { media_type: undefined, image_url: "https://x.test/a.jpg" }, /video_url requires media_type/],
    ["mais de 3 collaborators", { collaborators: ["a", "b", "c", "d"] }, /max of 3/],
    ["collaborator inválido", { collaborators: ["@diar.ia.br"] }, /Instagram usernames/],
    ["ig_account desconhecida", { ig_account: "outra" }, /ig_account must be one of/],
    ["ig_account fora do Instagram", { channel: "linkedin", media_type: undefined, video_url: undefined }, /ig_account only applies/],
  ];
  for (const [name, over, re] of rejects) {
    it(`recusa: ${name}`, async () => {
      const { env, kv } = mkEnv(VJPIXEL);
      const payload: Record<string, unknown> = reelsPayload(over);
      if (name === "ig_account fora do Instagram") payload.ig_account = "vjpixel";
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
      const res = await enqueue(env, payload);
      assert.equal(res.status, 400, `${name}: esperava 400`);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, re);
      assert.equal(kv.store.size, 0);
    });
  }

  it("post de imagem comum continua aceito (regressão: campos novos são opcionais)", async () => {
    const { env } = mkEnv();
    const res = await enqueue(env, {
      text: "post",
      scheduled_at: future(),
      destaque: "d1",
      channel: "instagram",
      image_url: "https://x.test/a.jpg",
    });
    assert.equal(res.status, 202);
  });
});

describe("#10823 resolveInstagramVjpixelCreds", () => {
  it("undefined sem as duas vars; usa INSTAGRAM_API_VERSION da conta principal", () => {
    assert.equal(resolveInstagramVjpixelCreds({ INSTAGRAM_VJPIXEL_ACCOUNT_ID: "x" } as Env), undefined);
    assert.deepEqual(
      resolveInstagramVjpixelCreds({ ...VJPIXEL, INSTAGRAM_API_VERSION: "v26.0" } as unknown as Env),
      { igUserId: "ig-vjpixel", accessToken: "token-vjpixel", apiVersion: "v26.0" },
    );
  });
});
