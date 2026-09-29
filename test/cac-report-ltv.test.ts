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
  resolveLtvLatestSnapshotDate,
  type CacReportLtvSection,
} from "../scripts/cac-report.ts";
import { buildCacReport, computeMonthBudgetUsage, isInternalOrTestEmail, type CacReport } from "../scripts/lib/cac.ts";
import {
  computeArpu,
  computeChurnExitsBetweenSnapshots,
  computeChurnRate,
  computeLtvCaixaFaixa,
  LTV_DEFAULT_HORIZON_MONTHS,
} from "../scripts/lib/ltv.ts";
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

      const section = computeLtvSection(report, backupRoot, "2026-09-09", root, () => new Date("2026-09-15T12:00:00Z"), {});
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

      // `report.rows` é construído A MÃO (não via `buildCacReport`) porque
      // `custoPorLeitor` real exige subs com campo `stats` (leitor-v1) — o
      // que este teste não precisa simular pra validar `computeLtvSection`,
      // que só LÊ `report.rows` (nunca recalcula custo por leitor).
      const report = {
        rows: [
          {
            kind: "measured" as const,
            canal: "Google Ads",
            spend: spendRow("Google Ads", 100),
            cadastros: 2,
            ativos: 1,
            leitores: 20,
            pending: 0,
            inativos: 1,
            invalid: 0,
            outrosStatus: 0,
            custoPorLeitor: 5,
            aberturaAgregada: null,
            amostraConsiderada: 20,
            amostraInstavel: false,
            amostraVazia: false,
            amostraPequena: false,
            aberturaAgregadaAnterior: null,
            degradado: null,
            window: null,
            excludedMissingCreated: 0,
          },
        ],
      } as CacReport;

      const section = computeLtvSection(report, backupRoot, "2026-09-09", root, () => new Date("2026-09-15T12:00:00Z"), {});
      assert.equal(section.applied, true);
      if (section.applied) {
        assert.ok(section.ltvFaixaBrl, "LTV deveria ser computável com receita + churn disponíveis");
        assert.ok(section.ltvFaixaBrl!.min > 0);
        assert.ok(section.ltvFaixaBrl!.max >= section.ltvFaixaBrl!.min);

        // `rows` (#8423 fleet review — must-add): canal com gasto real
        // (spendRow) + subs atribuídos (utm_source=google-ads) tem que
        // aparecer com ltvCacRatio numérico coerente com o midpoint da
        // faixa acima. Desde #9023 o denominador é custo por ATIVO
        // (100 / 1 ativo), não o custo por leitor (5) — mesma unidade do LTV.
        assert.equal(section.rows.length, 1);
        assert.equal(section.rows[0].canal, "Google Ads");
        assert.equal(section.rows[0].custoPorLeitor, 5);
        assert.equal(section.rows[0].custoPorAtivo, 100);
        assert.ok(section.rows[0].ltvCacRatio != null);
        const midpoint = (section.ltvFaixaBrl!.min + section.ltvFaixaBrl!.max) / 2;
        assert.ok(Math.abs(section.rows[0].ltvCacRatio! - midpoint / 100) < 1e-6);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeLtvSection — mesma população nos dois lados do churn e no ARPU (#9023 item 1)", () => {
  // Conta interna ativa nos DOIS snapshots: `loadPreparedSubscribers`/o
  // store a removeriam da coorte do funil. Antes do fix, o lado "atual" do
  // diff era essa coorte filtrada e o baseline era o snapshot cru — a conta
  // interna contava como "saída" e o ARPU dividia pela contagem filtrada.
  const INTERNO = "pixel@memelab.com.br";

  function setup(root: string): string {
    const backupRoot = join(root, "beehiiv-backup");
    writeSnapshotDir(root, "2026-08-10", [
      sub({ email: "a@x.com", status: "active" }),
      sub({ email: "b@x.com", status: "active" }),
      sub({ email: INTERNO, status: "active" }),
    ]);
    writeSnapshotDir(root, "2026-09-09", [
      sub({ email: "a@x.com", status: "active" }),
      sub({ email: "b@x.com", status: "inactive" }),
      sub({ email: INTERNO, status: "active" }),
    ]);
    const ltvDir = join(root, "data", "ltv");
    mkdirSync(ltvDir, { recursive: true });
    writeFileSync(join(ltvDir, "amazon-revenue.json"), JSON.stringify({ valorMensalBrl: 30, atualizadoEm: "2026-09-01T00:00:00Z" }), "utf8");
    return backupRoot;
  }

  // Valor esperado computado DIRETO das funções puras sobre os snapshots CRUS
  // — é o que studio-metrics.ts faz, então cac-report e painel batem.
  function expectedRawFaixa(): { min: number; max: number } {
    const baseline = [
      { email: "a@x.com", status: "active" },
      { email: "b@x.com", status: "active" },
      { email: INTERNO, status: "active" },
    ];
    const latest = [
      { email: "a@x.com", status: "active" },
      { email: "b@x.com", status: "inactive" },
      { email: INTERNO, status: "active" },
    ];
    const { exits, avgActiveBase } = computeChurnExitsBetweenSnapshots(baseline, latest);
    assert.equal(exits.length, 1, "só b@x.com saiu — a conta interna segue ativa nos dois lados");
    const periodMonths = (Date.parse("2026-09-09") - Date.parse("2026-08-10")) / 86_400_000 / 30;
    const churn = computeChurnRate({ exits, manualCleanupEmails: new Set(), periodMonths, avgActiveBase });
    const arpu = computeArpu({ revenueBySource: { "apoia-se": null, amazon: 30 }, activeBase: 2 });
    const r = computeLtvCaixaFaixa({
      arpuMonthlyBrl: arpu.valor,
      churnOrganicoMonthly: churn.monthly?.organico ?? null,
      churnComLimpezaMonthly: churn.monthly?.comLimpeza ?? null,
      horizonMonths: LTV_DEFAULT_HORIZON_MONTHS,
    });
    assert.ok(r.faixa);
    return r.faixa!;
  }

  it("conta interna ativa nos dois snapshots não vira 'saída' e entra no denominador do ARPU", () => {
    assert.ok(isInternalOrTestEmail(INTERNO), "fixture exige um e-mail que o filtro de internos remove");
    const root = makeRoot();
    try {
      const backupRoot = setup(root);
      const report = { rows: [] } as unknown as CacReport;
      const section = computeLtvSection(report, backupRoot, "2026-09-09", root, () => new Date("2026-09-15T12:00:00Z"), {});
      assert.equal(section.applied, true);
      if (section.applied) {
        assert.ok(section.ltvFaixaBrl, section.motivo ?? "LTV deveria ser computável");
        const exp = expectedRawFaixa();
        assert.ok(Math.abs(section.ltvFaixaBrl!.min - exp.min) < 1e-9, `min ${section.ltvFaixaBrl!.min} != ${exp.min}`);
        assert.ok(Math.abs(section.ltvFaixaBrl!.max - exp.max) < 1e-9, `max ${section.ltvFaixaBrl!.max} != ${exp.max}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--fonte store: rótulo que não é data de snapshot resolve pro snapshot Beehiiv mais recente anterior", () => {
    const root = makeRoot();
    try {
      const backupRoot = setup(root);
      const report = { rows: [] } as unknown as CacReport;
      const section = computeLtvSection(report, backupRoot, "2026-09-12", root, () => new Date("2026-09-15T12:00:00Z"), {});
      assert.equal(section.applied, true);
      if (section.applied) {
        const exp = expectedRawFaixa();
        assert.ok(section.ltvFaixaBrl, section.motivo ?? "LTV deveria ser computável");
        assert.ok(Math.abs(section.ltvFaixaBrl!.min - exp.min) < 1e-9);
        assert.ok(Math.abs(section.ltvFaixaBrl!.max - exp.max) < 1e-9);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveLtvLatestSnapshotDate: mais recente <= rótulo; null quando nenhum serve", () => {
    assert.equal(resolveLtvLatestSnapshotDate(["2026-08-10", "2026-09-09"], "2026-09-09"), "2026-09-09");
    assert.equal(resolveLtvLatestSnapshotDate(["2026-09-09", "2026-08-10"], "2026-09-12"), "2026-09-09");
    assert.equal(resolveLtvLatestSnapshotDate(["2026-09-09"], "2026-09-01"), null);
  });
});

describe("computeLtvSection — cache apoia.se corrompido nunca fabrica R$0 (#8423 fleet review item 1)", () => {
  it("JSON inválido no cache do mês fechado -> LTV indisponível, nunca calculado sobre R$0 fabricado", () => {
    const root = makeRoot();
    try {
      const backupRoot = join(root, "beehiiv-backup");
      writeSnapshotDir(root, "2026-08-10", [
        sub({ email: "a@x.com", status: "active" }),
        sub({ email: "b@x.com", status: "active" }),
      ]);
      const latestSubs = [sub({ email: "a@x.com", status: "active" }), sub({ email: "b@x.com", status: "inactive" })];
      writeSnapshotDir(root, "2026-09-09", latestSubs);

      const apoiaSeDir = join(root, "data", "apoia-se", "diaria");
      mkdirSync(apoiaSeDir, { recursive: true });
      writeFileSync(join(apoiaSeDir, "2026-08.json"), "{ json corrompido", "utf8");
      const ltvDir = join(root, "data", "ltv");
      mkdirSync(ltvDir, { recursive: true });
      writeFileSync(join(ltvDir, "amazon-revenue.json"), JSON.stringify({ valorMensalBrl: 40, atualizadoEm: "2026-09-01T00:00:00Z" }), "utf8");

      const report = buildCacReport([spendRow("Google Ads", 100)], latestSubs);
      const section = computeLtvSection(report, backupRoot, "2026-09-09", root, () => new Date("2026-09-15T12:00:00Z"), {});

      // Sem a receita apoia.se (cache corrompido == indisponível), só a
      // Amazon sobra — ARPU/LTV ainda podem ser computáveis, mas NUNCA
      // usando R$0 fabricado pra apoia.se. O teste principal é que o
      // relatório nunca lança e nunca trata "corrompido" como "0 receita
      // apoia.se confirmada".
      assert.equal(section.applied, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeLtvSection — limpeza manual corrompida nunca colapsa churn em silêncio (#8423 fleet review item 3)", () => {
  it("JSON inválido em descadastrados-manuais-2607.json -> ltvFaixaBrl:null, motivo cita a falha", () => {
    const root = makeRoot();
    try {
      const backupRoot = join(root, "beehiiv-backup");
      writeSnapshotDir(root, "2026-08-10", [
        sub({ email: "a@x.com", status: "active" }),
        sub({ email: "b@x.com", status: "active" }),
      ]);
      const latestSubs = [sub({ email: "a@x.com", status: "active" }), sub({ email: "b@x.com", status: "inactive" })];
      writeSnapshotDir(root, "2026-09-09", latestSubs);

      const analysisDir = join(root, "data", "analysis");
      mkdirSync(analysisDir, { recursive: true });
      writeFileSync(join(analysisDir, "descadastrados-manuais-2607.json"), "{ corrompido", "utf8");

      const report = buildCacReport([spendRow("Google Ads", 100)], latestSubs);
      const section = computeLtvSection(report, backupRoot, "2026-09-09", root, () => new Date("2026-09-15T12:00:00Z"), {});

      assert.equal(section.applied, true);
      if (section.applied) {
        assert.equal(section.ltvFaixaBrl, null);
        assert.match(section.motivo ?? "", /limpeza manual/);
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
      rows: [{ canal: "Google Ads", custoPorLeitor: 5, custoPorAtivo: 50, ltvCacRatio: 3 }],
    };
    const md = formatCacReportMarkdown(report, budget, {}, undefined, undefined, [], section);
    assert.match(md, /LTV de caixa \(blended\)/);
    assert.match(md, /Google Ads/);
    assert.match(md, /3\.00/);
    // #9023: a razão é por ativo — a tabela declara isso e mostra o custo/ativo.
    assert.match(md, /\| Canal \| Custo\/leitor \| Custo\/ativo \| LTV ÷ custo\/ativo \|/);
    assert.match(md, /\| Google Ads \| R\$ 5,00 \| R\$ 50,00 \| 3\.00 \|/);
  });

  it("piso/teto: piso = churn com limpeza (mais alto), teto = churn orgânico (mais baixo) — #8423 fleet review item 4", () => {
    const section: CacReportLtvSection = {
      applied: true,
      ltvFaixaBrl: { min: 14, max: 16 },
      motivo: null,
      rows: [],
    };
    const md = formatCacReportMarkdown(report, budget, {}, undefined, undefined, [], section);
    assert.match(md, /Piso = LTV assumindo o churn mais alto \(com limpeza/);
    assert.match(md, /teto = assumindo o churn mais baixo \(orgânico\)/);
  });
});
