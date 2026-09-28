/**
 * test/cac-report-ltv.test.ts (#8423)
 *
 * Cobertura da seção "LTV vs. custo" de `scripts/cac-report.ts`:
 * `computeLtvSection` (fail-soft, reusa `scripts/lib/ltv.ts`) e a
 * renderização markdown correspondente em `formatCacReportMarkdown`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeLtvSection,
  formatCacReportMarkdown,
  parseCacReportArgs,
  type CacReportLtvSection,
} from "../scripts/cac-report.ts";
import { buildCacReport, computeMonthBudgetUsage } from "../scripts/lib/cac.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "cac-report-ltv-"));
}

function sub(overrides: Record<string, unknown> = {}): BeehiivBackupSubscriber {
  return {
    email: "leitor@example.com",
    status: "active",
    created: 1755000000,
    utm_source: "google-ads",
    utm_medium: "cpc",
    utm_campaign: "",
    referring_site: "",
    ...overrides,
  } as BeehiivBackupSubscriber;
}

function writeSnapshotDir(root: string, date: string, subs: BeehiivBackupSubscriber[]): void {
  const dir = join(root, "beehiiv-backup", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subscribers.jsonl"), subs.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
}

function spendRow(canal: string, valor: number): SpendRow {
  return { canal, mes: "2026-09", moeda: "BRL", valor, fonte: "teste" };
}

describe("parseCacReportArgs — --no-ltv (#8423)", () => {
  it("ltv default true (liga), --no-ltv desliga", () => {
    assert.equal(parseCacReportArgs([]).ltv, true);
    assert.equal(parseCacReportArgs(["--no-ltv"]).ltv, false);
  });
});

describe("computeLtvSection", () => {
  it("sem 2 snapshots suficientemente espaçados: applied:true, ltvFaixaBrl:null, motivo explícito", () => {
    const root = makeRoot();
    try {
      writeSnapshotDir(root, "2026-09-09", [sub({ email: "a@x.com" })]);
      const backupRoot = join(root, "beehiiv-backup");
      const subs = [sub({ email: "a@x.com" })];
      const report = buildCacReport([spendRow("Google Ads", 100)], subs);

      const section = computeLtvSection(report, subs, backupRoot, "2026-09-09", root, () => new Date("2026-09-15T12:00:00Z"), {});
      assert.equal(section.applied, true);
      if (section.applied) {
        assert.equal(section.ltvFaixaBrl, null);
        assert.ok(section.motivo);
        assert.equal(section.rows.length, 0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("com receita, base ativa e 2 snapshots espaçados: LTV em faixa + LTV÷CAC por canal", () => {
    const root = makeRoot();
    try {
      const backupRoot = join(root, "beehiiv-backup");
      writeSnapshotDir(root, "2026-08-10", [
        sub({ email: "a@x.com", status: "active" }),
        sub({ email: "b@x.com", status: "active" }),
      ]);
      const latestSubs = [sub({ email: "a@x.com", status: "active" }), sub({ email: "b@x.com", status: "inactive" })];
      writeSnapshotDir(root, "2026-09-09", latestSubs);

      // apoia.se — mês FECHADO (agosto)
      const apoiaSeDir = join(root, "data", "apoia-se", "diaria");
      mkdirSync(apoiaSeDir, { recursive: true });
      writeFileSync(
        join(apoiaSeDir, "2026-08.json"),
        JSON.stringify({ "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 20 } }),
        "utf8",
      );
      // Amazon
      const ltvDir = join(root, "data", "ltv");
      mkdirSync(ltvDir, { recursive: true });
      writeFileSync(join(ltvDir, "amazon-revenue.json"), JSON.stringify({ valorMensalBrl: 40, atualizadoEm: "2026-09-01T00:00:00Z" }), "utf8");

      const report = buildCacReport([spendRow("Google Ads", 100)], latestSubs);

      const section = computeLtvSection(report, latestSubs, backupRoot, "2026-09-09", root, () => new Date("2026-09-15T12:00:00Z"), {});
      assert.equal(section.applied, true);
      if (section.applied) {
        assert.ok(section.ltvFaixaBrl, "LTV deveria ser computável com receita + churn disponíveis");
        assert.ok(section.ltvFaixaBrl!.min > 0);
        assert.ok(section.ltvFaixaBrl!.max >= section.ltvFaixaBrl!.min);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("formatCacReportMarkdown — seção LTV vs. custo (#8423)", () => {
  const subs = [sub({ email: "a@x.com" })];
  const report = buildCacReport([spendRow("Google Ads", 100)], subs);
  const budget = computeMonthBudgetUsage([spendRow("Google Ads", 100)], "2026-09", 4000);

  it("sem ltvSection -> nenhuma menção à seção (comportamento default preservado)", () => {
    const md = formatCacReportMarkdown(report, budget, {}, undefined, undefined, []);
    assert.doesNotMatch(md, /LTV vs\. custo/);
  });

  it("ltvSection applied:false -> aparece com o aviso, nunca some em silêncio", () => {
    const section: CacReportLtvSection = { applied: false, reason: "motivo de teste" };
    const md = formatCacReportMarkdown(report, budget, {}, undefined, undefined, [], section);
    assert.match(md, /LTV vs\. custo/);
    assert.match(md, /motivo de teste/);
  });

  it("ltvSection applied:true com ltvFaixaBrl:null -> aviso explícito, nunca 0/omissão", () => {
    const section: CacReportLtvSection = { applied: true, ltvFaixaBrl: null, motivo: "sem churn suficiente", rows: [] };
    const md = formatCacReportMarkdown(report, budget, {}, undefined, undefined, [], section);
    assert.match(md, /LTV de caixa indisponível/);
    assert.match(md, /sem churn suficiente/);
  });

  it("ltvSection completa -> faixa de LTV + tabela por canal", () => {
    const section: CacReportLtvSection = {
      applied: true,
      ltvFaixaBrl: { min: 14, max: 16 },
      motivo: null,
      rows: [{ canal: "Google Ads", custoPorLeitor: 5, ltvCacRatio: 3 }],
    };
    const md = formatCacReportMarkdown(report, budget, {}, undefined, undefined, [], section);
    assert.match(md, /LTV de caixa \(blended\)/);
    assert.match(md, /Google Ads/);
    assert.match(md, /3\.00/);
  });
});
