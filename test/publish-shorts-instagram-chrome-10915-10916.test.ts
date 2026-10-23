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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  instagramAccountKey,
  instagramApiMaxSecondsPremise,
  instagramReelsApiFit,
  loadInstagramApiMaxSeconds,
  resolveInstagramApiMaxSeconds,
  type ShortsPublishedFile,
} from "../scripts/lib/diaria/short-video.ts";
import {
  CHROME_UPLOAD_MAX_BYTES,
  CHROME_UPLOAD_MIN_VIDEO_KBPS,
  CHROME_UPLOAD_TARGET_BYTES,
  buildChromeUploadFfmpegPasses,
  chromeUploadBitrate,
  chromeUploadFileName,
  chromeUploadSidecarPath,
} from "../scripts/lib/diaria/instagram-chrome-upload.ts";
import {
  attachChromeUploadToPlan,
  collabInviteWarnings,
  decideInstagramConfirm,
  fetchInstagramRecentMedia,
  instagramAlreadyRegistered,
  instagramEditionMarkers,
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

  it("valida o mapa INTEIRO: valor quebrado na conta inativa também lança", () => {
    const c = cfgWith({ instagram_api_max_seconds_by_account: { vjpixel: 40, diaria: "55" } });
    assert.throws(() => loadInstagramApiMaxSeconds(c, "vjpixel"), /by_account\.diaria/);
    const c2 = cfgWith({ instagram_api_max_seconds_by_account: { vjpixel: 40, memelab: 0 } });
    assert.throws(() => loadInstagramApiMaxSeconds(c2, null), /by_account\.memelab/);
  });

  it("premissa quando o mapa existe mas não tem a conta: diz o teto e de onde veio", () => {
    const legacy = resolveInstagramApiMaxSeconds(cfgWith({ instagram_api_max_seconds: 30, instagram_api_max_seconds_by_account: { vjpixel: 40 } }), "memelab");
    assert.equal(legacy.maxSeconds, 30);
    assert.match(instagramApiMaxSecondsPremise(legacy) ?? "", /30 s, de publishing\.shorts\.instagram_api_max_seconds \(legado.*"memelab" não está/);
    const def = resolveInstagramApiMaxSeconds(cfgWith({ instagram_api_max_seconds_by_account: { vjpixel: 40 } }), null);
    assert.equal(def.maxSeconds, 40);
    assert.match(instagramApiMaxSecondsPremise(def) ?? "", /default.*"diaria" não está/);
    // Conta no mapa, ou sem mapa: nada a declarar.
    assert.equal(instagramApiMaxSecondsPremise(resolveInstagramApiMaxSeconds(cfgWith({ instagram_api_max_seconds_by_account: byAccount }), null)), null);
    assert.equal(instagramApiMaxSecondsPremise(resolveInstagramApiMaxSeconds(cfgWith({}), null)), null);
  });

  it("platform.config.json real: o teto da autora configurada resolve sem lançar (40 s da @vjpixel hoje)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const config = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
    const author = config.publishing.shorts.instagram_author_page ?? null;
    const r = resolveInstagramApiMaxSeconds(config, author);
    assert.equal(r.source, "by_account", "a autora configurada tem que estar no mapa por conta");
    assert.equal(r.maxSeconds, 40);
    // A outra conta do mapa também resolve (validação do mapa inteiro).
    assert.equal(loadInstagramApiMaxSeconds(config, null), 55);
  });

  it("motivo do guiado nomeia a conta pelo rótulo legível", () => {
    const fit = instagramReelsApiFit(50, 40, "x");
    assert.equal(fit.fits, false);
    assert.match((fit as { reason: string }).reason, /na conta x/);
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

  function fakeDeps(opts: { ffmpegFailsAt?: number; outSize?: number; prev?: { size: number; mtimeMs: number }; sidecar?: string } = {}) {
    const calls: string[][] = [];
    const files = new Map<string, { size: number; mtimeMs: number }>([["src.mp4", { size: 56_000_000, mtimeMs: 1000 }]]);
    const texts = new Map<string, string>();
    if (opts.prev) files.set("_internal/out.mp4", opts.prev);
    if (opts.sidecar !== undefined) texts.set(chromeUploadSidecarPath("_internal/out.mp4"), opts.sidecar);
    const removed: string[] = [];
    const deps: ChromeUploadDeps = {
      runFfmpeg: (args) => {
        calls.push(args);
        // A passada vem do valor depois de "-pass", nunca de um "2" qualquer nos args.
        const pass = args[args.indexOf("-pass") + 1];
        if (pass === "2") files.set(args.at(-1)!, { size: opts.outSize ?? 9_400_000, mtimeMs: 2000 });
        if (opts.ffmpegFailsAt === calls.length) return { ok: false, error: "ffmpeg: not found" };
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
      readText: (p) => texts.get(p) ?? null,
      writeText: (p, t) => {
        texts.set(p, t);
      },
      nullSink: "/dev/null",
    };
    return { deps, calls, files, removed, texts };
  }
  const input = { source: "src.mp4", output: "_internal/out.mp4", durationSeconds: 114 };
  const kbps114 = chromeUploadBitrate(114).videoKbps;
  const goodSidecar = (outputSizeBytes: number, over: Record<string, unknown> = {}) =>
    JSON.stringify({ source: { path: "src.mp4", sizeBytes: 56_000_000, mtimeMs: 1000 }, videoKbps: kbps114, outputSizeBytes, ...over });

  it("gera o arquivo: duas passadas, renomeia o parcial, limpa os logs do 2-pass e grava o sidecar", () => {
    const f = fakeDeps();
    const r = prepareInstagramChromeUpload(f.deps, input);
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].at(-1), "_internal/out.part.mp4");
    assert.deepEqual(f.files.get("_internal/out.mp4"), { size: 9_400_000, mtimeMs: 2000 });
    assert.ok(f.removed.includes("_internal/out.mp4.2pass-0.log"));
    assert.equal((r as { reused: boolean }).reused, false);
    assert.deepEqual(JSON.parse(f.texts.get("_internal/out.mp4.json")!), JSON.parse(goodSidecar(9_400_000)));
  });

  it("reaproveita só com sidecar batendo exatamente, sem rodar ffmpeg", () => {
    const f = fakeDeps({ prev: { size: 9_300_000, mtimeMs: 5000 }, sidecar: goodSidecar(9_300_000) });
    const r = prepareInstagramChromeUpload(f.deps, input);
    assert.equal(r.ok, true);
    assert.equal((r as { reused: boolean }).reused, true);
    assert.equal(f.calls.length, 0);
  });

  it("sem sidecar, ou sidecar de outra fonte/bitrate/tamanho, refaz o arquivo (mtime mais novo não basta)", () => {
    const cases: Array<string | undefined> = [
      undefined,
      "{quebrado",
      goodSidecar(9_300_000, { source: { path: "src.mp4", sizeBytes: 1, mtimeMs: 1000 } }),
      goodSidecar(9_300_000, { source: { path: "src.mp4", sizeBytes: 56_000_000, mtimeMs: 999 } }),
      goodSidecar(9_300_000, { source: { path: "outro.mp4", sizeBytes: 56_000_000, mtimeMs: 1000 } }),
      goodSidecar(9_300_000, { videoKbps: kbps114 + 1 }),
      goodSidecar(9_299_999),
    ];
    for (const sidecar of cases) {
      const f = fakeDeps({ prev: { size: 9_300_000, mtimeMs: 5000 }, sidecar });
      prepareInstagramChromeUpload(f.deps, input);
      assert.equal(f.calls.length, 2, `sidecar ${sidecar}`);
    }
  });

  it("reuso recusa arquivo acima de 10 MB e de 0 byte, mesmo com sidecar batendo", () => {
    for (const size of [CHROME_UPLOAD_MAX_BYTES + 1, 0]) {
      const f = fakeDeps({ prev: { size, mtimeMs: 5000 }, sidecar: goodSidecar(size) });
      prepareInstagramChromeUpload(f.deps, input);
      assert.equal(f.calls.length, 2, `size ${size}`);
    }
  });

  it("fail-soft: ffmpeg falhando NUNCA lança — volta ok:false e o passo aponta pro original, fitsChromeUpload false", () => {
    const f = fakeDeps({ ffmpegFailsAt: 1 });
    const r = prepareInstagramChromeUpload(f.deps, input);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /passada 1.*not found/);
    const items: ShortsPlanItem[] = [{ destination: "instagram", mode: "guided", action: "guided", caption: "c", detail: "d" }];
    const a = attachChromeUploadToPlan(items, r, { path: "/ed/orig.mp4", sizeBytes: 5_000_000 });
    assert.deepEqual((a.items[0] as { upload?: unknown }).upload, { path: "/ed/orig.mp4", sizeBytes: 5_000_000, fitsChromeUpload: false });
    assert.match(a.warnings[0], /não gerada.*original/);
  });

  it("falha na passada 2 limpa o .part.mp4 e os logs do 2-pass, sem renomear nem gravar sidecar", () => {
    const f = fakeDeps({ ffmpegFailsAt: 2 });
    const r = prepareInstagramChromeUpload(f.deps, input);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /passada 2/);
    assert.ok(f.removed.includes("_internal/out.part.mp4"));
    assert.ok(f.removed.includes("_internal/out.mp4.2pass-0.log"));
    assert.ok(f.removed.includes("_internal/out.mp4.2pass-0.log.mbtree"));
    assert.equal(f.files.has("_internal/out.part.mp4"), false);
    assert.equal(f.files.has("_internal/out.mp4"), false);
    assert.equal(f.texts.size, 0);
  });

  it("arquivo que saiu acima de 10 MB é usado, com aviso e fitsChromeUpload false", () => {
    const f = fakeDeps({ outSize: 11_000_000 });
    const r = prepareInstagramChromeUpload(f.deps, input);
    assert.equal(r.ok, true);
    assert.match((r as { warning?: string }).warning ?? "", /11\.0 MB/);
    const items: ShortsPlanItem[] = [{ destination: "instagram", mode: "guided", action: "guided", caption: "c", detail: "d" }];
    const a = attachChromeUploadToPlan(items, r, { path: "/ed/orig.mp4", sizeBytes: 56_000_000 });
    const up = (a.items[0] as { upload?: { fitsChromeUpload: boolean; sizeBytes: number } }).upload!;
    assert.equal(up.fitsChromeUpload, false);
    assert.equal(up.sizeBytes, 11_000_000);
    assert.match((a.items[0] as { detail: string }).detail, /o editor escolhe o arquivo/);
  });

  it("o passo guiado do Instagram ganha o arquivo comprimido; os outros itens ficam intactos", () => {
    const items: ShortsPlanItem[] = [
      { destination: "instagram", mode: "guided", action: "guided", caption: "legenda", detail: "acima do teto" },
      { destination: "youtube_shorts", mode: "guided", action: "guided", detail: "yt" },
    ];
    const a = attachChromeUploadToPlan(items, { ok: true, path: "/ed/_internal/x.mp4", sizeBytes: 9_400_000, videoKbps: 582, reused: false }, { path: "/ed/orig.mp4", sizeBytes: 56_000_000 });
    const ig = a.items[0] as { upload?: unknown; detail: string; caption?: string };
    assert.deepEqual(ig.upload, { path: "/ed/_internal/x.mp4", sizeBytes: 9_400_000, fitsChromeUpload: true });
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

  const markers = instagramEditionMarkers({ aammdd: "261022", d1Title: "**Título** do  D1" });
  const empty: ShortsPublishedFile = { aammdd: "261022", entries: [] };
  const since = "2026-10-22T03:00:00.000Z";
  const now = "2026-10-22T16:00:00.000Z";
  const caption = "Título do D1\n\nCorpo do destaque.\n\nEdição completa no link da bio.";

  it("marcadores: utm_campaign da edição e o título do D1 sem markdown", () => {
    assert.deepEqual(markers, ["utm_campaign=261022", "Título do D1"]);
    assert.deepEqual(instagramEditionMarkers({ aammdd: "261022", editionUrl: "https://diar.ia.br/p/x?utm_source=a" }), ["utm_campaign=261022", "https://diar.ia.br/p/x"]);
  });

  it("lê /media com a legenda, só leitura", async () => {
    const f = fetchSeq([{ json: { data: [] } }]);
    await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0");
    assert.match(f.urls[0], /\/v25\.0\/1784\/media\?/);
    assert.match(decodeURIComponent(f.urls[0]), /fields=id,permalink,timestamp,media_product_type,caption/);
    assert.ok(!/media_publish/.test(f.urls[0]));
  });

  it("2 Reels fora de ordem no payload: registra só o que tem o marcador, não o mais recente", () => {
    const media = {
      data: [
        { id: "outro", media_product_type: "REELS", timestamp: "2026-10-22T18:00:00+0000", permalink: "https://www.instagram.com/reel/outro/", caption: "Outro assunto do dia" },
        { id: "img", media_product_type: "FEED", timestamp: "2026-10-22T16:00:00+0000", caption },
        { id: "old", media_product_type: "REELS", timestamp: "2026-10-21T15:00:00+0000", caption },
        { id: "r1", media_product_type: "REELS", timestamp: "2026-10-22T15:22:00+0000", permalink: "https://www.instagram.com/reel/Dezuxl2q6Xy/", caption: caption.replace("Título", "TÍTULO") },
      ],
    };
    const d = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, nowIso: now });
    assert.equal(d.kind, "register");
    assert.deepEqual((d as { entry: unknown }).entry, {
      destination: "instagram",
      status: "published",
      id: "r1",
      url: "https://www.instagram.com/reel/Dezuxl2q6Xy/",
      scheduled_at: null,
      at: now,
    });
  });

  it("nenhum Reels com o marcador → recusa listando os candidatos (id, horário, permalink)", () => {
    const media = {
      data: [
        { id: "a", media_product_type: "REELS", timestamp: "2026-10-22T15:00:00+0000", permalink: "https://www.instagram.com/reel/a/", caption: "Outra coisa" },
        { id: "b", media_product_type: "REELS", timestamp: "2026-10-22T17:00:00+0000", caption: "Mais outra" },
      ],
    };
    const d = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, nowIso: now });
    assert.equal(d.kind, "refuse");
    assert.match((d as { reason: string }).reason, /nenhum dos 2 Reels.*--media-id/);
    assert.deepEqual(
      (d as { candidates: Array<{ id: string; timestamp: string; permalink: string | null }> }).candidates.map((c) => [c.id, c.timestamp, c.permalink]),
      [
        ["b", "2026-10-22T17:00:00+0000", null],
        ["a", "2026-10-22T15:00:00+0000", "https://www.instagram.com/reel/a/"],
      ],
    );
  });

  it("mais de 1 Reels com o marcador → recusa e pede --media-id", () => {
    const media = {
      data: [
        { id: "a", media_product_type: "REELS", timestamp: "2026-10-22T15:00:00+0000", caption },
        { id: "b", media_product_type: "REELS", timestamp: "2026-10-22T17:00:00+0000", caption },
      ],
    };
    const d = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, nowIso: now });
    assert.equal(d.kind, "refuse");
    assert.match((d as { reason: string }).reason, /2 Reels.*têm o marcador/);
  });

  it("nenhum Reels desde o início do dia → recusa sem candidatos", () => {
    const media = { data: [{ id: "old", media_product_type: "REELS", timestamp: "2026-10-21T15:00:00+0000", caption }] };
    const d = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, nowIso: now });
    assert.equal(d.kind, "refuse");
    assert.deepEqual((d as { candidates: unknown[] }).candidates, []);
  });

  it("--media-id escolhe explicitamente (sem marcador); id fora da lista recusa", () => {
    const media = { data: [{ id: "x", media_product_type: "REELS", timestamp: "2026-10-21T15:00:00+0000", caption: "sem marcador" }] };
    const ok = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, mediaId: "x", nowIso: now });
    assert.equal(ok.kind, "register");
    assert.equal((ok as { entry: { id: string } }).entry.id, "x");
    const bad = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, mediaId: "y", nowIso: now });
    assert.equal(bad.kind, "refuse");
    assert.match((bad as { reason: string }).reason, /--media-id y não está/);
  });

  it("já registrado → no-op (sem ler a mídia), reporta o status; exit 0 só se published", () => {
    const pub: ShortsPublishedFile = { aammdd: "261022", entries: [{ destination: "instagram", status: "published", id: "r1", at: now }] };
    // Sem `media`: prova que nem chega a ler a API.
    const d = decideInstagramConfirm({ published: pub, sinceIso: since, markers, nowIso: now });
    assert.equal(d.kind, "already_registered");
    assert.equal((d as { exitCode: number }).exitCode, 0);
    const sched: ShortsPublishedFile = { aammdd: "261022", entries: [{ destination: "instagram", status: "scheduled", id: "q", scheduled_at: now, at: now }] };
    const r = instagramAlreadyRegistered(sched)!;
    assert.equal(r.entry.status, "scheduled");
    assert.equal(r.exitCode, 1);
    assert.equal(instagramAlreadyRegistered(empty), null);
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
