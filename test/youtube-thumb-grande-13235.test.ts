/**
 * test/youtube-thumb-grande-13235.test.ts (#13235)
 *
 * Modo de teste da "fórmula Van Gogh" da capa horizontal (período de teste da
 * #13192), opt-in: gancho `grande` (Anton do repo, caixa alta, 2 linhas, a
 * última numa tarja teal, no topo), logo opcional abaixo do gancho e o prompt
 * do fundo de capa. O padrão (`serif`) não muda.
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
  ANTON_FONT_FILE,
  DEFAULT_HOOK_STYLE,
  GRANDE_HOOK_MAX_FONT,
  GRANDE_HOOK_MAX_HEIGHT,
  GRANDE_HOOK_MIN_FONT,
  YOUTUBE_THUMB_H,
  YOUTUBE_THUMB_W,
  assertAntonAvailable,
  composeYouTubeThumb,
  grandeBlockSize,
  grandeHookFontSize,
  grandeHookLines,
  hookWidthBesideLeft,
  parseHookStyle,
  renderGrandeHookLayer,
} from "../scripts/lib/diaria/youtube-thumb.ts";
import { THUMB_CAPA_BG_DIR, THUMB_CAPA_BG_PROMPT, buildCapaBackgroundPrompt, parseCapaScene } from "../scripts/lib/diaria/youtube-thumb-capa-bg.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// No Windows o pango do sharp não carrega o `fontfile` (sem fontconfig): a Anton não
// resolve e o guard recusa o gancho grande, de propósito (#13738). Lá os testes que
// rasterizam a Anton são pulados; no Linux (300, CI) nunca, o guard segue estrito.
const ANTON_SKIP: string | false =
  process.platform === "win32" ? await assertAntonAvailable().then(() => false, () => "Anton não resolve no rasterizador do Windows") : false;
const TEAL: [number, number, number] = [0, 160, 160];
const ORANGE: [number, number, number] = [220, 90, 30];

async function solid(w: number, h: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } } }).png().toBuffer();
}
async function cutout(w: number, h: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: w + 40, height: h + 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(w, h, rgb), left: 20, top: 20 }])
    .png()
    .toBuffer();
}
async function background(): Promise<Buffer> {
  return sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 30, g: 40, b: 80 } } }).jpeg().toBuffer();
}
/** Caixa dos pixels perto de `rgb` (tolerância por canal). */
async function colorBox(jpeg: Buffer, rgb: [number, number, number], tol = 30) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  let [minX, maxX, minY, maxY, n] = [Infinity, -1, Infinity, -1, 0];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (Math.abs(data[i] - rgb[0]) <= tol && Math.abs(data[i + 1] - rgb[1]) <= tol && Math.abs(data[i + 2] - rgb[2]) <= tol) {
        n++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { n, minX, maxX, minY, maxY };
}

describe("#13235 — parseHookStyle", () => {
  it("default é serif (o padrão não muda)", () => {
    assert.equal(DEFAULT_HOOK_STYLE, "serif");
    assert.equal(parseHookStyle(undefined), "serif");
    assert.equal(parseHookStyle(" Grande "), "grande");
  });
  it("valor fora das opções lança com as opções", () => {
    assert.throws(() => parseHookStyle("anton"), /serif \(default\) ou grande/);
  });
});

describe("#13235 — grandeHookLines", () => {
  it("gancho de uma linha vira 2, em caixa alta, a palavra-chave na última", () => {
    assert.deepEqual(grandeHookLines("IA ladra?"), ["IA", "LADRA?"]);
    assert.deepEqual(grandeHookLines("Google Photos te vigia?"), ["GOOGLE PHOTOS", "TE VIGIA?"]);
    assert.deepEqual(grandeHookLines("três palavras aqui"), ["TRÊS PALAVRAS", "AQUI"]);
  });
  it("quebra explícita do editor é respeitada", () => {
    assert.deepEqual(grandeHookLines("Claude vazou|suas senhas?"), ["CLAUDE VAZOU", "SUAS SENHAS?"]);
  });
  it("moeda e número ficam na mesma linha (#12278)", () => {
    assert.deepEqual(grandeHookLines("R$ 100 mil?"), ["R$ 100", "MIL?"]);
  });
  it("mesma validação do gancho padrão (2 a 4 palavras)", () => {
    assert.throws(() => grandeHookLines("Sozinho"), /2 a 4/);
    assert.throws(() => grandeHookLines("um dois três quatro cinco"), /2 a 4/);
  });
});

describe("#13235 — tamanho do bloco grande", () => {
  const at100 = [
    { width: 100, height: 87 },
    { width: 300, height: 87 },
  ];
  it("a tarja soma padding só na última linha", () => {
    const b = grandeBlockSize(at100, 100);
    assert.equal(b.width, 300 + 2 * b.padX);
    assert.equal(b.height, 87 + 87 + 2 * b.padY + b.gap);
  });
  it("o maior tamanho que cabe na largura e na altura, dentro dos limites", () => {
    const wide = grandeHookFontSize(at100, 10_000, 10_000);
    assert.equal(wide, GRANDE_HOOK_MAX_FONT);
    const s = grandeHookFontSize(at100, 500);
    const b = grandeBlockSize(at100, s);
    assert.ok(b.width <= 500 && b.height <= GRANDE_HOOK_MAX_HEIGHT, JSON.stringify({ s, b }));
    assert.ok(grandeBlockSize(at100, s + 2).width > 500 || grandeBlockSize(at100, s + 2).height > GRANDE_HOOK_MAX_HEIGHT);
    assert.equal(grandeHookFontSize(at100, 10), GRANDE_HOOK_MIN_FONT);
  });
});

describe("#13235 — fonte Anton versionada", () => {
  it("o TTF e a licença OFL estão no repo", () => {
    assert.ok(existsSync(ANTON_FONT_FILE), ANTON_FONT_FILE);
    const ofl = readFileSync(join(dirname(ANTON_FONT_FILE), "OFL.txt"), "utf8");
    assert.match(ofl, /SIL Open Font License/);
  });
  it("resolve no rasterizador (sem depender de fonte instalada)", { skip: ANTON_SKIP }, async () => {
    await assertAntonAvailable();
  });
  it("o gancho grande cabe na largura pedida, com a tarja teal", async () => {
    const layer = await renderGrandeHookLayer("IA ladra?", 400);
    assert.ok(layer.width <= 400, `largura ${layer.width}`);
    assert.ok(layer.height <= GRANDE_HOOK_MAX_HEIGHT);
    const box = await colorBox(await sharp(layer.png).flatten({ background: "#000" }).jpeg().toBuffer(), TEAL);
    assert.ok(box.n > 1000, `pixels teal: ${box.n}`);
  });
});

describe("#13235 — hookWidthBesideLeft", () => {
  it("espelho do hookWidthBeside: da margem esquerda até o retrato, menos a folga", () => {
    assert.equal(hookWidthBesideLeft(-1, 620), 620);
    assert.equal(hookWidthBesideLeft(700, 620), 620);
    assert.equal(hookWidthBesideLeft(500, 620), 500 - 24 - 40);
  });
});

describe("#13235 — composeYouTubeThumb com gancho grande", () => {
  it("tarja teal no canto SUPERIOR direito; logo abaixo do gancho, no mesmo lado", { skip: ANTON_SKIP }, async () => {
    const { jpeg, warnings } = await composeYouTubeThumb({
      background: await background(),
      portrait: await cutout(400, 600, [200, 150, 120]),
      hook: "IA ladra?",
      hookStyle: "grande",
      logo: await solid(400, 200, ORANGE),
    });
    assert.deepEqual(warnings, []);
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.width, YOUTUBE_THUMB_W);
    assert.equal(meta.height, YOUTUBE_THUMB_H);
    const tarja = await colorBox(jpeg, TEAL);
    assert.ok(tarja.n > 5000, `pixels teal: ${tarja.n}`);
    assert.ok(tarja.minX > YOUTUBE_THUMB_W / 2, `tarja à direita (minX ${tarja.minX})`);
    assert.ok(tarja.maxY < YOUTUBE_THUMB_H / 2, `tarja no topo (maxY ${tarja.maxY})`);
    const logo = await colorBox(jpeg, ORANGE);
    assert.ok(logo.n > 5000, `pixels do logo: ${logo.n}`);
    assert.ok(logo.minY > tarja.maxY, `logo abaixo do gancho (logo ${logo.minY}, tarja ${tarja.maxY})`);
    assert.ok(logo.minX > YOUTUBE_THUMB_W / 2);
  });

  it("layout right: o gancho grande vai para a esquerda", { skip: ANTON_SKIP }, async () => {
    const { jpeg } = await composeYouTubeThumb({
      background: await background(),
      portrait: await cutout(400, 600, [200, 150, 120]),
      hook: "IA ladra?",
      hookStyle: "grande",
      layout: "right",
    });
    const tarja = await colorBox(jpeg, TEAL);
    assert.ok(tarja.maxX < YOUTUBE_THUMB_W / 2, `tarja à esquerda (maxX ${tarja.maxX})`);
    assert.ok(tarja.maxY < YOUTUBE_THUMB_H / 2);
  });

  it("o padrão não muda: sem hookStyle sai igual ao serif explícito, sem tarja", async () => {
    const input = { background: await background(), portrait: await cutout(400, 600, [200, 150, 120]), hook: "IA ladra?" };
    const def = await composeYouTubeThumb(input);
    const serif = await composeYouTubeThumb({ ...input, hookStyle: "serif" });
    assert.ok(def.jpeg.equals(serif.jpeg));
    const tarja = await colorBox(def.jpeg, TEAL);
    assert.ok(tarja.n < 2000, `capa padrão sem tarja (pixels teal: ${tarja.n})`);
  });

  it("logo sem o gancho grande é recusado", async () => {
    await assert.rejects(
      composeYouTubeThumb({ background: await background(), portrait: await cutout(400, 600, [200, 150, 120]), hook: "IA ladra?", logo: await solid(100, 100, ORANGE) }),
      /--hook-style grande/,
    );
  });
});

describe("#13235 — prompt do fundo de capa", () => {
  it("escuro, um objeto no lado oposto ao do retrato, sem pessoas, sem texto, sem Noite Estrelada", () => {
    const p = buildCapaBackgroundPrompt("um cadeado aberto de metal");
    assert.match(p.positive, /van Gogh/i);
    assert.match(p.positive, /um cadeado aberto de metal/);
    assert.match(p.positive, /object sits in the right half/);
    assert.match(p.positive, /left half of the frame is empty/);
    assert.match(p.positive, /dark/i);
    assert.doesNotMatch(p.positive, /starry/i);
    for (const term of ["people", "text", "The Starry Night", "logo"]) assert.ok(p.negative.includes(term), term);
    assert.equal(p.final_width / p.final_height, 16 / 9);
    const right = buildCapaBackgroundPrompt("x", "right");
    assert.match(right.positive, /object sits in the left half/);
  });
  it("--scene é obrigatória e curta", () => {
    assert.throws(() => parseCapaScene(undefined), /--scene/);
    assert.throws(() => parseCapaScene("  "), /--scene/);
    assert.throws(() => parseCapaScene("x".repeat(201)), /máximo/);
    assert.equal(parseCapaScene("  um   cadeado "), "um cadeado");
  });
});

describe("#13235 — CLI gen-youtube-thumb", () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts", "261117", ...args], { cwd: ROOT, encoding: "utf8" });

  it("--background-prompt-capa grava o prompt e imprime o comando do Codex", () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-13235-"));
    try {
      const r = run(["--background-prompt-capa", "--scene", "um cadeado aberto", "--layout", "right", "--edition-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout) as { side: string; prompt: string; command: string };
      assert.equal(out.side, "right");
      assert.equal(out.prompt, join(dir, THUMB_CAPA_BG_DIR, THUMB_CAPA_BG_PROMPT));
      assert.match(out.command, /^node scripts\/codex-image\.js /);
      const saved = JSON.parse(readFileSync(out.prompt, "utf8")) as { positive: string };
      assert.match(saved.positive, /um cadeado aberto/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--background-prompt-capa sem --scene falha", () => {
    const r = run(["--background-prompt-capa", "--edition-dir", tmpdir()]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--scene/);
  });

  it("--logo sem --hook-style grande e --hook-style inválido falham antes de compor", () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-13235-"));
    try {
      writeFileSync(join(dir, "p.png"), "");
      const a = run(["--hook", "IA ladra?", "--portrait", join(dir, "p.png"), "--logo", join(dir, "p.png"), "--edition-dir", dir]);
      assert.notEqual(a.status, 0);
      assert.match(a.stderr, /--logo só com --hook-style grande/);
      const b = run(["--hook", "IA ladra?", "--portrait", join(dir, "p.png"), "--hook-style", "anton", "--edition-dir", dir]);
      assert.notEqual(b.status, 0);
      assert.match(b.stderr, /serif \(default\) ou grande/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
