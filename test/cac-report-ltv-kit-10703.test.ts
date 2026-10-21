/**
 * test/cac-report-ltv-kit-10703.test.ts (#10703)
 *
 * Regressão: a seção "LTV vs. custo" do `cac-report` saía sempre com
 * "ARPU mensal indisponível". Causa raiz: ARPU e churn liam só o snapshot
 * Beehiiv, que ficou sem nenhum ativo depois da migração da base pro Kit
 * (#7386). O motivo genérico de `computeLtvCaixa` ainda escondia a causa.
 * Desde o fix, com ativo Kit no store unificado, ARPU e churn saem do Kit,
 * Hotmart aparece como fonte sem dado e o motivo de falha nomeia o insumo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLtvSection, formatCacReportMarkdown, loadKitLifecycleRows } from "../scripts/cac-report.ts";
import { buildCacReport, computeMonthBudgetUsage, type CacReport } from "../scripts/lib/cac.ts";
import { computeChurnRate, computeKitLifetimeChurn, LTV_DEFAULT_HORIZON_MONTHS } from "../scripts/lib/ltv.ts";
import { openDiariaSubscribersDb } from "../scripts/lib/diaria-subscribers-db.ts";

const NOW = new Date("2026-10-21T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * DAY).toISOString();

interface KitSeed {
  email: string | null;
  status: string;
  entered: string | null;
  exited?: string | null;
}

function seedStore(dbPath: string, seeds: KitSeed[]): void {
  const db = openDiariaSubscribersDb(dbPath);
  try {
    const ts = NOW.toISOString();
    seeds.forEach((s, i) => {
      const id = Number(db.prepare("INSERT INTO subscriber (created_at, updated_at) VALUES (?, ?)").run(ts, ts).lastInsertRowid);
      if (s.email) {
        db.prepare("INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', ?, ?, ?)").run(
          id,
          `ext-${i}`,
          s.email,
          ts,
        );
      }
      db.prepare(
        "INSERT INTO subscription (subscriber_id, platform, status, entered_at, exited_at, source, updated_at) VALUES (?, 'kit', ?, ?, ?, NULL, ?)",
      ).run(id, s.status, s.entered, s.exited ?? null, ts);
    });
  } finally {
    db.close();
  }
}

function writeBeehiivSnapshotSemAtivos(root: string, date: string): string {
  const backupRoot = join(root, "beehiiv-backup");
  const dir = join(backupRoot, date);
  mkdirSync(dir, { recursive: true });
  // Estado real de 21/10/2026: nenhum `active`, só inactive/pending.
  const subs = [
    { email: "velho1@x.com", status: "inactive", created: 1755000000 },
    { email: "velho2@x.com", status: "pending", created: 1755000000 },
  ];
  writeFileSync(join(dir, "subscribers.jsonl"), subs.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  return backupRoot;
}

function writeRevenue(root: string): void {
  const apoiaSeDir = join(root, "data", "apoia-se", "diaria");
  mkdirSync(apoiaSeDir, { recursive: true });
  // Mês FECHADO anterior a 21/10/2026 = setembro.
  writeFileSync(
    join(apoiaSeDir, "2026-09.json"),
    JSON.stringify({ "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 30 } }),
    "utf8",
  );
  const ltvDir = join(root, "data", "ltv");
  mkdirSync(ltvDir, { recursive: true });
  writeFileSync(join(ltvDir, "amazon-revenue.json"), JSON.stringify({ valorMensalBrl: 10, atualizadoEm: "2026-10-01" }), "utf8");
}

const emptyReport = { rows: [] } as unknown as CacReport;

describe("computeLtvSection — população Kit quando o snapshot Beehiiv não tem ativo (#10703)", () => {
  it("Beehiiv sem ativo + Kit com ativos: LTV sai em faixa, ARPU pelo Kit, Hotmart como fonte sem dado", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-ltv-10703-"));
    try {
      const backupRoot = writeBeehiivSnapshotSemAtivos(root, "2026-10-18");
      writeRevenue(root);
      const dbPath = join(root, "store.db");
      seedStore(dbPath, [
        { email: "a@x.com", status: "active", entered: daysAgo(60) },
        { email: "b@x.com", status: "active", entered: daysAgo(60) },
        { email: "c@x.com", status: "active", entered: daysAgo(30) },
        { email: "d@x.com", status: "active", entered: daysAgo(30) },
        { email: "sai@x.com", status: "cancelled", entered: daysAgo(60), exited: daysAgo(0) },
        { email: "bounce@x.com", status: "bounced", entered: daysAgo(60), exited: daysAgo(0) },
        { email: "nunca@x.com", status: "inactive", entered: daysAgo(40) },
        // Conta interna: fora do denominador do ARPU (#9074).
        { email: "pixel@memelab.com.br", status: "active", entered: daysAgo(60) },
      ]);

      const section = computeLtvSection(emptyReport, backupRoot, "2026-10-21", root, () => NOW, {}, { storeDbPath: dbPath });
      assert.equal(section.applied, true);
      if (!section.applied) return;
      assert.ok(section.ltvFaixaBrl, `LTV deveria sair com Kit ativo; motivo: ${section.motivo}`);
      assert.equal(section.populacao, "kit-store");
      assert.equal(section.ativosArpu, 4);
      // (30 apoia.se + 10 Amazon) ÷ 4 ativos Kit.
      assert.ok(Math.abs(section.arpuMensalBrl! - 10) < 1e-9);
      assert.deepEqual(section.fontesSemDado, ["hotmart"]);
      // Exposição: 2×2 + 2×1 meses ativos + 2 saídas × 1 mês (metade de 2) = 8.
      assert.ok(Math.abs(section.churnMensal!.organico - 1 / 8) < 1e-9);
      assert.ok(Math.abs(section.churnMensal!.comLimpeza - 2 / 8) < 1e-9);
      // Vida útil 4 (com limpeza) e 8 (orgânico) meses, abaixo do horizonte.
      assert.ok(Math.abs(section.ltvFaixaBrl!.min - 40) < 1e-9);
      assert.ok(Math.abs(section.ltvFaixaBrl!.max - 80) < 1e-9);
      // Snapshots Beehiiv não descrevem a população no modo Kit.
      assert.equal(section.snapshotAtual, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Beehiiv sem ativo e sem store: motivo nomeia a causa, não o genérico 'ARPU mensal indisponível'", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-ltv-10703-"));
    try {
      const backupRoot = writeBeehiivSnapshotSemAtivos(root, "2026-10-18");
      writeRevenue(root);
      const section = computeLtvSection(emptyReport, backupRoot, "2026-10-21", root, () => NOW, {}, {
        storeDbPath: join(root, "nao-existe.db"),
      });
      assert.equal(section.applied, true);
      if (!section.applied) return;
      assert.equal(section.ltvFaixaBrl, null);
      assert.notEqual(section.motivo, "ARPU mensal indisponível");
      assert.match(section.motivo ?? "", /sem nenhum assinante ativo/);
      assert.match(section.motivo ?? "", /Kit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("store ausente não é criado como efeito colateral", async () => {
    const root = mkdtempSync(join(tmpdir(), "cac-ltv-10703-"));
    try {
      const backupRoot = writeBeehiivSnapshotSemAtivos(root, "2026-10-18");
      computeLtvSection(emptyReport, backupRoot, "2026-10-21", root, () => NOW, {});
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(join(root, "data", "diaria-subscribers", "diaria-subscribers.db")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadKitLifecycleRows (#10703)", () => {
  it("lê só Kit, resolve o e-mail do alias e mantém a linha sem alias com id sintético", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-ltv-10703-"));
    try {
      const dbPath = join(root, "store.db");
      seedStore(dbPath, [
        { email: "a@x.com", status: "active", entered: daysAgo(10) },
        { email: null, status: "active", entered: daysAgo(10) },
      ]);
      const db = openDiariaSubscribersDb(dbPath);
      try {
        const ts = NOW.toISOString();
        const id = Number(db.prepare("INSERT INTO subscriber (created_at, updated_at) VALUES (?, ?)").run(ts, ts).lastInsertRowid);
        db.prepare("INSERT INTO subscription (subscriber_id, platform, status, entered_at, updated_at) VALUES (?, 'brevo_diaria', 'active', ?, ?)").run(
          id,
          ts,
          ts,
        );
        const rows = loadKitLifecycleRows(db);
        assert.equal(rows.length, 2);
        assert.ok(rows.some((r) => r.email === "a@x.com"));
        assert.ok(rows.some((r) => r.email.startsWith("kit-subscription:")));
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeKitLifetimeChurn (#10703)", () => {
  const nowMs = NOW.getTime();

  it("ignora quem nunca esteve ativo e conta bounce + limpeza manual só no churn com limpeza", () => {
    const res = computeKitLifetimeChurn(
      [
        { email: "a@x.com", status: "active", enteredAt: daysAgo(90), exitedAt: null },
        { email: "sai@x.com", status: "cancelled", enteredAt: daysAgo(90), exitedAt: daysAgo(30) },
        { email: "spam@x.com", status: "complained", enteredAt: daysAgo(90), exitedAt: daysAgo(30) },
        { email: "B@X.com", status: "bounced", enteredAt: daysAgo(90), exitedAt: daysAgo(30) },
        { email: "limpo@x.com", status: "cancelled", enteredAt: daysAgo(90), exitedAt: daysAgo(30) },
        { email: "nunca@x.com", status: "inactive", enteredAt: daysAgo(90), exitedAt: null },
      ],
      new Set(["limpo@x.com"]),
      nowMs,
    );
    assert.equal(res.activeCount, 1);
    assert.equal(res.churnInput.exits.length, 4);
    const churn = computeChurnRate(res.churnInput);
    assert.equal(churn.organicExits, 2);
    assert.equal(churn.manualCleanupExits, 2);
    // Exposição: ativo 3 meses + 4 saídas × metade de 2 meses = 7.
    assert.ok(Math.abs(res.exposureMonths - 7) < 1e-9);
    assert.ok(Math.abs(churn.monthly!.organico - 2 / 7) < 1e-9);
    assert.ok(Math.abs(churn.monthly!.comLimpeza - 4 / 7) < 1e-9);
  });

  it("linha sem entered_at fica fora da exposição, mas o ativo continua no ARPU", () => {
    const res = computeKitLifetimeChurn(
      [
        { email: "a@x.com", status: "active", enteredAt: null, exitedAt: null },
        { email: "b@x.com", status: "active", enteredAt: daysAgo(30), exitedAt: null },
      ],
      new Set(),
      nowMs,
    );
    assert.equal(res.activeCount, 2);
    assert.equal(res.semEntradaCount, 1);
    assert.ok(Math.abs(res.exposureMonths - 1) < 1e-9);
  });

  it("sem nenhuma entrada datada: churn indeterminado (nunca 0 fabricado)", () => {
    const res = computeKitLifetimeChurn([], new Set(), nowMs);
    assert.equal(res.periodStart, null);
    assert.equal(computeChurnRate(res.churnInput).monthly, null);
  });
});

describe("formatCacReportMarkdown — rastreio da seção LTV (#10703)", () => {
  it("mostra ARPU, a fonte sem dado e o churn, e explica piso = teto", () => {
    const md = formatCacReportMarkdown(
      buildCacReport([], []),
      computeMonthBudgetUsage([], "2026-10", 4000),
      {},
      undefined,
      undefined,
      [],
      {
        applied: true,
        ltvFaixaBrl: { min: 9.06, max: 9.06 },
        motivo: null,
        rows: [],
        populacao: "kit-store",
        ativosArpu: 1169,
        arpuMensalBrl: 0.3776,
        fontesSemDado: ["hotmart"],
        churnMensal: { organico: 0.0255, comLimpeza: 0.0357 },
        churnDesde: "2026-08-24T18:14:36.000Z",
      },
    );
    assert.match(md, /ARPU mensal: R\$ 0,38 por ativo \(PISO\)/);
    assert.match(md, /hotmart/);
    assert.match(md, /Churn mensal: 2\.5% orgânico, 3\.6% com limpeza/);
    assert.match(md, /1169 ativos do Kit/);
    assert.match(md, new RegExp(`horizonte de ${LTV_DEFAULT_HORIZON_MONTHS} meses`));
    assert.doesNotMatch(md, /Snapshots Beehiiv usados/);
  });
});
