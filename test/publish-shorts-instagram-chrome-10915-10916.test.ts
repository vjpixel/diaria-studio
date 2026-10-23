/**
 * test/publish-shorts-instagram-chrome-10915-10916.test.ts
 *
 * #10916: o teto de duração do Reels pela API é POR CONTA (medido: @vjpixel
 * 40 s, @diar.ia.br 55 s). Antes era um teto global de 40 s: com a autora de
 * volta à conta do env, um vertical de 50 s viraria passo guiado sem precisar.
 *
 * #10915: acima do teto, o Instagram vira passo guiado no Chrome com uma versão
 * ≤ 9,5 MB do vertical (file_upload do Claude in Chrome aceita 10 MB). Testa o
 * cálculo do bitrate, os argumentos do ffmpeg, o preparo fail-soft do arquivo
 * e a leitura da mídia publicada (`--confirm-instagram`). Nenhum teste toca
 * rede nem roda ffmpeg.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { instagramAccountKey, loadInstagramApiMaxSeconds } from "../scripts/lib/diaria/short-video.ts";
import {
  CHROME_UPLOAD_MAX_BYTES,
  CHROME_UPLOAD_MIN_VIDEO_KBPS,
  CHROME_UPLOAD_TARGET_BYTES,
  buildChromeUploadFfmpegPasses,
  chromeUploadBitrate,
  chromeUploadFileName,
} from "../scripts/lib/diaria/instagram-chrome-upload.ts";
import {
  attachChromeUploadToPlan,
  collabInviteWarnings,
  findInstagramReelSince,
  planShortsPublish,
  prepareInstagramChromeUpload,
  type ChromeUploadDeps,
  type ShortsPlanItem,
} from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const byAccount = { vjpixel: 40, diaria: 55 };
const cfgWith = (shorts: Record<string, unknown>) => ({ publishing: { shorts } });

describe("#10916 teto de duração por conta", () => {
  it("chave da conta: slug da autora; null = diaria (conta do env)", () => {
    assert.equal(instagramAccountKey("vjpixel"), "vjpixel");
    assert.equal(instagramAccountKey(null), "diaria");
  });

  it("autora vjpixel → 40; autora null (conta do env) → 55", () => {
    const c = cfgWith({ instagram_api_max_seconds_by_account: byAccount });
    assert.equal(loadInstagramApiMaxSeconds(c, "vjpixel"), 40);
    assert.equal(loadInstagramApiMaxSeconds(c, null), 55);
  });

  it("mapa ausente → valor legado; legado ausente → 40", () => {
    assert.equal(loadInstagramApiMaxSeconds(cfgWith({ instagram_api_max_seconds: 70 }), null), 70);
    assert.equal(loadInstagramApiMaxSeconds(cfgWith({}), null), 40);
    assert.equal(loadInstagramApiMaxSeconds({}, null), 40);
  });

  it("conta fora do mapa cai no legado; null no mapa desliga só aquela conta", () => {
    const c = cfgWith({ instagram_api_max_seconds: 30, instagram_api_max_seconds_by_account: { vjpixel: null } });
    assert.equal(loadInstagramApiMaxSeconds(c, "vjpixel"), null);
    assert.equal(loadInstagramApiMaxSeconds(c, "memelab"), 30);
  });

  it("mapa ou valor inválido lança", () => {
    for (const bad of [[], "x", null, 5]) {
      assert.throws(() => loadInstagramApiMaxSeconds(cfgWith({ instagram_api_max_seconds_by_account: bad }), null), /by_account/);
    }
    for (const bad of [0, -1, "55", Number.NaN]) {
      assert.throws(() => loadInstagramApiMaxSeconds(cfgWith({ instagram_api_max_seconds_by_account: { diaria: bad } }), null), /by_account\.diaria/);
    }
  });

  const reviewed = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n";
  const pages: ResolvedFacebookPage[] = [
    { slug: "diaria", enabled: true, pageId: "1", token: "t1", missing: [], utmContent: null },
    { slug: "vjpixel", enabled: false, pageId: "937", token: "tok", missing: [], utmContent: "page-vjpixel" },
  ];
  function planFor(author: string | null, duration: number) {
    return planShortsPublish({
      aammdd: "261022",
      reviewedMd: reviewed,
      now: new Date("2026-10-22T09:00:00Z"),
      config: cfgWith({
        facebook_pages: ["diaria"],
        instagram: true,
        instagram_author_page: author,
        instagram_collaborators: author === null ? [] : ["diar.ia.br"],
        instagram_api_max_seconds_by_account: byAccount,
      }),
      pages,
      instagramReady: true,
      instagramQueue: { ready: true, account: author === null ? "diaria" : "vjpixel" },
      published: { aammdd: "261022", entries: [] },
      video: { path: "v.mp4", exists: true, sizeBytes: 5_000_000 },
      videoDurationSeconds: duration,
      editionUrl: "https://diar.ia.br/p/x",
    });
  }

  it("regressão: vertical de 50 s sai pela API na conta do env (teto 55) e vira guiado na @vjpixel (teto 40)", () => {
    assert.equal(planFor(null, 50).items.find((i) => i.destination === "instagram")!.action, "enqueue");
    const g = planFor("vjpixel", 50).items.find((i) => i.destination === "instagram")!;
    assert.equal(g.action, "guided");
    assert.match((g as { detail: string }).detail, /~40 s na conta vinculada à página vjpixel/);
    assert.match((g as { detail: string }).detail, /instagram\.com no Chrome/);
    assert.match((g as { detail: string }).detail, /--confirm-instagram/);
  });

  it("acima de 55 s a conta do env também vira guiado, nomeando a conta", () => {
    const g = planFor(null, 58).items.find((i) => i.destination === "instagram")!;
    assert.equal(g.action, "guided");
    assert.match((g as { detail: string }).detail, /~55 s na conta da diar\.ia\.br/);
  });
});

describe("#10915 versão ≤ 9,5 MB pro Chrome", () => {
  it("bitrate do caso validado (114 s) fica perto dos 590k que deram 9,5 MB", () => {
    const b = chromeUploadBitrate(114);
    assert.ok(b.fits);
    assert.ok(b.videoKbps >= 560 && b.videoKbps <= 600, `videoKbps ${b.videoKbps}`);
    assert.equal(b.audioKbps, 64);
    assert.ok(b.estimatedBytes <= CHROME_UPLOAD_TARGET_BYTES, `estimado ${b.estimatedBytes}`);
  });

  it("vídeo curto tem teto de bitrate; vídeo longo demais usa o mínimo e avisa", () => {
    assert.equal(chromeUploadBitrate(45).videoKbps, 1574);
    assert.equal(chromeUploadBitrate(10).videoKbps, 2500);
    const long = chromeUploadBitrate(600);
    assert.equal(long.fits, false);
    assert.equal(long.videoKbps, CHROME_UPLOAD_MIN_VIDEO_KBPS);
    assert.ok(long.estimatedBytes > CHROME_UPLOAD_MAX_BYTES);
    assert.match(long.warning ?? "", /file_upload do Chrome recusa/);
  });

  it("duração inválida lança", () => {
    for (const d of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => chromeUploadBitrate(d), /duração inválida/);
  });

  it("ffmpeg 2-pass: 720x1280 sem distorcer, bitrate, AAC 64k 48 kHz, +faststart, 1ª passada sem áudio pro descarte", () => {
    const [p1, p2] = buildChromeUploadFfmpegPasses({ input: "in.mp4", output: "out.part.mp4", videoKbps: 582, passlogfile: "out.2pass", nullSink: "NUL" });
    const vf = p1[p1.indexOf("-vf") + 1];
    assert.match(vf, /scale=720:1280:force_original_aspect_ratio=decrease/);
    assert.match(vf, /pad=720:1280/);
    for (const p of [p1, p2]) {
      assert.equal(p[p.indexOf("-b:v") + 1], "582k");
      assert.equal(p[p.indexOf("-passlogfile") + 1], "out.2pass");
    }
    assert.equal(p1[p1.indexOf("-pass") + 1], "1");
    assert.ok(p1.includes("-an"));
    assert.equal(p1.at(-1), "NUL");
    assert.equal(p2[p2.indexOf("-pass") + 1], "2");
    assert.equal(p2[p2.indexOf("-b:a") + 1], "64k");
    assert.equal(p2[p2.indexOf("-ar") + 1], "48000");
    assert.equal(p2[p2.indexOf("-movflags") + 1], "+faststart");
    assert.equal(p2.at(-1), "out.part.mp4");
  });

  it("nome do arquivo fica separado do vertical original", () => {
    assert.equal(chromeUploadFileName("261022"), "diaria-comentada-261022-short-instagram-chrome.mp4");
  });

  function fakeDeps(opts: { ffmpegFailsAt?: number; outSize?: number; prev?: { size: number; mtimeMs: number } } = {}) {
    const calls: string[][] = [];
    const files = new Map<string, { size: number; mtimeMs: number }>([["src.mp4", { size: 56_000_000, mtimeMs: 1000 }]]);
    if (opts.prev) files.set("_internal/out.mp4", opts.prev);
    const removed: string[] = [];
    const deps: ChromeUploadDeps = {
      runFfmpeg: (args) => {
        calls.push(args);
        if (opts.ffmpegFailsAt === calls.length) return { ok: false, error: "ffmpeg: not found" };
        if (args.includes("2")) files.set(args.at(-1)!, { size: opts.outSize ?? 9_400_000, mtimeMs: 2000 });
        return { ok: true };
      },
      stat: (p) => files.get(p) ?? null,
      rename: (a, b) => {
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      remove: (p) => {
        removed.push(p);
        files.delete(p);
      },
      mkdirp: () => {},
      nullSink: "/dev/null",
    };
    return { deps, calls, files, removed };
  }

  it("gera o arquivo: duas passadas, renomeia o parcial e limpa os logs do 2-pass", () => {
    const f = fakeDeps();
    const r = prepareInstagramChromeUpload(f.deps, { source: "src.mp4", output: "_internal/out.mp4", durationSeconds: 114 });
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].at(-1), "_internal/out.part.mp4");
    assert.deepEqual(f.files.get("_internal/out.mp4"), { size: 9_400_000, mtimeMs: 2000 });
    assert.ok(f.removed.includes("_internal/out.mp4.2pass-0.log"));
    assert.equal((r as { reused: boolean }).reused, false);
  });

  it("reaproveita o arquivo já gerado (mais novo que o original e ≤ 10 MB) sem rodar ffmpeg", () => {
    const f = fakeDeps({ prev: { size: 9_300_000, mtimeMs: 5000 } });
    const r = prepareInstagramChromeUpload(f.deps, { source: "src.mp4", output: "_internal/out.mp4", durationSeconds: 114 });
    assert.equal(r.ok, true);
    assert.equal((r as { reused: boolean }).reused, true);
    assert.equal(f.calls.length, 0);
  });

  it("arquivo antigo (mais velho que o original) é refeito", () => {
    const f = fakeDeps({ prev: { size: 9_300_000, mtimeMs: 10 } });
    prepareInstagramChromeUpload(f.deps, { source: "src.mp4", output: "_internal/out.mp4", durationSeconds: 114 });
    assert.equal(f.calls.length, 2);
  });

  it("fail-soft: ffmpeg falhando NUNCA lança — volta ok:false e o passo aponta pro original", () => {
    const f = fakeDeps({ ffmpegFailsAt: 1 });
    const r = prepareInstagramChromeUpload(f.deps, { source: "src.mp4", output: "_internal/out.mp4", durationSeconds: 114 });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /passada 1.*not found/);
    const items: ShortsPlanItem[] = [{ destination: "instagram", mode: "guided", action: "guided", caption: "c", detail: "d" }];
    const a = attachChromeUploadToPlan(items, r, "/ed/orig.mp4");
    assert.equal((a.items[0] as { file?: string }).file, "/ed/orig.mp4");
    assert.match(a.warnings[0], /não gerada.*original/);
  });

  it("arquivo que saiu acima de 10 MB é usado, mas com aviso", () => {
    const f = fakeDeps({ outSize: 11_000_000 });
    const r = prepareInstagramChromeUpload(f.deps, { source: "src.mp4", output: "_internal/out.mp4", durationSeconds: 114 });
    assert.equal(r.ok, true);
    assert.match((r as { warning?: string }).warning ?? "", /11\.0 MB/);
  });

  it("o passo guiado do Instagram ganha o arquivo comprimido; os outros itens ficam intactos", () => {
    const items: ShortsPlanItem[] = [
      { destination: "instagram", mode: "guided", action: "guided", caption: "legenda", detail: "acima do teto" },
      { destination: "youtube_shorts", mode: "guided", action: "guided", detail: "yt" },
    ];
    const a = attachChromeUploadToPlan(items, { ok: true, path: "/ed/_internal/x.mp4", sizeBytes: 9_400_000, videoKbps: 582, reused: false }, "/ed/orig.mp4");
    const ig = a.items[0] as { file?: string; detail: string; caption?: string };
    assert.equal(ig.file, "/ed/_internal/x.mp4");
    assert.equal(ig.caption, "legenda");
    assert.match(ig.detail, /9\.4 MB, 582 kbps/);
    assert.equal(a.items[1], items[1]);
    assert.deepEqual(a.warnings, []);
  });
});

describe("#10915 conferência pela API depois do Share", () => {
  function fetchSeq(seq: Array<{ json: unknown; status?: number }>) {
    const urls: string[] = [];
    return {
      deps: {
        fetch: async (url: string) => {
          urls.push(url);
          const r = seq[urls.length - 1];
          if (!r) throw new Error(`chamada inesperada: ${url}`);
          return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
        },
      },
      urls,
    };
  }

  it("acha o Reels mais recente desde o início do dia, ignorando post de imagem e Reels antigo", async () => {
    const f = fetchSeq([
      {
        json: {
          data: [
            { id: "old", media_product_type: "REELS", timestamp: "2026-10-21T15:00:00+0000", permalink: "https://www.instagram.com/reel/old/" },
            { id: "img", media_product_type: "FEED", timestamp: "2026-10-22T16:00:00+0000" },
            { id: "r1", media_product_type: "REELS", timestamp: "2026-10-22T15:22:00+0000", permalink: "https://www.instagram.com/reel/Dezuxl2q6Xy/" },
          ],
        },
      },
    ]);
    const r = await findInstagramReelSince(f.deps, "1784", "tok", "v25.0", "2026-10-22T03:00:00.000Z");
    assert.deepEqual(r, { id: "r1", permalink: "https://www.instagram.com/reel/Dezuxl2q6Xy/", timestamp: "2026-10-22T15:22:00+0000", countSince: 1 });
    assert.match(f.urls[0], /\/v25\.0\/1784\/media\?/);
    assert.ok(!/media_publish/.test(f.urls[0]));
  });

  it("nenhum Reels desde o início do dia → null", async () => {
    const f = fetchSeq([{ json: { data: [{ id: "old", media_product_type: "REELS", timestamp: "2026-10-21T15:00:00+0000" }] } }]);
    assert.equal(await findInstagramReelSince(f.deps, "1", "t", "v25.0", "2026-10-22T03:00:00.000Z"), null);
  });

  it("collab Pending vira aviso só na conferência; ausente é descartado", () => {
    const pending = [{ username: "diar.ia.br", invite_status: "Pending" }];
    assert.match(collabInviteWarnings(pending, ["diar.ia.br"], { reportPending: true })[0], /Pending/);
    assert.deepEqual(collabInviteWarnings(pending, ["diar.ia.br"], { reportPending: false }), []);
    assert.deepEqual(collabInviteWarnings([{ username: "diar.ia.br", invite_status: "Accepted" }], ["diar.ia.br"], { reportPending: true }), []);
    assert.match(collabInviteWarnings([], ["diar.ia.br"], { reportPending: true })[0], /descartado/);
    assert.match(collabInviteWarnings([{ username: "diar.ia.br", invite_status: "Declined" }], ["diar.ia.br"], { reportPending: true })[0], /Declined/);
  });
});
