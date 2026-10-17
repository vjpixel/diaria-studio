/**
 * test/starry-night-pending-swap-10335-10333.test.ts (#10335, #10333)
 *
 *   #10335 — ao resolver um `pending`, o plano de regeneração registrava o md5
 *            ATUAL dos dois ratios em `images` mesmo com o gerador fora. Um
 *            ratio trocado por outra pessoa nesse intervalo (ex.: arte 4:5
 *            nativa nova) virava "conhecido" e herdava a contagem de falhas —
 *            ia a `exhausted` sem nunca ter sido regenerado.
 *   #10333 — a entrada de estilo carimbada em `master`/`2x1` não ficava
 *            desatualizada quando nascia a arte `4x5-nativo` (o card passa a
 *            usá-la, mas o arquivo carimbado não muda). Com falso positivo
 *            marcado sobre o md5 antigo, a arte nova passava pelo gate sem
 *            revisão.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  normalizeCropReviewResult,
  stampCropReviewImageHashes,
  planEstiloRegeneration,
  MAX_ESTILO_REGEN_FAILED_RUNS,
} from "../scripts/run-image-crop-reviewer.ts";
import { isCropReviewEntryStale, checkStarryNightDetected, checkCropReviewWarnings } from "../scripts/lib/invariant-checks/stage-4.ts";

const ROOT = join(import.meta.dirname, "..");

const estilo = (ratio: "1x1" | "4x5") =>
  normalizeCropReviewResult(
    { results: [{ destaque: "d1", ratio, status: "warn", categoria: "estilo", motivo: "espiral" }] },
    "261017",
  );

describe("#10335: troca de imagem com pending vivo não herda a contagem", () => {
  it("cenário da issue: gerador falha 2x e o editor troca só a arte 4:5 → imagem nova ganha chance", () => {
    const md5: Record<string, string> = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v1" };
    const cur = (_d: string, r: string) => md5[r] ?? null;
    // Stage 3 acusa o 1x1; o gerador falha duas vezes (2:1 intacto)
    const p1 = planEstiloRegeneration(estilo("1x1"), {}, () => false, cur);
    assert.deepEqual(p1.regenerate, ["d1"]);
    const p2 = planEstiloRegeneration(estilo("1x1"), p1.state, () => false, cur);
    assert.deepEqual(p2.regenerate, ["d1"], "1ª falha do gerador ganha nova chance");
    assert.equal(p2.state.failed?.d1, 1);
    // pending sobrevive; o editor troca só a arte 4:5 nativa (2:1 e 1:1 iguais)
    md5["4x5"] = "nativo-do-editor";
    const p3 = planEstiloRegeneration(estilo("4x5"), p2.state, () => false, cur);
    assert.ok(
      !(p3.state.images?.d1 ?? []).includes("nativo-do-editor"),
      "arquivo trocado com o gerador fora não é imagem da regeneração",
    );
    assert.deepEqual(p3.regenerate, ["d1"], "arte nunca regenerada não pode sair como 'esgotou'");
    assert.deepEqual(p3.exhausted, []);
  });

  it("proposta grava o md5 de TODOS os ratios, não só do acusado", () => {
    const md5: Record<string, string> = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v1" };
    const p = planEstiloRegeneration(estilo("4x5"), {}, () => false, (_d, r) => md5[r] ?? null);
    assert.deepEqual(p.state.pending?.d1, { "4x5": "nativo-v1" });
    assert.deepEqual(p.state.pendingAll?.d1, { "1x1": "1x1-v1", "4x5": "nativo-v1" });
  });

  it("#10332 preservado: regeneração reescreve tudo → revisor alterna o ratio → esgotado", () => {
    const md5: Record<string, string> = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v1" };
    const cur = (_d: string, r: string) => md5[r] ?? null;
    const p1 = planEstiloRegeneration(estilo("4x5"), {}, () => false, cur);
    md5["2x1"] = "2x1-v2";
    md5["1x1"] = "1x1-v2";
    md5["4x5"] = "nativo-v2";
    const p2 = planEstiloRegeneration(estilo("1x1"), p1.state, () => false, cur);
    assert.deepEqual(p2.regenerate, []);
    assert.deepEqual(p2.exhausted, ["d1"]);
    assert.equal(p2.attempts.d1, 1);
  });

  it("#10332 preservado (failed): gerador fora e o ratio alterna sem troca → esgota no teto", () => {
    const md5: Record<string, string> = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v1" };
    const cur = (_d: string, r: string) => md5[r] ?? null;
    let state = planEstiloRegeneration(estilo("4x5"), {}, () => false, cur).state;
    let last;
    for (const r of ["1x1", "4x5", "1x1"] as const) {
      last = planEstiloRegeneration(estilo(r), state, () => false, cur);
      state = last.state;
    }
    assert.equal(last!.state.failed?.d1, MAX_ESTILO_REGEN_FAILED_RUNS + 1);
    assert.deepEqual(last!.exhausted, ["d1"]);
  });

  it("#10342 preservado: 4:5 nativo apagado pelo --force resolve pro 2:1 da proposta (conhecido)", () => {
    const md5: Record<string, string> = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v1" };
    const cur = (_d: string, r: string) => md5[r] ?? null;
    const p1 = planEstiloRegeneration(estilo("4x5"), {}, () => false, cur);
    md5["4x5"] = "2x1-v1"; // variante resolvida passou de nativo para o mesmo 2:1
    const p2 = planEstiloRegeneration(estilo("4x5"), p1.state, () => false, cur);
    assert.equal(p2.state.failed?.d1, 1, "falha do gerador, sem reset da contagem");
    const p3 = planEstiloRegeneration(estilo("4x5"), p2.state, () => false, cur);
    assert.deepEqual(p3.exhausted, ["d1"], "o teto de falhas vale para o 2:1 antigo");
  });
});

describe("#10333: entrada carimbada em master/2x1 fica desatualizada quando nasce o 4x5 nativo", () => {
  let dir: string;
  const img = (name: string, content: string) => writeFileSync(join(dir, name), content);
  const persist = (raw: unknown) => {
    const result = stampCropReviewImageHashes(normalizeCropReviewResult(raw, "261017"), dir);
    writeFileSync(join(dir, "_internal", "04-crop-review.json"), JSON.stringify(result, null, 2));
  };
  const review = () =>
    JSON.parse(readFileSync(join(dir, "_internal", "04-crop-review.json"), "utf8")) as {
      results: Array<{ destaque: string; ratio: string; image_md5?: string; image_variant?: string }>;
    };
  const ESTILO_D1_4X5 = {
    results: [{ destaque: "d1", ratio: "4x5", status: "warn", categoria: "estilo", motivo: "espiral" }],
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starry-10333-"));
    mkdirSync(join(dir, "_internal"));
    img("04-d1-2x1.jpg", "d1-2x1-v1");
    img("04-d1-1x1.jpg", "d1-1x1-v1");
    img("04-d1-master.jpg", "d1-master-v1");
    img("04-d1-4x5.jpg", "d1-card-v1");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("cenário da issue: carimbada em master, nasce o nativo (master intacto) → desatualizada", () => {
    persist(ESTILO_D1_4X5);
    const entry = review().results[0];
    assert.equal(entry.image_variant, "master");
    assert.equal(isCropReviewEntryStale(dir, entry), false);
    img("04-d1-4x5-nativo.jpg", "d1-nativo-novo"); // image-generate --ratio 4x5 --force
    assert.equal(isCropReviewEntryStale(dir, entry), true);
  });

  it("carimbada em 2x1, nasce o master → desatualizada", () => {
    rmSync(join(dir, "04-d1-master.jpg"));
    persist(ESTILO_D1_4X5);
    const entry = review().results[0];
    assert.equal(entry.image_variant, "2x1");
    assert.equal(isCropReviewEntryStale(dir, entry), false);
    img("04-d1-master.jpg", "d1-master-novo");
    assert.equal(isCropReviewEntryStale(dir, entry), true);
  });

  it("falso positivo marcado sobre o master não cobre a arte nativa nova (gate volta a exigir revisão)", () => {
    persist(ESTILO_D1_4X5);
    const fp = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(ROOT, "scripts", "run-image-crop-reviewer.ts"),
        "--edition-dir",
        dir,
        "--mark-false-positive",
        "d1",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(fp.status, 0, fp.stderr);
    assert.deepEqual(checkStarryNightDetected(dir), [], "falso positivo silencia a arte revisada");
    assert.deepEqual(checkCropReviewWarnings(dir), [], "nem warning sobre a arte marcada");
    img("04-d1-4x5-nativo.jpg", "d1-nativo-novo");
    const entry = review().results[0];
    assert.equal(isCropReviewEntryStale(dir, entry), true, "entrada não fala mais da arte atual");
    const warns = checkCropReviewWarnings(dir);
    assert.equal(warns.length, 1, "arte nativa nova nunca revisada não passa em silêncio");
    assert.equal(warns[0].source_issue, "#9598", "nota de desatualizado: re-rodar o revisor");
  });

  it("entrada sem variante (crop/1x1) segue o comportamento por md5 do #9598", () => {
    const entry = { destaque: "d1", ratio: "1x1", image_md5: "0".repeat(32) };
    assert.equal(isCropReviewEntryStale(dir, entry), true);
  });
});
