/**
 * test/stage4-lock-order-regen-plan-10354-10346.test.ts
 *
 *   #10354 — o playbook do Stage 4 mandava carimbar `update-stage-status.ts
 *            --status running` (escrita na edição) ANTES do `edition-lock.ts
 *            acquire`, contradizendo o "antes de qualquer escrita".
 *   #10346 — depois de um swap no Stage 4, a imagem nova acusada de Noite
 *            Estrelada tinha a contagem zerada (#10327), mas o playbook nunca
 *            rodava `--estilo-regen-plan` e o invariante dizia "esgotou" só
 *            porque `_internal/04-estilo-regen.json` existia.
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
  planEstiloRegenerationForEdition,
} from "../scripts/run-image-crop-reviewer.ts";
import { checkStarryNightDetected } from "../scripts/lib/invariant-checks/stage-4.ts";

const ROOT = join(import.meta.dirname, "..");
const STAGE4 = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-4.md"), "utf8");

describe("#10354: trava da edição antes da 1ª escrita do Stage 4", () => {
  it("acquire aparece antes do update-stage-status --status running", () => {
    const acquire = STAGE4.indexOf("npx tsx scripts/edition-lock.ts acquire --edition-dir {EDITION_DIR} --stage 4");
    const running = STAGE4.indexOf("npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 4 --status running");
    assert.ok(acquire > 0, "acquire presente");
    assert.ok(running > 0, "carimbo running presente");
    assert.ok(acquire < running, "acquire tem de vir antes do carimbo running (escrita na edição)");
  });
});

let dir: string;

function persist(raw: unknown): void {
  const result = stampCropReviewImageHashes(normalizeCropReviewResult(raw, "261016"), dir);
  writeFileSync(join(dir, "_internal", "04-crop-review.json"), JSON.stringify(result, null, 2));
}

function plan() {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, "scripts", "run-image-crop-reviewer.ts"), "--edition-dir", dir, "--estilo-regen-plan"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { regenerate: string[]; exhausted: string[] };
}

function img(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

const ESTILO_D2 = {
  results: [
    { destaque: "d1", ratio: "4x5", status: "ok" },
    { destaque: "d2", ratio: "4x5", status: "warn", categoria: "estilo", motivo: "redemoinho na tela do celular" },
  ],
};

describe("#10346: invariante distingue 'esgotou' de 'plano não rodou para a imagem atual'", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regen-10346-"));
    mkdirSync(join(dir, "_internal"));
    for (const d of ["d1", "d2", "d3"]) {
      img(`04-${d}-1x1.jpg`, `${d}-1x1-v1`);
      img(`04-${d}-4x5-nativo.jpg`, `${d}-nativo-v1`);
      img(`04-${d}-4x5.jpg`, `${d}-card-v1`);
    }
    // Stage 3: plano propõe, regenera, revisor re-acusa → esgotado.
    persist(ESTILO_D2);
    assert.deepEqual(plan().regenerate, ["d2"]);
    img("04-d2-4x5-nativo.jpg", "d2-nativo-v2");
    img("04-d2-4x5.jpg", "d2-card-v2");
    persist(ESTILO_D2);
    assert.deepEqual(plan().exhausted, ["d2"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("esgotado de fato → mensagem diz 'esgotou' e não sugere o plano", () => {
    const [v] = checkStarryNightDetected(dir);
    assert.match(v.message, /esgotou/);
    assert.doesNotMatch(v.message, /--estilo-regen-plan/);
  });

  it("cenário da issue: swap do D2 no Stage 4, imagem nova acusada → sugere o plano, sem causa falsa", () => {
    img("04-d2-4x5-nativo.jpg", "item-promovido-nativo");
    img("04-d2-4x5.jpg", "item-promovido-card");
    persist(ESTILO_D2);
    const [v] = checkStarryNightDetected(dir);
    assert.equal(v.rule, "image-starry-night-detected");
    assert.doesNotMatch(v.message, /esgotou/, "imagem nunca regenerada não pode sair como 'esgotou'");
    assert.match(v.message, /imagem ATUAL/);
    assert.match(v.message, /--estilo-regen-plan/);
    // e o plano de fato concorda
    assert.deepEqual(planEstiloRegenerationForEdition(dir)?.regenerate, ["d2"]);
  });

  it("o invariante não grava o estado do plano (só lê)", () => {
    const before = readFileSync(join(dir, "_internal", "04-estilo-regen.json"), "utf8");
    img("04-d2-4x5-nativo.jpg", "item-promovido-nativo");
    persist(ESTILO_D2);
    checkStarryNightDetected(dir);
    assert.equal(readFileSync(join(dir, "_internal", "04-estilo-regen.json"), "utf8"), before);
  });

  it("04-estilo-regen.json corrompido → sugere o plano (não afirma 'esgotou')", () => {
    // o plano trata JSON quebrado como estado vazio → regenerate
    writeFileSync(join(dir, "_internal", "04-estilo-regen.json"), "{ quebrado");
    const [v] = checkStarryNightDetected(dir);
    assert.match(v.message, /--estilo-regen-plan/);
    assert.doesNotMatch(v.message, /esgotou/);
  });
});

describe("#10346: playbook do Stage 4 roda o plano depois de re-revisar a imagem trocada", () => {
  it("§4d.1a: persist do revisor seguido de --estilo-regen-plan", () => {
    assert.match(
      STAGE4,
      /nunca passar só os pares do D\{N\}\. \*\*Depois do persist, rodar o plano de regeneração[\s\S]{0,200}--estilo-regen-plan/,
    );
  });

  it("--no-gates: roda o loop do plano antes do halt quando a mensagem o sugere", () => {
    assert.match(STAGE4, /Antes do halt \(#10346\)[\s\S]{0,300}--estilo-regen-plan/);
  });
});
