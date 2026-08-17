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
  resolveCacReportWindow,
  formatCacReportMarkdown,
  main,
  DEFAULT_BACKUP_ROOT,
  DEFAULT_SPEND_CSV_PATH,
  DEFAULT_ORIGEM_MAP_PATH,
} from "../scripts/cac-report.ts";
import { buildCacReport, computeMonthBudgetUsage } from "../scripts/lib/cac.ts";
import { parseSinceToEpochSeconds, parseUntilToEpochSecondsExclusive } from "../scripts/cohort-engagement.ts";
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

  it("defaults --desde/--ate para null", () => {
    const args = parseCacReportArgs([]);
    assert.equal(args.desde, null);
    assert.equal(args.ate, null);
  });

  it("--desde/--ate", () => {
    const args = parseCacReportArgs(["--desde", "2026-08-01", "--ate", "2026-08-16"]);
    assert.equal(args.desde, "2026-08-01");
    assert.equal(args.ate, "2026-08-16");
  });
});

describe("resolveCacReportWindow (#5495)", () => {
  it("nenhuma flag -> null (sem janela)", () => {
    assert.equal(resolveCacReportWindow({ desde: null, ate: null }), null);
  });

  it("--desde sozinho -> since preenchido, untilExclusive null", () => {
    const window = resolveCacReportWindow({ desde: "2026-08-01", ate: null });
    assert.equal(window!.since, parseSinceToEpochSeconds("2026-08-01"));
    assert.equal(window!.untilExclusive, null);
  });

  it("--desde + --ate -> janela fechada, ate INCLUSIVO (borda seguinte exclusiva)", () => {
    const window = resolveCacReportWindow({ desde: "2026-08-01", ate: "2026-08-16" });
    assert.equal(window!.since, parseSinceToEpochSeconds("2026-08-01"));
    assert.equal(window!.untilExclusive, parseUntilToEpochSecondsExclusive("2026-08-16"));
  });

  it("--desde depois de --ate lança (janela invertida)", () => {
    assert.throws(() => resolveCacReportWindow({ desde: "2026-08-16", ate: "2026-08-01" }), /janela inválida/);
  });

  it("formato inválido lança", () => {
    assert.throws(() => resolveCacReportWindow({ desde: "16/08/2026", ate: null }));
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

  it("sem janela: linha explícita 'nenhuma janela aplicada', nunca omissa (#5495)", () => {
    const spendRows: SpendRow[] = [{ canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "teste" }];
    const report = buildCacReport(spendRows, []);
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget);
    assert.match(md, /Nenhuma janela de cadastro aplicada/);
  });

  it("com janela: registra a janela aplicada e o descarte por created ausente no corpo (#5495)", () => {
    const spendRows: SpendRow[] = [{ canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "teste" }];
    const window = { since: parseSinceToEpochSeconds("2026-08-01"), untilExclusive: parseUntilToEpochSecondsExclusive("2026-08-16") };
    const report = buildCacReport(spendRows, [], { window });
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget);
    assert.match(md, /Janela de cadastro aplicada.*2026-08-01 a 2026-08-16/);
  });

  it("procedência (apuradoEm/snapshotDate) aparece no corpo quando informada (#5495)", () => {
    const spendRows: SpendRow[] = [{ canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "teste" }];
    const report = buildCacReport(spendRows, []);
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget, { apuradoEm: "2026-08-17T00:00:00.000Z", snapshotDate: "2026-08-16" });
    assert.match(md, /Apurado em: 2026-08-17T00:00:00\.000Z/);
    assert.match(md, /Snapshot Beehiiv usado: 2026-08-16/);
  });

  it("tabela inclui coluna Sub-canal com valor da linha (#5496)", () => {
    const spendRows: SpendRow[] = [{ canal: "Google Ads", subcanal: "PMax", mes: "2026-02", moeda: "BRL", valor: 718.39, fonte: "teste" }];
    const report = buildCacReport(spendRows, []);
    const budget = computeMonthBudgetUsage(spendRows, "2026-08");
    const md = formatCacReportMarkdown(report, budget);
    assert.match(md, /\| Sub-canal \|/);
    assert.match(md, /\| Google Ads \| PMax \|/);
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

  it("--desde/--ate: exclui cadastro fora da janela, id do relatório carrega sufixo de janela (#5495)", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-report-window-"));
    try {
      const backupRoot = join(root, "beehiiv-backup");
      const snapshotDir = join(backupRoot, "2026-08-14");
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(
        join(snapshotDir, "subscribers.jsonl"),
        [
          subscriberLine({ email: "dentro@example.com", created: Math.floor(Date.UTC(2026, 7, 10) / 1000) }),
          subscriberLine({ email: "fora@example.com", created: Math.floor(Date.UTC(2026, 0, 1) / 1000) }),
        ].join("\n") + "\n",
        "utf8",
      );

      const spendPath = join(root, "spend.csv");
      writeFileSync(spendPath, "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\n", "utf8");

      main(
        ["--root", backupRoot, "--spend", spendPath, "--origem", join(root, "sem-origem.json"), "--desde", "2026-08-01", "--ate", "2026-08-16"],
        root,
      );

      const reportPath = join(root, "data", "aquisicao", "cac-reports", "2026-08-14--w2026-08-01_2026-08-16.md");
      assert.ok(existsSync(reportPath), "report.md com sufixo de janela deveria ter sido escrito");
      const md = readFileSync(reportPath, "utf8");
      assert.match(md, /Janela de cadastro aplicada.*2026-08-01 a 2026-08-16/);

      const registryPath = join(root, "data", "reports", "index.jsonl");
      const lines = readFileSync(registryPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(lines.find((l) => l.id === "cac-2026-08-14--w2026-08-01_2026-08-16"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--desde inválido (formato errado) -> exit 1, nenhum report escrito", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-report-badwindow-"));
    try {
      const backupRoot = join(root, "beehiiv-backup");
      mkdirSync(join(backupRoot, "2026-08-14"), { recursive: true });
      writeFileSync(join(backupRoot, "2026-08-14", "subscribers.jsonl"), subscriberLine() + "\n", "utf8");
      const spendPath = join(root, "spend.csv");
      writeFileSync(spendPath, "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\n", "utf8");

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--root", backupRoot, "--spend", spendPath, "--desde", "not-a-date"], root);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.equal(exit, 1);
      assert.equal(existsSync(join(root, "data", "aquisicao", "cac-reports")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
