/**
 * test/youtube-title-thumb-11739-11740.test.ts
 *
 * #11739: `publish-youtube.ts --title` — título do YouTube diferente do D1
 * (caso real da 261030: "ChatGPT e remédio: pais processam OpenAI após morte
 * da filha" no lugar de "Pais acusam ChatGPT de matar sua filha"), gravado no
 * registro e ainda casando a detecção do vídeo já no canal (#11080/#11132).
 *
 * #11740: gancho da capa em duas linhas alinhadas à direita, com mais de 4
 * palavras no total (capa da 261030: "Confiou no chatbot" / "e morreu").
 *
 * Sem rede: o fetch do YouTube é falso.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { matchEditionVideo, YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { planYouTubePublish, runYouTubeUpload } from "../scripts/publish-youtube.ts";
import {
  YOUTUBE_THUMB_H,
  YOUTUBE_THUMB_W,
  buildHookSvg,
  composeYouTubeThumb,
  hookFontSize,
  splitHook,
} from "../scripts/lib/diaria/youtube-thumb.ts";
import { COLORS } from "../scripts/lib/shared/design-tokens.ts";

const D1_TITLE = "Pais acusam ChatGPT de matar sua filha";
const YT_TITLE = "ChatGPT e remédio: pais processam OpenAI após morte da filha";
const REVIEWED_MD = `DESTAQUE 1 | SAÚDE
${D1_TITLE}
https://fonte.exemplo.com/artigo

Os pais dizem que o chatbot recomendou a combinação de remédios.

Por que isso importa:
Porque sim.
`;
const ENV = {
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  YOUTUBE_REFRESH_TOKEN: "refresh",
  YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w",
};
const NOW = new Date("2026-10-29T23:00:00Z");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function channelDeps(videos: unknown[]) {
  const insertBodies: string[] = [];
  const calls: string[] = [];
  const deps: YouTubeUploadDeps = {
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
      if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: ENV.YOUTUBE_CHANNEL_ID }] });
      if (url.includes("/youtube/v3/playlistItems")) {
        return json(200, { items: videos.map((v) => ({ contentDetails: { videoId: (v as { id: string }).id } })) });
      }
      if (url.includes("/youtube/v3/videos?part=snippet,status")) return json(200, { items: videos });
      if (url.includes("uploadType=resumable")) {
        insertBodies.push(String(init?.body ?? ""));
        return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
      }
      if (url === "https://up/sess") return json(200, { id: "newVid", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: "2026-10-30T09:00:00.000Z" } });
      if (url.includes("/youtube/v3/videos?part=status")) return json(200, { items: [{ id: "newVid", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: "2026-10-30T09:00:00.000Z" } }] });
      throw new Error(`rota não mockada: ${url}`);
    },
  };
  return { deps, insertBodies, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-11739-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function plan(title?: string) {
  const videoPath = join(dir, "diaria-comentada-261030.mp4");
  writeFileSync(videoPath, Buffer.from("fake"));
  return planYouTubePublish({
    aammdd: "261030",
    reviewedMd: REVIEWED_MD,
    now: NOW,
    episode: 10,
    editionUrl: "https://diar.ia.br/p/pais-acusam",
    ...(title !== undefined ? { title } : {}),
    video: { path: videoPath, exists: true, sizeBytes: 4 },
    thumb: { path: join(dir, "04-youtube-thumb.jpg"), exists: false },
  });
}

async function run(deps: YouTubeUploadDeps, p: ReturnType<typeof plan>) {
  const logs: string[] = [];
  const outcome = await runYouTubeUpload(deps, {
    plan: p,
    editionDir: dir,
    env: ENV,
    force: false,
    readFile: (f) => readFileSync(f),
    log: (l) => logs.push(l),
  });
  return { outcome, logs };
}

describe("publish-youtube --title (#11739)", () => {
  it("sem --title, o título é o do D1 (padrão inalterado)", () => {
    const p = plan();
    assert.equal(p.metadata.title, D1_TITLE);
    assert.equal(p.d1Title, D1_TITLE);
    assert.equal(p.titleSource, "d1");
  });

  it("com --title, o request do videos.insert leva o título do editor e o plano registra a premissa", () => {
    const p = plan(YT_TITLE);
    assert.equal(p.metadata.title, YT_TITLE);
    assert.equal(p.titleSource, "flag");
    assert.equal(p.d1Title, D1_TITLE);
    assert.equal(p.request.body.snippet.title, YT_TITLE);
    assert.ok(p.premises.some((l) => l.includes("--title") && l.includes(D1_TITLE)));
    // Descrição e tags continuam derivadas do D1.
    assert.equal(p.metadata.description, plan().metadata.description);
  });

  it("--title igual ao do D1 não muda a origem", () => {
    assert.equal(plan(`  ${D1_TITLE}  `).titleSource, "d1");
  });

  it("--title passa pelo saneamento do título derivado: vazio recusa, longo corta com aviso", () => {
    assert.throws(() => plan("** **"), /--title vazio/);
    const long = plan("x".repeat(130));
    assert.equal(Array.from(long.metadata.title).length, 100);
    assert.ok(long.warnings.some((w) => w.includes("100 caracteres")));
  });

  it("--upload: o título efetivo vai para o registro, com o do D1 ao lado", async () => {
    const { deps, insertBodies } = channelDeps([]);
    const { outcome, logs } = await run(deps, plan(YT_TITLE));
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(insertBodies.length, 1);
    assert.equal(JSON.parse(insertBodies[0]).snippet.title, YT_TITLE);
    const onDisk = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
    assert.equal(onDisk.title, YT_TITLE);
    assert.equal(onDisk.title_source, "flag");
    assert.equal(onDisk.d1_title, D1_TITLE);
  });

  it("--upload sem --title não grava title_source nem d1_title", async () => {
    const { deps } = channelDeps([]);
    const { outcome } = await run(deps, plan());
    assert.equal(outcome.exitCode, 0);
    const onDisk = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
    assert.equal(onDisk.title, D1_TITLE);
    assert.equal("title_source" in onDisk, false);
    assert.equal("d1_title" in onDisk, false);
  });

  it("#11080 com --title: vídeo manual com o título do D1 (fora do dia, sem utm) ainda é reconhecido por título", async () => {
    const manual = {
      id: "manualD1",
      snippet: { title: D1_TITLE, description: "sem utm", tags: [], publishedAt: "2026-10-01T12:00:00Z" },
      status: { uploadStatus: "processed", privacyStatus: "public" },
    };
    const { deps, calls } = channelDeps([manual]);
    const { outcome, logs } = await run(deps, plan(YT_TITLE));
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.skipped, true);
    assert.equal(outcome.record?.matched_by, "title");
    assert.equal(calls.some((c) => c.includes("uploadType=resumable")), false);
  });

  it("matchEditionVideo: altTitles casa como título; sem eles, só o título principal", () => {
    const v = (title: string) => ({
      id: "a",
      snippet: { title, description: "", tags: [], publishedAt: "2026-10-01T12:00:00Z" },
      status: { privacyStatus: "public" },
    });
    const crit = { aammdd: "261030", title: YT_TITLE };
    assert.equal(matchEditionVideo([v(D1_TITLE)], crit), null);
    assert.equal(matchEditionVideo([v(D1_TITLE)], { ...crit, altTitles: [D1_TITLE] })?.matchedBy, "title");
    assert.equal(matchEditionVideo([v(YT_TITLE)], { ...crit, altTitles: [D1_TITLE] })?.matchedBy, "title");
  });
});

describe("gancho em duas linhas (#11740)", () => {
  it("o caso da 261030: 5 palavras em 2 linhas com `|`", () => {
    assert.deepEqual(splitHook("Confiou no chatbot|e morreu"), {
      body: "Confiou no chatbot e morreu",
      mark: "",
      lines: ["Confiou no chatbot", "e morreu"],
    });
  });

  it("aceita `\\n` literal (vindo do shell) e quebra real; espaços aparados", () => {
    const want = ["Confiou no chatbot", "e morreu"];
    assert.deepEqual(splitHook("Confiou no chatbot\\ne morreu").lines, want);
    assert.deepEqual(splitHook("Confiou no chatbot\ne morreu").lines, want);
    assert.deepEqual(splitHook("  Confiou  no chatbot | e morreu ").lines, want);
  });

  it("`?` final só na última linha, separado para o teal", () => {
    const parts = splitHook("Confiou no chatbot|e morreu?");
    assert.equal(parts.mark, "?");
    assert.deepEqual(parts.lines, ["Confiou no chatbot", "e morreu"]);
  });

  it("limites: 5 palavras numa linha só continua recusado (com dica da quebra); 3 linhas, linha vazia e linha com 5 palavras também", () => {
    assert.throws(() => splitHook("Confiou no chatbot e morreu"), /2 a 4.*\|/s);
    assert.throws(() => splitHook("a b|c d|e f"), /2 linhas|máximo é 2/);
    assert.throws(() => splitHook("Confiou no chatbot|"), /linha vazia/);
    assert.throws(() => splitHook("um dois três quatro cinco|seis"), /linha 1/);
  });

  it("linha única segue com o formato antigo (sem `lines`)", () => {
    assert.deepEqual(splitHook("IA ladra?"), { body: "IA ladra", mark: "?" });
  });

  it("fonte dimensionada pela linha mais longa, não pelo gancho inteiro", () => {
    const two = hookFontSize(splitHook("Confiou no chatbot|e morreu"));
    const longest = hookFontSize(splitHook("Confiou no chatbot"));
    assert.equal(two, longest);
  });

  it("SVG: uma <text> por linha, mesmo x, text-anchor end; `?` em teal só na última", () => {
    const svg = buildHookSvg("Confiou no chatbot|e morreu?");
    const texts = [...svg.matchAll(/<text x="(\d+)" y="(\d+)" text-anchor="end"/g)];
    assert.equal(texts.length, 2);
    assert.equal(texts[0][1], texts[1][1]);
    assert.ok(Number(texts[1][2]) > Number(texts[0][2]));
    assert.equal((svg.match(/<tspan/g) ?? []).length, 1);
    assert.ok(svg.includes(`fill="${COLORS.brand}">?</tspan></text></svg>`));
  });

  it("rasterizado, as duas linhas terminam na mesma coluna (alinhadas à direita)", async () => {
    const { data, info } = await sharp(Buffer.from(buildHookSvg("Confiou no chatbot|e morreu"))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const rightmost = (y0: number, y1: number) => {
      let max = -1;
      for (let y = y0; y < y1; y++) for (let x = info.width - 1; x > max; x--) if (data[(y * info.width + x) * 4 + 3] > 64) { max = x; break; }
      return max;
    };
    const mid = Math.floor(info.height / 2);
    const top = rightmost(0, mid);
    const bottom = rightmost(mid, info.height);
    assert.ok(top > 0 && bottom > 0, "as duas linhas têm tinta");
    assert.ok(Math.abs(top - bottom) <= 12, `bordas direitas ${top} e ${bottom}`);
  });

  it("composeYouTubeThumb aceita o gancho em duas linhas e sai 1280x720", async () => {
    const bg = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
    const body = await sharp({ create: { width: 300, height: 500, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer();
    const portrait = await sharp({ create: { width: 600, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: body, left: 150, top: 300 }])
      .png()
      .toBuffer();
    const { jpeg } = await composeYouTubeThumb({ background: bg, portrait, hook: "Confiou no chatbot|e morreu" });
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.width, YOUTUBE_THUMB_W);
    assert.equal(meta.height, YOUTUBE_THUMB_H);
  });
});
