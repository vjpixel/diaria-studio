/**
 * test/short-first-frame-cover-12100.test.ts (#12100, opção 2 — decisão do editor de 11/11/2026)
 *
 * O feed de Shorts mostra um frame automático do vertical (`oar2.jpg`) e o
 * `thumbnails.set` só troca a miniatura 16:9. O vertical enviado ao YouTube
 * passa a levar a capa nos primeiros ~0,4 s, para o frame automático cair
 * nela. Aqui: o plano/comando do ffmpeg (puro), o orquestrador com I/O falso
 * (nunca toca o vertical da edição, sempre apaga o temporário, nunca lança), a
 * chave do config, e o registro: `first_frame_cover` é "aplicado, não
 * confirmado" — nada afirma que o leitor vê a capa sem a medição do `oar2`.
 * Um teste usa o ffmpeg real quando ele existe na máquina (pulado sem ele).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORT_FIRST_FRAME_COVER_DEFAULT_MS,
  YOUTUBE_SHORT_MAX_SECONDS,
  buildFirstFrameCoverFfmpegArgs,
  checkFirstFrameCoverOutput,
  pickFpsExpr,
  buildVerticalProbeArgs,
  parseFps,
  parseVerticalProbe,
  planFirstFrameCover,
  prepareYouTubeFirstFrameCover,
  type FirstFrameCoverDeps,
  type VerticalProbe,
} from "../scripts/lib/diaria/short-first-frame-cover.ts";
import {
  YOUTUBE_SHORTS_COVER_PLAN,
  keepStudioWebVerticalFeed,
  planCoverDestination,
  youtubeShortAutoFrameUrl,
  youtubeShortsCoverRecord,
  youtubeShortsVerticalCoverWarning,
} from "../scripts/lib/diaria/short-cover.ts";
import { loadShortsConfig, loadYouTubeFirstFrameCoverMs } from "../scripts/lib/diaria/short-video.ts";
import { publishYouTubeShort, youtubeShortUploadFile, youtubeShortsPrepareBeforeMarker } from "../scripts/publish-shorts.ts";
import { feedImageUrl, fetchFeedImage, main as checkShortFeedCoverMain, parseFeedImageKind } from "../scripts/check-short-feed-cover.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";

const PROBE_AUDIO = JSON.stringify({
  streams: [
    { codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30/1" },
    { codec_type: "audio", sample_rate: "48000", channels: 2 },
  ],
  format: { duration: "62.5" },
});

const PROBE: VerticalProbe = parseVerticalProbe(PROBE_AUDIO);

/** O que o ffprobe diz da saída do ffmpeg: o vertical + 0,4 s de capa. */
const PROBE_OUT = JSON.stringify({ ...JSON.parse(PROBE_AUDIO), format: { duration: "62.9" } });

describe("#12100 opção 2 — probe e plano (puros)", () => {
  it("parseFps lê fração e inteiro; 0/0 e lixo viram null", () => {
    assert.equal(parseFps("30/1"), 30);
    assert.ok(Math.abs(parseFps("30000/1001")! - 29.97) < 0.01);
    assert.equal(parseFps("25"), 25);
    assert.equal(parseFps("0/0"), null);
    assert.equal(parseFps("x"), null);
    assert.equal(parseFps(undefined), null);
  });

  it("parseVerticalProbe: dimensões, fps cru, áudio e duração", () => {
    assert.deepEqual(PROBE, {
      width: 1080,
      height: 1920,
      fpsExpr: "30/1",
      fps: 30,
      hasAudio: true,
      audioSampleRate: 48000,
      audioChannels: 2,
      durationSeconds: 62.5,
    });
    const mute = parseVerticalProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 720, height: 1280, r_frame_rate: "0/0", avg_frame_rate: "30000/1001" }] }));
    assert.equal(mute.hasAudio, false);
    assert.equal(mute.fpsExpr, "30000/1001"); // r_frame_rate ilegível cai no avg
    assert.equal(mute.durationSeconds, null);
    assert.throws(() => parseVerticalProbe(JSON.stringify({ streams: [{ codec_type: "audio" }] })), /sem stream de vídeo/);
    assert.throws(() => parseVerticalProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 1, height: 1, r_frame_rate: "0/0" }] })), /fps ilegível/);
  });

  it("duração: container, senão a do stream de vídeo; nenhuma = null", () => {
    const v = { codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30/1" };
    assert.equal(parseVerticalProbe(JSON.stringify({ streams: [{ ...v, duration: "61.2" }] })).durationSeconds, 61.2);
    assert.equal(parseVerticalProbe(JSON.stringify({ streams: [{ ...v, duration: "61.2" }], format: { duration: "62" } })).durationSeconds, 62);
    assert.equal(parseVerticalProbe(JSON.stringify({ streams: [{ ...v, duration: "N/A" }], format: { duration: "N/A" } })).durationSeconds, null);
  });

  it("fps: avg_frame_rate vence quando o r_frame_rate diverge mais de 10% (VFR); acima de 120 fps recusa", () => {
    assert.equal(pickFpsExpr("60/1", "30000/1001"), "30000/1001");
    assert.equal(pickFpsExpr("30/1", "30000/1001"), "30/1"); // 0,1% de diferença: fica o r_frame_rate
    assert.equal(pickFpsExpr("30/1", undefined), "30/1");
    assert.equal(pickFpsExpr("0/0", "0/0"), null);
    assert.throws(
      () => parseVerticalProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 1080, height: 1920, r_frame_rate: "90000/1", avg_frame_rate: "90000/1" }] })),
      /acima de 120/,
    );
  });

  it("planFirstFrameCover: 400 ms a 30 fps = 12 frames; nunca menos de 1 frame", () => {
    assert.deepEqual(planFirstFrameCover({ probe: PROBE, leadMs: 400 }), { ok: true, frames: 12, leadSeconds: 0.4 });
    const tiny = planFirstFrameCover({ probe: PROBE, leadMs: 1 });
    assert.equal(tiny.ok && tiny.frames, 1);
  });

  it("planFirstFrameCover recusa quando vertical + capa passam do teto do Short", () => {
    const longo = { ...PROBE, durationSeconds: YOUTUBE_SHORT_MAX_SECONDS - 0.2 };
    const r = planFirstFrameCover({ probe: longo, leadMs: 400 });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /teto de 180 s/);
    // Duração desconhecida recusa: não dá para garantir o teto de 180 s.
    const semDur = planFirstFrameCover({ probe: { ...PROBE, durationSeconds: null }, leadMs: 400 });
    assert.equal(semDur.ok, false);
    assert.match(!semDur.ok ? semDur.reason : "", /duração do vertical desconhecida/);
  });

  it("checkFirstFrameCoverOutput: W×H, áudio sse a origem tem, duração = original + capa (±0,2 s)", () => {
    const out = parseVerticalProbe(PROBE_OUT);
    assert.equal(checkFirstFrameCoverOutput({ source: PROBE, output: out, leadSeconds: 0.4 }), null);
    assert.equal(checkFirstFrameCoverOutput({ source: PROBE, output: { ...out, durationSeconds: 63.05 }, leadSeconds: 0.4 }), null);
    assert.match(checkFirstFrameCoverOutput({ source: PROBE, output: { ...out, width: 720 }, leadSeconds: 0.4 })!, /720x1920/);
    assert.match(checkFirstFrameCoverOutput({ source: PROBE, output: { ...out, hasAudio: false }, leadSeconds: 0.4 })!, /sem áudio/);
    assert.match(checkFirstFrameCoverOutput({ source: { ...PROBE, hasAudio: false }, output: out, leadSeconds: 0.4 })!, /com áudio/);
    assert.match(checkFirstFrameCoverOutput({ source: PROBE, output: { ...out, durationSeconds: 62.5 }, leadSeconds: 0.4 })!, /esperado 62\.90/);
    assert.match(checkFirstFrameCoverOutput({ source: PROBE, output: { ...out, durationSeconds: null }, leadSeconds: 0.4 })!, /duração da saída/);
  });
});

describe("#12100 opção 2 — comando do ffmpeg (puro)", () => {
  const base = { cover: "/tmp/x/capa.jpg", video: "/ed/diaria-comentada-261111-short.mp4", output: "/tmp/x/out.mp4" };

  it("com áudio: still em loop no fps do vertical + silêncio + concat a=1, saída por último", () => {
    const args = buildFirstFrameCoverFfmpegArgs({ ...base, probe: PROBE, frames: 12 });
    assert.equal(args.at(-1), base.output);
    assert.deepEqual(args.slice(args.indexOf("-loop"), args.indexOf("-loop") + 6), ["-loop", "1", "-framerate", "30/1", "-i", base.cover]);
    assert.ok(args.includes("anullsrc=channel_layout=stereo:sample_rate=48000"));
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920/);
    assert.match(filter, /trim=end_frame=12/);
    assert.match(filter, /atrim=end=0\.400000/);
    assert.match(filter, /concat=n=2:v=1:a=1\[v\]\[a\]/);
    assert.deepEqual(args.filter((a) => a === "-map").length, 2);
    assert.ok(args.includes("+faststart"));
  });

  it("sem áudio: nenhuma entrada de silêncio e concat a=0", () => {
    const args = buildFirstFrameCoverFfmpegArgs({ ...base, probe: { ...PROBE, hasAudio: false, audioSampleRate: null, audioChannels: null }, frames: 12 });
    assert.ok(!args.some((a) => a.startsWith("anullsrc")));
    assert.match(args[args.indexOf("-filter_complex") + 1], /\[1:v\].*concat=n=2:v=1:a=0\[v\]/);
  });

  it("o vertical da edição só aparece como entrada (-i), nunca como saída", () => {
    for (const probe of [PROBE, { ...PROBE, hasAudio: false }]) {
      const args = buildFirstFrameCoverFfmpegArgs({ ...base, probe, frames: 12 });
      const i = args.indexOf(base.video);
      assert.equal(args[i - 1], "-i");
      assert.equal(args.lastIndexOf(base.video), i);
    }
  });

  it("probe lê streams e format em JSON", () => {
    assert.deepEqual(buildVerticalProbeArgs("/v.mp4"), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "/v.mp4"]);
  });
});

/** I/O falso: registra o que foi chamado. */
function fakeDeps(over: Partial<FirstFrameCoverDeps> = {}) {
  const calls = { ffmpeg: [] as string[][], removed: [] as string[], written: [] as string[], log: [] as string[] };
  const deps: FirstFrameCoverDeps = {
    // A 2ª passada (a saída do ffmpeg, no temporário) devolve o vertical + 0,4 s.
    runFfprobe: (args) => ({ ok: true, stdout: args.at(-1)!.endsWith("youtube-short-first-frame.mp4") ? PROBE_OUT : PROBE_AUDIO }),
    runFfmpeg: (args) => {
      calls.ffmpeg.push(args);
      return { ok: true };
    },
    makeTempDir: () => "/tmp/ff-1",
    writeFile: (p) => void calls.written.push(p),
    readFile: () => Buffer.from("derivado"),
    removeDir: (d) => void calls.removed.push(d),
    log: (l) => void calls.log.push(l),
    ...over,
  };
  return { deps, calls };
}

describe("#12100 opção 2 — prepareYouTubeFirstFrameCover (I/O falso)", () => {
  const input = { videoPath: "/ed/v.mp4", cover: Buffer.from("jpg"), leadMs: 400 };

  it("sucesso: devolve os bytes derivados, grava só no temporário e apaga o temporário", () => {
    const { deps, calls } = fakeDeps();
    const r = prepareYouTubeFirstFrameCover(deps, input);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.bytes.toString(), "derivado");
    assert.equal(r.ok && r.leadMs, 400);
    assert.equal(r.ok && r.frames, 12);
    assert.deepEqual(calls.written, ["/tmp/ff-1/capa.jpg"]);
    assert.deepEqual(calls.removed, ["/tmp/ff-1"]);
    assert.equal(calls.ffmpeg[0].at(-1), "/tmp/ff-1/youtube-short-first-frame.mp4");
  });

  it("falha do ffmpeg, do ffprobe, arquivo vazio ou exceção: ok:false, nunca lança, temporário apagado", () => {
    const cases: Array<Partial<FirstFrameCoverDeps>> = [
      { runFfmpeg: () => ({ ok: false, error: "boom" }) },
      { runFfprobe: () => ({ ok: false, error: "sem ffprobe" }) },
      { readFile: () => Buffer.alloc(0) },
      { readFile: () => { throw new Error("ENOENT"); } },
    ];
    for (const over of cases) {
      const { deps, calls } = fakeDeps(over);
      const r = prepareYouTubeFirstFrameCover(deps, input);
      assert.equal(r.ok, false);
      if (!over.runFfprobe) assert.deepEqual(calls.removed, ["/tmp/ff-1"]);
    }
  });

  it("saída que não confere com o vertical (ffprobe da saída): ok:false com o motivo, nunca sobe", () => {
    const outProbes: Record<string, string> = {
      "W×H": JSON.stringify({ streams: [{ codec_type: "video", width: 720, height: 1280, r_frame_rate: "30/1" }, { codec_type: "audio" }], format: { duration: "62.9" } }),
      "sem áudio": JSON.stringify({ streams: [{ codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30/1" }], format: { duration: "62.9" } }),
      duração: JSON.stringify({ ...JSON.parse(PROBE_AUDIO), format: { duration: "30" } }),
    };
    for (const [caso, stdout] of Object.entries(outProbes)) {
      const { deps, calls } = fakeDeps({ runFfprobe: (a) => ({ ok: true, stdout: a.at(-1)!.endsWith(".mp4") && a.at(-1)!.includes("first-frame") ? stdout : PROBE_AUDIO }) });
      const r = prepareYouTubeFirstFrameCover(deps, input);
      assert.equal(r.ok, false, caso);
      assert.match(!r.ok ? r.error : "", /saída do ffmpeg não confere/, caso);
      assert.deepEqual(calls.removed, ["/tmp/ff-1"], caso);
    }
    const { deps } = fakeDeps({ runFfprobe: (a) => (a.at(-1)!.includes("first-frame") ? { ok: false, error: "corrompido" } : { ok: true, stdout: PROBE_AUDIO }) });
    const r = prepareYouTubeFirstFrameCover(deps, input);
    assert.match(!r.ok ? r.error : "", /ffprobe da saída falhou: corrompido/);
  });

  it("temporário que não apaga: o resultado vale e o log traz [aviso]", () => {
    const { deps, calls } = fakeDeps({ removeDir: () => { throw new Error("EBUSY"); } });
    const r = prepareYouTubeFirstFrameCover(deps, input);
    assert.equal(r.ok, true);
    assert.match(calls.log.join("\n"), /\[aviso\].*\/tmp\/ff-1 não apagado \(EBUSY\)/);
  });

  it("vertical longo demais: não chama o ffmpeg", () => {
    const longo = JSON.stringify({ streams: [{ codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30/1" }], format: { duration: "179.9" } });
    const { deps, calls } = fakeDeps({ runFfprobe: () => ({ ok: true, stdout: longo }) });
    const r = prepareYouTubeFirstFrameCover(deps, input);
    assert.equal(r.ok, false);
    assert.equal(calls.ffmpeg.length, 0);
  });
});

describe("#12100 opção 2 — youtubeShortUploadFile (o que sobe para o YouTube)", () => {
  const original = Buffer.from("original");
  const run = (leadMs: number | null, cover: Buffer | null, over: Partial<FirstFrameCoverDeps> = {}) => {
    const lines: string[] = [];
    const out = youtubeShortUploadFile({ file: original, videoPath: "/ed/v.mp4", cover, leadMs, log: (l) => lines.push(l), deps: fakeDeps(over).deps });
    return { out, log: lines.join("\n") };
  };

  it("ligado e com capa: sobe o derivado e loga o que fez", () => {
    const { out, log } = run(400, Buffer.from("jpg"));
    assert.equal(out.file.toString(), "derivado");
    assert.deepEqual(out.firstFrame, { ms: 400 });
    assert.match(log, /\[ok\] youtube_shorts: arquivo preparado com a capa nos primeiros 400 ms \(12 frames/);
    assert.doesNotMatch(log, /enviado/); // roda antes do upload: nunca diz que enviou
    assert.match(log, /não confirmado/);
  });

  it("desligado, sem capa ou falha: sobe o original sem firstFrame, com a razão no log", () => {
    const off = run(null, Buffer.from("jpg"));
    assert.equal(off.out.file, original);
    assert.equal(off.out.firstFrame, null);
    assert.match(off.log, /desligada/);
    const semCapa = run(400, null);
    assert.equal(semCapa.out.file, original);
    assert.match(semCapa.log, /sem capa local/);
    // Capa que existe mas não deu para ler não é "sem capa local".
    const lines: string[] = [];
    const ilegivel = youtubeShortUploadFile({ file: original, videoPath: "/ed/v.mp4", cover: null, coverUnreadable: "EACCES", leadMs: 400, log: (l) => lines.push(l), deps: fakeDeps().deps });
    assert.equal(ilegivel.file, original);
    assert.match(lines.join("\n"), /capa local ilegível \(EACCES\)/);
    assert.doesNotMatch(lines.join("\n"), /sem capa local/);
    const falha = run(400, Buffer.from("jpg"), { runFfmpeg: () => ({ ok: false, error: "boom" }) });
    assert.equal(falha.out.file, original);
    assert.equal(falha.out.firstFrame, null);
    assert.match(falha.log, /\[aviso\].*não aplicada \(ffmpeg falhou: boom\)/);
  });
});

describe("#12100 opção 2 — config publishing.shorts", () => {
  it("default ligado em 400 ms; false desliga; ms fora da faixa ou não inteiro avisa e cai no default (não derruba os destinos)", () => {
    assert.equal(loadYouTubeFirstFrameCoverMs({}), SHORT_FIRST_FRAME_COVER_DEFAULT_MS);
    assert.equal(loadYouTubeFirstFrameCoverMs({ youtube_first_frame_cover: false, youtube_first_frame_cover_ms: 9 }), null);
    assert.equal(loadYouTubeFirstFrameCoverMs({ youtube_first_frame_cover_ms: 500 }), 500);
    for (const bad of [50, 2500, 400.5, "400"]) {
      const warns: string[] = [];
      assert.equal(loadYouTubeFirstFrameCoverMs({ youtube_first_frame_cover_ms: bad }, (l) => warns.push(l)), SHORT_FIRST_FRAME_COVER_DEFAULT_MS);
      assert.match(warns.join("\n"), /\[aviso\].*entre 100 e 2000.*default 400/);
    }
    assert.throws(() => loadYouTubeFirstFrameCoverMs({ youtube_first_frame_cover: "sim" }), /boolean/);
    assert.equal(loadShortsConfig(undefined).youtubeFirstFrameCoverMs, SHORT_FIRST_FRAME_COVER_DEFAULT_MS);
  });

  it("platform.config.json liga a capa no 1º frame", () => {
    const config = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    assert.equal(config.publishing.shorts.youtube_first_frame_cover, true);
    assert.equal(loadShortsConfig(config).youtubeFirstFrameCoverMs, 400);
  });

  it("o plano descreve a capa no 1º frame como não confirmada", () => {
    const ctx = { coverPath: "/c.jpg", coverUploadReady: true, bufferOffsetMs: 0 };
    const on = planCoverDestination({ destination: "youtube_shorts", mode: "api" }, { ...ctx, youtubeFirstFrameMs: 400 });
    assert.ok(on.startsWith(YOUTUBE_SHORTS_COVER_PLAN));
    assert.match(on, /first_frame_cover \(capa nos primeiros 400 ms.*não confirmado.*oar2/);
    assert.equal(planCoverDestination({ destination: "youtube_shorts", mode: "api" }, { ...ctx, youtubeFirstFrameMs: null }), YOUTUBE_SHORTS_COVER_PLAN);
    // Outros destinos não mudam.
    assert.equal(planCoverDestination({ destination: "facebook:diaria" }, { ...ctx, youtubeFirstFrameMs: 400 }), "thumbnail_upload");
  });
});

describe("#12100 opção 2 — registro honesto da capa", () => {
  it("16:9 ok + capa no 1º frame: vertical_feed first_frame_cover com first_frame_ms, sem nada que diga que o feed mostra a capa", () => {
    const rec = youtubeShortsCoverRecord({ attempted: true, ok: true }, { ms: 400 });
    assert.deepEqual(rec, { method: "thumbnails_set", ok: true, vertical_feed: "first_frame_cover", first_frame_ms: 400 });
    // Sem a capa no 1º frame, o registro segue o do #12139.
    assert.deepEqual(youtubeShortsCoverRecord({ attempted: true, ok: true }), { method: "thumbnails_set", ok: true, vertical_feed: "manual" });
  });

  it("thumbnails.set falho não apaga a capa no 1º frame (é outro canal)", () => {
    assert.deepEqual(youtubeShortsCoverRecord({ attempted: true, ok: false, error: "403" }, { ms: 400 }), {
      method: "thumbnails_set",
      ok: false,
      error: "403",
      vertical_feed: "first_frame_cover",
      first_frame_ms: 400,
    });
  });

  it("aviso do first_frame_cover: não confirmado, comando de medição do oar2 e o passo do Studio web", () => {
    const w = youtubeShortsVerticalCoverWarning("abcdefghijk", { method: "thumbnails_set", ok: true, vertical_feed: "first_frame_cover", first_frame_ms: 400 });
    assert.ok(w);
    assert.match(w!, /não confirmado/);
    assert.match(w!, /--image oar2/);
    assert.ok(w!.includes(youtubeShortAutoFrameUrl("abcdefghijk")));
    assert.match(w!, /Studio web/);
    // studio_web continua sem aviso.
    assert.equal(youtubeShortsVerticalCoverWarning("abcdefghijk", { method: "thumbnails_set", ok: true, vertical_feed: "studio_web", first_frame_ms: 400 }), null);
  });

  it("re-execução (--update-scheduled) não reenvia o vídeo: first_frame_cover e first_frame_ms sobrevivem; studio_web vence", () => {
    const next = youtubeShortsCoverRecord({ attempted: true, ok: true });
    assert.deepEqual(keepStudioWebVerticalFeed(next, { method: "thumbnails_set", ok: true, vertical_feed: "first_frame_cover", first_frame_ms: 400 }), {
      method: "thumbnails_set",
      ok: true,
      vertical_feed: "first_frame_cover",
      first_frame_ms: 400,
    });
    assert.deepEqual(keepStudioWebVerticalFeed(next, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web", first_frame_ms: 400 }), {
      method: "thumbnails_set",
      ok: true,
      vertical_feed: "studio_web",
      first_frame_ms: 400,
    });
  });

  it("studio_web anterior é absorvente: vence um next first_frame_cover", () => {
    const next = youtubeShortsCoverRecord({ attempted: true, ok: true }, { ms: 400 });
    assert.deepEqual(keepStudioWebVerticalFeed(next, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" }), {
      method: "thumbnails_set",
      ok: true,
      vertical_feed: "studio_web",
      first_frame_ms: 400,
    });
  });

  it("thumbnails.set falho na re-execução: first_frame_cover anterior preservado e o aviso de medição acende", () => {
    const next = youtubeShortsCoverRecord({ attempted: true, ok: false, error: "403" });
    const kept = keepStudioWebVerticalFeed(next, { method: "thumbnails_set", ok: true, vertical_feed: "first_frame_cover", first_frame_ms: 400 });
    assert.deepEqual(kept, { method: "thumbnails_set", ok: false, error: "403", vertical_feed: "first_frame_cover", first_frame_ms: 400 });
    const w = youtubeShortsVerticalCoverWarning("abcdefghijk", kept);
    assert.match(w ?? "", /primeiros 400 ms.*não confirmado.*--image oar2/);
  });

  it("publishYouTubeShort grava first_frame_cover e avisa da medição", async () => {
    const SLOT = "2026-11-12T09:30:00.000Z";
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const deps: YouTubeUploadDeps = {
      now: () => new Date("2026-11-12T03:00:00Z"),
      fetch: async (url) => {
        if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
        if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: "UC1" }] });
        if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
        if (url === "https://up/sess") return json(200, { id: "s1", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } });
        if (url.includes("thumbnails/set")) return json(200, { items: [] });
        if (url.includes("/youtube/v3/videos?part=status")) return json(200, { items: [{ id: "s1", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } }] });
        throw new Error(`rota não mockada: ${url}`);
      },
    };
    const out = await publishYouTubeShort({
      deps,
      env: { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UC1" },
      aammdd: "261112",
      title: "T",
      description: "d",
      scheduledAt: SLOT,
      file: Buffer.from("mp4"),
      force: true,
      cover: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      firstFrame: { ms: 400 },
    });
    assert.deepEqual(out.entry.cover, { method: "thumbnails_set", ok: true, vertical_feed: "first_frame_cover", first_frame_ms: 400 });
    assert.match((out.warnings ?? []).join("\n"), /oar2\.jpg/);
  });
});

describe("#12100 opção 2 — encode antes do marcador de envio (review da PR #12844)", () => {
  const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UC1" };

  it("só prepara no publish do youtube_shorts com a credencial do canal presente", () => {
    assert.equal(youtubeShortsPrepareBeforeMarker({ destination: "youtube_shorts", action: "publish" }, env), true);
    assert.equal(youtubeShortsPrepareBeforeMarker({ destination: "youtube_shorts", action: "publish" }, { ...env, YOUTUBE_REFRESH_TOKEN: "" }), false);
    assert.equal(youtubeShortsPrepareBeforeMarker({ destination: "youtube_shorts", action: "skip" }, env), false);
    assert.equal(youtubeShortsPrepareBeforeMarker({ destination: "facebook:diaria", action: "publish" }, env), false);
  });

  it("no CLI, o encode vem antes do markShortSending e o publishYouTubeShort usa o arquivo já preparado", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    const mainStart = src.indexOf("async function main(");
    assert.ok(mainStart > 0);
    const body = src.slice(mainStart);
    const prep = body.indexOf("youtubeShortsPrepareBeforeMarker(item");
    const marker = body.indexOf("markShortSending(dir");
    const encode = body.indexOf("youtubeShortUploadFile(");
    const publish = body.indexOf("outcome = await publishYouTubeShort(");
    assert.ok(prep > 0 && marker > 0 && encode > 0 && publish > 0);
    assert.ok(prep < marker && encode < marker, "o encode precisa vir antes do marcador de envio");
    assert.ok(marker < publish);
    // Nenhum outro encode dentro da janela do marcador.
    assert.equal(body.indexOf("youtubeShortUploadFile(", encode + 1), -1);
  });
});

describe("#12100 opção 2 — check-short-feed-cover: exit codes do --image (offline)", () => {
  it("parseFeedImageKind: ausente = sardefault; inválido = null", () => {
    assert.equal(parseFeedImageKind(undefined), "sardefault");
    assert.equal(parseFeedImageKind("oar2"), "oar2");
    assert.equal(parseFeedImageKind("oar1"), null);
  });

  it("--image inválido → 2; 404 no oar2 → 2; 404 no sardefault → 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "csfc-12100-"));
    const origErr = console.error;
    const origLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      const cover = join(dir, "c.jpg");
      writeFileSync(cover, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const seen: string[] = [];
      const f404 = (async (url: string) => {
        seen.push(url);
        return new Response("nf", { status: 404 });
      }) as unknown as typeof fetch;
      const id = "abcdefghijk";
      assert.equal(await checkShortFeedCoverMain(["--id", id, "--cover", cover, "--image", "oar1"], f404), 2);
      assert.deepEqual(seen, []); // inválido sai antes de qualquer rede
      assert.equal(await checkShortFeedCoverMain(["--id", id, "--cover", cover, "--image", "oar2"], f404), 2);
      assert.equal(await checkShortFeedCoverMain(["--id", id, "--cover", cover], f404), 1);
      assert.deepEqual(seen, [`https://i.ytimg.com/vi/${id}/oar2.jpg`, `https://i.ytimg.com/vi/${id}/sardefault.jpg`]);
    } finally {
      console.error = origErr;
      console.log = origLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12100 opção 2 — medição pelo oar2 (check-short-feed-cover --image oar2)", () => {
  it("feedImageUrl escolhe oar2 ou sardefault", () => {
    assert.equal(feedImageUrl("abcdefghijk", "oar2"), "https://i.ytimg.com/vi/abcdefghijk/oar2.jpg");
    assert.equal(feedImageUrl("abcdefghijk", "sardefault"), "https://i.ytimg.com/vi/abcdefghijk/sardefault.jpg");
  });

  it("fetchFeedImage com kind oar2 baixa o oar2.jpg", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    const buf = await fetchFeedImage("abcdefghijk", fake, "oar2");
    assert.deepEqual(seen, ["https://i.ytimg.com/vi/abcdefghijk/oar2.jpg"]);
    assert.equal(buf?.length, 3);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe("#12100 opção 2 — ffmpeg real (pulado sem ffmpeg na máquina)", () => {
  const audioCases = [
    { name: "estéreo", channels: 2 as number | null },
    { name: "mono", channels: 1 as number | null },
    { name: "sem áudio", channels: null as number | null },
  ];
  for (const ac of audioCases) it(`o 1º frame do derivado é a capa e o vertical original não muda (${ac.name})`, { skip: !hasFfmpeg && "ffmpeg/ffprobe ausentes" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-12100-"));
    try {
      const video = join(dir, "v.mp4");
      const cover = join(dir, "c.jpg");
      const ff = (args: string[]) => assert.equal(spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args]).status, 0);
      const audioIn = ac.channels === null ? [] : ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"];
      const audioOut = ac.channels === null ? [] : ["-c:a", "aac", "-ac", String(ac.channels)];
      ff(["-f", "lavfi", "-i", "color=blue:size=180x320:rate=30", ...audioIn, "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", ...audioOut, video]);
      ff(["-f", "lavfi", "-i", "color=red:size=90x160", "-frames:v", "1", cover]);
      const before = readFileSync(video);
      const deps: FirstFrameCoverDeps = {
        runFfprobe: (a) => {
          const r = spawnSync("ffprobe", a, { encoding: "utf8" });
          return r.status === 0 ? { ok: true, stdout: r.stdout } : { ok: false, error: r.stderr };
        },
        runFfmpeg: (a) => {
          const r = spawnSync("ffmpeg", a, { encoding: "utf8" });
          return r.status === 0 ? { ok: true } : { ok: false, error: r.stderr };
        },
        makeTempDir: () => mkdtempSync(join(dir, "tmp-")),
        writeFile: (p, b) => writeFileSync(p, b),
        readFile: (p) => readFileSync(p),
        removeDir: (d) => rmSync(d, { recursive: true, force: true }),
      };
      const r = prepareYouTubeFirstFrameCover(deps, { videoPath: video, cover: readFileSync(cover), leadMs: 400 });
      assert.equal(r.ok, true, !r.ok ? r.error : "");
      assert.ok(readFileSync(video).equals(before), "o vertical original foi alterado");
      const out = join(dir, "out.mp4");
      writeFileSync(out, r.ok ? r.bytes : Buffer.alloc(0));
      const probe = parseVerticalProbe(spawnSync("ffprobe", buildVerticalProbeArgs(out), { encoding: "utf8" }).stdout);
      assert.equal(probe.width, 180);
      assert.equal(probe.height, 320);
      assert.equal(probe.hasAudio, ac.channels !== null);
      assert.equal(probe.audioChannels, ac.channels);
      assert.ok(Math.abs(probe.durationSeconds! - 1.4) < 0.1, `duração ${probe.durationSeconds}`);
      // Pixel central do 1º frame: vermelho (capa); depois de 0,4 s: azul (vertical).
      const px = (ss: string) => spawnSync("ffmpeg", ["-loglevel", "error", "-ss", ss, "-i", out, "-frames:v", "1", "-vf", "crop=2:2:90:160", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
      const [r0, , b0] = px("0");
      assert.ok(r0 > 200 && b0 < 60, `1º frame não é a capa: rgb ${[...px("0")]}`);
      const [r1, , b1] = px("0.7");
      assert.ok(b1 > 200 && r1 < 60, `depois da capa não é o vertical: rgb ${[...px("0.7")]}`);
      // Sem os temporários.
      assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("tmp-")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
