/**
 * test/use-melhor-um-failsoft-9619.test.ts (#9619)
 *
 * O 4º post (`## um`, item USE MELHOR, #9568) é FAIL-SOFT: nunca quebra
 * D1/D2/D3. Regressão do achado do review diário: `lintLinkedinSchema`,
 * `lintCredentialBio` e `checkHumanizerSectionCoverage` passaram a cobrir o
 * `## um` e empurravam as violações dele para o veredito `ok`, tornando o
 * Stage 2 gate-blocking por causa de um post opcional (re-disparo do
 * social-writer reescrevendo d1–d3). E os warnings do `## um` em
 * `checkCarouselTextOverflow` inflavam as métricas de overflow do
 * backtest/eval de prompt.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  checkHumanizerSectionCoverage,
  isFailSoftSocialSection,
  lintCredentialBio,
  lintLinkedinSchema,
  lintUseMelhorFailSoft,
} from "../scripts/lib/social-lint-rules.ts";
import { runStage2SocialLintReport } from "../scripts/lint-social-md.ts";
import { runDistillationBacktest } from "../scripts/lib/distillation-backtest.ts";
import { runMechanicalGraders } from "../scripts/lib/prompt-regression-eval.ts";
import { checkCarouselTextOverflow } from "../scripts/lib/invariant-checks/stage-4.ts";
import { writeUseMelhorPostState } from "../scripts/lib/use-melhor-post.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const D_OK = "y".repeat(700); // dentro da faixa 400-1100 do formato `# Social`
const P = (s: string) => `${s} **Trecho curto em negrito.** Fim do parágrafo.`;
const TEXTO_D = [P("Primeiro parágrafo do destaque."), P("Segundo parágrafo."), P("Terceiro parágrafo."), "#InteligenciaArtificial"].join("\n\n");

function socialMd(um: string, d1 = D_OK): string {
  return `# Social\n\n## d1\n\n${d1}\n\n## d2\n\n${D_OK}\n\n## d3\n\n${D_OK}\n\n## um\n\n${um}\n`;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("isFailSoftSocialSection (#9619)", () => {
  it("só o `um` (com ou sem prefixo main_) é fail-soft", () => {
    assert.equal(isFailSoftSocialSection("um"), true);
    assert.equal(isFailSoftSocialSection("main_um"), true);
    for (const s of ["d1", "main_d1", "post_pixel", "comment_pixel (d1)"]) {
      assert.equal(isFailSoftSocialSection(s), false, s);
    }
  });
});

describe("lintLinkedinSchema — `## um` não derruba ok (#9619)", () => {
  it("`## um` curto demais: erro reportado, mas ok=true", () => {
    const r = lintLinkedinSchema(socialMd("Curto demais."));
    assert.ok(r.errors.some((e) => e.destaque === "um" && e.rule === "main_chars_out_of_range"));
    assert.equal(r.ok, true);
  });

  it("`## um` com menção à marca: reportado, ok=true", () => {
    const r = lintLinkedinSchema(socialMd(`${"z".repeat(600)} Diar.ia`));
    assert.ok(r.errors.some((e) => e.destaque === "um" && e.rule === "main_post_mentions_diaria"));
    assert.equal(r.ok, true);
  });

  it("d1 fora da faixa continua bloqueando (ok=false)", () => {
    const r = lintLinkedinSchema(socialMd("x".repeat(800), "curto"));
    assert.ok(r.errors.some((e) => e.destaque === "d1"));
    assert.equal(r.ok, false);
  });
});

describe("lintCredentialBio — `## um` não derruba ok (#9619)", () => {
  it("frase de bio só no `## um`: match reportado, ok=true", () => {
    const r = lintCredentialBio(socialMd(`${"z".repeat(500)} Faço uma newsletter sobre isso.`));
    assert.ok(r.matches.some((m) => m.section === "um"));
    assert.equal(r.ok, true);
  });

  it("frase de bio no `## post_pixel` legado continua bloqueando", () => {
    const md = `# Social\n\n## d1\n\n${D_OK}\n\n## post_pixel\n\nFaço uma newsletter sobre isso.\n`;
    assert.equal(lintCredentialBio(md).ok, false);
  });
});

describe("checkHumanizerSectionCoverage — main_um não tocado não bloqueia (#9619)", () => {
  it("só main_um idêntico: reportado em untouched, ok=true", () => {
    const pre = socialMd("Texto do um.");
    const post = pre.replace(/y{700}/g, "w".repeat(700));
    const r = checkHumanizerSectionCoverage(pre, post);
    assert.deepEqual(r.untouched, ["main_um"]);
    assert.equal(r.ok, true);
  });

  it("main_d1 idêntico continua bloqueando", () => {
    const pre = socialMd("Texto do um.");
    const r = checkHumanizerSectionCoverage(pre, pre.replace("Texto do um.", "Texto do um, reescrito."));
    assert.ok(r.untouched.includes("main_d1"));
    assert.equal(r.ok, false);
  });

  it("main_um DELETADO continua bloqueando (corrupção estrutural)", () => {
    const pre = socialMd("Texto do um.");
    const post = pre.replace(/y{700}/g, "w".repeat(700)).replace(/\n## um\n\nTexto do um\.\n/, "\n");
    const r = checkHumanizerSectionCoverage(pre, post);
    assert.deepEqual(r.deleted, ["main_um"]);
    assert.equal(r.ok, false);
  });
});

describe("Stage 2 — relatório agregado e CLI (#9619)", () => {
  it("`## um` curto: passed=true, linkedin-schema ok, aviso em use-melhor-um-fail-soft", () => {
    const dir = tmp("diaria-9619-stage2-");
    writeFileSync(join(dir, "03-social.md"), socialMd("Curto demais. Faço uma newsletter."));
    const report = runStage2SocialLintReport(dir);
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(report.passed, true);
    assert.equal(byId.get("linkedin-schema")?.ok, true);
    const um = byId.get("use-melhor-um-fail-soft")!;
    assert.equal(um.severity, "warn-only");
    assert.equal(um.ok, false);
    const issues = (um.result as ReturnType<typeof lintUseMelhorFailSoft>).issues;
    assert.ok(issues.some((i) => i.source === "linkedin-schema"));
    assert.ok(issues.some((i) => i.source === "no-credential-bio"));
  });

  it("`## um` limpo: use-melhor-um-fail-soft ok", () => {
    assert.equal(lintUseMelhorFailSoft(socialMd("x".repeat(800))).ok, true);
  });

  for (const check of ["linkedin-schema", "no-credential-bio"]) {
    it(`CLI --check ${check}: violação só no \`## um\` sai com exit 0 e aviso`, () => {
      const dir = tmp("diaria-9619-cli-");
      const file = join(dir, "03-social.md");
      writeFileSync(file, socialMd("Curto demais. Faço uma newsletter."));
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve(ROOT, "scripts", "lint-social-md.ts"), "--check", check, "--md", file],
        { encoding: "utf8", cwd: ROOT },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /fail-soft #9619/);
    });
  }
});

describe("métricas de overflow contam só severity error (#9619)", () => {
  /** Edição com d1–d3 que cabem no card + `## um` fora do formato (warning). */
  function editionWithUmWarningOnly(parent: string): string {
    const dir = join(parent, "261005");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const social = `# Social\n\n## d1\n\n${TEXTO_D}\n\n## d2\n\n${TEXTO_D}\n\n## d3\n\n${TEXTO_D}\n\n## um\n\n${P("Só um parágrafo.")}\n`;
    writeFileSync(join(dir, "03-social.md"), social, "utf8");
    writeUseMelhorPostState(dir, {
      enabled: true,
      time: "08:00",
      item: { url: "https://x.com/guia", title: "Guia", summary: "", score: 80 },
      generated_at: "x",
    });
    return dir;
  }

  it("pré-condição: o fixture só tem warnings (config do repo liga o 4º post)", () => {
    const dir = editionWithUmWarningOnly(tmp("diaria-9619-pre-"));
    const v = checkCarouselTextOverflow(dir);
    assert.ok(v.length > 0, "fixture deveria produzir warning do ## um");
    assert.ok(v.every((x) => x.severity === "warning"), JSON.stringify(v));
  });

  it("distillation-backtest: warning do ## um não conta como violação de carousel-text-overflow", () => {
    const root = tmp("diaria-9619-backtest-");
    editionWithUmWarningOnly(root);
    const report = runDistillationBacktest(root, ROOT);
    const check = report.checks.find((c) => c.name === "carousel-text-overflow")!;
    assert.equal(check.editions_evaluated, 1);
    assert.equal(check.editions_with_violation, 0);
  });

  it("prompt-regression-eval: grader carousel-text-overflow aprova com só warnings do ## um", () => {
    const dir = editionWithUmWarningOnly(tmp("diaria-9619-eval-"));
    const verdicts = runMechanicalGraders("social-writer", "## d1\n\ntexto\n", dir, dir);
    const carousel = verdicts.find((v) => v.name === "carousel-text-overflow")!;
    assert.equal(carousel.evaluable, true);
    assert.equal(carousel.ok, true);
  });
});
