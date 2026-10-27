/**
 * test/youtube-thumb-top-hook-frames-11220-11228.test.ts
 *
 * #11220: gancho no canto SUPERIOR direito, gradiente escuro no topo.
 * #11228: gancho de 4 palavras que encolhe para não invadir a cabeça do
 * retrato; realce de contraste do retrato preservando o alfa do rembg; frames
 * do bruto do Drive (instantes, argumentos do ffmpeg sem vazar o token, folha
 * de opções numerada); outpaint com imagem de referência no codex-image.js.
 * Sem rede, sem ffmpeg, sem Codex.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  YOUTUBE_THUMB_H,
  YOUTUBE_THUMB_W,
  composeYouTubeThumb,
  enhancePortrait,
  hookWidthBeside,
  portraitRightEdgeInRows,
} from "../scripts/lib/diaria/youtube-thumb.ts";
import {
  buildFrameSheet,
  driveMediaUrl,
  frameTimes,
  planDriveFrameArgs,
  redactFfmpegArgs,
  thumbFrameFileName,
} from "../scripts/lib/diaria/youtube-thumb-frames.ts";
// @ts-expect-error — módulo JS sem tipos
import { buildCodexArgs, buildCodexPrompt, parseCliArgs, DEFAULTS } from "../scripts/codex-image.js";

async function rgba(w: number, h: number, rgb: [number, number, number], alpha: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha } } })
    .png()
    .toBuffer();
}

/** Pixels "acesos" (cor papel do gancho) sobre fundo preto: caixa delimitadora. */
async function brightBox(jpeg: Buffer, minSum = 300) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] + data[i + 1] + data[i + 2] > minSum) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

describe("#11220 gancho no topo à direita", () => {
  it("gancho de 4 palavras (#11228) fica no topo, à direita, com margem de 40px", async () => {
    const { jpeg, warnings } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 0], 1),
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "Google Photos te vigia?",
    });
    assert.deepEqual(warnings, []);
    const box = await brightBox(jpeg);
    assert.ok(box.maxX <= YOUTUBE_THUMB_W - 40 + 2, `x final ${box.maxX}`);
    assert.ok(box.minY >= 38 && box.minY < 120, `topo do texto em y=${box.minY}`);
    assert.ok(box.maxY < YOUTUBE_THUMB_H / 2, `texto desce até y=${box.maxY}`);
  });

  it("gradiente escurece o topo e deixa a base intacta", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [240, 240, 240], 1),
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "IA ladra?",
    });
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const lum = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return data[i] + data[i + 1] + data[i + 2];
    };
    assert.ok(lum(300, 5) < lum(300, 700) - 200, `topo ${lum(300, 5)} vs base ${lum(300, 700)}`);
    assert.ok(lum(300, 700) > 690, "base sem gradiente");
  });
});

describe("#11228 gancho não invade a cabeça do retrato", () => {
  it("portraitRightEdgeInRows mede só as linhas pedidas, na coordenada da capa", () => {
    // Retrato 4x4 colado com topo em y=10: só o pixel (x=2, linha 1) é opaco.
    const w = 4;
    const data = new Uint8Array(w * 4 * 4);
    data[(1 * w + 2) * 4 + 3] = 255;
    const img = { data, width: w, height: 4, channels: 4 };
    assert.equal(portraitRightEdgeInRows(img, 10, 0, 10), -1, "linhas acima do retrato");
    assert.equal(portraitRightEdgeInRows(img, 10, 0, 11), 2);
    assert.equal(portraitRightEdgeInRows(img, 10, 12, 30), -1, "abaixo do pixel opaco");
  });

  it("hookWidthBeside: sem retrato nas linhas, largura cheia (800); com cabeça em x=599, cabe até ela menos a folga", () => {
    assert.equal(hookWidthBeside(-1), 800);
    assert.equal(hookWidthBeside(599), 1280 - 40 - (600 + 24));
    assert.equal(hookWidthBeside(10), 800);
  });

  it("retrato alto e largo: o gancho encolhe e começa depois da cabeça", async () => {
    // Retrato opaco largo, com o canto superior esquerdo transparente (como um
    // recorte real do rembg, que o `trim` usa como cor de fundo): depois do
    // resize ocupa o terço esquerdo até perto do topo.
    // Sem o encolhimento, o gancho (até 800px) começaria em x=440, dentro do retrato (até x≈640).
    const portrait = await sharp({ create: { width: 1040, height: 1040, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await rgba(1000, 1000, [10, 10, 200], 1), left: 20, top: 20 }])
      .png()
      .toBuffer();
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 0], 1),
      portrait,
      hook: "Google Photos te vigia?",
    });
    // Onde o retrato (azul) termina na altura do gancho, medido na imagem:
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    let portraitRight = -1;
    for (let x = 0; x < info.width; x++) {
      const i = (100 * info.width + x) * info.channels;
      if (data[i + 2] > 150 && data[i] < 80) portraitRight = x;
    }
    assert.ok(portraitRight > 600, `retrato chega ao topo até x=${portraitRight}`);
    const box = await brightBox(jpeg, 500);
    assert.ok(box.minX > portraitRight + 10, `gancho começa em x=${box.minX}, cabeça vai até x=${portraitRight}`);
  });
});

describe("#11228 realce do retrato", () => {
  it("aumenta o contraste e preserva a transparência do recorte", async () => {
    const base = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: await rgba(20, 40, [60, 60, 60], 1), left: 0, top: 0 },
        { input: await rgba(10, 40, [200, 200, 200], 1), left: 20, top: 0 },
      ])
      .png()
      .toBuffer();
    const out = await enhancePortrait(base);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
    const dark = px(5, 20);
    const light = px(25, 20);
    const transparent = px(35, 20);
    assert.equal(transparent[3], 0, "fundo recortado continua transparente");
    assert.equal(dark[3], 255);
    assert.equal(light[3], 255);
    assert.ok(dark[0] < 60, `escuro ficou mais escuro: ${dark[0]}`);
    assert.ok(light[0] > 200, `claro ficou mais claro: ${light[0]}`);
  });

  it("recusa retrato sem transparência", async () => {
    const opaque = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    await assert.rejects(enhancePortrait(opaque), /rembg/);
  });

  it("composeYouTubeThumb aceita enhancePortrait sem perder o recorte", async () => {
    const portrait = await sharp({ create: { width: 200, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await rgba(100, 200, [128, 128, 128], 1), left: 50, top: 100 }])
      .png()
      .toBuffer();
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 255], 1),
      portrait,
      hook: "IA ladra?",
      enhancePortrait: true,
    });
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    // Canto inferior direito do terço do retrato, fora da pessoa: segue azul (o fundo do recorte não virou opaco).
    const i = (700 * info.width + 600) * info.channels;
    assert.ok(data[i + 2] > 200 && data[i] < 40, `esperava fundo azul, veio ${[data[i], data[i + 1], data[i + 2]]}`);
  });
});

describe("#11228 frames do bruto no Drive", () => {
  it("frameTimes: N instantes no miolo do vídeo, ou os explícitos validados", () => {
    assert.deepEqual(frameTimes(100, { count: 5 }), [18, 34, 50, 66, 82]);
    assert.deepEqual(frameTimes(null, { explicit: "12, 30.5,48" }), [12, 30.5, 48]);
    assert.throws(() => frameTimes(40, { explicit: "12,45" }), /além do fim/);
    assert.throws(() => frameTimes(40, { explicit: "abc" }), /--times inválido/);
    assert.throws(() => frameTimes(null, {}), /duração do vídeo desconhecida/);
    assert.throws(() => frameTimes(60, { count: 0 }), /--count/);
  });

  it("planDriveFrameArgs: lê da Drive API com o token no header, seek antes do -i, um frame", () => {
    const args = planDriveFrameArgs({ fileId: "abc123", accessToken: "SEGREDO", atSeconds: 18, out: "/o/frame-1.png" });
    const h = args.indexOf("-headers");
    assert.equal(args[h + 1], "Authorization: Bearer SEGREDO\r\n");
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss antes de -i");
    assert.equal(args[args.indexOf("-i") + 1], driveMediaUrl("abc123"));
    assert.match(driveMediaUrl("abc123"), /\/files\/abc123\?alt=media&supportsAllDrives=true$/);
    assert.equal(args.at(-1), "/o/frame-1.png");
    assert.throws(() => planDriveFrameArgs({ fileId: "x", accessToken: "", atSeconds: 1, out: "o" }), /token/);
    assert.throws(() => planDriveFrameArgs({ fileId: "x", accessToken: "t", atSeconds: -1, out: "o" }), /instante/);
  });

  it("redactFfmpegArgs nunca deixa o token no log", () => {
    const args = planDriveFrameArgs({ fileId: "abc", accessToken: "SEGREDO", atSeconds: 1, out: "o.png" });
    assert.ok(!redactFfmpegArgs(args).join(" ").includes("SEGREDO"));
    assert.ok(args.join(" ").includes("SEGREDO"), "o original não é mutado");
  });

  it("buildFrameSheet: grade de 3 colunas com N miniaturas numeradas", async () => {
    const frame = await sharp({ create: { width: 3840, height: 2160, channels: 3, background: { r: 90, g: 90, b: 90 } } }).png().toBuffer();
    const sheet = await buildFrameSheet([frame, frame, frame, frame, frame]);
    const meta = await sharp(sheet).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 3 * 640 + 4 * 12);
    assert.equal(meta.height, 2 * 360 + 3 * 12);
    await assert.rejects(buildFrameSheet([]), /nenhum frame/);
    assert.equal(thumbFrameFileName(3), "frame-3.png");
  });
});

describe("#11228 codex-image.js com imagem de referência (outpaint)", () => {
  it("anexa cada referência com -i, caminho absoluto, antes do prompt via stdin", () => {
    const args: string[] = buildCodexArgs(DEFAULTS, ["data/x/04-d1-2x1.jpg"]);
    const i = args.indexOf("-i");
    assert.ok(i > 0);
    assert.match(args[i + 1], /^\/.*data\/x\/04-d1-2x1\.jpg$/);
    assert.equal(args.at(-1), "-");
    assert.ok(!buildCodexArgs(DEFAULTS).includes("-i"), "sem referência, sem -i");
  });

  it("#11296: `--` entre a última imagem e o `-` do stdin (o -i variádico não engole o `-`)", () => {
    const args: string[] = buildCodexArgs(DEFAULTS, ["/a.jpg", "/b.jpg"]);
    assert.deepEqual(args.slice(-2), ["--", "-"]);
    assert.equal(args.lastIndexOf("-i"), args.length - 4, "a última imagem vem logo antes do `--`");
    // Sem referência não há opção variádica antes do `-`: argv inalterado.
    const plain: string[] = buildCodexArgs(DEFAULTS);
    assert.ok(!plain.includes("--"));
    assert.equal(plain.at(-1), "-");
  });

  it("prompt pede outpaint mantendo a pintura da referência só quando há referência", () => {
    const sd = { positive: "x", final_width: 1536, final_height: 864 };
    assert.doesNotMatch(buildCodexPrompt(sd), /reference/);
    assert.match(buildCodexPrompt({ ...sd, reference_images: ["/a.jpg"] }), /attached image is the reference[\s\S]*outpaint/);
  });

  it("CLI: --ref repetível sai dos posicionais; --ref sem caminho lança", () => {
    assert.deepEqual(parseCliArgs(["p.json", "out.jpg", "--ref", "a.jpg", "--ref", "b.jpg"]), {
      positional: ["p.json", "out.jpg"],
      refs: ["a.jpg", "b.jpg"],
    });
    assert.throws(() => parseCliArgs(["p.json", "out.jpg", "--ref"]), /--ref/);
  });
});
