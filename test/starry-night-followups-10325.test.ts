/**
 * test/starry-night-followups-10325.test.ts (#10325, #10326, #10327, #10328)
 *
 * Follow-ups do review consolidado da rodada overnight 261015c sobre o
 * #10312 (Noite Estrelada vira erro no gate) e o #10309 (trava de edição):
 *
 *   #10325 — o achado de estilo no 4:5 carimbava o md5 do CARD com título;
 *            recompor o card (título novo, mesma arte) fazia o erro sumir.
 *   #10327 — `attempts` da regeneração automática ficava preso à POSIÇÃO:
 *            depois de um swap, a imagem nova "esgotava" sem tentativa.
 *   #10328 — falso positivo marcado `status: "ok"` no veredito se perdia no
 *            próximo persist completo do revisor.
 *   #10326 — a trava de edição só era liberada no §4e; `editar`/`abortar`/
 *            halts a deixavam presa por 45 min.
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
  MAX_ESTILO_REGEN_FAILED_RUNS,
  parseFalsePositiveTargets,
  selectFalsePositiveMarks,
} from "../scripts/run-image-crop-reviewer.ts";
import { checkCropReviewWarnings, checkStarryNightDetected } from "../scripts/lib/invariant-checks/stage-4.ts";
import { md5OfFile } from "../scripts/lib/shared/file-md5.ts";
import { estiloFalsePositivesPath } from "../scripts/lib/estilo-false-positives.ts";

const ROOT = join(import.meta.dirname, "..");
let dir: string;

function persist(raw: unknown): void {
  const result = stampCropReviewImageHashes(normalizeCropReviewResult(raw, "261016"), dir);
  writeFileSync(join(dir, "_internal", "04-crop-review.json"), JSON.stringify(result, null, 2));
}

function readReview(): { results: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, "_internal", "04-crop-review.json"), "utf8"));
}

function cli(...extra: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, "scripts", "run-image-crop-reviewer.ts"), "--edition-dir", dir, ...extra],
    { cwd: ROOT, encoding: "utf8" },
  );
}

function img(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

const ESTILO_D2_4X5 = {
  results: [
    { destaque: "d1", ratio: "4x5", status: "ok" },
    { destaque: "d2", ratio: "4x5", status: "warn", categoria: "estilo", motivo: "redemoinho na tela do celular" },
  ],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "starry-followups-"));
  mkdirSync(join(dir, "_internal"));
  for (const d of ["d1", "d2", "d3"]) {
    img(`04-${d}-1x1.jpg`, `${d}-1x1-v1`);
    img(`04-${d}-4x5-nativo.jpg`, `${d}-nativo-v1`);
    img(`04-${d}-4x5.jpg`, `${d}-card-titulo-A`);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("#10325: achado de estilo no 4:5 carimba a arte nativa, não o card", () => {
  it("cenário da issue: card recomposto (título novo, mesma arte) → erro continua", () => {
    persist(ESTILO_D2_4X5);
    const entry = readReview().results.find((r) => r.destaque === "d2")!;
    assert.equal(entry.image_variant, "4x5-nativo");
    assert.equal(entry.image_md5, md5OfFile(join(dir, "04-d2-4x5-nativo.jpg")));
    assert.equal(checkStarryNightDetected(dir).length, 1);

    // editor muda o título → gen-social-card-4x5.ts recompõe o card sem arte nova
    img("04-d2-4x5.jpg", "d2-card-titulo-B");
    const v = checkStarryNightDetected(dir);
    assert.equal(v.length, 1, "a mesma arte com Noite Estrelada não pode passar o gate");
    assert.equal(v[0].severity, "error");
    assert.deepEqual(
      checkCropReviewWarnings(dir).filter((x) => x.source_issue === "#9598"),
      [],
      "não vira nota de desatualizado",
    );
  });

  it("arte nativa regerada → entrada desatualizada, sem erro", () => {
    persist(ESTILO_D2_4X5);
    img("04-d2-4x5-nativo.jpg", "d2-nativo-v2");
    assert.deepEqual(checkStarryNightDetected(dir), []);
  });

  it("sem arte nativa: cai para master, depois 2:1 (mesma ordem do gen-social-card-4x5)", () => {
    rmSync(join(dir, "04-d2-4x5-nativo.jpg"));
    img("04-d2-master.jpg", "d2-master");
    persist(ESTILO_D2_4X5);
    assert.equal(readReview().results.find((r) => r.destaque === "d2")!.image_variant, "master");
  });

  it("achado de CROP no 4:5 continua carimbando o card (o corte é do card)", () => {
    persist({ results: [{ destaque: "d2", ratio: "4x5", status: "warn", motivo: "título cobre o rosto" }] });
    const entry = readReview().results[0];
    assert.equal(entry.image_variant, undefined);
    assert.equal(entry.image_md5, md5OfFile(join(dir, "04-d2-4x5.jpg")));
  });

  it("image_variant fora da allowlist é descartado na normalização (sem path arbitrário)", () => {
    const n = normalizeCropReviewResult(
      { results: [{ destaque: "d2", ratio: "4x5", status: "warn", categoria: "estilo", image_variant: "../../x" }] },
      "261016",
    );
    assert.equal(n.results[0].image_variant, undefined);
  });
});

describe("#10327: tentativas de regeneração presas à imagem, não à posição", () => {
  it("cenário da issue (CLI): regen no Stage 3, swap do D2 no Stage 4 → imagem nova ganha tentativa", () => {
    persist(ESTILO_D2_4X5);
    assert.deepEqual(JSON.parse(cli("--estilo-regen-plan").stdout).regenerate, ["d2"]);

    // Stage 3 regenerou o D2 e o revisor re-acusou → esgota
    img("04-d2-4x5-nativo.jpg", "d2-nativo-v2");
    img("04-d2-4x5.jpg", "d2-card-v2");
    persist(ESTILO_D2_4X5);
    const esgotou = JSON.parse(cli("--estilo-regen-plan").stdout);
    assert.deepEqual(esgotou.exhausted, ["d2"]);
    assert.equal(esgotou.attempts.d2, 1);

    // Stage 4: swap-destaque coloca outro item em D2; a imagem nova também é acusada
    img("04-d2-4x5-nativo.jpg", "item-promovido-nativo");
    img("04-d2-4x5.jpg", "item-promovido-card");
    persist(ESTILO_D2_4X5);
    const r = cli("--estilo-regen-plan");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.regenerate, ["d2"], "imagem nunca regenerada não pode sair como 'esgotou'");
    assert.deepEqual(out.exhausted, []);
  });

  it("re-acusação da própria imagem regenerada continua esgotada (o teto vale)", () => {
    const result = normalizeCropReviewResult(ESTILO_D2_4X5, "261016");
    let md5 = "a";
    const p1 = planEstiloRegeneration(result, {}, () => false, () => md5);
    md5 = "b";
    const p2 = planEstiloRegeneration(result, p1.state, () => false, () => md5);
    assert.deepEqual(p2.exhausted, ["d2"]);
    assert.deepEqual(p2.state.images?.d2, ["a", "b"]);
    const p3 = planEstiloRegeneration(result, p2.state, () => false, () => "a");
    assert.deepEqual(p3.exhausted, ["d2"], "voltar à imagem anterior não reabre a contagem");
  });

  // #10332: a regeneração reescreve o destaque inteiro; o revisor pode acusar
  // um ratio diferente do que estava no `pending`.
  const estilo = (ratio: "1x1" | "4x5") =>
    normalizeCropReviewResult(
      { results: [{ destaque: "d1", ratio, status: "warn", categoria: "estilo", motivo: "espiral" }] },
      "261016",
    );

  it("#10332: pending {4x5} → regenera → revisor acusa {1x1} → esgotado (teto não some)", () => {
    const md5: Record<string, string> = { "1x1": "1x1-v1", "4x5": "4x5-v1" };
    const cur = (_d: string, r: string) => md5[r] ?? null;
    const p1 = planEstiloRegeneration(estilo("4x5"), {}, () => false, cur);
    assert.deepEqual(p1.regenerate, ["d1"]);
    // image-generate --force regera 2x1+1x1, depois --ratio 4x5 --force
    md5["1x1"] = "1x1-v2";
    md5["4x5"] = "4x5-v2";
    const p2 = planEstiloRegeneration(estilo("1x1"), p1.state, () => false, cur);
    assert.deepEqual(p2.regenerate, [], "a imagem acusada é a própria regenerada");
    assert.deepEqual(p2.exhausted, ["d1"]);
    assert.equal(p2.attempts.d1, 1);
    // e se a próxima revisão voltar a acusar o 4x5, continua esgotado
    const p3 = planEstiloRegeneration(estilo("4x5"), p2.state, () => false, cur);
    assert.deepEqual(p3.exhausted, ["d1"]);
  });

  it("#10332: idem para failed — gerador falhou e o revisor alterna o ratio → esgotado", () => {
    const md5: Record<string, string> = { "1x1": "1x1-v1", "4x5": "4x5-v1" };
    const cur = (_d: string, r: string) => md5[r] ?? null;
    // 2 falhas toleradas (failed <= MAX_ESTILO_REGEN_FAILED_RUNS), na 3ª esgota
    let state = planEstiloRegeneration(estilo("4x5"), {}, () => false, cur).state;
    const ratios: Array<"1x1" | "4x5"> = ["1x1", "4x5", "1x1"];
    let last;
    for (const r of ratios) {
      last = planEstiloRegeneration(estilo(r), state, () => false, cur);
      state = last.state;
    }
    assert.equal(last!.state.failed?.d1, MAX_ESTILO_REGEN_FAILED_RUNS + 1);
    assert.deepEqual(last!.regenerate, [], "imagem nunca mudou: alternar o ratio não zera failed");
    assert.deepEqual(last!.exhausted, ["d1"]);
  });

  it("#10332: troca real da imagem (swap) depois do ratio alternado ainda zera a contagem", () => {
    const md5: Record<string, string> = { "1x1": "1x1-v1", "4x5": "4x5-v1" };
    const cur = (_d: string, r: string) => md5[r] ?? null;
    const p1 = planEstiloRegeneration(estilo("4x5"), {}, () => false, cur);
    md5["1x1"] = "1x1-v2";
    md5["4x5"] = "4x5-v2";
    const p2 = planEstiloRegeneration(estilo("1x1"), p1.state, () => false, cur);
    assert.deepEqual(p2.exhausted, ["d1"]);
    md5["1x1"] = "swap-1x1";
    md5["4x5"] = "swap-4x5";
    const p3 = planEstiloRegeneration(estilo("1x1"), p2.state, () => false, cur);
    assert.deepEqual(p3.regenerate, ["d1"]);
  });

  it("estado legado (sem images) mantém a contagem", () => {
    const result = normalizeCropReviewResult(ESTILO_D2_4X5, "261016");
    const p = planEstiloRegeneration(result, { attempts: { d2: 1 } }, () => false, () => "novo");
    assert.deepEqual(p.exhausted, ["d2"]);
  });
});

describe("#10328: falso positivo guardado fora do veredito, chaveado pelo md5", () => {
  const ESTILO_D1 = {
    results: [
      { destaque: "d1", ratio: "4x5", status: "warn", categoria: "estilo", motivo: "céu espiralado" },
      { destaque: "d3", ratio: "4x5", status: "ok" },
    ],
  };

  it("cenário da issue: marca D1, troca a imagem do D3, revisão completa re-acusa D1 → sem erro", () => {
    persist(ESTILO_D1);
    assert.equal(checkStarryNightDetected(dir).length, 1);
    const m = cli("--mark-false-positive", "d1");
    assert.equal(m.status, 0, m.stderr);
    assert.ok(existsSync(estiloFalsePositivesPath(dir)));
    assert.deepEqual(checkStarryNightDetected(dir), []);

    // troca a imagem do D3 → §4d.1 repete o revisor com TODOS os pares e reescreve o veredito
    img("04-d3-4x5-nativo.jpg", "d3-nativo-v2");
    img("04-d3-4x5.jpg", "d3-card-v2");
    persist(ESTILO_D1);
    assert.deepEqual(checkStarryNightDetected(dir), [], "a marcação sobrevive ao persist completo");
    assert.equal(
      checkCropReviewWarnings(dir).filter((v) => /céu espiralado/.test(v.message)).length,
      0,
      "também não volta como warning",
    );
    const plan = JSON.parse(cli("--estilo-regen-plan").stdout);
    assert.deepEqual(plan.regenerate, [], "falso positivo não dispara regeneração");
  });

  it("imagem do destaque regerada → marcação não vale mais (imagem nova, veredito novo)", () => {
    persist(ESTILO_D1);
    assert.equal(cli("--mark-false-positive", "d1").status, 0);
    img("04-d1-4x5-nativo.jpg", "d1-nativo-v2");
    persist(ESTILO_D1);
    assert.equal(checkStarryNightDetected(dir).length, 1);
  });

  it("sem achado atual para o alvo → exit 1, nada gravado", () => {
    persist(ESTILO_D1);
    const r = cli("--mark-false-positive", "d3");
    assert.equal(r.status, 1);
    assert.ok(!existsSync(estiloFalsePositivesPath(dir)));
  });

  it("parse de alvos e filtro por ratio", () => {
    assert.deepEqual(parseFalsePositiveTargets("d1, D2:4x5"), [
      { destaque: "d1", ratio: null },
      { destaque: "d2", ratio: "4x5" },
    ]);
    assert.throws(() => parseFalsePositiveTargets("d4"));
    const res = normalizeCropReviewResult(
      {
        results: [
          { destaque: "d2", ratio: "1x1", status: "warn", categoria: "estilo", image_md5: "a".repeat(32) },
          { destaque: "d2", ratio: "4x5", status: "warn", categoria: "estilo", image_md5: "b".repeat(32) },
        ],
      },
      "261016",
    );
    const marks = selectFalsePositiveMarks(res, [{ destaque: "d2", ratio: "4x5" }], () => false);
    assert.deepEqual(marks.map((x) => x.ratio), ["4x5"]);
  });

  it("mensagem: com o plano esgotado não sugere --estilo-regen-plan (que não faria nada); cita --mark-false-positive", () => {
    persist(ESTILO_D1);
    writeFileSync(join(dir, "_internal", "04-estilo-regen.json"), JSON.stringify({ attempts: { d1: 1 } }));
    const [v] = checkStarryNightDetected(dir);
    assert.doesNotMatch(v.message, /--estilo-regen-plan/);
    assert.match(v.message, /--mark-false-positive d1/);
  });
});

describe("#10326: playbook do Stage 4 libera a trava nos ramos terminais", () => {
  const stage4 = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-4.md"), "utf8");
  const line = (prefix: string) => stage4.split("\n").find((l) => l.startsWith(prefix)) ?? "";

  it("`editar` e `abortar` chamam edition-lock.ts release", () => {
    assert.match(line('**"editar":**'), /edition-lock\.ts release/);
    assert.match(line('**"abortar":**'), /edition-lock\.ts release/);
  });

  it("regra geral: liberar antes de qualquer halt banner (exceto o do próprio exit 3)", () => {
    assert.match(stage4, /Liberar em todo ramo terminal \(#10326\)[\s\S]{0,300}ANTES de qualquer halt banner/);
    assert.match(stage4, /edition-lock\.ts release --edition-dir \{EDITION_DIR\}/);
  });
});
