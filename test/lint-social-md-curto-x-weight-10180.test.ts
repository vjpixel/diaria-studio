/**
 * test/lint-social-md-curto-x-weight-10180.test.ts (#10180)
 *
 * Regressão da edição 261014: o `## um` do `# Curto` saiu com 283 de peso X e
 * só o Stage 5 (`prep-twitter-posts.ts`) recusou, depois do gate 4. O lint
 * `curto-x-weight` precisa reprovar antes, com o MESMO cálculo do Stage 5.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkCurtoXWeight,
  runStage4SocialLintReport,
  runStage2SocialLintReport,
} from "../scripts/lint-social-md.ts";
import { computeTwitterWeightedLength } from "../scripts/prep-twitter-posts.ts";
import { curtoPostTextForWeight } from "../scripts/lib/lint-checks/curto-x-weight.ts";

const SCRIPT_PATH = join(resolve(import.meta.dirname, ".."), "scripts", "lint-social-md.ts");

/** Post com peso X exato `n`: texto + espaço + `{edition_url}` (conta 23). */
function postOfWeight(n: number): string {
  return "a".repeat(n - 24) + " {edition_url}";
}

function socialMd(curto: Record<string, string>): string {
  const lines = ["# Social", "", "## d1", "", "Texto longo do LinkedIn.", "", "# Curto", ""];
  for (const [d, text] of Object.entries(curto)) lines.push(`## ${d}`, "", text, "");
  return lines.join("\n");
}

describe("checkCurtoXWeight (#10180)", () => {
  it("283 de peso X no ## um reprova, dizendo qual post e quanto cortar", () => {
    const r = checkCurtoXWeight(
      socialMd({ d1: postOfWeight(200), d2: postOfWeight(200), d3: postOfWeight(200), um: postOfWeight(283) }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].destaque, "um");
    assert.equal(r.errors[0].weighted, 283);
    assert.equal(r.errors[0].excess, 3);
    assert.match(r.errors[0].message, /## um/);
    assert.match(r.errors[0].message, /Corte 3/);
  });

  it("280 exatos passa (limite inclusivo, igual ao Stage 5)", () => {
    const r = checkCurtoXWeight(socialMd({ d1: postOfWeight(280), um: postOfWeight(280) }));
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.posts.map((p) => [p.destaque, p.weighted]),
      [["d1", 280], ["um", 280]],
    );
  });

  it("d1/d2/d3 também são checados", () => {
    const r = checkCurtoXWeight(socialMd({ d1: postOfWeight(100), d2: postOfWeight(281) }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.map((e) => e.destaque), ["d2"]);
  });

  it("{edition_url} literal pesa 23 (não 13), igual à URL resolvida", () => {
    const text = "Texto curto do post. {edition_url}";
    const [post] = checkCurtoXWeight(socialMd({ d1: text })).posts;
    const resolved = text.replace(
      "{edition_url}",
      "https://diar.ia.br/p/um-slug-bem-comprido-de-uma-edicao-qualquer?utm_source=twitter",
    );
    assert.equal(post.weighted, computeTwitterWeightedLength(resolved));
    assert.equal(post.weighted, "Texto curto do post. ".length + 23);
  });

  it("## um: linha {quebra} vira linha em branco (finalizeUseMelhorPostText), não conta 8", () => {
    const text = "Primeira parte.\n{quebra}\nSegunda parte.";
    assert.equal(curtoPostTextForWeight(text, "um"), "Primeira parte.\n\nSegunda parte.");
    const [post] = checkCurtoXWeight(socialMd({ um: text })).posts;
    assert.equal(post.weighted, "Primeira parte.\n\nSegunda parte.".length);
  });

  it("comentário HTML no bloco não conta (extractDestaqueBlock, mesmo do Stage 5)", () => {
    const [post] = checkCurtoXWeight(socialMd({ d1: "<!-- nota interna -->Oi." })).posts;
    assert.equal(post.weighted, 3);
  });

  it("sem seção # Curto: ok, nada checado", () => {
    const r = checkCurtoXWeight("# Social\n\n## d1\n\nTexto.\n");
    assert.equal(r.ok, true);
    assert.equal(r.posts.length, 0);
  });

  it("seções fora do # Curto não entram (o ## d1 do # Social é longo e é ignorado)", () => {
    const md = ["# Social", "", "## d1", "", "x".repeat(900), "", "# Curto", "", "## d1", "", "Curto.", ""].join("\n");
    const r = checkCurtoXWeight(md);
    assert.equal(r.ok, true);
    assert.deepEqual(r.posts, [{ destaque: "d1", weighted: 6 }]);
  });
});

describe("curto-x-weight nos agregadores e no CLI (#10180)", () => {
  function editionWith(md: string): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-curto-x-weight-"));
    writeFileSync(join(dir, "03-social.md"), md);
    return dir;
  }

  it("Stage 4: ## um com 283 derruba passed (gate-blocking)", () => {
    const dir = editionWith(socialMd({ d1: postOfWeight(200), um: postOfWeight(283) }));
    const report = runStage4SocialLintReport(dir);
    const check = report.checks.find((c) => c.id === "curto-x-weight");
    assert.equal(check?.severity, "gate-blocking");
    assert.equal(check?.ok, false);
    assert.equal(report.passed, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("Stage 2: mesmo check, gate-blocking", () => {
    const dir = editionWith(socialMd({ d1: postOfWeight(281) }));
    const check = runStage2SocialLintReport(dir).checks.find((c) => c.id === "curto-x-weight");
    assert.equal(check?.severity, "gate-blocking");
    assert.equal(check?.ok, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("CLI --check curto-x-weight: exit 1 com 283, exit 0 com 280", () => {
    const bad = editionWith(socialMd({ um: postOfWeight(283) }));
    const r1 = spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, "--check", "curto-x-weight", "--md", join(bad, "03-social.md")], { encoding: "utf8" });
    assert.equal(r1.status, 1, r1.stderr);
    assert.match(r1.stderr, /## um: 283/);

    const good = editionWith(socialMd({ um: postOfWeight(280) }));
    const r2 = spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, "--check", "curto-x-weight", "--md", join(good, "03-social.md")], { encoding: "utf8" });
    assert.equal(r2.status, 0, r2.stderr);
    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  });
});
