/**
 * test/starry-night-regen-10312.test.ts (#10312)
 *
 * Regressão: na edição 261016 o `image-crop-reviewer` acusou Noite Estrelada
 * (redemoinho azul/amarelo na tela do celular do D2), mas o achado era só
 * `image-crop-warn` (warning) e a imagem chegou ao gate pronta pra publicar.
 *
 * Cobre as três pontas do fix:
 *   1. Stage 4: achado `categoria: "estilo"` ATUAL vira ERRO
 *      (`image-starry-night-detected`), não warning.
 *   2. Stage 3: `--estilo-regen-plan` decide quais destaques regenerar, com
 *      teto de tentativas persistido (o loop termina sozinho).
 *   3. Prompt de geração: o sufixo fixo não convida mais ao motivo
 *      ("swirling textures" saiu) e reforça superfícies lisas em fraseado
 *      afirmativo, sem nomear a obra nem o motivo (#4201).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  normalizeCropReviewResult,
  stampCropReviewImageHashes,
  planEstiloRegeneration,
  estiloRegenCommands,
  formatGateSummary,
  MAX_ESTILO_AUTO_REGEN,
} from "../scripts/run-image-crop-reviewer.ts";
import {
  checkCropReviewWarnings,
  checkStarryNightDetected,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { STYLE_SUFFIX } from "../scripts/image-generate.ts";
import { findForbiddenPhrases } from "../scripts/lib/lint-image-prompt.ts";

let dir: string;

const RAW_261016 = {
  results: [
    { destaque: "d1", ratio: "1x1", status: "ok" },
    { destaque: "d2", ratio: "1x1", status: "warn", categoria: "estilo", motivo: "redemoinho concêntrico azul/amarelo na tela do celular" },
    { destaque: "d2", ratio: "4x5", status: "warn", categoria: "estilo", motivo: "redemoinho concêntrico azul/amarelo na tela do celular" },
    { destaque: "d3", ratio: "1x1", status: "warn", motivo: "sujeito cortado à direita" },
  ],
};

function persist(raw: unknown): void {
  const result = stampCropReviewImageHashes(normalizeCropReviewResult(raw, "261016"), dir);
  writeFileSync(join(dir, "_internal", "04-crop-review.json"), JSON.stringify(result, null, 2));
}

function runPlan() {
  const projectRoot = join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(projectRoot, "scripts", "run-image-crop-reviewer.ts"), "--edition-dir", dir, "--estilo-regen-plan"],
    { cwd: projectRoot, encoding: "utf8" },
  );
}

describe("Noite Estrelada no veredito do revisor (#10312)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starry-10312-"));
    mkdirSync(join(dir, "_internal"));
    for (const f of ["04-d1-1x1.jpg", "04-d2-1x1.jpg", "04-d2-4x5.jpg", "04-d3-1x1.jpg"]) {
      writeFileSync(join(dir, f), `img-${f}-v1`);
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("Stage 4: vira erro, não warning", () => {
    it("achado de estilo atual → 1 erro image-starry-night-detected por destaque", () => {
      persist(RAW_261016);
      const v = checkStarryNightDetected(dir);
      assert.equal(v.length, 1, JSON.stringify(v));
      assert.equal(v[0].rule, "image-starry-night-detected");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /D2 \(1x1, 4x5\)/);
      assert.match(v[0].message, /tela do celular/);
      assert.match(v[0].message, /--estilo-regen-plan/);
    });

    it("image-crop-warn deixa de carregar o achado de estilo atual (sem duplicar como warning)", () => {
      persist(RAW_261016);
      const v = checkCropReviewWarnings(dir);
      assert.equal(v.length, 1, JSON.stringify(v));
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /sujeito cortado/);
      assert.doesNotMatch(v.map((x) => x.message).join("\n"), /tela do celular/);
    });

    it("imagem regerada depois da revisão → sem erro, achado vira nota de desatualizado (#9598)", () => {
      persist(RAW_261016);
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "img-d2-1x1-v2");
      writeFileSync(join(dir, "04-d2-4x5.jpg"), "img-d2-4x5-v2");
      assert.deepEqual(checkStarryNightDetected(dir), []);
      const stale = checkCropReviewWarnings(dir).filter((x) => x.source_issue === "#9598");
      assert.equal(stale.length, 2);
    });

    it("falso positivo marcado ok pelo editor → sem erro", () => {
      persist({ results: [{ destaque: "d2", ratio: "1x1", status: "ok", categoria: "estilo" }] });
      assert.deepEqual(checkStarryNightDetected(dir), []);
    });

    it("registrada no Stage 4 com id próprio", () => {
      const rule = getRulesForStage(4).find((r) => r.id === "image-starry-night-detected");
      assert.ok(rule, "image-starry-night-detected deve estar registrada no Stage 4");
      assert.equal(rule.source_issue, "#10312");
    });
  });

  describe("Stage 3: plano de regeneração automática", () => {
    it("1ª passada regenera o destaque acusado; esgotado o teto, vai pra exhausted", () => {
      persist(RAW_261016);
      const result = normalizeCropReviewResult(
        JSON.parse(readFileSync(join(dir, "_internal", "04-crop-review.json"), "utf8")),
        "261016",
      );
      const p1 = planEstiloRegeneration(result, {});
      assert.deepEqual(p1.regenerate, ["d2"]);
      assert.deepEqual(p1.exhausted, []);
      assert.equal(p1.attempts.d2, 1);
      const p2 = planEstiloRegeneration(result, p1.attempts);
      assert.deepEqual(p2.regenerate, []);
      assert.deepEqual(p2.exhausted, ["d2"]);
      assert.equal(MAX_ESTILO_AUTO_REGEN, 1);
    });

    it("entrada desatualizada não dispara regeneração", () => {
      persist(RAW_261016);
      const result = normalizeCropReviewResult(
        JSON.parse(readFileSync(join(dir, "_internal", "04-crop-review.json"), "utf8")),
        "261016",
      );
      const p = planEstiloRegeneration(result, {}, () => true);
      assert.deepEqual(p.regenerate, []);
      assert.deepEqual(p.exhausted, []);
    });

    it("comandos regeneram 2:1, 4:5 nativo e recompõem o card, nessa ordem, com --force", () => {
      const cmds = estiloRegenCommands("data/editions/2610/261016/", "d2");
      assert.equal(cmds.length, 3);
      assert.match(cmds[0], /image-generate\.ts .*02-d2-prompt\.md .*--destaque d2 --force$/);
      assert.doesNotMatch(cmds[0], /--ratio/);
      assert.match(cmds[1], /--ratio 4x5 --force$/);
      assert.match(cmds[2], /gen-social-card-4x5\.ts --edition-dir data\/editions\/2610\/261016\/ --destaque d2$/);
    });

    it("CLI --estilo-regen-plan consome a tentativa no ato e termina o loop na 2ª chamada", () => {
      persist(RAW_261016);
      const r1 = runPlan();
      assert.equal(r1.status, 0, r1.stderr);
      const out1 = JSON.parse(r1.stdout);
      assert.deepEqual(out1.regenerate, ["d2"]);
      assert.equal(out1.commands.d2.length, 3);
      assert.ok(existsSync(join(dir, "_internal", "04-estilo-regen.json")));

      const r2 = runPlan();
      assert.equal(r2.status, 0, r2.stderr);
      const out2 = JSON.parse(r2.stdout);
      assert.deepEqual(out2.regenerate, []);
      assert.deepEqual(out2.exhausted, ["d2"]);
    });

    it("CLI --estilo-regen-plan sem veredito persistido → exit 1", () => {
      const r = runPlan();
      assert.equal(r.status, 1);
    });

    it("resumo do gate anuncia que Noite Estrelada não é mais decisão do editor", () => {
      const s = formatGateSummary(normalizeCropReviewResult(RAW_261016, "261016"));
      assert.match(s, /regenera o destaque sozinho/);
      assert.match(s, /image-starry-night-detected/);
    });
  });
});

describe("STYLE_SUFFIX não convida ao motivo de Noite Estrelada (#10312)", () => {
  it("sem 'swirling'/'swirl'/'vortex'/'whirl'/'spiral' no sufixo fixo", () => {
    assert.doesNotMatch(STYLE_SUFFIX, /swirl|vortex|whirl|spiral/i);
  });

  it("reforça superfícies lisas (telas inclusive) em fraseado afirmativo", () => {
    assert.match(STYLE_SUFFIX, /Screens, displays, skies/);
    assert.match(STYLE_SUFFIX, /calm, even fields of color/);
    assert.match(STYLE_SUFFIX, /straight, parallel brushstrokes/);
  });

  it("não nomeia a obra nem dispara o lint de prompt (#4201)", () => {
    assert.deepEqual(findForbiddenPhrases(STYLE_SUFFIX), []);
    assert.doesNotMatch(STYLE_SUFFIX, /starry|estrelada/i);
  });
});
