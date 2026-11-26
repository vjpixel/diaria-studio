/**
 * test/register-report-avulso-14069.test.ts (#14069)
 *
 * Relatório AVULSO (auditoria, revisão de repo, investigação) não tinha como
 * entrar na superfície de Relatórios do Studio: `register-report.ts` só
 * aceitava os kinds de pipeline, e usar `develop` como contorno caía no
 * `assertTitleMatchesReport` (#5521), que confere contagens de unidades que
 * um avulso não tem.
 *
 * Os casos de CLI rodam o `register-report.ts` real com `--root` num tmpdir:
 * nada aqui escreve no `data/reports/` real (sincronizado entre máquinas,
 * alimenta o /relatorios do editor).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAvulsoSessionId,
  isReportKind,
  listReports,
  listRegistryFiles,
  registerReport,
  resolveReportHtml,
  REPORT_KINDS,
} from "../scripts/lib/reports-registry.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "scripts", "register-report.ts");

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "reg-avulso-14069-"));
  return root;
}

function writeReport(r: string, rel: string, content: string): void {
  const abs = join(r, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function runCli(r: string, args: string[]) {
  const res = spawnSync(process.execPath, ["--import", "tsx", CLI, "--root", r, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, DIARIA_TEST_CREDENTIALS_PATH: "/nonexistent-14069" },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("kind avulso no registro (#14069)", () => {
  it("é um kind válido e os antigos seguem válidos", () => {
    assert.equal(isReportKind("avulso"), true);
    for (const k of ["edicao", "overnight", "develop", "mensal", "clarice-novos", "cac"]) {
      assert.equal(isReportKind(k), true, k);
    }
    assert.equal(isReportKind("auditoria"), false);
    assert.ok(REPORT_KINDS.includes("avulso"));
  });

  it("isAvulsoSessionId exige AAMMDD-slug", () => {
    assert.equal(isAvulsoSessionId("261125-revisao-13984"), true);
    assert.equal(isAvulsoSessionId("261125-x"), true);
    assert.equal(isAvulsoSessionId("revisao-13984"), false);
    assert.equal(isAvulsoSessionId("261125"), false);
    assert.equal(isAvulsoSessionId("261125-Revisao"), false);
    assert.equal(isAvulsoSessionId("261125-revisao--x"), false);
    assert.equal(isAvulsoSessionId("261125-../x"), false);
  });

  it("registerReport grava o avulso e listReports/resolveReportHtml o servem (markdown)", () => {
    const r = makeRoot();
    writeReport(r, "data/reports/avulso/261125-revisao.md", "# Revisão\n\n**3 achados**");
    const res = registerReport(r, {
      kind: "avulso",
      sessionId: "261125-revisao",
      title: "Revisão do repo",
      htmlPath: "data/reports/avulso/261125-revisao.md",
    });
    assert.equal(res.ok, true);
    const [entry] = listReports(r);
    assert.equal(entry.id, "avulso-261125-revisao");
    assert.equal(entry.kind, "avulso");
    assert.equal(entry.url, "/relatorios/avulso-261125-revisao");
    const html = resolveReportHtml(r, entry);
    assert.equal(html.ok, true);
    assert.match(html.html, /<strong>3 achados<\/strong>/);
  });
});

describe("register-report.ts --kind avulso (#14069)", () => {
  it("REGRESSÃO: aceita o avulso, grava a entrada com os campos e imprime a URL", () => {
    const r = makeRoot();
    writeReport(r, "data/reports/avulso/261125-revisao-13984.html", "<!doctype html><p>ok</p>");
    const out = runCli(r, [
      "--kind", "avulso",
      "--id", "261125-revisao-13984",
      "--title", "Revisão do repo (#13984) — 12 achados",
      "--html-path", "data/reports/avulso/261125-revisao-13984.html",
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /\/relatorios\/avulso-261125-revisao-13984\s*$/);
    // Sem a conferência de contagem do #5521 (nenhum aviso de "título NÃO conferido").
    assert.doesNotMatch(out.stderr, /NÃO conferido/);

    const entries = listReports(r);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "avulso");
    assert.equal(entries[0].sessionId, "261125-revisao-13984");
    assert.equal(entries[0].title, "Revisão do repo (#13984) — 12 achados");
    assert.equal(entries[0].htmlPath, "data/reports/avulso/261125-revisao-13984.html");
    assert.ok(entries[0].createdAt, "data do registro gravada");
    // Escreveu no tmpdir, não no registro do repo.
    assert.ok(listRegistryFiles(r).length >= 1);
  });

  it("avulso com id sem data sai 2 e não registra", () => {
    const r = makeRoot();
    writeReport(r, "data/reports/avulso/x.md", "# x");
    const out = runCli(r, ["--kind", "avulso", "--id", "revisao", "--title", "x", "--html-path", "data/reports/avulso/x.md"]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /AAMMDD-slug/);
    assert.deepEqual(listRegistryFiles(r), [], "nenhum arquivo de registro criado");
  });

  it("avulso com arquivo que não é .html/.md sai 2 e não registra", () => {
    const r = makeRoot();
    const out = runCli(r, ["--kind", "avulso", "--id", "261125-x", "--title", "x", "--html-path", "data/reports/avulso/x.pdf"]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /\.html nem \.md/);
    assert.equal(existsSync(join(r, "data", "reports")), false);
  });

  it("kind inválido continua rejeitado, e o uso lista o avulso entre os kinds", () => {
    const r = makeRoot();
    const out = runCli(r, ["--kind", "auditoria", "--id", "261125-x", "--title", "x", "--html-path", "x.md"]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /--kind \{edicao\|overnight\|develop\|mensal\|[^}]*avulso\}/);
    assert.equal(existsSync(join(r, "data", "reports")), false);
  });

  it("kind antigo (edicao) segue registrando como antes", () => {
    const r = makeRoot();
    writeReport(r, "data/editions/261126/_internal/edition-report.html", "<p>ok</p>");
    const out = runCli(r, [
      "--kind", "edicao",
      "--id", "261126",
      "--title", "Edição 261126",
      "--html-path", "data/editions/261126/_internal/edition-report.html",
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(listReports(r)[0].id, "edicao-261126");
  });
});
