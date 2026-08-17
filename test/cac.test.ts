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
  CHANNEL_KEY_SPECS,
  RESERVED_CHANNEL_NAMES,
  assertValidChannelKeySpecs,
  subscribersForChannel,
  subscribersForChannelSpec,
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
  type ChannelKeySpec,
} from "../scripts/lib/cac.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";
import { parseSinceToEpochSeconds, parseUntilToEpochSecondsExclusive } from "../scripts/cohort-engagement.ts";

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

// ---------------------------------------------------------------------------
// CHANNEL_KEY_SPECS — sub-canal + janela ambígua (#5496) + Meta/Microsoft
// deliberadamente bloqueados (#5493)
// ---------------------------------------------------------------------------

describe("assertValidChannelKeySpecs", () => {
  it("lança quando uma spec ambígua não tem janela", () => {
    const bad: ChannelKeySpec[] = [{ canal: "Google Ads", subcanal: "Search", keys: ["google.com"], ambigua: true }];
    assert.throws(() => assertValidChannelKeySpecs(bad), /janela obrigatória/);
  });

  it("não lança quando a spec ambígua tem janela", () => {
    const ok: ChannelKeySpec[] = [
      {
        canal: "Google Ads",
        subcanal: "Search",
        keys: ["google.com"],
        ambigua: true,
        janela: { since: parseSinceToEpochSeconds("2025-12-01"), untilExclusive: parseUntilToEpochSecondsExclusive("2026-02-28") },
      },
    ];
    assert.doesNotThrow(() => assertValidChannelKeySpecs(ok));
  });

  it("não lança pra spec não-ambígua sem janela", () => {
    assert.doesNotThrow(() => assertValidChannelKeySpecs([{ canal: "LinkedIn", keys: ["linkedin"] }]));
  });

  it("CHANNEL_KEY_SPECS real (módulo) passa na própria validação (sanity — já rodou no import)", () => {
    assert.doesNotThrow(() => assertValidChannelKeySpecs(CHANNEL_KEY_SPECS));
  });
});

describe("CHANNEL_GROUP_KEYS derivado — nunca inclui chave ambígua", () => {
  it("Google Ads (legado, sem sub-canal) NÃO inclui google.com", () => {
    assert.ok(!CHANNEL_GROUP_KEYS["Google Ads"].includes("google.com"));
  });

  it("subscribersForChannel(subs, 'Google Ads') não casa google.com mesmo dentro da janela da campanha", () => {
    const subs = [sub({ utm_source: "google.com", created: parseSinceToEpochSeconds("2026-01-15") })];
    assert.deepEqual(subscribersForChannel(subs, "Google Ads"), []);
  });
});

describe("RESERVED_CHANNEL_NAMES (#5493) — Meta/Microsoft Advertising canônicos, sem spec ainda", () => {
  it("nomes canônicos fixados", () => {
    assert.deepEqual(RESERVED_CHANNEL_NAMES, ["Meta", "Microsoft Advertising"]);
  });

  it("nenhum dos dois tem entrada em CHANNEL_GROUP_KEYS ainda (bloqueado por observação real)", () => {
    for (const canal of RESERVED_CHANNEL_NAMES) {
      assert.equal(CHANNEL_GROUP_KEYS[canal], undefined);
    }
  });

  it("tráfego orgânico de Instagram (instagram.com/instagram-diaria/instagram-pessoal) nunca cai em canal pago", () => {
    const subs = [
      sub({ utm_source: "instagram.com" }),
      sub({ utm_source: "instagram-diaria" }),
      sub({ utm_source: "instagram-pessoal" }),
    ];
    // Nenhum canal conhecido (Google Ads, LinkedIn) casa esses referrers —
    // e não existe spec "Meta" ainda pra casar também (#5493).
    assert.deepEqual(subscribersForChannel(subs, "Google Ads"), []);
    assert.deepEqual(subscribersForChannel(subs, "LinkedIn"), []);
    for (const spec of CHANNEL_KEY_SPECS) {
      assert.deepEqual(subscribersForChannelSpec(subs, spec), [], `spec ${spec.canal}/${spec.subcanal ?? ""} não deveria casar Instagram orgânico`);
    }
  });
});

describe("subscribersForChannelSpec — sub-canal PMax/Search (#5496)", () => {
  const pmaxSpec = CHANNEL_KEY_SPECS.find((s) => s.canal === "Google Ads" && s.subcanal === "PMax")!;
  const searchSpec = CHANNEL_KEY_SPECS.find((s) => s.canal === "Google Ads" && s.subcanal === "Search")!;

  it("PMax casa android.googlequicksearchbox, não casa google.com", () => {
    const subs = [sub({ utm_source: "android.googlequicksearchbox" }), sub({ utm_source: "google.com" })];
    assert.equal(subscribersForChannelSpec(subs, pmaxSpec).length, 1);
  });

  it("Search casa google.com (sem aplicar a janela sozinho — isso é responsabilidade do orquestrador)", () => {
    const subs = [sub({ utm_source: "google.com" }), sub({ utm_source: "direct" })];
    assert.equal(subscribersForChannelSpec(subs, searchSpec).length, 1);
  });

  it("spec Search tem janela dez/2025-fev/2026 (campanha real, #4466/#5254/#5496)", () => {
    assert.ok(searchSpec.ambigua);
    assert.ok(searchSpec.janela);
  });
});

// ---------------------------------------------------------------------------
// buildCacReport com sub-canal (#5496) — PMax/Search não fundidos, guard de
// dupla-contagem, google.com só dentro da janela
// ---------------------------------------------------------------------------

describe("buildCacReport — sub-canal (#5496)", () => {
  it("linha com subcanal='PMax' mede só as chaves de PMax", () => {
    const spendRows: SpendRow[] = [spend({ canal: "Google Ads", subcanal: "PMax", valor: 718.39 })];
    const subs = [sub({ utm_source: "android.googlequicksearchbox" }), sub({ utm_source: "google.com", created: parseSinceToEpochSeconds("2026-01-15") })];
    const report = buildCacReport(spendRows, subs);
    const row = report.rows[0] as CacMeasuredRow;
    assert.equal(row.leitores, 1);
    assert.equal(row.spend.subcanal, "PMax");
  });

  it("linha com subcanal='Search' só conta google.com DENTRO da janela dez/2025-fev/2026", () => {
    const spendRows: SpendRow[] = [spend({ canal: "Google Ads", subcanal: "Search", valor: 239.62 })];
    const subs = [
      sub({ email: "dentro@example.com", utm_source: "google.com", created: parseSinceToEpochSeconds("2026-01-15") }),
      sub({ email: "fora@example.com", utm_source: "google.com", created: parseSinceToEpochSeconds("2026-05-01") }),
    ];
    const report = buildCacReport(spendRows, subs);
    const row = report.rows[0] as CacMeasuredRow;
    assert.equal(row.cadastros, 1, "só o cadastro dentro da janela da campanha deveria contar");
  });

  it("PMax e Search não se fundem — 2 linhas distintas, cada uma com seu subcanal", () => {
    const spendRows: SpendRow[] = [
      spend({ canal: "Google Ads", subcanal: "PMax", valor: 718.39 }),
      spend({ canal: "Google Ads", subcanal: "Search", valor: 239.62 }),
    ];
    const report = buildCacReport(spendRows, []);
    assert.equal(report.rows.length, 2);
    assert.deepEqual(
      report.rows.map((r) => r.spend.subcanal).sort(),
      ["PMax", "Search"],
    );
  });

  it("canal/subcanal sem spec correspondente vira unmapped (ex: Google Ads/Display, sem spec)", () => {
    const spendRows: SpendRow[] = [spend({ canal: "Google Ads", subcanal: "Display", valor: 10 })];
    const report = buildCacReport(spendRows, []);
    assert.deepEqual(report.unmappedChannels, ["Google Ads/Display"]);
  });

  it("linha de canal inteiro + linha de sub-canal no MESMO canal/mês lança (dupla-contagem)", () => {
    const spendRows: SpendRow[] = [
      spend({ canal: "Google Ads", mes: "2026-02", valor: 956.21 }), // canal inteiro, sem subcanal
      spend({ canal: "Google Ads", mes: "2026-02", subcanal: "PMax", valor: 718.39 }),
    ];
    assert.throws(() => buildCacReport(spendRows, []), /dupla contagem/);
  });

  it("mensagem de erro identifica o canal/mês corretamente mesmo com canal multi-palavra (regressão: replace(' ', ...) ingênuo casava o espaço DENTRO de 'Google Ads')", () => {
    const spendRows: SpendRow[] = [
      spend({ canal: "Google Ads", mes: "2026-02", valor: 956.21 }),
      spend({ canal: "Google Ads", mes: "2026-02", subcanal: "PMax", valor: 718.39 }),
    ];
    assert.throws(() => buildCacReport(spendRows, []), /Google Ads \/ mês 2026-02/);
  });

  it("linha de canal inteiro + linha de sub-canal em MESES DIFERENTES não lança", () => {
    const spendRows: SpendRow[] = [
      spend({ canal: "Google Ads", mes: "2026-01", valor: 100 }),
      spend({ canal: "Google Ads", mes: "2026-02", subcanal: "PMax", valor: 50 }),
    ];
    assert.doesNotThrow(() => buildCacReport(spendRows, []));
  });
});

// ---------------------------------------------------------------------------
// buildCacReport — janela global --desde/--ate (#5495)
// ---------------------------------------------------------------------------

describe("buildCacReport — janela global (#5495)", () => {
  it("sem window: comportamento idêntico a antes (window=null, excludedMissingCreated=0)", () => {
    const report = buildCacReport([spend()], [sub()]);
    assert.equal(report.window, null);
    assert.equal(report.excludedMissingCreated, 0);
  });

  it("com window: cadastro fora da janela não entra na base nem no canal", () => {
    const window = { since: parseSinceToEpochSeconds("2026-08-01"), untilExclusive: parseUntilToEpochSecondsExclusive("2026-08-16") };
    const subs = [
      sub({ email: "dentro@example.com", utm_source: "android.googlequicksearchbox", created: parseSinceToEpochSeconds("2026-08-10") }),
      sub({ email: "fora@example.com", utm_source: "android.googlequicksearchbox", created: parseSinceToEpochSeconds("2026-01-01") }),
    ];
    const report = buildCacReport([spend()], subs, { window });
    assert.equal(report.window, window);
    assert.equal(report.base.amostraConsiderada, 1);
    const row = report.rows[0] as CacMeasuredRow;
    assert.equal(row.cadastros, 1);
    assert.deepEqual(row.window, window);
  });

  it("assinante sem created é descartado (nunca assumido dentro/fora) e contado em excludedMissingCreated", () => {
    const window = { since: parseSinceToEpochSeconds("2026-08-01"), untilExclusive: null };
    const subs = [sub({ created: undefined as unknown as number })];
    const report = buildCacReport([spend()], subs, { window });
    assert.equal(report.excludedMissingCreated, 1);
    assert.equal(report.base.amostraConsiderada, 0);
  });

  it("janela global + janela do sub-canal ambíguo se combinam por intersecção", () => {
    // Janela global mais estreita que a da campanha de Search — só a
    // intersecção (jan/2026) deveria sobrar.
    const window = { since: parseSinceToEpochSeconds("2026-01-01"), untilExclusive: parseUntilToEpochSecondsExclusive("2026-01-31") };
    const spendRows: SpendRow[] = [spend({ canal: "Google Ads", subcanal: "Search", valor: 100 })];
    const subs = [
      sub({ email: "jan@example.com", utm_source: "google.com", created: parseSinceToEpochSeconds("2026-01-15") }),
      sub({ email: "dez@example.com", utm_source: "google.com", created: parseSinceToEpochSeconds("2025-12-15") }), // fora da janela GLOBAL
    ];
    const report = buildCacReport(spendRows, subs, { window });
    const row = report.rows[0] as CacMeasuredRow;
    assert.equal(row.cadastros, 1, "só o cadastro de janeiro deveria sobreviver à intersecção");
  });
});
