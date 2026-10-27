/**
 * #11378 — o bruto vem espelhado (`source.json` da montagem: `mirrored: true`)
 * e o `--frames-from-drive` extraía os frames sem desespelhar: o retrato da
 * capa saía com rosto e microfone do lado errado (261028, corrigido à mão com
 * `ffmpeg -vf hflip`). Agora `--frames-from-drive` e `--pick-frame` aplicam o
 * `mirrored` em vigor, com a precedência da `/diaria-video-montagem`.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  THUMB_FRAMES_DIR,
  THUMB_FRAMES_META,
  THUMB_FRAME_PICKED,
  pickFrameNeedsFlop,
  planDriveFrameArgs,
  resolveThumbMirrored,
  thumbFrameFileName,
} from "../scripts/lib/diaria/youtube-thumb-frames.ts";
import { effectiveSource } from "../scripts/lib/diaria/video-montage.ts";

const CLI = fileURLToPath(new URL("../scripts/gen-youtube-thumb.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("planDriveFrameArgs: hflip conforme o mirrored (#11378)", () => {
  const base = { fileId: "abc", accessToken: "T", atSeconds: 10, out: "/o/frame-1.png" };

  it("mirrored: true → -vf hflip, saída continua no fim", () => {
    const args = planDriveFrameArgs({ ...base, mirrored: true });
    const vf = args.indexOf("-vf");
    assert.ok(vf > args.indexOf("-i"), "filtro é de saída, depois do -i");
    assert.equal(args[vf + 1], "hflip");
    assert.equal(args.at(-1), "/o/frame-1.png");
  });

  it("mirrored: false ou ausente → sem filtro", () => {
    assert.ok(!planDriveFrameArgs({ ...base, mirrored: false }).includes("-vf"));
    assert.ok(!planDriveFrameArgs(base).includes("-vf"));
  });
});

describe("resolveThumbMirrored: mesma precedência da montagem (#11378)", () => {
  it("flag > blocks.json > source.json > default true", () => {
    assert.deepEqual(resolveThumbMirrored({ flag: false, blocks: { mirrored: true }, source: { mirrored: true } }), { mirrored: false, from: "flag" });
    assert.deepEqual(resolveThumbMirrored({ blocks: { mirrored: false }, source: { mirrored: true } }), { mirrored: false, from: "blocks.json" });
    assert.deepEqual(resolveThumbMirrored({ blocks: { source: { mirrored: false } }, source: { mirrored: true } }), { mirrored: false, from: "blocks.json" });
    assert.deepEqual(resolveThumbMirrored({ blocks: { blocks: [] }, source: { mirrored: false } }), { mirrored: false, from: "source.json" });
    assert.deepEqual(resolveThumbMirrored({}), { mirrored: true, from: "default" });
    assert.deepEqual(resolveThumbMirrored({ source: { mirrored: "sim" } }), { mirrored: true, from: "default" });
  });

  it("concorda com effectiveSource da montagem nos mesmos insumos", () => {
    const measured = { path: "/b.mp4", fps: 30, durationS: 60, width: 3840, height: 2160, mirrored: true };
    const cases: { blocks?: { mirrored?: boolean; source?: { mirrored?: boolean } }; sourceMirrored: boolean }[] = [
      { sourceMirrored: true },
      { sourceMirrored: false },
      { blocks: { mirrored: false }, sourceMirrored: true },
      { blocks: { mirrored: true }, sourceMirrored: false },
      { blocks: { source: { mirrored: false } }, sourceMirrored: true },
    ];
    for (const c of cases) {
      const montage = effectiveSource({ ...measured, mirrored: c.sourceMirrored }, c.blocks).source.mirrored;
      const thumb = resolveThumbMirrored({ blocks: c.blocks, source: { mirrored: c.sourceMirrored } }).mirrored;
      assert.equal(thumb, montage, JSON.stringify(c));
    }
  });
});

describe("pickFrameNeedsFlop (#11378)", () => {
  it("espelha só quando o aplicado na extração difere do em vigor", () => {
    assert.equal(pickFrameNeedsFlop(true, { mirrored_applied: true }), false, "já desespelhado na extração");
    assert.equal(pickFrameNeedsFlop(true, null), true, "frames antigos, sem frames.json");
    assert.equal(pickFrameNeedsFlop(false, null), false);
    assert.equal(pickFrameNeedsFlop(false, { mirrored_applied: true }), true, "--no-mirrored desfaz o hflip da extração");
  });
});

/** PNG 4x1: só o pixel da ESQUERDA é vermelho — o espelho o leva para a direita. */
async function asymmetricPng(): Promise<Buffer> {
  const raw = Buffer.alloc(4 * 1 * 3);
  raw[0] = 255;
  return sharp(raw, { raw: { width: 4, height: 1, channels: 3 } }).png().toBuffer();
}

async function redAt(png: Buffer): Promise<number> {
  const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let x = 0; x < 4; x++) if (data[x * 3] === 255) return x;
  return -1;
}

async function editionWithFrame(opts: { sourceMirrored?: boolean; framesMeta?: object }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "thumb-11378-"));
  roots.push(dir);
  const framesDir = join(dir, THUMB_FRAMES_DIR);
  mkdirSync(framesDir, { recursive: true });
  writeFileSync(join(framesDir, thumbFrameFileName(1)), await asymmetricPng());
  if (opts.framesMeta) writeFileSync(join(framesDir, THUMB_FRAMES_META), JSON.stringify(opts.framesMeta));
  if (opts.sourceMirrored !== undefined) {
    const state = join(dir, "_internal", "video-montagem");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "source.json"), JSON.stringify({ path: "/b.mp4", fps: 30, durationS: 60, mirrored: opts.sourceMirrored }));
  }
  return dir;
}

function pick(dir: string, extra: string[] = []) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, "261028", "--pick-frame", "1", "--edition-dir", dir, ...extra], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("CLI --pick-frame aplica o mirrored em vigor (#11378)", () => {
  it("frame antigo (sem frames.json) + source.json mirrored → escolhido.png desespelhado", async () => {
    const dir = await editionWithFrame({ sourceMirrored: true });
    const r = pick(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await redAt(readFileSync(join(dir, THUMB_FRAMES_DIR, THUMB_FRAME_PICKED))), 3);
  });

  it("frame já desespelhado na extração → cópia, sem 2º espelho", async () => {
    const dir = await editionWithFrame({ sourceMirrored: true, framesMeta: { mirrored_applied: true, mirrored_from: "source.json" } });
    const r = pick(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await redAt(readFileSync(join(dir, THUMB_FRAMES_DIR, THUMB_FRAME_PICKED))), 0);
  });

  it("--no-mirrored sobrepõe o source.json", async () => {
    const dir = await editionWithFrame({ sourceMirrored: true });
    const r = pick(dir, ["--no-mirrored"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await redAt(readFileSync(join(dir, THUMB_FRAMES_DIR, THUMB_FRAME_PICKED))), 0);
  });

  it("sem estado da montagem vale o default dela (espelhado)", async () => {
    const dir = await editionWithFrame({});
    const r = pick(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await redAt(readFileSync(join(dir, THUMB_FRAMES_DIR, THUMB_FRAME_PICKED))), 3);
  });

  it("--mirrored e --no-mirrored juntos é erro", async () => {
    const dir = await editionWithFrame({});
    const r = pick(dir, ["--mirrored", "--no-mirrored"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--mirrored e --no-mirrored juntos/);
  });
});
