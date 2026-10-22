/**
 * #10784 — imagem do D1 na newsletter vira link pro vídeo do dia no YouTube
 * (UTM `video-d1-{AAMMDD}`), convite escrito na imagem (sem ícone de play), legenda
 * do D1 = crédito padrão, cópia do hero só pra newsletter, fallback pro canal
 * quando o vídeo ainda não tem URL (nunca link quebrado). Sem a cópia, sem link.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  D1_INVITE_LINES,
  D1_INVITE_TEXT,
  D1_INVITE_VERSION,
  D1_PLAY_HERO_FILE,
  D1_PLAY_STAMP_FILE,
  buildD1VideoLink,
  buildInviteSvg,
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
    const u = new URL(l.href);
    assert.equal(u.origin + u.pathname, "https://youtu.be/abcdefghijk");
    assert.equal(u.searchParams.get("utm_source"), "newsletter");
    assert.equal(u.searchParams.get("utm_medium"), "email");
    assert.equal(u.searchParams.get("utm_campaign"), "video-d1-261022");
  });

  it("sem URL do vídeo: aponta pro canal @diariabr, com a mesma UTM", () => {
    const l = buildD1VideoLink(null, "261022");
    assert.equal(l.kind, "channel");
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
  it("sem _internal/05-video-url.txt → canal (com a cópia); sem a cópia → sem link", () => {
    const { root, dir } = editionDir();
    try {
      assert.deepEqual(d1VideoHeroFields(dir), {}, "sem a cópia com o convite não há link");
      writeFileSync(join(dir, D1_PLAY_HERO_FILE), "x");
      const f = d1VideoHeroFields(dir);
      assert.equal(f.videoLink?.kind, "channel");
      assert.equal(f.heroFile, D1_PLAY_HERO_FILE);
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
      writeFileSync(join(dir, D1_PLAY_HERO_FILE), "x");
      assert.equal(d1VideoHeroFields(dir).videoLink?.kind, "channel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#10784 — render do hero", () => {
  const link = buildD1VideoLink("https://youtu.be/abcdefghijk", "261022");

  it("D1: imagem com o convite embrulhada no link do vídeo, legenda = crédito padrão (sem link)", () => {
    const html = renderDestaque(destaque(1, { videoLink: link, heroFile: D1_PLAY_HERO_FILE }));
    const hrefEsc = link.href.replace(/&/g, "&amp;");
    assert.ok(
      html.includes(`<a class="hero-video" href="${hrefEsc}"`),
      "o <a> do vídeo precisa envolver a imagem do D1",
    );
    assert.match(html, /<a class="hero-video"[^>]*><img class="hero" src="\{\{IMG:04-d1-2x1-play\.jpg\}\}"/);
    assert.ok(/Criada com/.test(html), "legenda do D1 volta a ser o crédito padrão, como no D2/D3");
    assert.ok(!/Clique na imagem/.test(html), "o convite está escrito na imagem, não na legenda");
    assert.equal(html.split(hrefEsc).length - 1, 1, "o href aparece só na imagem: a legenda de crédito não é link");
    assert.ok(html.includes(`alt="Título D1. ${D1_INVITE_TEXT}."`), "alt da imagem do D1 carrega o convite (leitor de tela, imagens bloqueadas)");
    assert.ok(!/[←→]/.test(html), "sem seta no que chega ao leitor (#9721)");
  });

  it("D1 sem a cópia com o convite: hero default e SEM link (nada de link escondido)", () => {
    const { root, dir } = editionDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "05-video-url.txt"), "https://youtu.be/abcdefghijk\n");
      assert.deepEqual(d1VideoHeroFields(dir), {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
  it("gera a cópia sem tocar no hero; sem play no centro, faixa do convite embaixo; regera só quando o hero muda", async () => {
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
      // Sem ícone de play: o centro segue com a arte original (R=40).
      const { data, info } = await sharp(playPath).raw().toBuffer({ resolveWithObject: true });
      const px = (x: number, y: number) => data[(y * info.width + x) * info.channels];
      assert.ok(px(200 - 30, 100) < 60, `centro não pode ter play, veio ${px(170, 100)}`);
      // Faixa de tinta (#171411 a 82%) na parte de baixo: R cai de 40 para ~26.
      assert.ok(px(60, 164) < 33, `faixa do convite deveria escurecer a base, veio ${px(60, 164)}`);
      assert.ok(px(10, 10) < 100, "canto segue com a arte original");

      const r2 = await ensureD1PlayImage(dir);
      assert.equal(r2.status, "fresh");

      // Cópia antiga (carimbo sem `overlay`, do ícone de play) regera mesmo com o hero igual.
      const stampPath = join(dir, D1_PLAY_STAMP_FILE);
      const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
      assert.equal(stamp.overlay, D1_INVITE_VERSION);
      delete stamp.overlay;
      writeFileSync(stampPath, JSON.stringify(stamp));
      assert.equal((await ensureD1PlayImage(dir)).status, "generated", "mudou só o desenho: regera");

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

  it("o texto cabe na faixa mesmo com fonte inexistente (fallback do rasterizador)", async () => {
    const W = 1600, H = 800;
    const flat = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 40, g: 60, b: 90 } } }).png().toBuffer();
    const svg = buildInviteSvg(W, H).replace(/font-family="[^"]*"/g, `font-family="NoSuchFontXYZ"`);
    const out = await sharp(flat).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => out.data[(y * out.info.width + x) * out.info.channels];
    const pillW = W * 0.74;
    const left = (W - pillW) / 2, right = left + pillW;
    let minX = W, maxX = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px(x, y) > 200) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    assert.ok(maxX > 0, "o texto deveria ter sido desenhado (branco)");
    assert.ok(minX >= left + 20 && maxX <= right - 20, `texto ${minX}-${maxX} fora da faixa ${left}-${right}`);
  });

  it("buildInviteSvg: faixa de 74% da largura na base, 2 linhas do convite, sem círculo de play", () => {
    const svg = buildInviteSvg(1600, 800);
    assert.ok(svg.includes(`width="1184.0"`), svg);
    for (const l of D1_INVITE_LINES) assert.ok(svg.includes(l), l);
    assert.ok(svg.includes(`fill="#171411"`));
    assert.ok(!svg.includes("<circle") && !svg.includes("<polygon"), "sem ícone de play");
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
