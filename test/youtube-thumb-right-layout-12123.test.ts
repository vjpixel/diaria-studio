/**
 * test/youtube-thumb-right-layout-12123.test.ts (#12123)
 *
 * Capa espelhada da 261104: `--layout right` (retrato colado à direita, gancho
 * embaixo à esquerda, vinheta com centro em cx=0.38), `--bg-crop x,y,w,h`
 * (amplia a cena sem novo outpaint) e o prompt do retrato com ombros/braços
 * inteiros e olhar para a cena, no lado oposto ao do retrato.
 * Sem rede, sem ffmpeg, sem Codex.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  BOTTOM_HOOK_PORTRAIT_OVERLAP,
  VIGNETTE_CX_RIGHT,
  YOUTUBE_THUMB_H,
  YOUTUBE_THUMB_W,
  assertBgCropInside,
  buildHookSvg,
  buildVignetteSvg,
  composeYouTubeThumb,
  hookWidthBesideBottomLeft,
  parseBgCrop,
  parseThumbLayout,
  portraitLeftEdgeInRows,
  portraitSideForLayout,
} from "../scripts/lib/diaria/youtube-thumb.ts";
import { PORTRAIT_EXPRESSIONS, THUMB_PORTRAITS_DIR, buildPortraitPrompt, gazeSentence } from "../scripts/lib/diaria/youtube-thumb-portrait.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function rgba(w: number, h: number, rgb: [number, number, number], alpha: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha } } })
    .png()
    .toBuffer();
}
async function cutout(w: number, h: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: w + 40, height: h + 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await rgba(w, h, rgb, 1), left: 20, top: 20 }])
    .png()
    .toBuffer();
}
async function raw(jpeg: Buffer) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { data, info, px };
}
async function brightBox(jpeg: Buffer, minSum = 500) {
  const { data, info } = await raw(jpeg);
  let [minX, maxX, minY, maxY] = [Infinity, -1, Infinity, -1];
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

describe("#12123 layout right", () => {
  it("parseThumbLayout aceita right; o retrato fica à direita só nele", () => {
    assert.equal(parseThumbLayout("right"), "right");
    assert.equal(parseThumbLayout(" Right "), "right");
    assert.equal(portraitSideForLayout("right"), "right");
    assert.equal(portraitSideForLayout("bottom"), "left");
    assert.equal(portraitSideForLayout("top"), "left");
  });

  it("vinheta espelhada: centro em cx=0.38; a do bottom segue em 0.62", () => {
    assert.match(buildVignetteSvg(1280, 720, VIGNETTE_CX_RIGHT), /cx="0.38"/);
    assert.match(buildVignetteSvg(), /cx="0.62"/);
  });

  it("retrato colado à DIREITA e na base, close-up até 55% da largura", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 255], 1),
      portrait: await cutout(600, 800, [200, 30, 30]),
      hook: "IA ladra?",
      layout: "right",
    });
    const { px } = await raw(jpeg);
    const isRed = (x: number, y: number) => {
      const [r, , b] = px(x, y);
      return r > 90 && b < 90;
    };
    // 600x800 em 704x720 (inside) → 540x720, colado em x = 1280 - 540 = 740.
    assert.ok(isRed(1270, 4), `topo direito é retrato: ${px(1270, 4)}`);
    assert.ok(isRed(1270, 715), `base direita é retrato: ${px(1270, 715)}`);
    assert.ok(isRed(780, 200), `miolo do retrato: ${px(780, 200)}`);
    assert.ok(!isRed(700, 200), `antes do retrato é fundo: ${px(700, 200)}`);
  });

  it("gancho embaixo à ESQUERDA, com margem de 40px", async () => {
    const { jpeg, warnings } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 0], 1),
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "IA ladra?",
      layout: "right",
    });
    assert.deepEqual(warnings, []);
    const box = await brightBox(jpeg);
    assert.ok(box.minX >= 40 - 2 && box.minX < 80, `texto começa em x=${box.minX}`);
    assert.ok(box.maxX < YOUTUBE_THUMB_W / 2 + 200, `texto vai até x=${box.maxX}`);
    assert.ok(box.maxY <= YOUTUBE_THUMB_H - 40 + 2 && box.maxY > YOUTUBE_THUMB_H - 80, `base do texto em y=${box.maxY}`);
  });

  it("vinheta espelhada: a cena à esquerda fica clara, o canto direito escurece", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [240, 240, 240], 1),
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "IA ladra?",
      layout: "right",
    });
    const { px } = await raw(jpeg);
    const lum = (x: number, y: number) => px(x, y).reduce((a, b) => a + b, 0);
    // Espelho do ponto (790, 300) do teste do #11942: x = 1280 - 790 = 490.
    assert.ok(lum(490, 300) > 650, `miolo ${lum(490, 300)}`);
    assert.ok(lum(1274, 5) < lum(490, 300) - 200, `canto ${lum(1274, 5)} vs miolo ${lum(490, 300)}`);
  });

  it("portraitLeftEdgeInRows / hookWidthBesideBottomLeft: espelho do bottom", async () => {
    // Retrato 10x4, opaco só nas colunas 3..6 das linhas 1..2.
    const w = 10;
    const data = new Uint8Array(w * 4 * 4);
    for (const y of [1, 2]) for (let x = 3; x <= 6; x++) data[(y * w + x) * 4 + 3] = 255;
    const img = { data, width: w, height: 4, channels: 4 };
    assert.equal(portraitLeftEdgeInRows(img, 100, 100, 103), 3);
    assert.equal(portraitLeftEdgeInRows(img, 100, 100, 100), -1, "linha 0 sem nada");
    assert.equal(hookWidthBesideBottomLeft(-1), 720);
    assert.equal(hookWidthBesideBottomLeft(576), 576 + BOTTOM_HOOK_PORTRAIT_OVERLAP - 40);
    assert.equal(hookWidthBesideBottomLeft(1200), 720, "nunca passa do teto");
  });

  it("retrato largo: o gancho de baixo à esquerda encolhe e cobre o ombro só até o limite", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 0], 1),
      portrait: await cutout(1000, 700, [10, 10, 200]),
      hook: "Superinteligência descontrolada amanhã?",
      layout: "right",
    });
    const { info, px } = await raw(jpeg);
    let portraitLeft = info.width;
    for (let x = info.width - 1; x >= 0; x--) {
      const [r, g, b] = px(x, 650);
      if (b > 150 && r < 80 && g < 80) portraitLeft = x;
    }
    // 1000x700 em 704x720 (inside) → 704 de largura, colado em x = 576.
    assert.ok(portraitLeft >= 572 && portraitLeft < 630, `retrato começa em x=${portraitLeft}`);
    const box = await brightBox(jpeg);
    assert.ok(box.maxX <= portraitLeft + BOTTOM_HOOK_PORTRAIT_OVERLAP + 4, `gancho vai até x=${box.maxX}, retrato começa em x=${portraitLeft}`);
  });

  it("gancho em 2 linhas no right: linhas alinhadas à esquerda (text-anchor start)", () => {
    const svg = buildHookSvg("Confiou no chatbot|e morreu", "start");
    assert.match(svg, /text-anchor="start"/);
    assert.doesNotMatch(svg, /text-anchor="end"/);
    assert.match(buildHookSvg("Confiou no chatbot|e morreu"), /text-anchor="end"/);
  });
});

describe("#12123 --bg-crop", () => {
  it("parseBgCrop valida 4 inteiros ≥ 0 com largura e altura > 0", () => {
    assert.deepEqual(parseBgCrop("200,80,1400,788"), { left: 200, top: 80, width: 1400, height: 788 });
    assert.deepEqual(parseBgCrop(" 0, 0, 16, 9 "), { left: 0, top: 0, width: 16, height: 9 });
    for (const bad of ["1,2,3", "1,2,3,4,5", "a,0,10,10", "-1,0,10,10", "0,0,10.5,10", "0,,10,10"]) {
      assert.throws(() => parseBgCrop(bad), /--bg-crop .* inválido/, bad);
    }
    assert.throws(() => parseBgCrop("0,0,0,10"), /maiores que zero/);
  });

  it("assertBgCropInside lança quando o recorte passa da imagem", () => {
    assertBgCropInside({ left: 0, top: 0, width: 100, height: 50 }, 100, 50);
    assert.throws(() => assertBgCropInside({ left: 10, top: 0, width: 100, height: 50 }, 100, 50), /passa da imagem de fundo \(100x50\)/);
  });

  it("o recorte vira a cena inteira: a metade esquerda vermelha de um fundo vermelho|verde enche a capa", async () => {
    // Fundo 2560x720: esquerda vermelha, direita verde. Recorte da metade esquerda (16:9).
    const bg = await sharp({ create: { width: 2560, height: 720, channels: 3, background: { r: 0, g: 200, b: 0 } } })
      .composite([{ input: { create: { width: 1280, height: 720, channels: 3, background: { r: 200, g: 0, b: 0 } } }, left: 0, top: 0 }])
      .png()
      .toBuffer();
    const { jpeg, warnings } = await composeYouTubeThumb({
      background: bg,
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "IA ladra?",
      layout: "top",
      bgCrop: { left: 0, top: 0, width: 1280, height: 720 },
    });
    assert.deepEqual(warnings, [], "recorte 16:9 não avisa");
    const { px } = await raw(jpeg);
    const [r, g] = px(1100, 600);
    assert.ok(r > 120 && g < 80, `canto direito-baixo é o vermelho do recorte: ${px(1100, 600)}`);
  });

  it("recorte fora 16:9 avisa; recorte fora da imagem lança", async () => {
    const bg = await rgba(1600, 900, [50, 50, 50], 1);
    const { warnings } = await composeYouTubeThumb({
      background: bg,
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "IA ladra?",
      bgCrop: { left: 0, top: 0, width: 800, height: 800 },
    });
    assert.ok(warnings.some((w) => /recorte do fundo 800x800 não é 16:9/.test(w)), warnings.join("\n"));
    await assert.rejects(
      composeYouTubeThumb({ background: bg, portrait: await rgba(10, 10, [0, 0, 0], 0.02), hook: "IA ladra?", bgCrop: { left: 1000, top: 0, width: 800, height: 450 } }),
      /passa da imagem de fundo/,
    );
  });
});

describe("#12123 prompt do retrato", () => {
  it("pede ombros e braços inteiros com margem dos dois lados", () => {
    const p = buildPortraitPrompt("desconfiado", "/abs/f.png");
    assert.match(p.positive, /both shoulders and the upper arms entirely inside the frame/);
    assert.match(p.positive, /margin on both the left and the right side/);
    assert.match(p.negative, /cropped shoulder/);
    assert.ok(p.positive.includes(PORTRAIT_EXPRESSIONS.desconfiado));
  });

  it("olhar para a cena: retrato à esquerda olha para a direita, à direita olha para a esquerda", () => {
    assert.match(gazeSentence("left"), /portrait goes on the left side .* turn toward the right of the frame/);
    assert.match(gazeSentence("right"), /portrait goes on the right side .* turn toward the left of the frame/);
    assert.ok(buildPortraitPrompt("surpreso", "/abs/f.png").positive.includes(gazeSentence("left")), "default = esquerda");
    assert.ok(buildPortraitPrompt("surpreso", "/abs/f.png", "right").positive.includes(gazeSentence("right")));
  });

  it("nenhuma expressão fixa a direção do olhar (vem do lado do retrato)", () => {
    for (const [k, v] of Object.entries(PORTRAIT_EXPRESSIONS)) {
      assert.doesNotMatch(v, /right|left|camera/, `${k}: ${v}`);
    }
  });
});

describe("#12123 skill documenta o layout right e o --bg-crop", () => {
  it("Passo A2 cita --layout right, --bg-crop e o --layout no --portrait-prompts", () => {
    const skill = readFileSync(resolve(ROOT, ".claude/skills/diaria-publica/SKILL.md"), "utf8");
    const a2 = skill.slice(skill.indexOf("### Passo A2"), skill.indexOf("### Passo A3"));
    assert.match(a2, /--layout right/);
    assert.match(a2, /--bg-crop/);
    assert.match(a2, /--portrait-prompts .*\[--layout right\]/);
    assert.match(a2, /#12123/);
  });
});

describe("#12123 CLI", () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts", "261104", ...args], { cwd: ROOT, encoding: "utf8" });

  it("--portrait-prompts --layout right grava o lado e o olhar para a esquerda", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-12123-"));
    try {
      const ref = join(dir, "frame.png");
      writeFileSync(ref, await rgba(64, 80, [120, 90, 60], 1));
      const p = run(["--portrait-prompts", "--expressions", "desconfiado", "--ref", ref, "--layout", "right", "--edition-dir", dir]);
      assert.equal(p.status, 0, p.stderr);
      const out = JSON.parse(p.stdout) as { side: string; options: { prompt: string }[] };
      assert.equal(out.side, "right");
      assert.ok(JSON.parse(readFileSync(out.options[0].prompt, "utf8")).positive.includes(gazeSentence("right")));
      const meta = JSON.parse(readFileSync(join(dir, THUMB_PORTRAITS_DIR, "retratos.json"), "utf8"));
      assert.equal(meta.side, "right");

      const bad = run(["--portrait-prompts", "--ref", ref, "--layout", "meio", "--edition-dir", dir]);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /bottom, top ou right/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--bg-crop inválido ou sem valor falha antes de compor", () => {
    const bad = run(["--hook", "IA ladra?", "--portrait", "x.png", "--bg-crop", "1,2,3", "--edition-dir", tmpdir()]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--bg-crop .* inválido/);
    const bare = run(["--hook", "IA ladra?", "--portrait", "x.png", "--edition-dir", tmpdir(), "--bg-crop"]);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /--bg-crop exige/);
  });
});
