/**
 * test/lint-newsletter-md-stage-json.test.ts (#5416)
 *
 * Cobre o modo agregador `--stage <2|4> --json` de `lint-newsletter-md.ts`:
 * roda os mesmos checks que `.claude/agents/orchestrator-stage-4.md` §4c.2 /
 * `orchestrator-stage-2.md` §2b disparam em 1 invocação de processo por
 * check, numa única chamada — com o MESMO veredito por check.
 *
 * Estratégia de teste: em vez de tentar construir um fixture "100% limpo"
 * que passe em todos os 15/6 checks (superfície grande, frágil), o teste usa
 * as próprias funções puras (`checkSecondaryItemsHaveSummary`,
 * `checkTitleTrailingPeriod`, etc. — já exportadas por este arquivo) como
 * ORÁCULO: roda o agregador e a função pura sobre o MESMO markdown e compara
 * o `.result` armazenado em cada entrada byte-a-byte. Isso prova que o
 * agregador não reimplementa lógica paralela — ele chama exatamente as
 * mesmas funções que os modos `--check X` individuais chamam.
 *
 * Complementarmente, 2 testes de CLI (spawnSync) fecham o loop pedido pela
 * issue: "mesmo veredito que rodar cada --check X individualmente" — um
 * check gate-blocking (secondary-items-have-summary) e um warn-only
 * (title-trailing-period), comparando exit code do `--check X` isolado
 * contra a severity/ok reportada pelo agregador.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  runStage4LintReport,
  runStage2LintReport,
  checkSecondaryItemsHaveSummary,
  checkNoUntranslatedSummary,
  checkVideoLinksAreYoutube,
  checkSectionLinksResolve,
  checkTitlePublisherSuffix,
  checkTitleTrailingPeriod,
  checkNoTrailingEllipsis,
  checkMidSentenceEllipsis,
  checkTitleMentionsIA,
  checkNoXmlArtifacts,
  checkDestaqueMinChars,
  checkDestaqueMaxChars,
  checkWhyMattersLength,
  checkAprofundeFormat,
  checkSectionCounts,
  lintNewsletter,
} from "../scripts/lint-newsletter-md.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "lint-newsletter-md.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    encoding: "utf8",
  });
}

// Intro válida (formato legado #592/#609, ainda aceito por compat) — mesma
// contagem (2) usada em ambos os fixtures abaixo, não checada por este teste.
const INTRO_LINE =
  "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 7 artigos. Selecionamos os 2 mais relevantes para as pessoas que assinam a newsletter.";

/**
 * 1 destaque (deliberadamente curto — abaixo do piso de #914, dispara
 * `destaque-min-chars`/`why-matters-length` como falha) + 1 seção LANÇAMENTOS
 * com 2 itens: um bem formado, outro SEM descrição E com título terminando
 * em ponto final (dispara `secondary-items-have-summary` GATE-BLOCKING e
 * `title-trailing-period` WARN-ONLY na mesma linha — não é acidente, é
 * deliberado pra exercitar as duas severities num só fixture).
 */
function buildMd(): string {
  return [
    INTRO_LINE,
    "",
    "---",
    "",
    "**DESTAQUE 1 | PRODUTO**",
    "",
    "**[Título de teste](https://example.com/d1)**",
    "",
    "Corpo curto de teste, deliberadamente abaixo do piso editorial de 1000 chars.",
    "",
    "Por que isso importa:",
    "",
    "Impacto direto pequeno, também deliberadamente curto pra este fixture de teste.",
    "",
    "---",
    "",
    "**LANÇAMENTOS**",
    "",
    "**[Ferramenta A](https://example.com/lanc-a)**",
    "Descrição válida e completa da ferramenta A, em português.",
    "",
    "**[Ferramenta B.](https://example.com/lanc-b)**",
    "",
    "---",
    "",
  ].join("\n");
}

function buildApproved() {
  return {
    highlights: [{ url: "https://example.com/d1", title: "Título de teste" }],
    lancamento: [
      { url: "https://example.com/lanc-a", title: "Ferramenta A" },
      { url: "https://example.com/lanc-b", title: "Ferramenta B." },
    ],
    radar: [],
    pesquisa: [],
    noticias: [],
    tutorial: [],
    video: [],
  };
}

describe("runStage4LintReport (#5416)", () => {
  function makeEditionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage4-json-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), buildMd());
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(buildApproved()));
    return dir;
  }

  it("cada check reportado bate byte-a-byte com a função pura correspondente (oráculo)", () => {
    const editionDir = makeEditionDir();
    const md = buildMd();
    const report = runStage4LintReport(editionDir, PROJECT_ROOT);

    const byId = new Map(report.checks.map((c) => [c.id, c]));

    assert.deepEqual(byId.get("secondary-items-have-summary")?.result, checkSecondaryItemsHaveSummary(md));
    assert.deepEqual(byId.get("no-untranslated-summary")?.result, checkNoUntranslatedSummary(md));
    assert.deepEqual(byId.get("video-links-are-youtube")?.result, checkVideoLinksAreYoutube(md));
    assert.deepEqual(byId.get("section-links-resolve")?.result, checkSectionLinksResolve(md));
    assert.deepEqual(byId.get("title-publisher-suffix")?.result, checkTitlePublisherSuffix(md));
    assert.deepEqual(byId.get("title-trailing-period")?.result, checkTitleTrailingPeriod(md));
    assert.deepEqual(byId.get("no-trailing-ellipsis")?.result, checkNoTrailingEllipsis(md));
    assert.deepEqual(byId.get("mid-sentence-ellipsis")?.result, checkMidSentenceEllipsis(md));
    assert.deepEqual(byId.get("title-mentions-ia")?.result, checkTitleMentionsIA(md));
    assert.deepEqual(byId.get("no-xml-artifacts")?.result, checkNoXmlArtifacts(md));

    rmSync(editionDir, { recursive: true, force: true });
  });

  it("marca secondary-items-have-summary como gate-blocking + ok:false (item B sem descrição)", () => {
    const editionDir = makeEditionDir();
    const report = runStage4LintReport(editionDir, PROJECT_ROOT);
    const check = report.checks.find((c) => c.id === "secondary-items-have-summary");
    assert.ok(check);
    assert.equal(check.severity, "gate-blocking");
    assert.equal(check.ok, false);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("marca title-trailing-period como warn-only + ok:false (mesmo item B), sem derrubar `passed`", () => {
    const editionDir = makeEditionDir();
    const report = runStage4LintReport(editionDir, PROJECT_ROOT);
    const check = report.checks.find((c) => c.id === "title-trailing-period");
    assert.ok(check);
    assert.equal(check.severity, "warn-only");
    assert.equal(check.ok, false);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("passed=false quando ao menos 1 check gate-blocking falha (secondary-items-have-summary)", () => {
    const editionDir = makeEditionDir();
    const report = runStage4LintReport(editionDir, PROJECT_ROOT);
    assert.equal(report.stage, 4);
    assert.equal(report.passed, false);
    // Todo check tem id/source_issue/severity/ok/result.
    for (const c of report.checks) {
      assert.equal(typeof c.id, "string");
      assert.equal(typeof c.source_issue, "string");
      assert.ok(c.severity === "gate-blocking" || c.severity === "warn-only");
      assert.equal(typeof c.ok, "boolean");
    }
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("18 checks presentes (17 do MD + agradecimento-hardcoded)", () => {
    const editionDir = makeEditionDir();
    const report = runStage4LintReport(editionDir, PROJECT_ROOT);
    const ids = report.checks.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      "agradecimento-hardcoded",
      "banned-lexicon",
      "mid-sentence-ellipsis",
      "no-trailing-ellipsis",
      "no-untranslated-summary",
      "no-xml-artifacts",
      "orphan-box-in-gap",
      "secondary-item-coherence",
      "secondary-items-have-summary",
      "section-links-resolve",
      "snippet-staleness",
      "stacked-intro-callouts",
      "title-clickbait-vulgar",
      "title-mentions-ia",
      "title-publisher-suffix",
      "title-trailing-period",
      "url-bucket",
      "video-links-are-youtube",
    ]);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("02-reviewed.md ausente: passed=false, check único md-exists gate-blocking", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage4-json-missing-"));
    const report = runStage4LintReport(dir, PROJECT_ROOT);
    assert.equal(report.passed, false);
    assert.equal(report.checks.length, 2); // md-exists + agradecimento-hardcoded (lê snippet real, fora do editionDir)
    const mdExists = report.checks.find((c) => c.id === "md-exists");
    assert.equal(mdExists?.severity, "gate-blocking");
    assert.equal(mdExists?.ok, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("CLI --stage 4 --json: exit 1 (passed=false) + JSON parseável no stdout", () => {
    const editionDir = makeEditionDir();
    const r = runCli(["--stage", "4", "--json", "--edition-dir", editionDir]);
    assert.equal(r.status, 1, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.stage, 4);
    assert.equal(out.passed, false);
    assert.ok(Array.isArray(out.checks));
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("CLI --stage 4 --json: exit 2 quando --edition-dir ausente", () => {
    const r = runCli(["--stage", "4", "--json"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--stage <2\|4> --json --edition-dir/);
  });

  // ---------------------------------------------------------------------
  // Parity com --check X individual (#5416 requisito #6): o veredito do
  // agregador precisa bater com rodar o mesmo check isolado via CLI.
  // ---------------------------------------------------------------------

  it("parity: secondary-items-have-summary (gate-blocking) — agregador ok:false <=> --check individual exit 1", () => {
    const editionDir = makeEditionDir();
    const mdPath = join(editionDir, "02-reviewed.md");
    const individual = runCli(["--check", "secondary-items-have-summary", "--md", mdPath]);
    const report = runStage4LintReport(editionDir, PROJECT_ROOT);
    const aggregated = report.checks.find((c) => c.id === "secondary-items-have-summary");

    assert.equal(individual.status, 1);
    assert.equal(aggregated?.ok, false);
    assert.equal(aggregated?.severity, "gate-blocking");
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("parity: title-trailing-period (warn-only) — agregador ok:false mas --check individual segue exit 0", () => {
    const editionDir = makeEditionDir();
    const mdPath = join(editionDir, "02-reviewed.md");
    const individual = runCli(["--check", "title-trailing-period", "--md", mdPath]);
    const report = runStage4LintReport(editionDir, PROJECT_ROOT);
    const aggregated = report.checks.find((c) => c.id === "title-trailing-period");

    assert.equal(individual.status, 0, `--check title-trailing-period isolado deveria seguir WARN-ONLY (exit 0): ${individual.stderr}`);
    assert.equal(JSON.parse(individual.stdout).ok, false);
    assert.equal(aggregated?.ok, false);
    assert.equal(aggregated?.severity, "warn-only");
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("regressão: --check secondary-items-have-summary isolado continua funcionando exatamente como antes (sem --stage)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage4-regression-"));
    const mdPath = join(dir, "02-reviewed.md");
    writeFileSync(
      mdPath,
      "**🚀 LANÇAMENTOS**\n\n**[Ferramenta X](https://x.com/release)**\n\n---\n",
    );
    const r = runCli(["--check", "secondary-items-have-summary", "--md", mdPath]);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.errors.length, 1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runStage2LintReport (#5416)", () => {
  function makeEditionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage2-json-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "02-draft.md"), buildMd());
    writeFileSync(
      join(dir, "_internal", "01-approved-capped.json"),
      JSON.stringify(buildApproved()),
    );
    return dir;
  }

  it("6 checks presentes, todos gate-blocking (mesma severity do modo --check individual)", () => {
    const editionDir = makeEditionDir();
    const report = runStage2LintReport(editionDir, PROJECT_ROOT);
    const ids = report.checks.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      "aprofunde-format",
      "destaque-max-chars",
      "destaque-min-chars",
      "section-counts",
      "url-bucket",
      "why-matters-length",
    ]);
    for (const c of report.checks) assert.equal(c.severity, "gate-blocking");
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("cada check bate byte-a-byte com a função pura correspondente (oráculo)", () => {
    const editionDir = makeEditionDir();
    const md = buildMd();
    const approved = buildApproved();
    const report = runStage2LintReport(editionDir, PROJECT_ROOT);
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    assert.deepEqual(byId.get("destaque-min-chars")?.result, checkDestaqueMinChars(md));
    assert.deepEqual(byId.get("destaque-max-chars")?.result, checkDestaqueMaxChars(md));
    assert.deepEqual(byId.get("why-matters-length")?.result, checkWhyMattersLength(md));
    assert.deepEqual(byId.get("aprofunde-format")?.result, checkAprofundeFormat(md));
    assert.deepEqual(
      byId.get("section-counts")?.result,
      checkSectionCounts(md, approved as Parameters<typeof checkSectionCounts>[1]),
    );
    assert.deepEqual(
      byId.get("url-bucket")?.result,
      lintNewsletter(md, approved as Parameters<typeof lintNewsletter>[1]),
    );
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("passed=false: fixture tem destaque abaixo do piso de #914 (destaque-min-chars)", () => {
    const editionDir = makeEditionDir();
    const report = runStage2LintReport(editionDir, PROJECT_ROOT);
    assert.equal(report.stage, 2);
    assert.equal(report.passed, false);
    const minChars = report.checks.find((c) => c.id === "destaque-min-chars");
    assert.equal(minChars?.ok, false);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("parity: destaque-min-chars — agregador ok:false <=> --check individual exit 1", () => {
    const editionDir = makeEditionDir();
    const mdPath = join(editionDir, "_internal", "02-draft.md");
    const individual = runCli(["--check", "destaque-min-chars", "--md", mdPath]);
    const report = runStage2LintReport(editionDir, PROJECT_ROOT);
    const aggregated = report.checks.find((c) => c.id === "destaque-min-chars");

    assert.equal(individual.status, 1);
    assert.equal(aggregated?.ok, false);
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("02-draft.md ausente: passed=false, único check md-exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage2-json-missing-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const report = runStage2LintReport(dir, PROJECT_ROOT);
    assert.equal(report.passed, false);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].id, "md-exists");
    rmSync(dir, { recursive: true, force: true });
  });

  it("CLI --stage 2 --json: exit 1 (passed=false) + JSON parseável no stdout", () => {
    const editionDir = makeEditionDir();
    const r = runCli(["--stage", "2", "--json", "--edition-dir", editionDir]);
    assert.equal(r.status, 1, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.stage, 2);
    assert.equal(out.passed, false);
    rmSync(editionDir, { recursive: true, force: true });
  });
});

// -----------------------------------------------------------------------
// #5455 fix — regressão do achado crítico do fleet review sobre #5416:
// JSON malformado em 01-approved.json/01-approved-capped.json não pode
// derrubar o agregador inteiro (processo morrendo, stdout vazio) nem
// engolir o veredito dos OUTROS checks independentes.
// -----------------------------------------------------------------------

describe("runStage4LintReport / runStage2LintReport — 01-approved*.json malformado (#5455)", () => {
  it("Stage 4: JSON.parse inválido não derruba o processo — stdout continua JSON válido, url-bucket falha isolado, outros checks seguem normais", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage4-json-malformed-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), buildMd());
    // JSON deliberadamente inválido (não é nem objeto, nem array parseável).
    writeFileSync(join(dir, "_internal", "01-approved.json"), "{ isto não é json válido ][");

    // (a) processo não crasha sem stdout — sai com JSON no stdout, nunca vazio.
    const r = runCli(["--stage", "4", "--json", "--edition-dir", dir]);
    assert.ok(r.stdout.length > 0, `stdout não deveria ficar vazio; stderr: ${r.stderr}`);
    assert.equal(r.status, 1, `stderr: ${r.stderr}`);

    // (b) stdout é JSON válido.
    const out = JSON.parse(r.stdout);
    assert.equal(out.stage, 4);
    assert.equal(out.passed, false);

    // (c) url-bucket (o check que depende de 01-approved.json) aparece
    // isolado como falha, com o erro serializado — não propaga exceção.
    const urlBucket = out.checks.find((c: { id: string }) => c.id === "url-bucket");
    assert.ok(urlBucket, "url-bucket deveria estar presente mesmo com JSON malformado");
    assert.equal(urlBucket.ok, false);
    assert.equal(urlBucket.severity, "gate-blocking");
    assert.match(urlBucket.result.error, /exceção não tratada em url-bucket/);

    // (d) checks independentes (não leem 01-approved.json) continuam
    // reportando o veredito NORMAL — não são engolidos pelo crash.
    const secondary = out.checks.find(
      (c: { id: string }) => c.id === "secondary-items-have-summary",
    );
    assert.ok(secondary, "secondary-items-have-summary deveria continuar presente");
    assert.equal(secondary.severity, "gate-blocking");
    assert.deepEqual(secondary.result, checkSecondaryItemsHaveSummary(buildMd()));

    const trailingPeriod = out.checks.find(
      (c: { id: string }) => c.id === "title-trailing-period",
    );
    assert.ok(trailingPeriod, "title-trailing-period deveria continuar presente");
    assert.deepEqual(trailingPeriod.result, checkTitleTrailingPeriod(buildMd()));

    // Todos os 18 checks continuam presentes — nenhum foi engolido (#7260 adicionou banned-lexicon).
    assert.equal(out.checks.length, 18);

    rmSync(dir, { recursive: true, force: true });
  });

  it("Stage 4: função exportada também isola a exceção (sem passar pelo CLI)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage4-malformed-direct-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), buildMd());
    writeFileSync(join(dir, "_internal", "01-approved.json"), "{{{not json");

    assert.doesNotThrow(() => runStage4LintReport(dir, PROJECT_ROOT));
    const report = runStage4LintReport(dir, PROJECT_ROOT);
    assert.equal(report.passed, false);
    const urlBucket = report.checks.find((c) => c.id === "url-bucket");
    assert.equal(urlBucket?.ok, false);
    assert.match((urlBucket?.result as { error: string }).error, /exceção não tratada/);
    // Outro check independente segue presente com veredito normal.
    const xmlArtifacts = report.checks.find((c) => c.id === "no-xml-artifacts");
    assert.deepEqual(xmlArtifacts?.result, checkNoXmlArtifacts(buildMd()));

    rmSync(dir, { recursive: true, force: true });
  });

  it("Stage 2: JSON.parse inválido não derruba o processo — url-bucket E section-counts falham isolados, checks independentes (destaque-*) seguem normais", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage2-json-malformed-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "02-draft.md"), buildMd());
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), "][ não é json {{{");

    const r = runCli(["--stage", "2", "--json", "--edition-dir", dir]);
    assert.ok(r.stdout.length > 0, `stdout não deveria ficar vazio; stderr: ${r.stderr}`);
    assert.equal(r.status, 1, `stderr: ${r.stderr}`);

    const out = JSON.parse(r.stdout);
    assert.equal(out.stage, 2);
    assert.equal(out.passed, false);

    const urlBucket = out.checks.find((c: { id: string }) => c.id === "url-bucket");
    assert.ok(urlBucket);
    assert.equal(urlBucket.ok, false);
    assert.equal(urlBucket.severity, "gate-blocking");
    assert.match(urlBucket.result.error, /exceção não tratada ao ler\/parsear/);

    const sectionCounts = out.checks.find((c: { id: string }) => c.id === "section-counts");
    assert.ok(sectionCounts);
    assert.equal(sectionCounts.ok, false);
    assert.match(sectionCounts.result.error, /exceção não tratada ao ler\/parsear/);

    // Checks independentes (não leem 01-approved-capped.json) continuam
    // presentes com veredito normal — engolir o crash perderia justamente
    // estes.
    const minChars = out.checks.find((c: { id: string }) => c.id === "destaque-min-chars");
    assert.ok(minChars);
    assert.deepEqual(minChars.result, checkDestaqueMinChars(buildMd()));

    const aprofunde = out.checks.find((c: { id: string }) => c.id === "aprofunde-format");
    assert.ok(aprofunde);
    assert.deepEqual(aprofunde.result, checkAprofundeFormat(buildMd()));

    // Todos os 6 checks continuam presentes.
    assert.equal(out.checks.length, 6);

    rmSync(dir, { recursive: true, force: true });
  });

  it("Stage 2: função exportada também isola a exceção (sem passar pelo CLI)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-stage2-malformed-direct-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "02-draft.md"), buildMd());
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), "not json at all");

    assert.doesNotThrow(() => runStage2LintReport(dir, PROJECT_ROOT));
    const report = runStage2LintReport(dir, PROJECT_ROOT);
    assert.equal(report.passed, false);
    const urlBucket = report.checks.find((c) => c.id === "url-bucket");
    assert.equal(urlBucket?.ok, false);
    const whyLength = report.checks.find((c) => c.id === "why-matters-length");
    assert.deepEqual(whyLength?.result, checkWhyMattersLength(buildMd()));

    rmSync(dir, { recursive: true, force: true });
  });
});
