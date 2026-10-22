/**
 * #10784 — imagem do D1 na newsletter vira link pro vídeo do dia no YouTube
 * (UTM `video-d1-{AAMMDD}`), legenda do D1 = só o convite, cópia do hero com
 * ícone de play só pra newsletter, fallback pro canal quando o vídeo ainda
 * não tem URL (nunca link quebrado, nunca imagem sem link).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  D1_CHANNEL_CAPTION,
  D1_PLAY_HERO_FILE,
  D1_VIDEO_CAPTION,
  buildD1VideoLink,
  buildPlayIconSvg,
  editionFromDir,
} from "../scripts/lib/diaria/d1-video-hero.ts";
import { ensureD1PlayImage } from "../scripts/lib/diaria/d1-play-image.ts";
import { d1VideoHeroFields, type RenderDestaque } from "../scripts/lib/newsletter-parse.ts";
import { renderDestaque } from "../scripts/lib/newsletter-render-html.ts";
import { md5OfFile } from "../scripts/lib/shared/file-md5.ts";
import { uploadPublicImages } from "../scripts/upload-images-public.ts";

function destaque(n: 1 | 2 | 3, extra: Partial<RenderDestaque> = {}): RenderDestaque {
  return {
    n,
    category: "LANÇAMENTO",
    title: `Título D${n}`,
    body: "Corpo do destaque.",
    why: "Porque importa.",
    url: `https://exemplo.com/d${n}`,
    emoji: "🚀",
    imageGenerator: "codex",
    ...extra,
  };
}

function editionDir(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "d1-video-10784-"));
  const dir = join(root, "2610", "261022");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return { root, dir };
}

async function writeHero(dir: string, rgb = { r: 40, g: 60, b: 90 }): Promise<void> {
  const buf = await sharp({ create: { width: 400, height: 200, channels: 3, background: rgb } }).jpeg().toBuffer();
  writeFileSync(join(dir, "04-d1-2x1.jpg"), buf);
}

describe("#10784 — link da imagem do D1", () => {
  it("vídeo do dia: URL do vídeo + UTM video-d1-{AAMMDD} + convite", () => {
    const l = buildD1VideoLink("https://youtu.be/abcdefghijk", "261022");
    assert.equal(l.kind, "video");
    assert.equal(l.caption, D1_VIDEO_CAPTION);
    const u = new URL(l.href);
    assert.equal(u.origin + u.pathname, "https://youtu.be/abcdefghijk");
    assert.equal(u.searchParams.get("utm_source"), "newsletter");
    assert.equal(u.searchParams.get("utm_medium"), "email");
    assert.equal(u.searchParams.get("utm_campaign"), "video-d1-261022");
  });

  it("sem URL do vídeo: aponta pro canal @diariabr, com a mesma UTM", () => {
    const l = buildD1VideoLink(null, "261022");
    assert.equal(l.kind, "channel");
    assert.equal(l.caption, D1_CHANNEL_CAPTION);
    const u = new URL(l.href);
    assert.equal(u.origin + u.pathname, "https://www.youtube.com/@diariabr");
    assert.equal(u.searchParams.get("utm_campaign"), "video-d1-261022");
  });

  it("edição fora do formato AAMMDD lança (UTM errada em silêncio não)", () => {
    assert.throws(() => buildD1VideoLink(null, "2610"), /AAMMDD/);
  });

  it("editionFromDir lê o layout aninhado e tolera barra final", () => {
    assert.equal(editionFromDir("data/editions/2610/261022"), "261022");
    assert.equal(editionFromDir("data/editions/2610/261022/"), "261022");
    assert.equal(editionFromDir("/tmp/fixture"), null);
  });
});

describe("#10784 — fonte da URL e arquivo do hero (d1VideoHeroFields)", () => {
  it("sem _internal/05-video-url.txt → canal; sem cópia com play → hero default", () => {
    const { root, dir } = editionDir();
    try {
      const f = d1VideoHeroFields(dir);
      assert.equal(f.videoLink?.kind, "channel");
      assert.equal(f.heroFile, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("com a URL gravada por link-video-d1.ts --save → vídeo; cópia com play existente → usada", () => {
    const { root, dir } = editionDir();
    try {
      writeFileSync(join(dir, "_internal", "05-video-url.txt"), "https://www.youtube.com/watch?v=abcdefghijk\n");
      writeFileSync(join(dir, D1_PLAY_HERO_FILE), "x");
      const f = d1VideoHeroFields(dir);
      assert.equal(f.videoLink?.kind, "video");
      assert.ok(f.videoLink!.href.startsWith("https://youtu.be/abcdefghijk?"), f.videoLink!.href);
      assert.equal(f.heroFile, D1_PLAY_HERO_FILE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("arquivo de URL inválido → canal (nunca link quebrado)", () => {
    const { root, dir } = editionDir();
    try {
      writeFileSync(join(dir, "_internal", "05-video-url.txt"), "https://exemplo.com/nao-e-video\n");
      assert.equal(d1VideoHeroFields(dir).videoLink?.kind, "channel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#10784 — render do hero", () => {
  const link = buildD1VideoLink("https://youtu.be/abcdefghijk", "261022");

  it("D1: imagem com play embrulhada no link do vídeo, legenda = só o convite", () => {
    const html = renderDestaque(destaque(1, { videoLink: link, heroFile: D1_PLAY_HERO_FILE }));
    const hrefEsc = link.href.replace(/&/g, "&amp;");
    assert.ok(
      html.includes(`<a class="hero-video" href="${hrefEsc}"`),
      "o <a> do vídeo precisa envolver a imagem do D1",
    );
    assert.match(html, /<a class="hero-video"[^>]*><img class="hero" src="\{\{IMG:04-d1-2x1-play\.jpg\}\}"/);
    assert.ok(html.includes(D1_VIDEO_CAPTION));
    assert.ok(!/Criada com/.test(html), "crédito da ferramenta sai da legenda do D1 (fica no rodapé, #10783)");
    assert.ok(!/[←→]/.test(html), "sem seta no que chega ao leitor (#9721)");
  });

  it("D1 sem cópia com play: hero default, ainda com link", () => {
    const html = renderDestaque(destaque(1, { videoLink: link }));
    assert.match(html, /<a class="hero-video"[^>]*><img class="hero" src="\{\{IMG:04-d1-2x1\.jpg\}\}"/);
  });

  it("D2/D3 nunca viram link, mesmo com videoLink setado à mão", () => {
    for (const n of [2, 3] as const) {
      const html = renderDestaque(destaque(n, { videoLink: link, heroFile: D1_PLAY_HERO_FILE }));
      assert.ok(!html.includes("hero-video"), `D${n} não leva link`);
      assert.ok(html.includes(`{{IMG:04-d${n}-2x1.jpg}}`));
      assert.ok(/Criada com/.test(html), `D${n} mantém o crédito na legenda`);
    }
  });

  it("acréscimo de bytes no HTML é pequeno (teto de 102KB do Gmail)", () => {
    const sem = renderDestaque(destaque(1));
    const com = renderDestaque(destaque(1, { videoLink: link, heroFile: D1_PLAY_HERO_FILE }));
    assert.ok(com.length - sem.length < 800, `acréscimo de ${com.length - sem.length} bytes`);
  });
});

describe("#10784 — cópia do hero com play", () => {
  it("gera a cópia sem tocar no hero; play branco no centro; regera só quando o hero muda", async () => {
    const { root, dir } = editionDir();
    try {
      await writeHero(dir);
      const heroPath = join(dir, "04-d1-2x1.jpg");
      const heroMd5 = md5OfFile(heroPath);

      const r1 = await ensureD1PlayImage(dir);
      assert.equal(r1.status, "generated");
      assert.equal(md5OfFile(heroPath), heroMd5, "o hero original (usado nas redes) não pode mudar");
      const playPath = join(dir, D1_PLAY_HERO_FILE);
      const meta = await sharp(playPath).metadata();
      assert.equal(meta.width, 400);
      assert.equal(meta.height, 200);
      // Ponto dentro do círculo e fora do triângulo (à esquerda dele): branco.
      const { data, info } = await sharp(playPath).raw().toBuffer({ resolveWithObject: true });
      const px = (x: number, y: number) => data[(y * info.width + x) * info.channels];
      assert.ok(px(200 - 30, 100) > 200, `pixel no círculo deveria ser claro, veio ${px(170, 100)}`);
      assert.ok(px(10, 10) < 100, "canto segue com a arte original");

      const r2 = await ensureD1PlayImage(dir);
      assert.equal(r2.status, "fresh");

      await writeHero(dir, { r: 200, g: 30, b: 30 }); // editor troca a arte no Stage 4
      const r3 = await ensureD1PlayImage(dir);
      assert.equal(r3.status, "generated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem hero: remove cópia órfã; hero ilegível: falha e remove a cópia defasada", async () => {
    const { root, dir } = editionDir();
    try {
      writeFileSync(join(dir, D1_PLAY_HERO_FILE), "velha");
      const r1 = await ensureD1PlayImage(dir);
      assert.equal(r1.status, "no_hero");
      assert.ok(!existsSync(join(dir, D1_PLAY_HERO_FILE)));

      writeFileSync(join(dir, "04-d1-2x1.jpg"), "nao-e-jpeg");
      writeFileSync(join(dir, D1_PLAY_HERO_FILE), "velha");
      const r2 = await ensureD1PlayImage(dir);
      assert.equal(r2.status, "failed");
      assert.ok(!existsSync(join(dir, D1_PLAY_HERO_FILE)), "cópia defasada não pode ir pro e-mail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildPlayIconSvg: círculo de 18% da largura, centralizado", () => {
    const svg = buildPlayIconSvg(1600, 800);
    assert.ok(svg.includes(`cx="800.0" cy="400.0" r="144.0"`), svg);
    assert.ok(svg.includes(`fill="#171411"`));
  });

  it("upload modo newsletter gera a cópia e sobe d1_play; falha vira warning", async () => {
    const { root, dir } = editionDir();
    try {
      await writeHero(dir);
      for (const f of ["01-eia-A.jpg", "01-eia-B.jpg", "04-d2-2x1.jpg", "04-d3-2x1.jpg"]) {
        writeFileSync(join(dir, f), `bytes-${f}`);
      }
      writeFileSync(
        join(dir, "_internal", "01-approved-capped.json"),
        JSON.stringify({ highlights: [{}, {}, {}] }),
      );
      const uploaded: string[] = [];
      const result = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (imagePath: string, key: string) => {
            uploaded.push(imagePath);
            return `https://x/${key}`;
          },
        },
      });
      assert.ok(result.images.d1_play?.url, "d1_play precisa estar no cache pro substitute-image-urls");
      assert.ok(uploaded.some((p) => p.endsWith(D1_PLAY_HERO_FILE)));
      assert.ok(readFileSync(join(dir, D1_PLAY_HERO_FILE)).length > 0);

      const failed = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: { uploadToCloudflare: async (_p: string, key: string) => `https://x/${key}` },
        ensureD1PlayImage: async () => ({ status: "failed", path: null, reason: "boom" }),
      });
      assert.ok(failed.warnings.some((w) => w.includes("#10784") && w.includes("boom")), JSON.stringify(failed.warnings));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
