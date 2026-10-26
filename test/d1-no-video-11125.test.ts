/**
 * test/d1-no-video-11125.test.ts (#11125)
 *
 * Edição sem vídeo: o marcador `_internal/no-video.json` desliga a cópia do
 * hero do D1 com o convite (`04-d1-2x1-play.jpg`, #10784) no upload e no
 * render. Cenário real da issue (edição 261026): o editor apagou a cópia, o
 * carimbo e a chave `d1_play` à mão, e o upload seguinte em modo newsletter
 * regerava tudo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { D1_PLAY_HERO_FILE, D1_PLAY_STAMP_FILE } from "../scripts/lib/diaria/d1-video-hero.ts";
import { D1_VIDEO_URL_FILE } from "../scripts/lib/diaria/d1-video-link.ts";
import { clearNoVideo, D1_NO_VIDEO_MARKER_FILE, isNoVideoEdition, markNoVideo } from "../scripts/lib/diaria/d1-no-video.ts";
import { d1VideoHeroFields } from "../scripts/lib/newsletter-parse.ts";
import { uploadPublicImages } from "../scripts/upload-images-public.ts";
import { main as setNoVideoMain } from "../scripts/set-d1-no-video.ts";

function editionDir(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "d1-no-video-11125-"));
  const dir = join(root, "2610", "261026");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return { root, dir };
}

async function writeEdition(dir: string): Promise<void> {
  const buf = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 40, g: 60, b: 90 } } })
    .jpeg()
    .toBuffer();
  writeFileSync(join(dir, "04-d1-2x1.jpg"), buf);
  for (const f of ["01-eia-A.jpg", "01-eia-B.jpg", "04-d2-2x1.jpg", "04-d3-2x1.jpg"]) {
    writeFileSync(join(dir, f), `bytes-${f}`);
  }
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}, {}] }));
}

const stubUpload = { uploadToCloudflare: async (_p: string, key: string) => `https://x/${key}` };

describe("#11125 — marcador de edição sem vídeo", () => {
  it("mark/clear/isNoVideoEdition: presença do arquivo decide; JSON ilegível segue valendo", () => {
    const { root, dir } = editionDir();
    try {
      assert.equal(isNoVideoEdition(dir), false);
      const p = markNoVideo(dir, "editor não gravou", new Date("2026-10-26T12:00:00Z"));
      assert.equal(p, join(dir, D1_NO_VIDEO_MARKER_FILE));
      assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {
        no_video: true,
        marked_at: "2026-10-26T12:00:00.000Z",
        reason: "editor não gravou",
      });
      assert.equal(isNoVideoEdition(dir), true);
      writeFileSync(p, "{lixo");
      assert.equal(isNoVideoEdition(dir), true, "lado seguro: marcador ilegível ainda desliga o convite");
      assert.equal(clearNoVideo(dir), true);
      assert.equal(isNoVideoEdition(dir), false);
      assert.equal(clearNoVideo(dir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("render: com o marcador o D1 sai sem link mesmo com a cópia no disco e URL de vídeo gravada", () => {
    const { root, dir } = editionDir();
    try {
      writeFileSync(join(dir, D1_PLAY_HERO_FILE), "x");
      writeFileSync(join(dir, D1_VIDEO_URL_FILE), "https://youtu.be/abc123def45\n");
      assert.equal(d1VideoHeroFields(dir).heroFile, D1_PLAY_HERO_FILE, "sanidade: sem marcador usa a cópia");
      markNoVideo(dir);
      assert.deepEqual(d1VideoHeroFields(dir), {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upload newsletter: cenário da 261026 — não regera a cópia, apaga a sobra e tira d1_play do cache", async () => {
    const { root, dir } = editionDir();
    try {
      await writeEdition(dir);
      // 1ª rodada sem marcador: gera a cópia e sobe d1_play (estado de antes da remoção à mão).
      const first = await uploadPublicImages({ editionDir: dir, mode: "newsletter", uploaders: stubUpload });
      assert.ok(first.images.d1_play, "sanidade: sem marcador, d1_play sobe");
      assert.ok(existsSync(join(dir, D1_PLAY_HERO_FILE)));
      assert.ok(existsSync(join(dir, D1_PLAY_STAMP_FILE)));

      markNoVideo(dir);
      let ensureCalled = false;
      const uploaded: string[] = [];
      const second = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (p: string, key: string) => {
            uploaded.push(p);
            return `https://x/${key}`;
          },
        },
        skipExisting: false,
        ensureD1PlayImage: async () => {
          ensureCalled = true;
          return { status: "generated", path: join(dir, D1_PLAY_HERO_FILE) };
        },
      });
      assert.equal(ensureCalled, false, "com o marcador a cópia não é (re)gerada");
      assert.equal(second.images.d1_play, undefined, "d1_play sai do retorno");
      const cache = JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8"));
      assert.equal(cache.images.d1_play, undefined, "d1_play sai de 06-public-images.json");
      assert.ok(cache.images.cover, "o hero puro (cover) continua no cache");
      assert.ok(!existsSync(join(dir, D1_PLAY_HERO_FILE)), "cópia que sobrou é apagada");
      assert.ok(!existsSync(join(dir, D1_PLAY_STAMP_FILE)), "carimbo que sobrou é apagado");
      assert.ok(!uploaded.some((p) => p.endsWith(D1_PLAY_HERO_FILE)));
      assert.ok(!second.warnings.some((w) => w.includes("d1_play")), JSON.stringify(second.warnings));

      // Religar: sem o marcador, a próxima rodada volta a gerar e subir.
      clearNoVideo(dir);
      const third = await uploadPublicImages({ editionDir: dir, mode: "newsletter", uploaders: stubUpload });
      assert.ok(third.images.d1_play);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upload social não mexe no d1_play nem no marcador", async () => {
    const { root, dir } = editionDir();
    try {
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { d1_play: { file_id: "k", url: "u", mime_type: "image/jpeg", filename: D1_PLAY_HERO_FILE } } }),
      );
      writeFileSync(join(dir, D1_PLAY_HERO_FILE), "x");
      markNoVideo(dir);
      await uploadPublicImages({ editionDir: dir, mode: "social", destaques: [], uploaders: stubUpload });
      assert.ok(existsSync(join(dir, D1_PLAY_HERO_FILE)), "modo social não apaga a cópia");
      const cache = JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8"));
      assert.ok(cache.images.d1_play, "modo social preserva a chave do outro modo (#1865)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI set-d1-no-video: marca e apaga a sobra; --clear desmarca; uso inválido = 2", () => {
    const { root, dir } = editionDir();
    try {
      writeFileSync(join(dir, D1_PLAY_HERO_FILE), "x");
      writeFileSync(join(dir, D1_PLAY_STAMP_FILE), "{}");
      assert.equal(setNoVideoMain(["261026", "--edition-dir", dir, "--reason", "sem gravação"]), 0);
      assert.ok(isNoVideoEdition(dir));
      assert.ok(!existsSync(join(dir, D1_PLAY_HERO_FILE)));
      assert.ok(!existsSync(join(dir, D1_PLAY_STAMP_FILE)));
      assert.equal(setNoVideoMain(["261026", "--edition-dir", dir, "--clear"]), 0);
      assert.equal(isNoVideoEdition(dir), false);
      assert.equal(setNoVideoMain(["2610"]), 2);
      assert.equal(setNoVideoMain(["261026", "--edition-dir", join(root, "nao-existe")]), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
