/**
 * #11672 — o revisor de crop sugeria "usar o 4:5 nativo" e não havia comando
 * que aplicasse. Na edição 261030 o 1:1 do D3 foi gerado à mão com um script
 * avulso de sharp, sobrescrito em `04-d3-1x1.jpg`, e o revisor não rodou de novo.
 *
 * Cobre:
 *   1. `derive-square-from-native.ts`: quadrado 800×800 a partir do nativo,
 *      registro da fonte, chave 1:1 removida do cache público (as outras ficam),
 *      pares do revisor só do dN:1x1, com o nativo como fonte;
 *   2. registro ignorado quando o 1:1 muda depois (volta ao 2:1);
 *   3. `run-image-crop-reviewer.ts --only`: descoberta filtrada e persist que
 *      troca só a entrada do alvo, sem recarimbar as demais.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

import { deriveSquareFromNative, parseDestaque, parsePosition } from "../scripts/derive-square-from-native.ts";
import {
  discoverCropPairs,
  mergeCropReviewResults,
  parseOnlyTargets,
  type CropReviewResult,
} from "../scripts/run-image-crop-reviewer.ts";
import { invalidatePublicImageKeys } from "../scripts/lib/public-images-invalidate.ts";
import { md5OfFile } from "../scripts/lib/shared/file-md5.ts";

async function jpeg(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .jpeg()
    .toBuffer();
}

async function makeEdition(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "derive-square-11672-"));
  writeFileSync(join(dir, "04-d3-2x1.jpg"), await jpeg(1600, 800, [200, 0, 0]));
  writeFileSync(join(dir, "04-d3-1x1.jpg"), await jpeg(800, 800, [200, 0, 0]));
  writeFileSync(join(dir, "04-d3-4x5-nativo.jpg"), await jpeg(1080, 1350, [0, 0, 200]));
  writeFileSync(join(dir, "04-d3-4x5.jpg"), await jpeg(1080, 1350, [0, 0, 180]));
  writeFileSync(join(dir, "04-d1-1x1.jpg"), await jpeg(800, 800, [0, 200, 0]));
  writeFileSync(
    join(dir, "06-public-images.json"),
    JSON.stringify({ images: { d3: { url: "u-1x1" }, d3_4x5: { url: "u-4x5" }, d3_2x1: { url: "u-2x1" }, d1: { url: "x" } } }),
  );
  return dir;
}

function runReviewer(dir: string, extra: string[]) {
  const script = join(import.meta.dirname, "..", "scripts", "run-image-crop-reviewer.ts");
  return spawnSync(process.execPath, ["--import", "tsx", script, "--edition-dir", dir, ...extra], { encoding: "utf8" });
}

describe("derive-square-from-native (#11672)", () => {
  it("gera o 1:1 a partir do nativo, registra a fonte e invalida só a chave 1:1", async () => {
    const dir = await makeEdition();
    try {
      const before = md5OfFile(join(dir, "04-d3-1x1.jpg"));
      // Antes: o revisor compararia o 1:1 com o 2:1.
      assert.equal(discoverCropPairs(dir).find((p) => p.destaque === "d3" && p.ratio === "1x1")?.hero_path, join(dir, "04-d3-2x1.jpg"));

      const r = await deriveSquareFromNative({ editionDir: dir, destaque: "d3" });

      const meta = await sharp(readFileSync(join(dir, "04-d3-1x1.jpg"))).metadata();
      assert.equal(meta.width, 800);
      assert.equal(meta.height, 800);
      assert.notEqual(md5OfFile(join(dir, "04-d3-1x1.jpg")), before);
      // Cor do nativo (azul), não do 2:1 (vermelho).
      const { data } = await sharp(readFileSync(join(dir, "04-d3-1x1.jpg"))).raw().toBuffer({ resolveWithObject: true });
      assert.ok(data[2]! > 150 && data[0]! < 50, `pixel ${data[0]},${data[1]},${data[2]} não veio do nativo`);

      assert.deepEqual(r.removed_public_keys, ["d3"]);
      const pub = JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8")).images;
      assert.equal(pub.d3, undefined);
      assert.equal(pub.d3_4x5.url, "u-4x5");
      assert.equal(pub.d3_2x1.url, "u-2x1");
      assert.equal(pub.d1.url, "x");

      assert.deepEqual(
        r.review.pairs.map((p) => [p.destaque, p.ratio, p.hero_path]),
        [["d3", "1x1", join(dir, "04-d3-4x5-nativo.jpg")]],
      );
      assert.match(r.review.persist_command, /--only d3:1x1 --input-json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registro deixa de valer quando o 1:1 é regerado depois", async () => {
    const dir = await makeEdition();
    try {
      await deriveSquareFromNative({ editionDir: dir, destaque: "d3" });
      writeFileSync(join(dir, "04-d3-1x1.jpg"), await jpeg(800, 800, [10, 10, 10]));
      assert.equal(discoverCropPairs(dir).find((p) => p.destaque === "d3" && p.ratio === "1x1")?.hero_path, join(dir, "04-d3-2x1.jpg"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava nada; nativo ausente lança", async () => {
    const dir = await makeEdition();
    try {
      const before = md5OfFile(join(dir, "04-d3-1x1.jpg"));
      const r = await deriveSquareFromNative({ editionDir: dir, destaque: "d3", dryRun: true });
      assert.equal(r.dry_run, true);
      assert.equal(md5OfFile(join(dir, "04-d3-1x1.jpg")), before);
      assert.equal(existsSync(join(dir, "_internal", "04-square-source.json")), false);
      await assert.rejects(deriveSquareFromNative({ editionDir: dir, destaque: "d1" }), /4x5-nativo\.jpg não existe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("valida --destaque e --position", () => {
    assert.equal(parseDestaque("D2"), "d2");
    assert.throws(() => parseDestaque("d4"));
    assert.equal(parsePosition(undefined), "centre");
    assert.equal(parsePosition("center"), "centre");
    assert.equal(parsePosition("top"), "top");
    assert.throws(() => parsePosition("left"));
  });

  it("invalidatePublicImageKeys não mexe em shape inesperado", () => {
    assert.equal(invalidatePublicImageKeys({ foo: 1 }, ["d1"]).changed, false);
    assert.equal(invalidatePublicImageKeys({ images: { d2: 1 } }, ["d1"]).changed, false);
  });
});

describe("run-image-crop-reviewer --only (#11672)", () => {
  const base: CropReviewResult = {
    edition: "261030",
    checked_at: "t0",
    results: [
      { destaque: "d1", ratio: "1x1", status: "warn", categoria: "crop", motivo: "velho d1", image_md5: "a".repeat(32) },
      { destaque: "d3", ratio: "1x1", status: "warn", categoria: "crop", motivo: "corta pessoas", image_md5: "b".repeat(32) },
      { destaque: "d3", ratio: "4x5", status: "ok", categoria: "crop", image_md5: "c".repeat(32) },
    ],
    summary: { total: 3, ok: 1, warn: 2 },
  };

  it("mergeCropReviewResults troca só os alvos e preserva o carimbo dos demais", () => {
    const incoming: CropReviewResult = {
      edition: "261030",
      checked_at: "t1",
      results: [
        { destaque: "d3", ratio: "1x1", status: "ok", categoria: "crop", image_md5: "d".repeat(32) },
        { destaque: "d1", ratio: "1x1", status: "ok", categoria: "crop" },
      ],
      summary: { total: 2, ok: 2, warn: 0 },
    };
    const merged = mergeCropReviewResults(base, incoming, parseOnlyTargets("d3:1x1"));
    assert.deepEqual(
      merged.results.map((r) => [r.destaque, r.ratio, r.status, r.image_md5?.[0]]),
      [
        ["d1", "1x1", "warn", "a"],
        ["d3", "4x5", "ok", "c"],
        ["d3", "1x1", "ok", "d"],
      ],
    );
    assert.deepEqual(merged.summary, { total: 3, ok: 2, warn: 1 });
    assert.deepEqual(mergeCropReviewResults(null, incoming, parseOnlyTargets("d3")).results.length, 1);
  });

  it("parseOnlyTargets rejeita alvo inválido", () => {
    assert.deepEqual(parseOnlyTargets("d3:1x1,d1"), [
      { destaque: "d3", ratio: "1x1" },
      { destaque: "d1", ratio: null },
    ]);
    assert.throws(() => parseOnlyTargets("d3:2x1"));
    assert.throws(() => parseOnlyTargets(" "));
  });

  it("CLI: descoberta filtrada e persist parcial mantêm o resto do veredito", async () => {
    const dir = await makeEdition();
    try {
      await deriveSquareFromNative({ editionDir: dir, destaque: "d3" });
      const disc = runReviewer(dir, ["--only", "d3:1x1"]);
      assert.equal(disc.status, 0, disc.stderr);
      const pairs = JSON.parse(disc.stdout).pairs as Array<{ destaque: string; ratio: string; hero_path: string }>;
      assert.deepEqual(pairs.map((p) => [p.destaque, p.ratio, p.hero_path]), [["d3", "1x1", join(dir, "04-d3-4x5-nativo.jpg")]]);

      const verdictPath = join(dir, "_internal", "04-crop-review.json");
      writeFileSync(verdictPath, JSON.stringify(base));
      const inputPath = join(dir, "in.json");
      writeFileSync(inputPath, JSON.stringify({ results: [{ destaque: "d3", ratio: "1x1", status: "ok" }] }));
      const persist = runReviewer(dir, ["--only", "d3:1x1", "--input-json", inputPath]);
      assert.equal(persist.status, 0, persist.stderr);
      const saved = JSON.parse(readFileSync(verdictPath, "utf8")) as CropReviewResult;
      const d3sq = saved.results.find((r) => r.destaque === "d3" && r.ratio === "1x1")!;
      assert.equal(d3sq.status, "ok");
      assert.equal(d3sq.image_md5, md5OfFile(join(dir, "04-d3-1x1.jpg")));
      // Entrada do d1 mantém o carimbo original (não foi re-revisada).
      assert.equal(saved.results.find((r) => r.destaque === "d1")!.image_md5, "a".repeat(32));
      assert.equal(saved.results.length, 3);

      // Veredito ilegível: persist parcial recusa em vez de apagar o resto.
      writeFileSync(verdictPath, "{nao json");
      const bad = runReviewer(dir, ["--only", "d3:1x1", "--input-json", inputPath]);
      assert.equal(bad.status, 1);
      assert.equal(readFileSync(verdictPath, "utf8"), "{nao json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
