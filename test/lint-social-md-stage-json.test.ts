/**
 * test/lint-social-md-stage-json.test.ts (#5416)
 *
 * Cobre o modo agregador `--stage 4 --json` de `lint-social-md.ts` — mesmo
 * tratamento dado a `lint-newsletter-md.ts` (#5416): agrega os 4 checks que
 * `.claude/agents/orchestrator-stage-4.md` §4c.2b dispara em invocações
 * separadas (`post_pixel-matches-d1`, `no-xml-artifacts`,
 * `no-antithesis-reveal`, `no-trailing-editorial-hook` — todos
 * GATE-BLOCKING) numa única chamada de processo.
 *
 * Mesma estratégia de oráculo do teste irmão
 * (test/lint-newsletter-md-stage-json.test.ts): compara o `.result` de cada
 * entrada do agregador contra chamar a função pura correspondente
 * diretamente sobre o mesmo markdown.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  runStage4SocialLintReport,
  lintPostPixelMatchesD1,
  checkNoXmlArtifacts,
  lintAntithesisReveal,
  lintTrailingEditorialHook,
} from "../scripts/lint-social-md.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "lint-social-md.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    encoding: "utf8",
  });
}

/**
 * `post_pixel` deliberadamente reusa o vocabulário de `d3` (robótica
 * industrial) e nenhum de `d1` (Claude/IA generativa) — dispara
 * `post_pixel-matches-d1` (caso real #1861: reorder pós-Stage-2 sem
 * re-sincronizar o post pessoal). Os outros 3 checks (no-xml-artifacts,
 * no-antithesis-reveal, no-trailing-editorial-hook) passam limpos neste
 * fixture — cobertos pelo teste de "oráculo" mesmo passando.
 */
function buildSocialMd(): string {
  return [
    "# LinkedIn",
    "",
    "## d1",
    "",
    "Post sobre Claude e IA generativa no mercado brasileiro, cobrindo avanços recentes.",
    "",
    "### comment_diaria",
    "",
    "Edição completa em diar.ia.br/p/edicao",
    "",
    "## d2",
    "",
    "Post sobre modelos de código aberto e comunidade open source de IA.",
    "",
    "### comment_diaria",
    "",
    "Edição completa em diar.ia.br/p/edicao",
    "",
    "## d3",
    "",
    "Post sobre robótica industrial e automação de fábricas no Brasil.",
    "",
    "### comment_diaria",
    "",
    "Edição completa em diar.ia.br/p/edicao",
    "",
    "## post_pixel",
    "",
    "Fiquei pensando na robótica industrial e na automação de fábricas no Brasil, um tema que mexe comigo.",
    "",
    "#IA #futuro",
    "",
  ].join("\n");
}

describe("runStage4SocialLintReport (#5416)", () => {
  function makeEditionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-social-stage4-json-"));
    writeFileSync(join(dir, "03-social.md"), buildSocialMd());
    return dir;
  }

  it("4 checks presentes, todos gate-blocking", () => {
    const editionDir = makeEditionDir();
    const report = runStage4SocialLintReport(editionDir);
    const ids = report.checks.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      "no-antithesis-reveal",
      "no-trailing-editorial-hook",
      "no-xml-artifacts",
      "post_pixel-matches-d1",
    ]);
    for (const c of report.checks) assert.equal(c.severity, "gate-blocking");
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("cada check bate byte-a-byte com a função pura correspondente (oráculo)", () => {
    const editionDir = makeEditionDir();
    const md = buildSocialMd();
    const report = runStage4SocialLintReport(editionDir);
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    assert.deepEqual(byId.get("post_pixel-matches-d1")?.result, lintPostPixelMatchesD1(md));
    assert.deepEqual(byId.get("no-xml-artifacts")?.result, checkNoXmlArtifacts(md));
    assert.deepEqual(byId.get("no-antithesis-reveal")?.result, lintAntithesisReveal(md));
    assert.deepEqual(byId.get("no-trailing-editorial-hook")?.result, lintTrailingEditorialHook(md));
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("passed=false: post_pixel stale (reusa vocabulário de d3, não d1)", () => {
    const editionDir = makeEditionDir();
    const report = runStage4SocialLintReport(editionDir);
    assert.equal(report.stage, 4);
    assert.equal(report.passed, false);
    const postPixel = report.checks.find((c) => c.id === "post_pixel-matches-d1");
    assert.equal(postPixel?.ok, false);
    // As 3 outras entradas seguem ok:true neste fixture (só post_pixel está stale).
    assert.equal(report.checks.find((c) => c.id === "no-xml-artifacts")?.ok, true);
    assert.equal(report.checks.find((c) => c.id === "no-antithesis-reveal")?.ok, true);
    assert.equal(report.checks.find((c) => c.id === "no-trailing-editorial-hook")?.ok, true);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("03-social.md ausente: passed=false, único check md-exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-social-stage4-json-missing-"));
    const report = runStage4SocialLintReport(dir);
    assert.equal(report.passed, false);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].id, "md-exists");
    rmSync(dir, { recursive: true, force: true });
  });

  it("CLI --stage 4 --json: exit 1 (passed=false) + JSON parseável no stdout", () => {
    const editionDir = makeEditionDir();
    const r = runCli(["--stage", "4", "--json", "--edition-dir", editionDir]);
    assert.equal(r.status, 1, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.stage, 4);
    assert.equal(out.passed, false);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("CLI --stage 4 --json: exit 2 quando --edition-dir ausente", () => {
    const r = runCli(["--stage", "4", "--json"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--stage 4 --json --edition-dir/);
  });

  it("parity: post_pixel-matches-d1 — agregador ok:false <=> --check individual exit 1", () => {
    const editionDir = makeEditionDir();
    const mdPath = join(editionDir, "03-social.md");
    const individual = runCli(["--check", "post_pixel-matches-d1", "--md", mdPath]);
    const report = runStage4SocialLintReport(editionDir);
    const aggregated = report.checks.find((c) => c.id === "post_pixel-matches-d1");

    assert.equal(individual.status, 1);
    assert.equal(aggregated?.ok, false);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("parity: no-xml-artifacts (passa neste fixture) — agregador ok:true <=> --check individual exit 0", () => {
    const editionDir = makeEditionDir();
    const mdPath = join(editionDir, "03-social.md");
    const individual = runCli(["--check", "no-xml-artifacts", "--md", mdPath]);
    const report = runStage4SocialLintReport(editionDir);
    const aggregated = report.checks.find((c) => c.id === "no-xml-artifacts");

    assert.equal(individual.status, 0, `stderr: ${individual.stderr}`);
    assert.equal(aggregated?.ok, true);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("regressão: --check post_pixel-matches-d1 isolado continua funcionando exatamente como antes (sem --stage)", () => {
    const editionDir = makeEditionDir();
    const mdPath = join(editionDir, "03-social.md");
    const r = runCli(["--check", "post_pixel-matches-d1", "--md", mdPath]);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.best_match, "d3");
    rmSync(editionDir, { recursive: true, force: true });
  });
});
