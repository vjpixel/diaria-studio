/**
 * #13403 item 1: guard pós-upload do áudio registrado pelo YouTube.
 * Números reais: 7OMVoFQNru8 (Short degradado) = 2377 bps; UxmyPxgSCV0 (reenvio
 * bom) = 309422; 4HgymlXJrTE (horizontal) = 309410. Sem rede: fetch mockado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  YOUTUBE_AUDIO_MIN_BITRATE_BPS,
  assessYouTubeAudio,
  buildYouTubeAudioAlarm,
  checkYouTubeAudio,
  describeYouTubeAudioCheck,
  mp4HasAudioTrack,
  notifyYouTubeAudioDegraded,
  reportYouTubeAudioCheck,
  type YouTubeAudioCheck,
  type YouTubeFileDetailsItem,
} from "../scripts/lib/diaria/youtube-audio-check.ts";
import { publishYouTubeShort } from "../scripts/publish-shorts.ts";
import { audioCheckExitCode, runCheckYouTubeAudio } from "../scripts/check-youtube-audio.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";

const NOW = new Date("2026-11-17T12:00:00Z");
const DONE = { processingStatus: "succeeded", fileDetailsAvailability: "available" };
const item = (id: string, bitrateBps: unknown, processing = DONE): YouTubeFileDetailsItem =>
  ({ id, processingDetails: processing, fileDetails: { audioStreams: [{ bitrateBps, codec: "aac", channelCount: 2 }] } }) as YouTubeFileDetailsItem;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── MP4 sintético: moov/trak/mdia/hdlr ──────────────────────────────────────
function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
function hdlr(handler: string): Buffer {
  const b = Buffer.alloc(24);
  b.write(handler, 8, "latin1"); // version/flags (4) + pre_defined (4) + handler_type
  return box("hdlr", b);
}
const trak = (handler: string) => box("trak", box("tkhd", Buffer.alloc(8)), box("mdia", box("mdhd", Buffer.alloc(8)), hdlr(handler)));
const mp4 = (...handlers: string[]) => Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", box("mvhd", Buffer.alloc(20)), ...handlers.map(trak)), box("mdat", Buffer.alloc(16))]);

describe("#13403 mp4HasAudioTrack", () => {
  it("vídeo + áudio = true; só vídeo = false; não-MP4 = null", () => {
    assert.equal(mp4HasAudioTrack(mp4("vide", "soun")), true);
    assert.equal(mp4HasAudioTrack(mp4("vide")), false);
    assert.equal(mp4HasAudioTrack(Buffer.from("fake-mp4-bytes")), null);
  });
});

describe("#13403 assessYouTubeAudio", () => {
  it("limiar com os números reais: 2377 degradado; 309422 e 309410 ok (string uint64 e número)", () => {
    const bad = assessYouTubeAudio({ sourceHasAudio: true, item: item("7OMVoFQNru8", "2377"), now: NOW });
    assert.equal(bad.status, "degraded");
    assert.equal(bad.status === "degraded" && bad.ok, false);
    assert.equal(bad.status === "degraded" && bad.bitrate_bps, 2377);
    const good = assessYouTubeAudio({ sourceHasAudio: true, item: item("UxmyPxgSCV0", "309422"), now: NOW });
    assert.deepEqual(good, { status: "ok", ok: true, bitrate_bps: 309422, source_audio: true, checked_at: NOW.toISOString() });
    assert.equal(assessYouTubeAudio({ sourceHasAudio: true, item: item("4HgymlXJrTE", 309410), now: NOW }).status, "ok");
  });

  it("borda: 32000 ok, 31999 degradado; origem ilegível (null) ainda confere", () => {
    assert.equal(YOUTUBE_AUDIO_MIN_BITRATE_BPS, 32_000);
    assert.equal(assessYouTubeAudio({ sourceHasAudio: true, item: item("x", 32000), now: NOW }).status, "ok");
    assert.equal(assessYouTubeAudio({ sourceHasAudio: null, item: item("x", 31999), now: NOW }).status, "degraded");
  });

  it("nenhum stream de áudio registrado com áudio na origem = degradado", () => {
    const r = assessYouTubeAudio({ sourceHasAudio: true, item: { id: "x", processingDetails: DONE, fileDetails: { audioStreams: [] } }, now: NOW });
    assert.equal(r.status, "degraded");
    assert.equal(r.status === "degraded" && r.bitrate_bps, null);
  });

  it("processamento não terminou = pending, mesmo com bitrate baixo já visível", () => {
    const processing = assessYouTubeAudio({ sourceHasAudio: true, item: item("x", "2377", { processingStatus: "processing", fileDetailsAvailability: "inProgress" }), now: NOW });
    assert.equal(processing.status, "pending");
    assert.equal(processing.status === "pending" && processing.pending, true);
    const notAvail = assessYouTubeAudio({ sourceHasAudio: true, item: item("x", "2377", { processingStatus: "succeeded", fileDetailsAvailability: "inProgress" }), now: NOW });
    assert.equal(notAvail.status, "pending");
    assert.match(describeYouTubeAudioCheck(processing, "abcdefghijk")!, /check-youtube-audio\.ts --id abcdefghijk/);
  });

  it("origem sem áudio = sem aviso, mesmo com 2377", () => {
    const r = assessYouTubeAudio({ sourceHasAudio: false, item: item("x", "2377"), now: NOW });
    assert.equal(r.status, "no_source_audio");
    assert.equal(describeYouTubeAudioCheck(r, "x"), null);
  });

  it("bitrateBps ilegível vira erro de leitura, não ok", () => {
    assert.equal(assessYouTubeAudio({ sourceHasAudio: true, item: item("x", "abc"), now: NOW }).status, "error");
  });
});

describe("#13403 checkYouTubeAudio (I/O)", () => {
  const deps = (handler: (url: string) => Response | Promise<Response>) => {
    const calls: string[] = [];
    return { calls, d: { now: () => NOW, fetch: async (url: string) => (calls.push(url), handler(url)) } };
  };

  it("lê fileDetails,processingDetails do id certo", async () => {
    const { d, calls } = deps(() => json(200, { items: [item("7OMVoFQNru8", "2377")] }));
    const r = await checkYouTubeAudio(d, "tok", "7OMVoFQNru8", true);
    assert.equal(r.status, "degraded");
    assert.match(calls[0], /videos\?part=fileDetails,processingDetails&id=7OMVoFQNru8/);
  });

  it("erro HTTP, rede caindo e corpo não-JSON viram status error, nunca lançam", async () => {
    for (const h of [() => json(500, { error: "x" }), () => Promise.reject(new Error("ECONNRESET")), () => new Response("<html>", { status: 200 })]) {
      const { d } = deps(h);
      const r = await checkYouTubeAudio(d, "tok", "x", true);
      assert.equal(r.status, "error");
    }
  });

  it("origem sem áudio não chama a API", async () => {
    const { d, calls } = deps(() => json(200, {}));
    assert.equal((await checkYouTubeAudio(d, "tok", "x", false)).status, "no_source_audio");
    assert.equal(calls.length, 0);
  });
});

describe("#13403 alarme e relato", () => {
  const degraded = assessYouTubeAudio({ sourceHasAudio: true, item: item("7OMVoFQNru8", "2377"), now: NOW }) as Extract<YouTubeAudioCheck, { status: "degraded" }>;
  const ctx = { videoId: "7OMVoFQNru8", url: "https://youtube.com/shorts/7OMVoFQNru8", label: "vertical (Short) da edição 261117" };

  it("o alarme cita o bitrate e a referência", () => {
    const a = buildYouTubeAudioAlarm(degraded, ctx);
    assert.match(a.subject, /Áudio do YouTube degradado/);
    assert.match(a.body, /2377 bps/);
  });

  it("notifyYouTubeAudioDegraded abre issue `acao` com fingerprint = id; falha do portão não lança", async () => {
    const seen: unknown[] = [];
    const ok = await notifyYouTubeAudioDegraded(degraded, ctx, {}, (async (f: unknown) => {
      seen.push(f);
      return { severity: "acao", emailPolicy: "urgent_only", emailSent: false, issue: { action: "created", issueNumber: 1, url: "https://x/1" } };
    }) as never);
    assert.equal(ok.ok, true);
    assert.equal((seen[0] as { fingerprint: string; severity: string }).fingerprint, "7OMVoFQNru8");
    assert.equal((seen[0] as { severity: string }).severity, "acao");
    const fail = await notifyYouTubeAudioDegraded(degraded, ctx, {}, (async () => {
      throw new Error("gh offline");
    }) as never);
    assert.equal(fail.ok, false);
  });

  it("reportYouTubeAudioCheck: degradado dispara o alarme; pendente e ok não", async () => {
    let alarms = 0;
    const alarm = async () => (alarms++, { ok: true, detail: "alarme created" });
    const lines = await reportYouTubeAudioCheck(degraded, ctx, () => {}, alarm);
    assert.equal(alarms, 1);
    assert.match(lines[0], /^\[aviso\] áudio do YouTube degradado/);
    const pending = assessYouTubeAudio({ sourceHasAudio: true, item: item("x", "1", { processingStatus: "processing", fileDetailsAvailability: "inProgress" }), now: NOW });
    await reportYouTubeAudioCheck(pending, ctx, () => {}, alarm);
    await reportYouTubeAudioCheck(assessYouTubeAudio({ sourceHasAudio: true, item: item("x", "309422"), now: NOW }), ctx, () => {}, alarm);
    assert.equal(alarms, 1);
  });
});

// ── publishYouTubeShort: o guard no destino youtube_shorts ──────────────────
const ENV = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w" };
const SLOT = "2026-11-18T12:30:00.000Z";
function shortDeps(fileDetails: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const d: YouTubeUploadDeps = {
    now: () => NOW,
    fetch: async (url) => {
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
      if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: ENV.YOUTUBE_CHANNEL_ID }] });
      if (url.includes("/youtube/v3/playlistItems")) return json(200, { items: [] });
      if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
      if (url === "https://up/sess") return json(200, { id: "7OMVoFQNru8", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } });
      if (url.includes("/youtube/v3/videos?part=fileDetails,processingDetails")) return fileDetails();
      if (url.includes("/youtube/v3/videos?part=status")) return json(200, { items: [{ id: "7OMVoFQNru8", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } }] });
      throw new Error(`rota não mockada: ${url}`);
    },
  };
  return { d, calls };
}
const runShort = (d: YouTubeUploadDeps, file: Buffer, alarm?: Parameters<typeof publishYouTubeShort>[0]["notifyAudioDegraded"]) =>
  publishYouTubeShort({ deps: d, env: ENV, aammdd: "261117", title: "D1", description: "gancho\n#Shorts", scheduledAt: SLOT, file, force: true, ...(alarm ? { notifyAudioDegraded: alarm } : {}) });

describe("#13403 publishYouTubeShort", () => {
  it("2377 bps com áudio na origem: registro com audio_check degradado, aviso e alarme; o Short segue agendado", async () => {
    const { d } = shortDeps(() => json(200, { items: [item("7OMVoFQNru8", "2377")] }));
    let alarms = 0;
    const out = await runShort(d, mp4("vide", "soun"), async () => (alarms++, { ok: true, detail: "alarme created" }));
    assert.equal(out.entry.status, "scheduled");
    const ac = (out.entry as { audio_check?: YouTubeAudioCheck }).audio_check;
    assert.equal(ac?.status, "degraded");
    assert.equal(ac?.status === "degraded" && ac.bitrate_bps, 2377);
    assert.equal(alarms, 1);
    assert.ok(out.warnings?.some((w) => /áudio do YouTube degradado/.test(w)));
  });

  it("processamento em curso: audio_check pending e aviso com o comando, sem alarme", async () => {
    const { d } = shortDeps(() => json(200, { items: [{ id: "7OMVoFQNru8", processingDetails: { processingStatus: "processing", fileDetailsAvailability: "inProgress" } }] }));
    let alarms = 0;
    const out = await runShort(d, mp4("vide", "soun"), async () => (alarms++, { ok: true, detail: "" }));
    const ac = (out.entry as { audio_check?: YouTubeAudioCheck }).audio_check;
    assert.equal(ac?.status === "pending" && ac.pending, true);
    assert.equal(alarms, 0);
    assert.ok(out.warnings?.some((w) => /check-youtube-audio\.ts --id 7OMVoFQNru8/.test(w)));
  });

  it("origem sem áudio: nenhuma leitura de fileDetails, sem aviso de áudio", async () => {
    const { d, calls } = shortDeps(() => json(200, { items: [item("7OMVoFQNru8", "2377")] }));
    const out = await runShort(d, mp4("vide"), async () => ({ ok: true, detail: "" }));
    assert.equal(calls.some((u) => u.includes("fileDetails")), false);
    assert.equal((out.entry as { audio_check?: YouTubeAudioCheck }).audio_check?.status, "no_source_audio");
    assert.ok(!(out.warnings ?? []).some((w) => /áudio/.test(w)));
  });

  it("erro de leitura: aviso, o Short segue registrado (nunca derruba a publicação)", async () => {
    const { d } = shortDeps(() => json(403, { error: { message: "forbidden" } }));
    const out = await runShort(d, mp4("vide", "soun"));
    assert.equal(out.entry.status, "scheduled");
    assert.equal((out.entry as { audio_check?: YouTubeAudioCheck }).audio_check?.status, "error");
    assert.ok(out.warnings?.some((w) => /áudio do YouTube não conferido/.test(w)));
  });
});

// ── CLI de checagem sob demanda ─────────────────────────────────────────────
describe("#13403 check-youtube-audio.ts", () => {
  const cli = (fileDetails: () => Response, argv: string[], env: Record<string, string | undefined> = ENV) => {
    const out: string[] = [];
    const err: string[] = [];
    let alarms = 0;
    const { d, calls } = shortDeps(fileDetails);
    const p = runCheckYouTubeAudio(argv, {
      upload: d,
      env,
      readFile: () => mp4("vide"),
      alarm: async () => (alarms++, { ok: true, detail: "alarme created" }),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return p.then((code) => ({ code, out, err, alarms: () => alarms, calls }));
  };

  it("exit codes: ok 0, degradado 1 (com alarme), pendente 3, sem credencial 2", async () => {
    assert.equal((await cli(() => json(200, { items: [item("UxmyPxgSCV0", "309422")] }), ["--id", "UxmyPxgSCV0"])).code, 0);
    const bad = await cli(() => json(200, { items: [item("7OMVoFQNru8", "2377")] }), ["--id", "7OMVoFQNru8"]);
    assert.equal(bad.code, 1);
    assert.equal(bad.alarms(), 1);
    assert.match(bad.out[0], /"bitrate_bps": 2377/);
    const noAlarm = await cli(() => json(200, { items: [item("7OMVoFQNru8", "2377")] }), ["--id", "7OMVoFQNru8", "--no-alarm"]);
    assert.equal(noAlarm.alarms(), 0);
    assert.equal((await cli(() => json(200, { items: [{ id: "7OMVoFQNru8", processingDetails: { processingStatus: "processing" } }] }), ["--id", "7OMVoFQNru8"])).code, 3);
    assert.equal((await cli(() => json(200, {}), ["--id", "7OMVoFQNru8"], {})).code, 2);
    assert.equal((await cli(() => json(200, {}), ["--id", "curto"])).code, 2);
  });

  it("--source sem faixa de áudio: exit 0 sem chamar a API", async () => {
    const r = await cli(() => json(200, { items: [item("7OMVoFQNru8", "2377")] }), ["--id", "7OMVoFQNru8", "--source", "v.mp4"]);
    assert.equal(r.code, 0);
    assert.equal(r.calls.length, 0);
  });

  it("audioCheckExitCode cobre o erro de leitura", () => {
    assert.equal(audioCheckExitCode({ status: "error", error: "x", checked_at: NOW.toISOString() }), 2);
  });
});
