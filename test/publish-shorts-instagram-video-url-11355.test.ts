/**
 * test/publish-shorts-instagram-video-url-11355.test.ts
 *
 * #11355: o rupload do Reels processa de forma síncrona e a Meta encerra a
 * requisição em ~32,5 s (23 casos em 01/11/2026), o que recusa todo vertical
 * real. A rota `video_url` deu 6/6 FINISHED de 45 a 75 s na @diar.ia.br. Por
 * isso a conta deixa de ter teto e cria o container com a URL do R2. Substitui
 * a trava do teto de 30 s (#11281), revogado aqui. Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { instagramReelUploadRoute, loadInstagramApiMaxSeconds, shortInstagramVideoFileName, shortVideoFileName } from "../scripts/lib/diaria/short-video.ts";
import { R2_RETENTION_POLICIES } from "../scripts/lib/r2-object-upload.ts";
import {
  credentialSkippedItems,
  instagramR2VideoKey,
  planShortsPublish,
  publicVideoUnavailableCause,
  publicVideoUnavailableReason,
  publishInstagramReel,
  resolveInstagramReelInputs,
  type GraphDeps,
  type ShortsPlanInput,
} from "../scripts/publish-shorts.ts";
import { interpretInstagramTimerOutput } from "../scripts/shorts-instagram-timer.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const realConfig = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
const realShorts = realConfig.publishing.shorts;

const SCHEDULE = { rotation_times: ["12:00", "19:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };

function planDiaria(extra: Partial<ShortsPlanInput> = {}, authorPage: string | null = null) {
  return planShortsPublish({
    aammdd: "261102",
    reviewedMd: "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n",
    now: new Date("2026-11-02T15:05:00Z"),
    config: {
      publishing: {
        shorts: {
          schedule: SCHEDULE,
          facebook_pages: [],
          instagram: true,
          instagram_author_page: authorPage,
          instagram_collaborators: ["vjpixel"],
          instagram_api_max_seconds_by_account: realShorts.instagram_api_max_seconds_by_account,
        },
      },
    },
    pages: [],
    instagramReady: true,
    writer: "instagram-timer",
    forceNow: true,
    publicVideo: { ready: true },
    published: { aammdd: "261102", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 181_000_000 },
    videoDurationSeconds: 75,
    editionUrl: "https://diar.ia.br/p/x",
    ...extra,
  });
}

/** Graph falsa: responde pela URL e guarda as chamadas. Qualquer rupload é erro. */
function fakeGraph(statuses: string[] = ["IN_PROGRESS", "FINISHED"]) {
  const calls: { url: string; body: Record<string, string> | null }[] = [];
  const sleeps: number[] = [];
  let poll = 0;
  const deps: GraphDeps = {
    fetch: async (url, init) => {
      assert.doesNotMatch(url, /rupload/, "a rota video_url não pode chamar o rupload");
      const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
      calls.push({ url, body });
      let json: unknown = {};
      if (url.includes("/media_publish")) json = { id: "m1" };
      else if (url.endsWith("/ig/media")) json = { id: "c1" };
      else if (url.includes("/c1?") || url.endsWith("/c1")) json = { status_code: statuses[poll++], status: "motivo" };
      else if (url.includes("/m1/collaborators")) json = { data: [{ username: "vjpixel", invite_status: "Pending" }] };
      else if (url.includes("/m1")) json = { permalink: "https://instagram.com/reel/m1" };
      return new Response(JSON.stringify(json), { status: 200 });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date("2026-11-02T15:05:00Z"),
    log: () => {},
  };
  return { deps, calls, sleeps };
}

describe("#11355 plano", () => {
  it("regressão: vertical de 75 s na conta diaria planeja api, não passo guiado", () => {
    const ig = planDiaria().items.find((i) => i.destination === "instagram")!;
    assert.equal(ig.action, "publish");
    assert.equal(ig.mode, "api");
  });

  it("config real: @diar.ia.br sem teto e @vjpixel com os 40 s de sempre, e a nota registra a medição", () => {
    assert.equal(loadInstagramApiMaxSeconds(realConfig, null), null);
    assert.equal(loadInstagramApiMaxSeconds(realConfig, "vjpixel"), 40);
    assert.match(realShorts.instagram_api_max_seconds_note, /#11355/);
    assert.match(realShorts.instagram_api_max_seconds_note, /01\/11\/2026/);
  });

  it("sem R2 a conta diaria não tenta publicar: skip com o motivo, que o timer lê como alarme", () => {
    const p = planDiaria({ publicVideo: { ready: false, reason: "faltam os secrets" } });
    const ig = p.items.find((i) => i.destination === "instagram")! as { action: string; detail: string };
    assert.equal(ig.action, "skip_missing_credentials");
    assert.match(ig.detail, /video_url.*faltam os secrets/);
  });

  it("sem R2 o alarme cita o R2, não o token do Instagram, e não diz 'fica pendente'", () => {
    const reason = publicVideoUnavailableReason("timer-300", ["R2_ACCOUNT_ID"]);
    const cause = publicVideoUnavailableCause("timer-300", ["R2_ACCOUNT_ID"]);
    assert.match(reason, /fica pendente/, "X e Threads seguem com o aviso do #11498");
    const p = planDiaria({ publicVideo: { ready: false, reason, cause } });
    const ig = p.items.find((i) => i.destination === "instagram")!;
    assert.equal((ig as { cause?: string }).cause, "public_video");
    assert.deepEqual(credentialSkippedItems(p.items).filter((i) => i.destination === "instagram"), [], "sem R2 não é terminal (#11478)");
    const alarm = interpretInstagramTimerOutput(0, JSON.stringify({ items: p.items })) as { key: string; detail: string };
    assert.equal(alarm.key, "credentials");
    assert.match(alarm.detail, /^sem R2 no 300:/);
    assert.match(alarm.detail, /R2_\*/);
    assert.doesNotMatch(alarm.detail, /credencial do Instagram|fica pendente/);
  });

  it("sem R2, antes do horário segue esperando (não alarma cedo)", () => {
    const p = planDiaria({ forceNow: false, now: new Date("2026-11-02T12:00:00Z"), publicVideo: { ready: false, reason: "x" } });
    assert.equal(p.items.find((i) => i.destination === "instagram")!.action, "pending_schedule");
  });

  it("a @vjpixel segue com teto (acima dele, guiado) e no rupload, mesmo sem R2", () => {
    assert.equal(instagramReelUploadRoute("vjpixel"), "rupload");
    assert.equal(instagramReelUploadRoute(null), "video_url");
    assert.equal(instagramReelUploadRoute("diaria"), "video_url");
    const pages = [{ slug: "vjpixel", enabled: true, pageId: "1", token: "t", missing: [], utmContent: null }];
    const over = planDiaria({ pages }, "vjpixel");
    assert.equal(over.items.find((i) => i.destination === "instagram")!.action, "guided");
    const within = planDiaria({ pages, videoDurationSeconds: 35, publicVideo: { ready: false, reason: "x" } }, "vjpixel");
    assert.equal(within.items.find((i) => i.destination === "instagram")!.action, "publish");
  });
});

describe("#11355 container por video_url", () => {
  const source = { videoUrl: "https://r2.example/shorts/v.mp4" };

  it("regressão: cria o container com video_url e os campos do Worker, sem rupload, e publica", async () => {
    const { deps, calls, sleeps } = fakeGraph();
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda", ["vjpixel"], "https://r2.example/c.jpg");
    const body = calls[0].body!;
    assert.deepEqual(
      { ...body },
      {
        media_type: "REELS",
        video_url: source.videoUrl,
        caption: "legenda",
        share_to_feed: "true",
        access_token: "tok",
        cover_url: "https://r2.example/c.jpg",
        collaborators: JSON.stringify(["vjpixel"]),
      },
    );
    assert.equal(body.upload_type, undefined);
    assert.ok(calls.some((c) => c.url.includes("/media_publish") && c.body?.creation_id === "c1"));
    assert.equal(sleeps.length, 1, "espera entre os polls");
    assert.equal(out.entry.url, "https://instagram.com/reel/m1");
    assert.equal(out.entry.status, "published");
  });

  it("o poll aguenta o pior caso medido (72 s, 8 consultas de 10 s) sem desistir", async () => {
    const { deps } = fakeGraph([...Array(8).fill("IN_PROGRESS"), "FINISHED"]);
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda");
    assert.equal(out.entry.id, "m1");
  });

  it("container ERROR não publica e aponta a rota à mão", async () => {
    const { deps, calls } = fakeGraph(["ERROR"]);
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", source, "x"), /ERROR motivo.*video_url.*Passo B3b/);
    assert.ok(!calls.some((c) => c.url.includes("/media_publish")));
  });
});

describe("#11355 R2", () => {
  it("corte do Instagram tem chave própria; o genérico reaproveita o objeto de X e Threads", () => {
    const aammdd = "261102";
    const dir = "data/editions/2611/261102";
    assert.equal(instagramR2VideoKey(aammdd, `${dir}/${shortVideoFileName(aammdd)}`), `shorts/${shortVideoFileName(aammdd)}`);
    const cutKey = instagramR2VideoKey(aammdd, `${dir}/${shortInstagramVideoFileName(aammdd)}`);
    assert.equal(cutKey, `shorts/${shortInstagramVideoFileName(aammdd)}`);
    assert.notEqual(cutKey, `shorts/${shortVideoFileName(aammdd)}`);
    assert.ok(R2_RETENTION_POLICIES.some((p) => cutKey.startsWith(p.prefix)), "a chave própria continua sob a retenção de shorts/");
  });

  it("a capa sobe antes do vídeo: a poda dela não apaga um vertical já resolvido", async () => {
    const order: string[] = [];
    const out = await resolveInstagramReelInputs({
      route: "video_url",
      file: Buffer.from("v"),
      uploadCover: async () => {
        order.push("cover");
        return "https://r2.example/c.jpg";
      },
      uploadVideo: async () => {
        order.push("video");
        return "https://r2.example/v.mp4";
      },
    });
    assert.deepEqual(order, ["cover", "video"]);
    assert.deepEqual(out, { source: { videoUrl: "https://r2.example/v.mp4" }, cover: "https://r2.example/c.jpg" });
  });

  it("falha no R2 lança antes de qualquer container; a rota rupload nem chama o R2", async () => {
    await assert.rejects(
      resolveInstagramReelInputs({
        route: "video_url",
        file: Buffer.from("v"),
        uploadCover: async () => undefined,
        uploadVideo: async () => {
          throw new Error("R2 não configurado");
        },
      }),
      /R2 não configurado/,
    );
    const file = Buffer.from("v");
    const out = await resolveInstagramReelInputs({
      route: "rupload",
      file,
      uploadCover: async () => undefined,
      uploadVideo: async () => assert.fail("rupload não usa o R2"),
    });
    assert.equal(out.source, file);
  });
});
