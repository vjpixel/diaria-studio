/**
 * test/youtube-thumb-261021-layout-11942.test.ts (#11942)
 *
 * A capa do YouTube volta ao padrão da 261021 ("IA ladra?"): close-up do
 * editor gerado por IA a partir do frame (só referência de identidade, com a
 * expressão editável), gancho embaixo à direita, gradiente na base e vinheta.
 * O layout de gancho no topo (#11220) fica opcional (`layout: "top"`).
 * Sem rede, sem ffmpeg, sem Codex.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  BOTTOM_HOOK_PORTRAIT_OVERLAP,
  DEFAULT_THUMB_LAYOUT,
  VIGNETTE_MAX_OPACITY,
  YOUTUBE_THUMB_H,
  YOUTUBE_THUMB_W,
  buildGradientSvg,
  buildVignetteSvg,
  composeYouTubeThumb,
  hookWidthBesideBottom,
  parseThumbLayout,
} from "../scripts/lib/diaria/youtube-thumb.ts";
import {
  DEFAULT_PORTRAIT_EXPRESSIONS,
  PORTRAIT_EXPRESSIONS,
  THUMB_PORTRAITS_DIR,
  buildPortraitPrompt,
  parseExpressions,
} from "../scripts/lib/diaria/youtube-thumb-portrait.ts";
// @ts-expect-error — módulo JS sem tipos
import { buildCodexPrompt } from "../scripts/codex-image.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function rgba(w: number, h: number, rgb: [number, number, number], alpha: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha } } })
    .png()
    .toBuffer();
}

/** Recorte fake do rembg: bloco opaco com margem transparente (o `trim` a remove). */
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

/** Caixa dos pixels "acesos" (cor papel do gancho). */
async function brightBox(jpeg: Buffer, minSum = 500) {
  const { data, info } = await raw(jpeg);
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

describe("#11942 layout", () => {
  it("o default é bottom (padrão da 261021); top segue aceito; valor inválido lança", () => {
    assert.equal(DEFAULT_THUMB_LAYOUT, "bottom");
    assert.equal(parseThumbLayout(undefined), "bottom");
    assert.equal(parseThumbLayout("top"), "top");
    assert.equal(parseThumbLayout(" Bottom "), "bottom");
    assert.throws(() => parseThumbLayout("meio"), /bottom, top ou right/); // #12123: + right
  });

  it("gradiente de baixo cobre os 45% inferiores, escuro na base; o de cima não mudou", () => {
    const svg = buildGradientSvg(1280, 720, "bottom");
    assert.match(svg, /<rect x="0" y="396" width="1280" height="324"/);
    assert.match(svg, /<stop offset="1" stop-color="#000" stop-opacity="0.6"\/>/);
    assert.equal(buildGradientSvg(), buildGradientSvg(1280, 720, "top"));
  });

  it("vinheta radial escurece as bordas", () => {
    const svg = buildVignetteSvg();
    assert.match(svg, /radialGradient/);
    assert.ok(svg.includes(`stop-opacity="${VIGNETTE_MAX_OPACITY}"`));
  });
});

describe("#11942 composição no padrão da 261021", () => {
  it("sem layout, o gancho vai para o canto INFERIOR direito, com margem de 40px", async () => {
    const { jpeg, warnings } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 0], 1),
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "IA ladra?",
    });
    assert.deepEqual(warnings, []);
    const box = await brightBox(jpeg);
    assert.ok(box.maxX <= YOUTUBE_THUMB_W - 40 + 2, `x final ${box.maxX}`);
    assert.ok(box.maxY <= YOUTUBE_THUMB_H - 40 + 2 && box.maxY > YOUTUBE_THUMB_H - 80, `base do texto em y=${box.maxY}`);
    assert.ok(box.minY > YOUTUBE_THUMB_H / 2, `texto sobe até y=${box.minY}`);
    assert.ok(box.minX >= YOUTUBE_THUMB_W - 40 - 720 - 2, `texto começa em x=${box.minX}`);
  });

  it("vinheta: cantos escuros, miolo da cena (à direita, no alto) quase intacto", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [240, 240, 240], 1),
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "IA ladra?",
    });
    const { px } = await raw(jpeg);
    const lum = (x: number, y: number) => px(x, y).reduce((a, b) => a + b, 0);
    assert.ok(lum(790, 300) > 650, `miolo ${lum(790, 300)}`);
    assert.ok(lum(5, 5) < lum(790, 300) - 200, `canto ${lum(5, 5)} vs miolo ${lum(790, 300)}`);
  });

  it("retrato vira close-up: ocupa a altura inteira, colado à esquerda e na base, até 55% da largura", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 255], 1),
      portrait: await cutout(600, 800, [200, 30, 30]),
      hook: "IA ladra?",
    });
    const { px } = await raw(jpeg);
    const isRed = (x: number, y: number) => {
      const [r, , b] = px(x, y);
      return r > 90 && b < 90;
    };
    assert.ok(isRed(20, 4), `topo esquerdo é retrato: ${px(20, 4)}`);
    assert.ok(isRed(20, 715), `base esquerda é retrato: ${px(20, 715)}`);
    // 600x800 em 704x720 (inside) → 540x720: termina em x≈539.
    assert.ok(isRed(500, 360), `miolo do retrato: ${px(500, 360)}`);
    assert.ok(!isRed(600, 360), `depois do retrato é fundo: ${px(600, 360)}`);
  });

  it("hookWidthBesideBottom: sem retrato nas linhas, 720; com o ombro até x=703, cobre no máximo 160px", () => {
    assert.equal(hookWidthBesideBottom(-1), 720);
    assert.equal(hookWidthBesideBottom(703), 1280 - 40 - (704 - BOTTOM_HOOK_PORTRAIT_OVERLAP));
    assert.equal(hookWidthBesideBottom(10), 720);
    assert.equal(hookWidthBesideBottom(1000), 1280 - 40 - (1001 - BOTTOM_HOOK_PORTRAIT_OVERLAP));
  });

  it("retrato largo: o gancho de baixo encolhe e cobre o ombro só até o limite", async () => {
    // Retrato opaco largo e baixo: no layout bottom vai a 704px de largura na base.
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 0], 1),
      portrait: await cutout(1000, 700, [10, 10, 200]),
      hook: "Superinteligência descontrolada amanhã?",
    });
    const { info, px } = await raw(jpeg);
    // O `?` do gancho é teal (#00A0A0: r=0, g=160, b=160) e, com a métrica da
    // fonte de fallback do runner do CI, desce até a linha y=650: sem filtrar o
    // verde, a varredura lia o `?` como retrato (x=1238) e o teste dependia da
    // fonte instalada. O retrato é azul puro (g baixo); o teal nunca passa.
    let portraitRight = -1;
    for (let x = 0; x < info.width; x++) {
      const [r, g, b] = px(x, 650);
      if (b > 150 && r < 80 && g < 80) portraitRight = x;
    }
    // Geometria pura: 1000x700 em 704x720 (inside) → 704 de largura, termina em x≈703.
    assert.ok(portraitRight > 650 && portraitRight <= 706, `retrato chega à base até x=${portraitRight}`);
    const box = await brightBox(jpeg);
    assert.ok(
      box.minX >= portraitRight - BOTTOM_HOOK_PORTRAIT_OVERLAP - 4,
      `gancho começa em x=${box.minX}, retrato vai até x=${portraitRight}`,
    );
  });

  it("layout top continua disponível: gancho no alto", async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await rgba(1280, 720, [0, 0, 0], 1),
      portrait: await rgba(10, 10, [0, 0, 0], 0.02),
      hook: "IA ladra?",
      layout: "top",
    });
    const box = await brightBox(jpeg);
    assert.ok(box.maxY < YOUTUBE_THUMB_H / 2, `texto desce até y=${box.maxY}`);
  });
});

describe("#11942 retrato por IA com expressão editável", () => {
  it("parseExpressions: default desconfiado/surpreso/preocupado; valida chave, repetição e máximo", () => {
    assert.deepEqual(parseExpressions(undefined), [...DEFAULT_PORTRAIT_EXPRESSIONS]);
    assert.equal(DEFAULT_PORTRAIT_EXPRESSIONS[0], "desconfiado");
    assert.deepEqual(parseExpressions(" Surpreso, serio "), ["surpreso", "serio"]);
    assert.throws(() => parseExpressions(""), /vazio/);
    assert.throws(() => parseExpressions("feliz"), /desconhecida/);
    assert.throws(() => parseExpressions("serio,serio"), /repete/);
    assert.throws(() => parseExpressions("serio,surpreso,preocupado,ironico,intrigado"), /máximo/);
  });

  it("buildPortraitPrompt: close-up fotorrealista 4:5, frame como referência de identidade, expressão no prompt", () => {
    const sd = buildPortraitPrompt("desconfiado", "/abs/escolhido.png");
    assert.equal(sd.reference_mode, "identity");
    assert.deepEqual(sd.reference_images, ["/abs/escolhido.png"]);
    assert.equal(sd.final_width / sd.final_height, 1080 / 1350);
    assert.match(sd.positive, /close-up/i);
    assert.match(sd.positive, /Photorealistic/);
    assert.ok(sd.positive.includes(PORTRAIT_EXPRESSIONS.desconfiado));
    assert.match(sd.negative, /painting/);
    assert.match(sd.negative, /hands/);
  });

  it("codex-image.js: reference_mode identity pede foto nova com a mesma pessoa, não outpaint", () => {
    const p = buildCodexPrompt(buildPortraitPrompt("surpreso", "/abs/f.png"));
    assert.match(p, /identity reference/);
    assert.match(p, /facial expression/);
    assert.doesNotMatch(p, /outpaint/);
    assert.match(p, /portrait 4:5/);
    // Sem reference_mode, a referência segue sendo outpaint (#11228).
    assert.match(buildCodexPrompt({ positive: "x", reference_images: ["/a.jpg"] }), /outpaint/);
  });

  it("codex-image.js: identity não anexa o headroom generoso (puxaria contra o close-up); os outros modos mantêm", () => {
    assert.doesNotMatch(buildCodexPrompt(buildPortraitPrompt("desconfiado", "/abs/f.png")), /headroom/);
    assert.match(buildCodexPrompt({ positive: "x", reference_images: ["/a.jpg"] }), /generous empty headroom/);
    assert.match(buildCodexPrompt({ positive: "x" }), /generous empty headroom/);
  });
});

describe("#11942 CLI: opções de retrato", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts", "261103", ...args], { cwd: ROOT, encoding: "utf8" });

  it("--portrait-prompts → --portrait-sheet → --pick-portrait", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-11942-"));
    try {
      const ref = join(dir, "frame.png");
      writeFileSync(ref, await rgba(64, 80, [120, 90, 60], 1));

      const noRef = run(["--portrait-prompts", "--edition-dir", dir]);
      assert.equal(noRef.status, 1, noRef.stderr);
      assert.match(noRef.stderr, /--pick-frame/);

      const p = run(["--portrait-prompts", "--expressions", "desconfiado,serio", "--ref", ref, "--edition-dir", dir]);
      assert.equal(p.status, 0, p.stderr);
      const out = JSON.parse(p.stdout) as { options: { n: number; expression: string; prompt: string; out: string; command: string }[] };
      assert.deepEqual(out.options.map((o) => o.expression), ["desconfiado", "serio"]);
      const prompt1 = JSON.parse(readFileSync(out.options[0].prompt, "utf8"));
      assert.equal(prompt1.reference_mode, "identity");
      assert.deepEqual(prompt1.reference_images, [ref]);
      assert.match(out.options[1].command, /^node scripts\/codex-image\.js .*prompt-2\.json .*retrato-2\.jpg$/);

      const missing = run(["--portrait-sheet", "--edition-dir", dir]);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /retrato-1\.jpg/);

      for (const o of out.options) {
        writeFileSync(o.out, await sharp({ create: { width: 108, height: 135, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer());
      }
      const sheet = run(["--portrait-sheet", "--edition-dir", dir]);
      assert.equal(sheet.status, 0, sheet.stderr);
      assert.ok(existsSync(join(dir, THUMB_PORTRAITS_DIR, "opcoes.jpg")));
      assert.match(sheet.stderr, /1=desconfiado, 2=serio/);

      const badPick = run(["--pick-portrait", "3", "--edition-dir", dir]);
      assert.equal(badPick.status, 1);
      const pick = run(["--pick-portrait", "2", "--edition-dir", dir]);
      assert.equal(pick.status, 0, pick.stderr);
      assert.deepEqual(readFileSync(join(dir, THUMB_PORTRAITS_DIR, "escolhido.jpg")), readFileSync(out.options[1].out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--portrait-prompts de nova rodada apaga retrato-N.jpg, folha e escolha da rodada anterior (review #11946)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-11942-stale-"));
    try {
      const ref = join(dir, "frame.png");
      writeFileSync(ref, await rgba(64, 80, [120, 90, 60], 1));
      const first = run(["--portrait-prompts", "--expressions", "desconfiado,surpreso,preocupado", "--ref", ref, "--edition-dir", dir]);
      assert.equal(first.status, 0, first.stderr);
      const pdir = join(dir, THUMB_PORTRAITS_DIR);
      const jpg = await sharp({ create: { width: 108, height: 135, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
      for (const n of [1, 2, 3]) writeFileSync(join(pdir, `retrato-${n}.jpg`), jpg);
      writeFileSync(join(pdir, "opcoes.jpg"), jpg);
      writeFileSync(join(pdir, "escolhido.jpg"), jpg);
      writeFileSync(join(pdir, "prompt-3.json"), "{}");
      writeFileSync(join(pdir, "outro.txt"), "fica");

      const second = run(["--portrait-prompts", "--expressions", "serio,ironico", "--ref", ref, "--edition-dir", dir]);
      assert.equal(second.status, 0, second.stderr);
      for (const f of ["retrato-1.jpg", "retrato-2.jpg", "retrato-3.jpg", "opcoes.jpg", "escolhido.jpg", "prompt-3.json"]) {
        assert.ok(!existsSync(join(pdir, f)), `${f} da rodada anterior deveria ter sido apagado`);
      }
      assert.ok(existsSync(join(pdir, "prompt-1.json")) && existsSync(join(pdir, "prompt-2.json")));
      assert.ok(existsSync(join(pdir, "outro.txt")), "arquivo fora do padrão não é tocado");

      // Sem as opções novas, a folha falha em vez de usar as velhas; o N=3 velho sumiu.
      const sheet = run(["--portrait-sheet", "--edition-dir", dir]);
      assert.equal(sheet.status, 1);
      assert.match(sheet.stderr, /retrato-1\.jpg/);
      assert.equal(run(["--pick-portrait", "3", "--edition-dir", dir]).status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--layout inválido ou sem valor falha antes de compor", () => {
    const bad = run(["--hook", "IA ladra?", "--portrait", "x.png", "--layout", "meio", "--edition-dir", tmpdir()]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /bottom, top ou right/);
    const bare = run(["--hook", "IA ladra?", "--portrait", "x.png", "--edition-dir", tmpdir(), "--layout"]);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /--layout exige/);
  });
});

describe("#11942 skill documenta o padrão da 261021", () => {
  const skill = readFileSync(resolve(ROOT, ".claude/skills/diaria-publica-video/SKILL.md"), "utf8");
  const a2 = skill.slice(skill.indexOf("### Passo A2"), skill.indexOf("### Passo A3"));

  it("Passo A2 usa o close-up pelo Codex com folha de expressões e o layout bottom", () => {
    assert.match(a2, /--portrait-prompts/);
    assert.match(a2, /--portrait-sheet/);
    assert.match(a2, /--pick-portrait/);
    assert.match(a2, /261021/);
    assert.match(a2, /--layout top/);
    assert.match(a2, /#11942/);
  });
});
