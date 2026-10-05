/**
 * test/crop-review-stale-9598.test.ts (#9598)
 *
 * Regressão: depois de regerar/trocar a imagem de um destaque, o gate do
 * Stage 4 continuava citando avisos `image-crop-warn` da imagem ANTIGA
 * (edição 261005: urna/celulares, céu estilo Noite Estrelada, maestro). O
 * persist do revisor agora carimba o md5 da imagem revisada em cada entrada
 * e o invariante descarta a entrada cujo md5 não bate mais.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeCropReviewResult,
  stampCropReviewImageHashes,
} from "../scripts/run-image-crop-reviewer.ts";
import {
  checkCropReviewWarnings,
  isCropReviewEntryStale,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { reorderCropReviewJson } from "../scripts/reorder-destaques.ts";

let dir: string;

function writeReview(data: unknown): void {
  writeFileSync(join(dir, "_internal", "04-crop-review.json"), JSON.stringify(data, null, 2));
}

function persist(raw: unknown): void {
  writeReview(stampCropReviewImageHashes(normalizeCropReviewResult(raw, "261005"), dir));
}

const RAW = {
  results: [
    { destaque: "d1", ratio: "1x1", status: "warn", motivo: "maestro cortado" },
    { destaque: "d3", ratio: "1x1", status: "warn", motivo: "urna fora do quadro" },
    { destaque: "d3", ratio: "4x5", status: "warn", categoria: "estilo", motivo: "céu Noite Estrelada" },
  ],
};

describe("crop review desatualizado após regeração/troca de imagem (#9598)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crop-stale-9598-"));
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, "04-d1-1x1.jpg"), "img-d1-1x1-v1");
    writeFileSync(join(dir, "04-d3-1x1.jpg"), "img-d3-1x1-v1");
    writeFileSync(join(dir, "04-d3-4x5.jpg"), "img-d3-4x5-v1");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persist carimba image_md5 em cada entrada cuja imagem existe", () => {
    const r = stampCropReviewImageHashes(normalizeCropReviewResult(RAW, "261005"), dir);
    for (const e of r.results) assert.match(e.image_md5 ?? "", /^[0-9a-f]{32}$/);
  });

  it("imagens inalteradas → os 3 avisos originais aparecem", () => {
    persist(RAW);
    const v = checkCropReviewWarnings(dir);
    assert.equal(v.length, 3);
    assert.ok(v.every((x) => x.source_issue === "#3951"));
  });

  it("D3 regerado → avisos do D3 antigo somem, viram nota de desatualizado; D1 segue", () => {
    persist(RAW);
    writeFileSync(join(dir, "04-d3-1x1.jpg"), "img-d3-1x1-KOLIBRI");
    writeFileSync(join(dir, "04-d3-4x5.jpg"), "img-d3-4x5-KOLIBRI");
    const v = checkCropReviewWarnings(dir);
    const msgs = v.map((x) => x.message).join("\n");
    assert.doesNotMatch(msgs, /urna|Noite Estrelada/);
    assert.match(msgs, /maestro cortado/);
    const stale = v.filter((x) => x.source_issue === "#9598");
    assert.equal(stale.length, 2, msgs);
    assert.ok(stale.every((x) => x.rule === "image-crop-warn" && x.severity === "warning"));
    assert.match(stale.map((x) => x.message).join("\n"), /D3 \(1x1\)[\s\S]*D3 \(4x5\)/);
  });

  it("imagem removida depois da revisão → entrada tratada como desatualizada", () => {
    persist(RAW);
    rmSync(join(dir, "04-d1-1x1.jpg"));
    assert.equal(
      isCropReviewEntryStale(dir, { destaque: "d1", ratio: "1x1", image_md5: "0".repeat(32) }),
      true,
    );
  });

  it("reorder D1↔D3 (imagens e entradas remapeadas juntas) NÃO invalida os avisos", () => {
    persist(RAW);
    // Simula o reorder-destaques: conteúdo das imagens troca de slot…
    renameSync(join(dir, "04-d1-1x1.jpg"), join(dir, "tmp.jpg"));
    renameSync(join(dir, "04-d3-1x1.jpg"), join(dir, "04-d1-1x1.jpg"));
    renameSync(join(dir, "tmp.jpg"), join(dir, "04-d3-1x1.jpg"));
    renameSync(join(dir, "04-d3-4x5.jpg"), join(dir, "04-d1-4x5.jpg"));
    // …e as entradas do JSON são remapeadas pelo mesmo newOrder.
    const cur = JSON.parse(readFileSync(join(dir, "_internal", "04-crop-review.json"), "utf8"));
    const { data } = reorderCropReviewJson(cur, [3, 2, 1]);
    writeReview(data);
    const v = checkCropReviewWarnings(dir);
    assert.equal(v.length, 3);
    assert.ok(v.every((x) => x.source_issue === "#3951"), JSON.stringify(v));
  });

  it("entrada legada sem image_md5 segue o comportamento antigo (aviso exibido)", () => {
    writeReview({ results: [{ destaque: "d1", ratio: "1x1", status: "warn", motivo: "legado" }] });
    writeFileSync(join(dir, "04-d1-1x1.jpg"), "outra-imagem");
    const v = checkCropReviewWarnings(dir);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /legado/);
  });
});
