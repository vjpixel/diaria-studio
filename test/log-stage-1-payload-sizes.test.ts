import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildReport,
  listInternalJsonFiles,
  payloadLevel,
  PAYLOAD_WARN_BYTES,
  PAYLOAD_ERROR_BYTES,
} from "../scripts/log-stage-1-payload-sizes.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..");

function makeFixture(): { root: string; internalDir: string; edition: string } {
  const root = mkdtempSync(join(tmpdir(), "stage1-payload-sizes-"));
  const editionDir = join(root, "data", "editions", "260507");
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  return { root, internalDir, edition: "260507" };
}

describe("listInternalJsonFiles (#891)", () => {
  it("retorna [] quando _internal/ não existe", () => {
    const root = mkdtempSync(join(tmpdir(), "stage1-payload-empty-"));
    try {
      const files = listInternalJsonFiles(join(root, "missing"));
      assert.deepEqual(files, []);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("lista apenas .json, ignorando .md/.bak/etc", () => {
    const { root, internalDir } = makeFixture();
    try {
      writeFileSync(join(internalDir, "researcher-results.json"), "[]");
      writeFileSync(join(internalDir, "01-categorized.json"), "{}");
      writeFileSync(join(internalDir, "01-categorized.md.bak-2026-05-07"), "stale md");
      writeFileSync(join(internalDir, "cost.md"), "# cost");
      writeFileSync(join(internalDir, "01-categorized.json.pre-refinement.bak"), "{}");

      const files = listInternalJsonFiles(internalDir);
      const names = files.map((f) => f.split(/[\\/]/).pop()).sort();
      assert.deepEqual(names, ["01-categorized.json", "researcher-results.json"]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("ignora subdir link-verify-bodies (cache de raw HTML, não payload de agent)", () => {
    const { root, internalDir } = makeFixture();
    try {
      writeFileSync(join(internalDir, "link-verify-all.json"), "[]");
      const bodiesDir = join(internalDir, "link-verify-bodies");
      mkdirSync(bodiesDir, { recursive: true });
      writeFileSync(join(bodiesDir, "001.html"), "<html>...</html>");
      writeFileSync(join(bodiesDir, "002.json"), "{\"oops\":true}");

      const files = listInternalJsonFiles(internalDir);
      const names = files.map((f) => f.split(/[\\/]/).pop());
      assert.deepEqual(names, ["link-verify-all.json"]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("ignora subdir _forensic/ (#959 — link-verify-bodies movido pra lá)", () => {
    const { root, internalDir } = makeFixture();
    try {
      writeFileSync(join(internalDir, "01-approved.json"), "{}");
      const forensicDir = join(internalDir, "_forensic");
      const bodiesDir = join(forensicDir, "link-verify-bodies");
      mkdirSync(bodiesDir, { recursive: true });
      writeFileSync(join(bodiesDir, "001.html"), "<html>...</html>");
      writeFileSync(join(forensicDir, "raw-research.json"), "{}");

      const files = listInternalJsonFiles(internalDir);
      const names = files.map((f) => f.split(/[\\/]/).pop());
      assert.deepEqual(names, ["01-approved.json"]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("ignora _test-backup-* dirs", () => {
    const { root, internalDir } = makeFixture();
    try {
      writeFileSync(join(internalDir, "01-approved.json"), "{}");
      const backupDir = join(internalDir, "_test-backup-20260505-181634");
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, "01-approved.json"), "{}");

      const files = listInternalJsonFiles(internalDir);
      assert.equal(files.length, 1);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("buildReport (#891)", () => {
  it("agrega bytes e calcula tokens estimados", () => {
    const { root, internalDir, edition } = makeFixture();
    try {
      // 100 bytes
      writeFileSync(join(internalDir, "researcher-results.json"), "x".repeat(100));
      // 200 bytes
      writeFileSync(join(internalDir, "tmp-articles-raw.json"), "y".repeat(200));

      const report = buildReport({
        edition,
        internalDir,
        repoRoot: root,
        now: new Date("2026-05-07T12:00:00.000Z"),
      });

      assert.equal(report.edition, "260507");
      assert.equal(report.generated_at, "2026-05-07T12:00:00.000Z");
      assert.equal(report.totals.file_count, 2);
      assert.equal(report.totals.bytes, 300);
      // 1 token ≈ 4 bytes — 300 * 0.25 = 75
      assert.equal(report.totals.est_tokens, 75);
      assert.equal(report.files.length, 2);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("top_3 ordena por bytes desc, máx 3", () => {
    const { root, internalDir, edition } = makeFixture();
    try {
      writeFileSync(join(internalDir, "small.json"), "a".repeat(10));
      writeFileSync(join(internalDir, "huge.json"), "b".repeat(10000));
      writeFileSync(join(internalDir, "medium.json"), "c".repeat(500));
      writeFileSync(join(internalDir, "tiny.json"), "d".repeat(5));

      const report = buildReport({ edition, internalDir, repoRoot: root });
      assert.equal(report.top_3.length, 3);
      assert.ok(report.top_3[0].path.endsWith("huge.json"));
      assert.ok(report.top_3[1].path.endsWith("medium.json"));
      assert.ok(report.top_3[2].path.endsWith("small.json"));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("top_3 com tie em bytes: ordem é estável (alfabética por filename)", () => {
    // Array.sort() é estável desde ES2019. Como listInternalJsonFiles já retorna
    // os arquivos em ordem alfabética, ties em `bytes` preservam essa ordem no
    // sort decrescente — garantia explícita para evitar regressão futura.
    const { root, internalDir, edition } = makeFixture();
    try {
      writeFileSync(join(internalDir, "a-large.json"), "x".repeat(100));
      writeFileSync(join(internalDir, "b-medium.json"), "y".repeat(50));
      writeFileSync(join(internalDir, "c-medium.json"), "z".repeat(50));

      const report1 = buildReport({ edition, internalDir, repoRoot: root });
      const report2 = buildReport({ edition, internalDir, repoRoot: root });
      const report3 = buildReport({ edition, internalDir, repoRoot: root });

      assert.equal(report1.top_3.length, 3);
      assert.ok(report1.top_3[0].path.endsWith("a-large.json"));
      assert.equal(report1.top_3[0].bytes, 100);
      // Tie em 50 bytes entre b-medium.json e c-medium.json — alfabética desempata
      assert.ok(
        report1.top_3[1].path.endsWith("b-medium.json"),
        `expected b-medium.json second, got: ${report1.top_3[1].path}`
      );
      assert.equal(report1.top_3[1].bytes, 50);
      assert.ok(
        report1.top_3[2].path.endsWith("c-medium.json"),
        `expected c-medium.json third, got: ${report1.top_3[2].path}`
      );
      assert.equal(report1.top_3[2].bytes, 50);

      // Determinismo: runs consecutivos produzem mesmo top_3
      assert.deepEqual(report2.top_3, report1.top_3);
      assert.deepEqual(report3.top_3, report1.top_3);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("paths são relativos ao repo root, com separadores POSIX", () => {
    const { root, internalDir, edition } = makeFixture();
    try {
      writeFileSync(join(internalDir, "researcher-results.json"), "{}");
      const report = buildReport({ edition, internalDir, repoRoot: root });
      assert.equal(report.files.length, 1);
      const path = report.files[0].path;
      assert.ok(path.includes("/"), `expected POSIX separator, got: ${path}`);
      assert.ok(!path.includes("\\"), `expected no backslash, got: ${path}`);
      assert.ok(path.endsWith("_internal/researcher-results.json"));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("_internal/ vazio retorna report bem-formado com totals zerados", () => {
    const { root, internalDir, edition } = makeFixture();
    try {
      const report = buildReport({ edition, internalDir, repoRoot: root });
      assert.equal(report.totals.file_count, 0);
      assert.equal(report.totals.bytes, 0);
      assert.equal(report.totals.est_tokens, 0);
      assert.deepEqual(report.files, []);
      assert.deepEqual(report.top_3, []);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("_internal/ inexistente também retorna report vazio (não crash)", () => {
    const root = mkdtempSync(join(tmpdir(), "stage1-payload-missing-"));
    try {
      const report = buildReport({
        edition: "260507",
        internalDir: join(root, "missing"),
        repoRoot: root,
      });
      assert.equal(report.totals.file_count, 0);
      assert.deepEqual(report.files, []);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("payloadLevel ratchet (#891, recalibrado #1203)", () => {
  it("info quando bytes < 1MB (baseline saudável)", () => {
    assert.equal(payloadLevel(0), "info");
    assert.equal(payloadLevel(150 * 1024), "info");
    // Baseline 260507 pós-cap (243K) cai em info — pipeline saudável.
    assert.equal(payloadLevel(243 * 1024), "info");
    // 260517 baseline (~987K) cai em info — pipeline cresceu com checkpoints
    // intermediários mas dentro do esperado.
    assert.equal(payloadLevel(700 * 1024), "info");
    assert.equal(payloadLevel(PAYLOAD_WARN_BYTES - 1), "info");
  });

  it("warn quando bytes >= 1MB e < 2.5MB", () => {
    assert.equal(payloadLevel(PAYLOAD_WARN_BYTES), "warn");
    assert.equal(payloadLevel(1.5 * 1024 * 1024), "warn");
    assert.equal(payloadLevel(PAYLOAD_ERROR_BYTES - 1), "warn");
  });

  it("error quando bytes >= 2.5MB (regressão real)", () => {
    assert.equal(payloadLevel(PAYLOAD_ERROR_BYTES), "error");
    assert.equal(payloadLevel(3 * 1024 * 1024), "error");
    // Cenário do bug original 561KB pré-cap não cai mais em error
    // (era 309% do limite de 700K; agora é 22% do limite de 2.5MB).
    // Recalibração: error = território de context overflow real,
    // não falso-positivo de pipeline com muitos checkpoints.
  });

  it("constants exportadas: warn=1MB, error=2.5MB (#1203)", () => {
    assert.equal(PAYLOAD_WARN_BYTES, 1024 * 1024);
    assert.equal(PAYLOAD_ERROR_BYTES, 2.5 * 1024 * 1024);
  });
});

describe("CLI (#4278: disk-aware via resolveEditionDir, layout nested)", () => {
  // #3484/#3496 pattern (ver test/log-runtime-fix.test.ts): cwd fica em
  // PROJECT_ROOT (senão `--import tsx` não resolve o pacote a partir de um
  // tmpdir fora da árvore do projeto) e o isolamento do `data/editions/` REAL
  // (junction OneDrive nesta máquina) é feito via `--editions-dir` explícito
  // apontando pro fixture tmpdir — nunca lendo/escrevendo a árvore de verdade.
  // `--log-path` isola também o `data/run-log.jsonl` REAL pelo mesmo motivo
  // (cwd == PROJECT_ROOT faria o script escrever lá sem o override).
  function runCli(args: string[], logDir: string) {
    return spawnSync(
      process.execPath,
      [
        "--import", "tsx", join(PROJECT_ROOT, "scripts", "log-stage-1-payload-sizes.ts"),
        ...args,
        "--log-path", join(logDir, "run-log.jsonl"),
      ],
      { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 15000 },
    );
  }

  it("edição no layout nested (data/editions/{AAMM}/{AAMMDD}) grava o relatório no diretório REAL, não num flat órfão", () => {
    // Fixture reproduz o caso real da edição 260729: a edição só existe no
    // disco no layout nested (#2463/#3024). Antes do #4278, o script montava
    // `data/editions/{AAMMDD}` à mão e criava um diretório flat órfão em vez
    // de escrever no diretório real — e reportava 0 arquivos.
    const editionsDir = mkdtempSync(join(tmpdir(), "stage1-payload-cli-nested-"));
    try {
      const nestedInternalDir = join(editionsDir, "2607", "260729", "_internal");
      mkdirSync(nestedInternalDir, { recursive: true });
      writeFileSync(join(nestedInternalDir, "01-approved.json"), "{}");

      const result = runCli(["--edition", "260729", "--editions-dir", editionsDir], editionsDir);
      assert.equal(result.status, 0, result.stderr);

      const nestedReportPath = join(nestedInternalDir, "01-payload-sizes.json");
      assert.ok(existsSync(nestedReportPath), `relatório deveria existir no diretório nested real: ${nestedReportPath}`);
      const report = JSON.parse(readFileSync(nestedReportPath, "utf8"));
      // No momento da geração só 01-approved.json estava presente em
      // _internal/ — 1 arquivo, não 0 (o bug original reportava 0 porque
      // olhava pro diretório flat órfão, sempre vazio).
      assert.equal(report.totals.file_count, 1, "deveria contar o 01-approved.json fixture, não reportar 0");

      const flatOrphanReportPath = join(editionsDir, "260729", "_internal", "01-payload-sizes.json");
      assert.ok(
        !existsSync(flatOrphanReportPath),
        `#4278: não deveria criar diretório flat órfão em ${flatOrphanReportPath}`,
      );
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("edição no layout flat legado (data/editions/{AAMMDD}) continua funcionando", () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "stage1-payload-cli-flat-"));
    try {
      const flatInternalDir = join(editionsDir, "260501", "_internal");
      mkdirSync(flatInternalDir, { recursive: true });
      writeFileSync(join(flatInternalDir, "01-approved.json"), "{}");

      const result = runCli(["--edition", "260501", "--editions-dir", editionsDir], editionsDir);
      assert.equal(result.status, 0, result.stderr);

      const reportPath = join(flatInternalDir, "01-payload-sizes.json");
      assert.ok(existsSync(reportPath), `relatório deveria existir no diretório flat: ${reportPath}`);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("edição ainda não criada em disco (nenhum layout existente) cai no default nested — não quebra", () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "stage1-payload-cli-none-"));
    try {
      const result = runCli(["--edition", "260601", "--editions-dir", editionsDir], editionsDir);
      assert.equal(result.status, 0, result.stderr);
      const reportPath = join(editionsDir, "2606", "260601", "_internal", "01-payload-sizes.json");
      assert.ok(existsSync(reportPath), `relatório deveria existir no default nested: ${reportPath}`);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("--edition-dir explícito continua tendo prioridade sobre resolveEditionDir()", () => {
    const root = mkdtempSync(join(tmpdir(), "stage1-payload-cli-override-"));
    try {
      const customDir = join(root, "custom-dir");
      mkdirSync(join(customDir, "_internal"), { recursive: true });
      writeFileSync(join(customDir, "_internal", "x.json"), "{}");

      const result = runCli(["--edition", "260501", "--edition-dir", customDir], root);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(customDir, "_internal", "01-payload-sizes.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
