/**
 * test/cac.test.ts (#5236 Parte 2)
 *
 * Núcleo puro do relatório de custo por leitor por canal
 * (`scripts/lib/cac.ts`) — agrupamento por canal, filtro de contas
 * internas/teste, aplicação do mapa de origem, faixa mín-máx do Boost, e
 * ranking do relatório completo. Tudo com fixtures sintéticas — nenhum I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmail,
  isInternalOrTestEmail,
  filterInternalAndTestSubscribers,
  buildNormalizedOrigemIndex,
  applyOrigemOverride,
  countLeitoresV1,
  CHANNEL_GROUP_KEYS,
  subscribersForChannel,
  BOOST_ESTIMATE_ANCHOR,
  computeBoostRange,
  computeMeasuredRow,
  computeBoostRow,
  computeBaseMetrics,
  buildCacReport,
  computeMonthBudgetUsage,
  MONTHLY_BUDGET_FLOOR_BRL,
  DEGRADATION_THRESHOLD_PCT,
  type CacMeasuredRow,
  type CacBoostRow,
} from "../scripts/lib/cac.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

function sub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: "leitor@example.com",
    status: "active",
    created: 1700000000,
    utm_source: "direct",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 40 },
    ...overrides,
  };
}

function spend(overrides: Partial<SpendRow> = {}): SpendRow {
  return { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "teste", ...overrides };
}

// ---------------------------------------------------------------------------
// Filtro de contas internas/teste (achado do self-review #5235, endereçado aqui)
// ---------------------------------------------------------------------------

describe("normalizeEmail / isInternalOrTestEmail", () => {
  it("normaliza case e trim", () => {
    assert.equal(normalizeEmail("  Foo@Example.COM  "), "foo@example.com");
  });

  it("reconhece INTERNAL_EMAILS mesmo com case/trim diferente do literal", () => {
    assert.equal(isInternalOrTestEmail("VJPixel@Gmail.com"), true);
    assert.equal(isInternalOrTestEmail(" vjpixel@gmail.com "), true);
  });

  it("reconhece conta de teste (vjpixel+test*)", () => {
    assert.equal(isInternalOrTestEmail("vjpixel+test2@gmail.com"), true);
    assert.equal(isInternalOrTestEmail("vjpixel+teste4@gmail.com"), true);
  });

  it("não marca assinante real como interno/teste", () => {
    assert.equal(isInternalOrTestEmail("leitor.real@example.com"), false);
  });
});

describe("filterInternalAndTestSubscribers", () => {
  it("remove internos/teste, mantém o resto, e conta quantos removeu", () => {
    const subs = [
      sub({ email: "vjpixel@gmail.com" }),
      sub({ email: "vjpixel+test2@gmail.com" }),
      sub({ email: "leitor.real@example.com" }),
    ];
    const { kept, removedCount } = filterInternalAndTestSubscribers(subs);
    assert.equal(removedCount, 2);
    assert.deepEqual(kept.map((s) => s.email), ["leitor.real@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// Mapa de origem recuperada — índice normalizado + override
// ---------------------------------------------------------------------------

describe("buildNormalizedOrigemIndex / applyOrigemOverride", () => {
  it("casa email com case diferente do índice (chave crua não-normalizada)", () => {
    const idx = buildNormalizedOrigemIndex({
      "Leitor@Example.com": { utm_source: "android.googlequicksearchbox", referring_site: "" },
    });
    const overridden = applyOrigemOverride([sub({ email: "leitor@example.com", utm_source: "brevo-diaria" })], idx);
    assert.equal(overridden[0].utm_source, "android.googlequicksearchbox");
  });

  it("assinante sem entrada no índice mantém utm_source original", () => {
    const idx = buildNormalizedOrigemIndex({});
    const overridden = applyOrigemOverride([sub({ utm_source: "direct" })], idx);
    assert.equal(overridden[0].utm_source, "direct");
  });

  it("índice vazio retorna a mesma referência de array (fast path, sem alocar)", () => {
    const subs = [sub()];
    const idx = buildNormalizedOrigemIndex({});
    assert.equal(applyOrigemOverride(subs, idx), subs);
  });
});

// ---------------------------------------------------------------------------
// leitor-v1 por grupo — nunca GroupEngagement.leitores (open_rate ausente localmente)
// ---------------------------------------------------------------------------

describe("countLeitoresV1", () => {
  it("conta só ativos com CTR real >= 2% e >= 20 recebidas", () => {
    const subs = [
      sub({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 90 } }), // CTR 5% -> leitor
      sub({ stats: { total_received: 100, total_unique_clicked: 1, total_unique_opened: 90 } }), // CTR 1% -> não
      sub({ status: "inactive", stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 90 } }), // inativo -> não
      sub({ stats: { total_received: 5, total_unique_clicked: 5, total_unique_opened: 5 } }), // < 20 recebidas -> não
    ];
    assert.equal(countLeitoresV1(subs), 1);
  });

  it("nunca lê click_rate mesmo se presente e mentiroso", () => {
    const subs = [
      sub({
        stats: {
          total_received: 100,
          total_unique_clicked: 1, // CTR real 1% -> NÃO deveria contar
          total_unique_opened: 2,
          // click_rate mentiroso: 1/2 = 50% — se a função lesse isso, contaria errado
          click_rate: 50,
        } as any,
      }),
    ];
    assert.equal(countLeitoresV1(subs), 0);
  });
});

// ---------------------------------------------------------------------------
// Agrupamento por canal medido (Google Ads / LinkedIn)
// ---------------------------------------------------------------------------

describe("subscribersForChannel / CHANNEL_GROUP_KEYS", () => {
  it("Google Ads casa android.googlequicksearchbox (confirmado em #4466/#5254)", () => {
    const subs = [sub({ utm_source: "android.googlequicksearchbox" }), sub({ utm_source: "direct" })];
    const result = subscribersForChannel(subs, "Google Ads");
    assert.equal(result.length, 1);
  });

  it("casa por referring_site quando utm_source ausente (fallback de resolveGroupKey)", () => {
    const subs = [sub({ utm_source: "", referring_site: "linkedin.com" })];
    const result = subscribersForChannel(subs, "LinkedIn");
    assert.equal(result.length, 1);
  });

  it("case-insensitive (normalizeKey lowercase)", () => {
    const subs = [sub({ utm_source: "Android.GoogleQuickSearchBox" })];
    assert.equal(subscribersForChannel(subs, "Google Ads").length, 1);
  });

  it("canal desconhecido (fora de CHANNEL_GROUP_KEYS) retorna lista vazia, nunca lança", () => {
    assert.deepEqual(subscribersForChannel([sub()], "Beehiiv Boosts"), []);
    assert.deepEqual(subscribersForChannel([sub()], "Canal Que Não Existe"), []);
  });

  it("CHANNEL_GROUP_KEYS não inclui Beehiiv Boosts (estimado, nunca medido por grupo)", () => {
    assert.equal(CHANNEL_GROUP_KEYS["Beehiiv Boosts"], undefined);
  });
});

// ---------------------------------------------------------------------------
// Faixa mín-máx do Beehiiv Boosts
// ---------------------------------------------------------------------------

describe("computeBoostRange", () => {
  it("usa a âncora 157 faturados / 233 totais / 80 ativos / 16 leitores (#4466/#5236)", () => {
    assert.equal(BOOST_ESTIMATE_ANCHOR.billedLeads, 157);
    assert.equal(BOOST_ESTIMATE_ANCHOR.totalLeads, 233);
    assert.equal(BOOST_ESTIMATE_ANCHOR.ativosAnchor, 80);
    assert.equal(BOOST_ESTIMATE_ANCHOR.leitoresAnchor, 16);
  });

  it("mín usa leitoresAnchor (16) como denominador MAIOR -> custo mín MENOR", () => {
    const range = computeBoostRange(397.08);
    assert.equal(range.leitoresMin, 16);
    assert.ok(Math.abs(range.custoPorLeitorMax! - 397.08 / 16) < 1e-9);
  });

  it("máx escala pela razão totalLeads/billedLeads (233/157) e produz leitoresMax > leitoresMin", () => {
    const range = computeBoostRange(397.08);
    assert.ok(range.leitoresMax > range.leitoresMin);
    assert.equal(range.leitoresMax, Math.round(16 * (233 / 157)));
    assert.ok(range.custoPorLeitorMin! < range.custoPorLeitorMax!, "mais leitores no denominador -> custo mín menor");
  });

  it("gasto 0 produz custo 0 nos dois limites (não null — leitoresMin/Max sempre > 0 na âncora fixa)", () => {
    const range = computeBoostRange(0);
    assert.equal(range.custoPorLeitorMin, 0);
    assert.equal(range.custoPorLeitorMax, 0);
  });
});

// ---------------------------------------------------------------------------
// computeMeasuredRow — inclui sinal de degradação vs. snapshot anterior
// ---------------------------------------------------------------------------

describe("computeMeasuredRow", () => {
  it("leitores=0 produz custoPorLeitor null (nunca Infinity silencioso)", () => {
    const row = computeMeasuredRow(spend(), []);
    assert.equal(row.leitores, 0);
    assert.equal(row.custoPorLeitor, null);
  });

  it("calcula custoPorLeitor = valor / leitores quando há leitores", () => {
    const subs = [sub({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 90 } })];
    const row = computeMeasuredRow(spend({ valor: 100 }), subs);
    assert.equal(row.leitores, 1);
    assert.equal(row.custoPorLeitor, 100);
  });

  it("sem previousChannelSubs: aberturaAgregadaAnterior e degradado ficam null (nunca false por omissão)", () => {
    const row = computeMeasuredRow(spend(), [sub()]);
    assert.equal(row.aberturaAgregadaAnterior, null);
    assert.equal(row.degradado, null);
  });

  it("abertura caiu mais que o limiar -> degradado=true", () => {
    const now = [sub({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 20 } })]; // 20% abertura
    const before = [sub({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 50 } })]; // 50% abertura
    const row = computeMeasuredRow(spend(), now, { previousChannelSubs: before });
    assert.equal(row.aberturaAgregadaAnterior, 0.5);
    assert.equal(row.degradado, true);
    assert.ok((0.5 - row.aberturaAgregada!) * 100 >= DEGRADATION_THRESHOLD_PCT);
  });

  it("abertura estável -> degradado=false, não null", () => {
    const now = [sub({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 40 } })];
    const before = [sub({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 41 } })];
    const row = computeMeasuredRow(spend(), now, { previousChannelSubs: before });
    assert.equal(row.degradado, false);
  });
});

describe("computeBoostRow", () => {
  it("nota explica a estimativa e nunca oferece um ponto único", () => {
    const row = computeBoostRow(spend({ canal: "Beehiiv Boosts", valor: 397.08 }));
    assert.equal(row.kind, "boost-estimate");
    assert.match(row.note, /157/);
    assert.match(row.note, /233/);
    assert.ok(row.range.custoPorLeitorMin! < row.range.custoPorLeitorMax!);
  });
});

// ---------------------------------------------------------------------------
// buildCacReport — end-to-end com as 3 linhas de spend + fixtures
// ---------------------------------------------------------------------------

describe("buildCacReport", () => {
  const spendRows: SpendRow[] = [
    spend({ canal: "Google Ads", valor: 956.21 }),
    spend({ canal: "Beehiiv Boosts", valor: 397.08 }),
    spend({ canal: "LinkedIn", valor: 0, mes: "2026-08" }),
  ];

  it("produz 3 linhas, uma por linha de spend.csv, na mesma ordem de canais (antes do rank)", () => {
    const report = buildCacReport(spendRows, []);
    assert.equal(report.rows.length, 3);
    assert.deepEqual(
      report.rows.map((r) => r.canal).sort(),
      ["Beehiiv Boosts", "Google Ads", "LinkedIn"],
    );
  });

  it("Beehiiv Boosts vira boost-estimate; Google Ads e LinkedIn viram measured", () => {
    const report = buildCacReport(spendRows, []);
    const byCanal = Object.fromEntries(report.rows.map((r) => [r.canal, r]));
    assert.equal(byCanal["Beehiiv Boosts"].kind, "boost-estimate");
    assert.equal(byCanal["Google Ads"].kind, "measured");
    assert.equal(byCanal["LinkedIn"].kind, "measured");
  });

  it("ranqueia por custo por leitor ascendente (canal mais barato primeiro)", () => {
    const subs = [
      sub({ utm_source: "android.googlequicksearchbox", stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 40 } }),
    ];
    const report = buildCacReport(spendRows, subs);
    const googleRow = report.rows.find((r) => r.canal === "Google Ads") as CacMeasuredRow;
    assert.equal(googleRow.leitores, 1);
    assert.equal(googleRow.custoPorLeitor, 956.21);
    // LinkedIn sem assinantes -> custoPorLeitor null -> vai pro fim
    const linkedinIdx = report.rows.findIndex((r) => r.canal === "LinkedIn");
    assert.equal(linkedinIdx, report.rows.length - 1);
  });

  it("totalGastoMedido exclui a linha boost-estimate (nunca soma no blended, requisito da issue)", () => {
    const report = buildCacReport(spendRows, []);
    assert.equal(report.totalGastoMedido, 956.21 + 0); // Google Ads + LinkedIn, SEM Boosts
  });

  it("propaga internalFiltered/originApplied recebidos via opts", () => {
    const report = buildCacReport(spendRows, [], { internalFiltered: 3, originApplied: true });
    assert.equal(report.internalFiltered, 3);
    assert.equal(report.originApplied, true);
  });

  it("canal sem linhas correspondentes no snapshot ainda aparece (n=0/vazio, nunca desaparece)", () => {
    const report = buildCacReport(spendRows, []);
    const googleRow = report.rows.find((r) => r.canal === "Google Ads") as CacMeasuredRow;
    assert.equal(googleRow.leitores, 0);
    assert.equal(googleRow.amostraVazia, true);
  });

  it("canal com typo (ex: 'Beehiiv Boost' sem 's') vira measured vazio E entra em unmappedChannels (finding 4 #5236, PR #5276)", () => {
    const typoRows: SpendRow[] = [spend({ canal: "Beehiiv Boost", valor: 397.08 })];
    const report = buildCacReport(typoRows, []);
    assert.equal(report.rows[0].kind, "measured");
    assert.deepEqual(report.unmappedChannels, ["Beehiiv Boost"]);
  });

  it("canal reconhecido (Google Ads/LinkedIn/Beehiiv Boosts) NUNCA entra em unmappedChannels", () => {
    const report = buildCacReport(spendRows, []);
    assert.deepEqual(report.unmappedChannels, []);
  });

  it("unmappedChannels lista cada canal desconhecido na ordem de spend.csv, mesmo com múltiplos", () => {
    const mixedRows: SpendRow[] = [
      spend({ canal: "Google Ads", valor: 100 }),
      spend({ canal: "Beehiiv Boost", valor: 50 }), // typo
      spend({ canal: "TikTok Ads", valor: 30 }), // canal genuinamente novo, não mapeado ainda
    ];
    const report = buildCacReport(mixedRows, []);
    assert.deepEqual(report.unmappedChannels, ["Beehiiv Boost", "TikTok Ads"]);
  });

  it("base metrics vêm de TODOS os ativos, não só dos canais medidos", () => {
    const subs = [
      sub({ utm_source: "direct", stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 50 } }),
      sub({ utm_source: "android.googlequicksearchbox", stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 20 } }),
    ];
    const base = computeBaseMetrics(subs);
    assert.equal(base.amostraConsiderada, 2);
    assert.ok(Math.abs(base.aberturaAgregada! - 0.35) < 1e-9); // (50+20)/(100+100)
  });
});

// ---------------------------------------------------------------------------
// Orçamento mensal
// ---------------------------------------------------------------------------

describe("computeMonthBudgetUsage", () => {
  it("soma só as linhas do mês pedido", () => {
    const rows: SpendRow[] = [
      spend({ mes: "2026-08", valor: 100 }),
      spend({ mes: "2026-08", valor: 50 }),
      spend({ mes: "2026-02", valor: 956.21 }),
    ];
    const usage = computeMonthBudgetUsage(rows, "2026-08");
    assert.equal(usage.spentBrl, 150);
    assert.equal(usage.budgetFloorBrl, MONTHLY_BUDGET_FLOOR_BRL);
    assert.ok(Math.abs(usage.fractionUsed - 150 / MONTHLY_BUDGET_FLOOR_BRL) < 1e-9);
  });

  it("mês sem nenhuma linha -> 0 gasto, nunca lança", () => {
    const usage = computeMonthBudgetUsage([spend({ mes: "2026-01" })], "2026-08");
    assert.equal(usage.spentBrl, 0);
    assert.equal(usage.fractionUsed, 0);
  });
});
