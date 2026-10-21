/**
 * test/studio-metrics-valor-kit-10713.test.ts (#10713)
 *
 * Regressão: o bloco "Valor" do Studio (`computeValorLayer`) calculava ARPU,
 * churn e LTV só a partir do snapshot Beehiiv, que depois da migração pro
 * Kit (#7386) não tem nenhum ativo — os três saíam `indeterminado`. A PR
 * #10711 (#10703) corrigiu só o `cac-report`; aqui o painel passa a usar a
 * mesma população Kit do store unificado e a mesma lista de fontes sem dado
 * (Hotmart), e o teste de paridade trava painel = relatório (#9023).
 * Só fixtures em tmpdir — o worktree pode não ter `data/`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetricsData, clearMetricsCache } from "../scripts/studio-ui/studio-metrics.ts";
import { computeLtvSection } from "../scripts/cac-report.ts";
import type { CacReport } from "../scripts/lib/cac.ts";
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

function storePath(root: string): string {
  return join(root, "data", "diaria-subscribers", "diaria-subscribers.db");
}

function seedStore(root: string, seeds: KitSeed[]): void {
  mkdirSync(join(root, "data", "diaria-subscribers"), { recursive: true });
  const db = openDiariaSubscribersDb(storePath(root));
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

/** Estado real de 18/10/2026: snapshot Beehiiv sem nenhum `active`. */
function writeBeehiivSemAtivos(root: string, date: string): string {
  const backupRoot = join(root, "data", "beehiiv-backup");
  const dir = join(backupRoot, date);
  mkdirSync(dir, { recursive: true });
  const subs = [
    { email: "velho1@x.com", status: "inactive", created: 1755000000 },
    { email: "velho2@x.com", status: "pending", created: 1755000000 },
  ];
  writeFileSync(join(dir, "subscribers.jsonl"), subs.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  return backupRoot;
}

function writeRevenue(root: string): void {
  // Mês FECHADO anterior a 21/10/2026 = setembro.
  const apoiaSeDir = join(root, "data", "apoia-se", "diaria");
  mkdirSync(apoiaSeDir, { recursive: true });
  writeFileSync(
    join(apoiaSeDir, "2026-09.json"),
    JSON.stringify({ "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 30 } }),
    "utf8",
  );
  const ltvDir = join(root, "data", "ltv");
  mkdirSync(ltvDir, { recursive: true });
  writeFileSync(join(ltvDir, "amazon-revenue.json"), JSON.stringify({ valorMensalBrl: 10, atualizadoEm: "2026-10-01" }), "utf8");
}

const KIT_SEEDS: KitSeed[] = [
  { email: "a@x.com", status: "active", entered: daysAgo(60) },
  { email: "b@x.com", status: "active", entered: daysAgo(60) },
  { email: "c@x.com", status: "active", entered: daysAgo(30) },
  { email: "d@x.com", status: "active", entered: daysAgo(30) },
  { email: "sai@x.com", status: "cancelled", entered: daysAgo(60), exited: daysAgo(0) },
  { email: "bounce@x.com", status: "bounced", entered: daysAgo(60), exited: daysAgo(0) },
  { email: "nunca@x.com", status: "inactive", entered: daysAgo(40) },
  // Conta interna: fora do denominador do ARPU (#9074).
  { email: "pixel@memelab.com.br", status: "active", entered: daysAgo(60) },
];

describe("buildMetricsData — Valor pela população Kit (#10713)", () => {
  it("snapshot Beehiiv sem ativo + Kit com ativos: ARPU, churn e LTV saem determinados, Hotmart como fonte sem dado", async () => {
    clearMetricsCache();
    const root = mkdtempSync(join(tmpdir(), "studio-valor-10713-"));
    try {
      writeBeehiivSemAtivos(root, "2026-10-18");
      writeRevenue(root);
      seedStore(root, KIT_SEEDS);

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => NOW });
      const v = data.valor;
      assert.equal(v.populacao, "kit-store");
      // (30 apoia.se + 10 Amazon) ÷ 4 ativos Kit (interno fora).
      assert.ok(v.arpuAtivo.valor != null, `ARPU indeterminado: ${v.arpuAtivo.motivo}`);
      assert.ok(Math.abs(v.arpuAtivo.valor - 10) < 1e-9);
      assert.equal(v.arpuAtivo.qualidade, "piso");
      // Hotmart aparece como fonte declarada sem dado na receita.
      assert.equal(v.receitaMensal.qualidade, "piso");
      // Exposição 8 meses-assinante: 1 saída orgânica, 2 com limpeza.
      assert.equal(v.churnMensal.qualidade, "faixa", `churn: ${v.churnMensal.motivo}`);
      assert.equal(v.ltvCaixa.qualidade, "faixa", `ltv: ${v.ltvCaixa.motivo}`);
      assert.ok(v.ltvCaixa.limites);
      assert.ok(Math.abs(v.ltvCaixa.limites.min - 40) < 1e-9);
      assert.ok(Math.abs(v.ltvCaixa.limites.max - 80) < 1e-9);
      assert.equal(v.churnPeriodo.baselineDate, daysAgo(60).slice(0, 10));
      assert.equal(v.churnPeriodo.latestDate, "2026-10-21");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("paridade painel × cac-report (#9023): mesmo ARPU e mesmo LTV de caixa sobre os mesmos dados", async () => {
    clearMetricsCache();
    const root = mkdtempSync(join(tmpdir(), "studio-valor-10713-par-"));
    try {
      const backupRoot = writeBeehiivSemAtivos(root, "2026-10-18");
      writeRevenue(root);
      seedStore(root, KIT_SEEDS);

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => NOW });
      const section = computeLtvSection({ rows: [] } as unknown as CacReport, backupRoot, "2026-10-21", root, () => NOW, {}, {
        storeDbPath: storePath(root),
      });
      assert.equal(section.applied, true);
      if (!section.applied) return;
      assert.ok(section.ltvFaixaBrl);
      assert.ok(data.valor.ltvCaixa.limites);
      assert.equal(section.populacao, data.valor.populacao);
      assert.ok(Math.abs((section.arpuMensalBrl ?? NaN) - (data.valor.arpuAtivo.valor ?? NaN)) < 1e-9);
      assert.ok(Math.abs(section.ltvFaixaBrl.min - data.valor.ltvCaixa.limites.min) < 1e-9);
      assert.ok(Math.abs(section.ltvFaixaBrl.max - data.valor.ltvCaixa.limites.max) < 1e-9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("store sem ativo Kit: cai no snapshot Beehiiv (fallback), sem fabricar número", async () => {
    clearMetricsCache();
    const root = mkdtempSync(join(tmpdir(), "studio-valor-10713-fb-"));
    try {
      writeBeehiivSemAtivos(root, "2026-10-18");
      writeRevenue(root);
      seedStore(root, [{ email: "sai@x.com", status: "cancelled", entered: daysAgo(60), exited: daysAgo(0) }]);

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => NOW });
      assert.equal(data.valor.populacao, "beehiiv-snapshot");
      assert.equal(data.valor.arpuAtivo.valor, null);
      assert.equal(data.valor.ltvCaixa.valor, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
