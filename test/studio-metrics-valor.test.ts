/**
 * test/studio-metrics-valor.test.ts (#8423)
 *
 * Cobertura do bloco "Valor" (receita, ARPU, churn, conversão em apoiador,
 * LTV blended/por origem, LTV÷CAC) de `scripts/studio-ui/studio-metrics.ts`.
 * Mesma disciplina fail-soft do resto do módulo: `data/` parcial nunca
 * lança, `valor: null` nunca vira `0`, insumo ausente vira `indeterminado`
 * com motivo — nunca I/O real (só fixtures em tmpdir).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetricsData, clearMetricsCache } from "../scripts/studio-ui/studio-metrics.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "studio-metrics-valor-"));
}

function beehiivSubscriberLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: "leitor@example.com",
    status: "active",
    created: 1755000000,
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    ...overrides,
  });
}

function writeBeehiivSnapshot(root: string, date: string, lines: string[]): void {
  const dir = join(root, "data", "beehiiv-backup", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subscribers.jsonl"), lines.join("\n") + "\n", "utf8");
}

function writeApoiaSeCache(root: string, month: string, cache: Record<string, unknown>, campaign = "diaria"): void {
  const dir = join(root, "data", "apoia-se", campaign);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${month}.json`), JSON.stringify(cache), "utf8");
}

function writeAmazonConfig(root: string, valorMensalBrl: number, atualizadoEm = "2026-09-01T00:00:00.000Z"): void {
  const dir = join(root, "data", "ltv");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "amazon-revenue.json"), JSON.stringify({ valorMensalBrl, atualizadoEm }), "utf8");
}

function writeManualCleanup(root: string, entries: { email: string; received: number; opened: number; clicked: number }[]): void {
  const dir = join(root, "data", "analysis");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "descadastrados-manuais-2607.json"), JSON.stringify(entries), "utf8");
}

// `previousCompetenceMonth`/`findChurnBaselineDate`/`computeChurnExitsBetweenSnapshots`
// são cobertas em test/ltv.test.ts (onde o núcleo agora mora, #8423) — este
// arquivo cobre só a INTEGRAÇÃO via `buildMetricsData`.

describe("buildMetricsData — Valor (#8423) — sem nenhum insumo", () => {
  it("data/ ausente: todo o bloco Valor sai indeterminado, nunca lança", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      const data = await buildMetricsData(root, { now: () => new Date("2026-09-15T12:00:00Z") });
      assert.equal(data.valor.receitaMensal.valor, null);
      assert.equal(data.valor.arpuAtivo.valor, null);
      assert.equal(data.valor.churnMensal.valor, null);
      assert.equal(data.valor.conversaoApoiador.valor, null);
      assert.equal(data.valor.ltvCaixa.valor, null);
      assert.equal(data.valor.amazonConfig.valorMensalBrl, null);
      assert.ok(data.valor.amazonConfig.motivo);
      assert.equal(data.valor.apoiaSeCache.available, false);
      assert.equal(data.valor.apoiaSeCache.competenceMonth, "2026-08");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — Valor (#8423) — receita e ARPU", () => {
  it("soma apoia.se + Amazon e divide pela base ativa Beehiiv", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-09-09", [
        beehiivSubscriberLine({ email: "a@x.com", status: "active" }),
        beehiivSubscriberLine({ email: "b@x.com", status: "active" }),
      ]);
      // mês FECHADO (agosto) — nunca o corrente
      writeApoiaSeCache(root, "2026-08", {
        "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 },
        "b@x.com": { isBacker: false, isPaidThisMonth: false },
      });
      writeAmazonConfig(root, 50);

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });
      assert.equal(data.valor.receitaMensal.valor, 75); // 25 (apoia.se) + 50 (amazon)
      assert.equal(data.valor.receitaMensal.qualidade, "exato");
      assert.ok(data.valor.arpuAtivo.valor != null);
      assert.ok(Math.abs(data.valor.arpuAtivo.valor - 75 / 2) < 1e-9); // base ativa Beehiiv = 2
      assert.equal(data.valor.apoiaSeCache.available, true);
      assert.equal(data.valor.amazonConfig.valorMensalBrl, 50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PISO quando só a apoia.se tem dado (Amazon sem config)", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-09-09", [beehiivSubscriberLine({ email: "a@x.com", status: "active" })]);
      writeApoiaSeCache(root, "2026-08", { "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 } });

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });
      assert.equal(data.valor.receitaMensal.valor, 25);
      assert.equal(data.valor.receitaMensal.qualidade, "piso");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — Valor (#8423) — churn e LTV de caixa", () => {
  it("2 snapshots ~30 dias de distância produzem churn em faixa e LTV em faixa", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      // baseline: 4 ativos; mais recente: 2 saíram (1 limpeza manual, 1 orgânico)
      writeBeehiivSnapshot(root, "2026-08-10", [
        beehiivSubscriberLine({ email: "a@x.com", status: "active" }),
        beehiivSubscriberLine({ email: "b@x.com", status: "active" }),
        beehiivSubscriberLine({ email: "manual@x.com", status: "active" }),
        beehiivSubscriberLine({ email: "organico-exit@x.com", status: "active" }),
      ]);
      writeBeehiivSnapshot(root, "2026-09-09", [
        beehiivSubscriberLine({ email: "a@x.com", status: "active" }),
        beehiivSubscriberLine({ email: "b@x.com", status: "active" }),
        beehiivSubscriberLine({ email: "manual@x.com", status: "inactive" }),
        beehiivSubscriberLine({ email: "organico-exit@x.com", status: "inactive" }),
      ]);
      writeManualCleanup(root, [{ email: "manual@x.com", received: 10, opened: 2, clicked: 0 }]);
      writeApoiaSeCache(root, "2026-08", { "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 20 } });
      writeAmazonConfig(root, 40);

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });

      assert.equal(data.valor.churnPeriodo.baselineDate, "2026-08-10");
      assert.equal(data.valor.churnPeriodo.latestDate, "2026-09-09");
      assert.equal(data.valor.churnMensal.qualidade, "faixa");
      assert.ok(data.valor.churnMensal.limites);
      assert.ok(data.valor.churnMensal.limites!.min < data.valor.churnMensal.limites!.max);

      assert.equal(data.valor.ltvCaixa.qualidade, "faixa");
      assert.ok(data.valor.ltvCaixa.limites!.min > 0);
      assert.ok(data.valor.ltvCaixa.limites!.max >= data.valor.ltvCaixa.limites!.min);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem 2 snapshots suficientemente espaçados: churn/LTV indeterminados, nunca 0", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-09-09", [beehiivSubscriberLine({ email: "a@x.com", status: "active" })]);

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });
      assert.equal(data.valor.churnPeriodo.baselineDate, null);
      assert.equal(data.valor.churnMensal.valor, null);
      assert.equal(data.valor.churnMensal.qualidade, "indeterminado");
      assert.equal(data.valor.ltvCaixa.valor, null);
      assert.equal(data.valor.ltvCaixa.qualidade, "indeterminado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — Valor (#8423) — conversão em apoiador e LTV por origem", () => {
  it("classifica por classe de aquisição e vincula por e-mail com a apoia.se", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-09-09", [
        // orgânico, apoiador pagante
        beehiivSubscriberLine({ email: "organico-backer@x.com", status: "active", referring_site: "google.com" }),
        // orgânico, não-apoiador
        beehiivSubscriberLine({ email: "organico-plain@x.com", status: "active", referring_site: "google.com" }),
      ]);
      writeApoiaSeCache(root, "2026-08", {
        "organico-backer@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 30 },
      });

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });
      assert.ok(data.valor.conversaoApoiador.valor != null);
      assert.ok(Math.abs(data.valor.conversaoApoiador.valor - 0.5) < 1e-9); // 1 de 2

      // ltv-por-origem sempre decomposto por classe internamente — 'valor'
      // é a média ponderada, nunca null quando há ao menos 1 classe com LTV
      // computável.
      assert.ok(data.valor.ltvPorOrigem.valor != null || data.valor.ltvPorOrigem.qualidade === "indeterminado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("2+ classes de aquisição (organico via referring_site=google.com, pago via utm_source=meta-ads) produzem o valor blended REAL — nunca assertion tautológica", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-09-09", [
        // classe organico: 1 apoiador pagante (R$30/mês) de 1 confirmado -> conversao 1.0
        beehiivSubscriberLine({ email: "organico-backer@x.com", status: "active", referring_site: "google.com" }),
        // classe pago: 1 apoiador pagante (R$10/mês) de 1 confirmado -> conversao 1.0
        beehiivSubscriberLine({
          email: "pago-backer@x.com",
          status: "active",
          utm_source: "meta-ads",
          utm_medium: "paid_social",
        }),
      ]);
      writeApoiaSeCache(root, "2026-08", {
        "organico-backer@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 30 },
        "pago-backer@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 10 },
      });

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });

      assert.equal(data.valor.ltvPorOrigem.qualidade, "exato");
      assert.ok(data.valor.ltvPorOrigem.series);
      const organico = data.valor.ltvPorOrigem.series!.find((s) => s.chave === "organico");
      const pago = data.valor.ltvPorOrigem.series!.find((s) => s.chave === "pago");
      assert.ok(organico && organico.valor != null);
      assert.ok(pago && pago.valor != null);
      // conversao 1.0 × R$30/mês × 24 meses (horizonte default) = 720
      assert.ok(Math.abs((organico!.valor as number) - 30 * 24) < 1e-6);
      // conversao 1.0 × R$10/mês × 24 meses = 240
      assert.ok(Math.abs((pago!.valor as number) - 10 * 24) < 1e-6);
      // 'valor' = média ponderada por n (1 e 1 aqui) = média simples das duas
      assert.ok(data.valor.ltvPorOrigem.valor != null);
      assert.ok(Math.abs((data.valor.ltvPorOrigem.valor as number) - (30 * 24 + 10 * 24) / 2) < 1e-6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — Valor (#8423) — vínculo por e-mail é case-insensitive", () => {
  it("e-mail em maiúsculas/mistas no snapshot Beehiiv ainda vincula com o cache apoia.se (minúsculo)", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-09-09", [
        beehiivSubscriberLine({ email: "Mixed.Case@X.com", status: "active" }),
      ]);
      // cache gravado com e-mail já normalizado (minúsculo) — cenário comum
      // já que `checkBacker` normaliza antes de consultar/gravar.
      writeApoiaSeCache(root, "2026-08", {
        "mixed.case@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 30 },
      });

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });
      assert.ok(data.valor.conversaoApoiador.valor != null);
      assert.equal(data.valor.conversaoApoiador.valor, 1); // 1 de 1 vinculou apesar do case diferente
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — Valor (#8423) — cache apoia.se corrompido nunca fabrica R$0", () => {
  it("JSON inválido no cache do mês: receita/ARPU excluem apoia-se (null, não 0); conversão/ltv-por-origem indeterminados", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-09-09", [beehiivSubscriberLine({ email: "a@x.com", status: "active" })]);
      writeAmazonConfig(root, 50);
      // grava JSON corrompido no lugar do cache do mês fechado (agosto)
      const cacheDir = join(root, "data", "apoia-se", "diaria");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "2026-08.json"), "{ isso não é json válido", "utf8");

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });

      // receita só soma Amazon (50) — apoia-se fica null, nunca 0 fabricado
      // fazendo a soma parecer "só Amazon" por coincidência.
      assert.equal(data.valor.receitaMensal.valor, 50);
      assert.equal(data.valor.receitaMensal.qualidade, "piso");
      assert.equal(data.valor.apoiaSeCache.available, false);
      assert.equal(data.valor.apoiaSeCache.corrupted, true);

      assert.equal(data.valor.conversaoApoiador.valor, null);
      assert.equal(data.valor.conversaoApoiador.qualidade, "indeterminado");
      assert.match(data.valor.conversaoApoiador.motivo ?? "", /apoia\.se/);

      assert.equal(data.valor.ltvPorOrigem.valor, null);
      assert.equal(data.valor.ltvPorOrigem.qualidade, "indeterminado");
      assert.match(data.valor.ltvPorOrigem.motivo ?? "", /apoia\.se/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — Valor (#8423) — arquivo de limpeza manual corrompido nunca colapsa churn em silêncio", () => {
  it("JSON inválido em descadastrados-manuais-2607.json: churn/LTV saem indeterminados, motivo cita a falha", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-08-10", [
        beehiivSubscriberLine({ email: "a@x.com", status: "active" }),
        beehiivSubscriberLine({ email: "b@x.com", status: "active" }),
      ]);
      writeBeehiivSnapshot(root, "2026-09-09", [
        beehiivSubscriberLine({ email: "a@x.com", status: "active" }),
        beehiivSubscriberLine({ email: "b@x.com", status: "inactive" }),
      ]);
      const analysisDir = join(root, "data", "analysis");
      mkdirSync(analysisDir, { recursive: true });
      writeFileSync(join(analysisDir, "descadastrados-manuais-2607.json"), "{ arquivo corrompido", "utf8");

      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-15T12:00:00Z") });

      assert.equal(data.valor.churnMensal.valor, null);
      assert.equal(data.valor.churnMensal.qualidade, "indeterminado");
      assert.match(data.valor.churnMensal.motivo ?? "", /limpeza manual/);
      assert.equal(data.valor.ltvCaixa.valor, null);
      assert.equal(data.valor.ltvCaixa.qualidade, "indeterminado");
      assert.ok(data.valor.manualCleanup.error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — Valor (#8423) — ltvCacRatio", () => {
  it("indeterminado quando não há nenhum insumo (sem data/)", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      const data = await buildMetricsData(root, { now: () => new Date("2026-09-15T12:00:00Z") });
      assert.equal(data.valor.ltvCacRatio.valor, null);
      assert.equal(data.valor.ltvCacRatio.qualidade, "indeterminado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
