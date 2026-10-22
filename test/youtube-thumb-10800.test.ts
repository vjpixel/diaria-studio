/**
 * test/youtube-thumb-10800.test.ts (#10800)
 *
 * Composição determinística da capa do YouTube no padrão diar.ia.br:
 * gancho (2–3 palavras, `?` em teal), retrato recortado obrigatório, fundo
 * sem desfoque, 1280x720 ≤ 2 MB, e o frame da capa do Short. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { COLORS } from "../scripts/lib/shared/design-tokens.ts";
import {
  SHORT_COVER_LETTERING_WINDOW_S,
  YOUTUBE_THUMB_H,
  YOUTUBE_THUMB_MAX_BYTES,
  YOUTUBE_THUMB_W,
  buildGradientSvg,
  buildHookSvg,
  composeYouTubeThumb,
  hookFontSize,
  isSixteenByNine,
  planShortCoverFrame,
  splitHook,
} from "../scripts/lib/diaria/youtube-thumb.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function solid(w: number, h: number, rgb: [number, number, number], alpha = false): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } : { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

/** Retrato fake: retângulo opaco no meio de um canvas transparente. */
async function cutoutPortrait(): Promise<Buffer> {
  const body = await solid(300, 500, [200, 50, 50]);
  return sharp({ create: { width: 600, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body, left: 150, top: 300 }])
    .png()
    .toBuffer();
}

describe("gancho (#10800)", () => {
  it("separa o ? final pra ir em teal", () => {
    assert.deepEqual(splitHook("IA antiveneno?"), { body: "IA antiveneno", mark: "?" });
    assert.deepEqual(splitHook("  IA   ladra? "), { body: "IA ladra", mark: "?" });
    assert.deepEqual(splitHook("IA sem freio"), { body: "IA sem freio", mark: "" });
  });

  it("recusa gancho fora de 2 ou 3 palavras", () => {
    assert.throws(() => splitHook(""), /vazio/);
    assert.throws(() => splitHook("IA?"), /2 ou 3/);
    assert.throws(() => splitHook("a IA virou ladra?"), /2 ou 3/);
  });

  it("tamanho cabe na caixa e respeita teto/piso", () => {
    assert.equal(hookFontSize(splitHook("IA ladra?")), 130);
    const long = hookFontSize(splitHook("Superinteligência descontrolada aqui?"));
    assert.equal(long, 64);
    const mid = hookFontSize(splitHook("IA antiveneno?"));
    assert.ok(mid < 130 && mid > 64, String(mid));
  });

  it("SVG do gancho: Georgia bold cor papel, ? em teal, escapado; posição vem da caixa real, não de text-anchor", () => {
    const svg = buildHookSvg("IA <ladra>?");
    assert.match(svg, /font-family="Georgia/);
    assert.match(svg, /font-weight="700"/);
    assert.doesNotMatch(svg, /text-anchor="end"/);
    assert.ok(svg.includes(`fill="${COLORS.onInk}"`));
    assert.ok(svg.includes(`<tspan fill="${COLORS.brand}">?</tspan>`));
    assert.ok(svg.includes("IA &lt;ladra&gt;"));
    assert.ok(!buildHookSvg("IA sem freio").includes("<tspan"));
  });

  it("gradiente é escuro e só na parte de baixo", () => {
    const svg = buildGradientSvg();
    assert.match(svg, /stop-color="#000"/);
    assert.match(svg, /<rect x="0" y="396"/);
  });
});

describe("composeYouTubeThumb (#10800)", () => {
  it("gera JPEG 1280x720 ≤ 2 MB com fundo 16:9, sem aviso", async () => {
    const { jpeg, warnings } = await composeYouTubeThumb({
      background: await solid(1920, 1080, [200, 120, 40]),
      portrait: await cutoutPortrait(),
      hook: "IA antiveneno?",
    });
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, YOUTUBE_THUMB_W);
    assert.equal(meta.height, YOUTUBE_THUMB_H);
    assert.ok(jpeg.length <= YOUTUBE_THUMB_MAX_BYTES);
    assert.deepEqual(warnings, []);
  });

  it("retrato fica à esquerda colado na base; o lado direito alto segue o fundo (sem desfoque nem retrato)", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await solid(1280, 720, [0, 0, 255]),
      portrait: await cutoutPortrait(),
      hook: "IA ladra?",
    });
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // Retrato (vermelho) aparado e encostado na base esquerda.
    const [r, g, b] = px(40, 600);
    assert.ok(r > 120 && b < 100, `esperava retrato em (40,600), veio ${[r, g, b]}`);
    // Canto superior direito: fundo azul intacto.
    const [r2, , b2] = px(1200, 40);
    assert.ok(b2 > 200 && r2 < 40, `esperava fundo em (1200,40), veio ${px(1200, 40)}`);
  });

  it("gancho fica no canto inferior direito e nunca invade o terço esquerdo, mesmo longo", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await solid(1280, 720, [0, 0, 0]),
      portrait: await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.02 } } }).png().toBuffer(),
      hook: "Superinteligência descontrolada amanhã?",
    });
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    let minX = Infinity;
    let maxX = -1;
    let minY = Infinity;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] + data[i + 1] + data[i + 2] > 300) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
        }
      }
    }
    assert.ok(minX >= YOUTUBE_THUMB_W - 40 - 800 - 2, `texto começa em x=${minX}`);
    assert.ok(maxX <= YOUTUBE_THUMB_W - 40 + 2, `texto termina em x=${maxX}`);
    assert.ok(minY > YOUTUBE_THUMB_H / 2, `texto sobe até y=${minY}`);
  });

  it("fundo 2:1 (a 04-d1-2x1.jpg crua) passa com aviso de recorte", async () => {
    const { warnings } = await composeYouTubeThumb({
      background: await solid(1600, 800, [10, 80, 30]),
      portrait: await cutoutPortrait(),
      hook: "IA ladra?",
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /não é 16:9/);
  });

  it("retrato sem transparência é recusado (recorte com rembg obrigatório)", async () => {
    await assert.rejects(
      composeYouTubeThumb({
        background: await solid(1280, 720, [0, 0, 0]),
        portrait: await solid(400, 600, [128, 128, 128]),
        hook: "IA ladra?",
      }),
      /rembg/,
    );
  });

  it("gancho inválido falha antes de processar imagem", async () => {
    await assert.rejects(
      composeYouTubeThumb({ background: Buffer.from("x"), portrait: Buffer.from("y"), hook: "IA" }),
      /2 ou 3/,
    );
  });

  it("isSixteenByNine tolera 2%", () => {
    assert.ok(isSixteenByNine(1280, 720));
    assert.ok(isSixteenByNine(1536, 864));
    assert.ok(!isSixteenByNine(1600, 800));
  });
});

describe("capa do Short (#10800)", () => {
  it("frame dentro da janela do lettering: argumentos do ffmpeg, sem aviso", () => {
    const p = planShortCoverFrame("/v/short.mp4", 1.8, "/o/capa.jpg");
    assert.deepEqual(p.warnings, []);
    const i = p.args.indexOf("-ss");
    assert.equal(p.args[i + 1], "1.8");
    assert.ok(i < p.args.indexOf("-i"), "-ss antes de -i (seek rápido)");
    assert.ok(p.args.includes("/v/short.mp4"));
    assert.equal(p.args.at(-1), "/o/capa.jpg");
    assert.ok(p.args.includes("-frames:v"));
  });

  it("frame depois da janela vira aviso; tempo inválido lança", () => {
    const p = planShortCoverFrame("/v/s.mp4", SHORT_COVER_LETTERING_WINDOW_S + 1, "/o/c.jpg");
    assert.match(p.warnings[0], /fora da janela/);
    assert.throws(() => planShortCoverFrame("/v/s.mp4", Number.NaN, "/o/c.jpg"), /--at/);
    assert.throws(() => planShortCoverFrame("/v/s.mp4", -1, "/o/c.jpg"), /--at/);
  });
});

describe("CLI gen-youtube-thumb.ts (#10800)", () => {
  const src = readFileSync(resolve(ROOT, "scripts/gen-youtube-thumb.ts"), "utf8");

  it("tem guard de import, guard de fonte e não chama rede", () => {
    assert.match(src, /isMainModule\(import\.meta\.url\)/);
    assert.match(src, /assertBrandSerifAvailable\("gen-youtube-thumb"\)/);
    assert.doesNotMatch(src, /\bfetch\(/);
  });

  it("grava no arquivo que publish-youtube.ts já envia", () => {
    assert.match(src, /YOUTUBE_THUMB_FILE/);
  });

  it("a skill /diaria-youtube documenta o script", () => {
    const skill = readFileSync(resolve(ROOT, ".claude/skills/diaria-youtube/SKILL.md"), "utf8");
    assert.match(skill, /gen-youtube-thumb\.ts/);
  });
});
