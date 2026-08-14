/**
 * test/cac-report.test.ts (#5236 Parte 2)
 *
 * Camada CLI de `scripts/cac-report.ts`: parsing de flags, formatação
 * markdown, e um caminho end-to-end com fixtures em tmpdir (snapshot +
 * spend.csv) verificando exit codes e o registro em `data/reports/index.jsonl`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCacReportArgs,
  formatCacReportMarkdown,
  main,
  DEFAULT_BACKUP_ROOT,
  DEFAULT_SPEND_CSV_PATH,
  DEFAULT_ORIGEM_MAP_PATH,
} from "../scripts/cac-report.ts";
import { buildCacReport, computeMonthBudgetUsage } from "../scripts/lib/cac.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

describe("parseCacReportArgs", () => {
  it("defaults", () => {
    const args = parseCacReportArgs([]);
    assert.equal(args.backupRoot, DEFAULT_BACKUP_ROOT);
    assert.equal(args.spendPath, DEFAULT_SPEND_CSV_PATH);
    assert.equal(args.origemPath, DEFAULT_ORIGEM_MAP_PATH);
    assert.equal(args.snapshotDate, null);
    assert.equal(args.json, false);
    assert.equal(args.register, true);
  });

  it("--no-register desliga o registro", () => {
    assert.equal(parseCacReportArgs(["--no-register"]).register, false);
  });

  it("--json/--snapshot/--root/--spend/--origem", () => {
    const args = parseCacReportArgs([
      "--json",
      "--snapshot",
      "2026-08-14",
      "--root",
      "/x",
      "--spend",
      "/y.csv",
      "--origem",
      "/z.json",
    ]);
    assert.equal(args.json, true);
    assert.equal(args.snapshotDate, "2026-08-14");
    assert.equal(args.backupRoot, "/x");
    assert.equal(args.spendPath, "/y.csv");
    assert.equal(args.origemPath, "/z.json");
  });
});

describe("formatCacReportMarkdown", () => {
  it("inclui header, tabela e aviso quando mapa de origem não foi aplicado", () => {
    const spendRows: SpendRow[] = [
      { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "teste" },
    ];
    const report = buildCacReport(spendRows, []);
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget);
    assert.match(md, /# Custo por leitor por canal/);
    assert.match(md, /Google Ads/);
    assert.match(md, /mapa de origem recuperada NÃO aplicado/);
  });

  it("não emite o aviso de origem quando originApplied=true", () => {
    const spendRows: SpendRow[] = [
      { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "teste" },
    ];
    const report = buildCacReport(spendRows, [], { originApplied: true });
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget);
    assert.doesNotMatch(md, /NÃO aplicado/);
  });

  it("emite aviso de canal desconhecido quando spend.csv tem um nome fora do mapeamento (finding 4 #5236)", () => {
    const spendRows: SpendRow[] = [
      { canal: "Beehiiv Boost", mes: "2026-07", moeda: "BRL", valor: 397.08, fonte: "teste" }, // typo, sem "s"
    ];
    const report = buildCacReport(spendRows, []);
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget);
    assert.match(md, /canal\(is\) desconhecido\(s\) em spend\.csv/);
    assert.match(md, /Beehiiv Boost\b/);
  });

  it("não emite aviso de canal desconhecido quando todos os canais são reconhecidos", () => {
    const spendRows: SpendRow[] = [
      { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "teste" },
    ];
    const report = buildCacReport(spendRows, []);
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget);
    assert.doesNotMatch(md, /canal\(is\) desconhecido/);
  });

  it("linha de Beehiiv Boosts mostra faixa (en-dash entre mín e máx), nunca ponto único", () => {
    const spendRows: SpendRow[] = [
      { canal: "Beehiiv Boosts", mes: "2026-07", moeda: "BRL", valor: 397.08, fonte: "teste" },
    ];
    const report = buildCacReport(spendRows, []);
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget);
    assert.match(md, /R\$ \d+,\d\d–R\$ \d+,\d\d/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end com tmpdir — fixtures reais em disco
// ---------------------------------------------------------------------------

function subscriberLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: "leitor@example.com",
    status: "active",
    created: 1755000000,
    utm_source: "android.googlequicksearchbox",
    utm_medium: "cpc",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 40 },
    ...overrides,
  });
}

describe("main — end-to-end com fixtures em tmpdir", () => {
  it("gera report.md, registra em data/reports/index.jsonl, exit 0", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-report-e2e-"));
    try {
      const backupRoot = join(root, "beehiiv-backup");
      const snapshotDir = join(backupRoot, "2026-08-14");
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(
        join(snapshotDir, "subscribers.jsonl"),
        [subscriberLine({ email: "a@example.com" }), subscriberLine({ email: "b@example.com", utm_source: "direct" })].join("\n") + "\n",
        "utf8",
      );

      const spendPath = join(root, "spend.csv");
      writeFileSync(
        spendPath,
        "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\nBeehiiv Boosts,2026-07,BRL,397.08,teste\nLinkedIn,2026-08,BRL,0,teste\n",
        "utf8",
      );

      const origemPath = join(root, "origem-inexistente.json");

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--root", backupRoot, "--spend", spendPath, "--origem", origemPath], root);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.notEqual(exit, 1, "não deveria falhar com fixtures válidas");

      const reportPath = join(root, "data", "aquisicao", "cac-reports", "2026-08-14.md");
      assert.ok(existsSync(reportPath), "report.md deveria ter sido escrito");
      const md = readFileSync(reportPath, "utf8");
      assert.match(md, /Google Ads/);

      const registryPath = join(root, "data", "reports", "index.jsonl");
      assert.ok(existsSync(registryPath), "index.jsonl deveria ter sido escrito");
      const lines = readFileSync(registryPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const entry = lines.find((l) => l.id === "cac-2026-08-14");
      assert.ok(entry, "entrada cac-2026-08-14 deveria existir no registry");
      assert.equal(entry.kind, "cac");
      assert.equal(entry.url, "/relatorios/cac-2026-08-14");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--no-register não escreve em data/reports/index.jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-report-noreg-"));
    try {
      const backupRoot = join(root, "beehiiv-backup");
      const snapshotDir = join(backupRoot, "2026-08-14");
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(join(snapshotDir, "subscribers.jsonl"), subscriberLine() + "\n", "utf8");

      const spendPath = join(root, "spend.csv");
      writeFileSync(spendPath, "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\n", "utf8");

      main(["--root", backupRoot, "--spend", spendPath, "--origem", join(root, "sem-origem.json"), "--no-register"], root);

      assert.equal(existsSync(join(root, "data", "reports", "index.jsonl")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spend.csv ausente -> exit 1, nenhum report escrito", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-report-nospend-"));
    try {
      const backupRoot = join(root, "beehiiv-backup");
      mkdirSync(join(backupRoot, "2026-08-14"), { recursive: true });
      writeFileSync(join(backupRoot, "2026-08-14", "subscribers.jsonl"), subscriberLine() + "\n", "utf8");

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--root", backupRoot, "--spend", join(root, "nao-existe.csv")], root);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.equal(exit, 1);
      assert.equal(existsSync(join(root, "data", "aquisicao", "cac-reports")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nenhum snapshot encontrado -> exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-report-nosnap-"));
    try {
      const spendPath = join(root, "spend.csv");
      writeFileSync(spendPath, "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\n", "utf8");

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--root", join(root, "beehiiv-backup-vazio"), "--spend", spendPath], root);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.equal(exit, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
