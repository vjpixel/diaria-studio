/**
 * test/check-youtube-audio-corte-13734.test.ts (#13734)
 *
 * O aviso do `publish-shorts --corte` sugeria `check-youtube-audio.ts --id ID
 * --edition {data do corte}`, que sai `exit 2` ("nenhum registro da edição"):
 * o vertical de corte fica em `data/cortes/{slug}/`, não na pasta da edição. O
 * workaround foi `--source data/cortes/{slug}/corte-{slug}.mp4 --no-alarm`.
 * Agora o comando aceita `--corte SLUG` e o aviso do modo corte o imprime.
 * Sem rede: fetch mockado.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeYouTubeAudioCheck, youtubeAudioCheckCommand, type YouTubeFileDetailsItem } from "../scripts/lib/diaria/youtube-audio-check.ts";
import { runCheckYouTubeAudio } from "../scripts/check-youtube-audio.ts";
import { publishYouTubeShort } from "../scripts/publish-shorts/youtube.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";

const NOW = new Date("2026-11-19T12:00:00Z");
const ENV = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w" };
const SLUG = "guia-261117";
const ID = "UL2maIaZs_Q";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const item = (bitrateBps: string): YouTubeFileDetailsItem =>
  ({ id: ID, processingDetails: { processingStatus: "succeeded", fileDetailsAvailability: "available" }, fileDetails: { audioStreams: [{ bitrateBps }] } }) as YouTubeFileDetailsItem;

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
function trak(handler: string): Buffer {
  const h = Buffer.alloc(24);
  h.write(handler, 8, "latin1");
  return box("trak", box("tkhd", Buffer.alloc(8)), box("mdia", box("mdhd", Buffer.alloc(8)), box("hdlr", h)));
}
const mp4 = (...handlers: string[]) => Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", box("mvhd", Buffer.alloc(20)), ...handlers.map(trak))]);

function deps(fileDetails: () => Response) {
  const calls: string[] = [];
  const d: YouTubeUploadDeps = {
    now: () => NOW,
    fetch: async (url) => {
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
      if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: ENV.YOUTUBE_CHANNEL_ID }] });
      if (url.includes("/youtube/v3/playlistItems")) return json(200, { items: [] });
      if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
      if (url === "https://up/sess") return json(200, { id: ID, status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: "2026-11-23T11:30:00.000Z" } });
      if (url.includes("part=fileDetails,processingDetails")) return fileDetails();
      if (url.includes("part=status")) return json(200, { items: [{ id: ID, status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: "2026-11-23T11:30:00.000Z" } }] });
      throw new Error(`rota não mockada: ${url}`);
    },
  };
  return { d, calls };
}

describe("#13734 comando sugerido no modo corte", () => {
  it("youtubeAudioCheckCommand com o slug leva --corte, não --edition", () => {
    assert.equal(youtubeAudioCheckCommand(ID, "261120", SLUG), `npx tsx scripts/check-youtube-audio.ts --id ${ID} --corte ${SLUG}`);
    assert.equal(youtubeAudioCheckCommand(ID, "261120"), `npx tsx scripts/check-youtube-audio.ts --id ${ID} --edition 261120`);
    const line = describeYouTubeAudioCheck({ status: "pending", processing_status: "processing", file_details_availability: "inProgress", checked_at: NOW.toISOString() }, ID, "261120", SLUG);
    assert.match(line ?? "", new RegExp(`--corte ${SLUG}`));
    assert.doesNotMatch(line ?? "", /--edition/);
  });

  it("publishYouTubeShort do corte avisa com --corte SLUG (era --edition {data do corte})", async () => {
    const { d } = deps(() => json(200, { items: [{ id: ID, processingDetails: { processingStatus: "processing", fileDetailsAvailability: "inProgress" } }] }));
    const out = await publishYouTubeShort({
      deps: d, env: ENV, aammdd: "261120", title: "Guia", description: "gancho\n#Shorts", scheduledAt: "2026-11-23T11:30:00.000Z",
      file: mp4("vide", "soun"), force: true, matchTitleOnly: true, corteSlug: SLUG,
    });
    assert.equal(out.entry.audio_check?.status, "pending");
    assert.ok(out.warnings?.some((w) => w.includes(`check-youtube-audio.ts --id ${ID} --corte ${SLUG}`)), (out.warnings ?? []).join("\n"));
  });
});

describe("#13734 check-youtube-audio.ts --corte SLUG", () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yt-audio-13734-"));
    dir = join(root, SLUG);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "corte.json"), JSON.stringify({ slug: SLUG, date: "261120", hhmm: "08:00", title: "Guia", hook: "Gancho.", video: `corte-${SLUG}.mp4` }));
    writeFileSync(
      join(dir, "_internal", "06-shorts-published.json"),
      JSON.stringify({
        aammdd: "261120",
        entries: [
          { destination: "youtube_shorts", status: "scheduled", id: ID, at: NOW.toISOString(), audio_check: { status: "pending" } },
          { destination: "x", status: "scheduled", id: "buffer:1", at: NOW.toISOString() },
        ],
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cli = (argv: string[], fileDetails: () => Response, video: Buffer | null = mp4("vide", "soun")) => {
    const out: string[] = [];
    const err: string[] = [];
    const alarms: string[] = [];
    const { d, calls } = deps(fileDetails);
    if (video) writeFileSync(join(dir, `corte-${SLUG}.mp4`), video);
    const p = runCheckYouTubeAudio(argv, {
      upload: d,
      env: ENV,
      readFile: (p) => readFileSync(p),
      alarm: async (_c, ctx) => {
        alarms.push(ctx.label);
        return { ok: true, detail: "alarme created" };
      },
      editionDir: () => join(root, "nao-e-a-pasta-do-corte"),
      corteDir: (slug) => join(root, slug),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return p.then((code) => ({ code, out, err, alarms, calls }));
  };

  it("o cenário da issue: --corte acha o Short no registro do corte e regrava só a entrada youtube_shorts", async () => {
    const r = await cli(["--id", ID, "--corte", SLUG], () => json(200, { items: [item("309422")] }));
    assert.equal(r.code, 0, r.err.join("\n"));
    const reg = JSON.parse(readFileSync(join(dir, "_internal", "06-shorts-published.json"), "utf8"));
    const yt = reg.entries.find((e: { destination: string }) => e.destination === "youtube_shorts");
    assert.equal(yt.audio_check.status, "ok");
    assert.equal(yt.audio_check.bitrate_bps, 309422);
    assert.equal(yt.audio_check.source_audio, true, "a origem padrão é o vertical do corte (corte.json)");
    assert.equal(reg.entries.find((e: { destination: string }) => e.destination === "x").id, "buffer:1");
  });

  it("vertical do corte sem faixa de áudio: nada a conferir, sem chamar a API (o workaround do --source, agora sozinho)", async () => {
    const r = await cli(["--id", ID, "--corte", SLUG], () => json(200, { items: [item("2377")] }), mp4("vide"));
    assert.equal(r.code, 0);
    assert.equal(r.calls.length, 0);
  });

  it("vertical ausente nesta máquina: confere o YouTube mesmo assim, com aviso", async () => {
    const r = await cli(["--id", ID, "--corte", SLUG], () => json(200, { items: [item("309422")] }), null);
    assert.equal(r.code, 0, r.err.join("\n"));
    assert.ok(r.err.some((l) => /vertical do corte ilegível/.test(l)));
  });

  it("degradado: alarme com o rótulo do corte, depois de gravado", async () => {
    const r = await cli(["--id", ID, "--corte", SLUG], () => json(200, { items: [item("2377")] }));
    assert.equal(r.code, 1);
    assert.deepEqual(r.alarms, [`vertical (Short) do corte ${SLUG}`]);
  });

  it("uso errado sai 2 sem chamar a API: --corte com --edition, --part horizontal, slug inválido, corte sem o vídeo, corte inexistente", async () => {
    const ok = () => json(200, { items: [item("309422")] });
    for (const argv of [
      ["--id", ID, "--corte", SLUG, "--edition", "261120"],
      ["--id", ID, "--corte", SLUG, "--part", "horizontal"],
      ["--id", ID, "--corte", "Slug Inválido"],
      ["--id", ID, "--corte"],
      ["--id", "7OMVoFQNru8", "--corte", SLUG],
      ["--id", ID, "--corte", "outro-corte"],
    ]) {
      const r = await cli(argv, ok);
      assert.equal(r.code, 2, argv.join(" "));
      assert.equal(r.calls.length, 0, argv.join(" "));
    }
  });
});
