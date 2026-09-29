/**
 * test/ltv.test.ts (#8423)
 *
 * Cobertura do núcleo PURO de LTV/valor (`scripts/lib/ltv.ts`) — ARPU,
 * churn (orgânico × com limpeza), LTV de caixa (blended + faixa), LTV por
 * origem, conversão em apoiador e LTV÷CAC. Sanity-check contra a ordem de
 * grandeza dos números de referência da issue #8423 (calculados à mão em
 * 19/09/2026) — nunca exato, o tempo passou e a base mudou.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LTV_DEFAULT_HORIZON_MONTHS,
  CONVERSAO_APOIADOR_MIN_N,
  computeArpu,
  computeChurnRate,
  computeLtvCaixa,
  computeLtvCaixaFaixa,
  computeConversaoApoiador,
  computeLtvPorOrigem,
  computeLtvCacRatio,
  summarizeApoiaSeMonthRevenue,
  parseAmazonRevenueConfig,
  previousCompetenceMonth,
  findChurnBaselineDate,
  computeChurnExitsBetweenSnapshots,
  resolveApoiaSeCampaignName,
  type ChurnRateResult,
  type LtvCaixaFaixaResult,
} from "../scripts/lib/ltv.ts";

// #8968: ChurnRateResult.monthly e LtvCaixaFaixaResult.faixa modelam pares
// "ambos ou nenhum" como `{ ... } | null` (mesmo idioma de `MetricLimites`
// em scripts/lib/metrics/registry.ts) em vez de 2 campos nullable
// independentes — este teste é só de TIPO/FORMA: falha em `tsc`
// (npx tsc -p tsconfig.test.json --noEmit), nunca em `node --test`, se
// alguém reintroduzir o par independente.
describe("#8968 — pares min/max agrupados em { ... } | null", () => {
  it("ChurnRateResult.monthly: ambos os campos presentes juntos, nunca um só", () => {
    const comAmbos: ChurnRateResult["monthly"] = { organico: 0.01, comLimpeza: 0.02 };
    const semNenhum: ChurnRateResult["monthly"] = null;
    // @ts-expect-error — não é permitido só um dos dois campos
    const apenasUm: ChurnRateResult["monthly"] = { organico: 0.01 };
    assert.ok(comAmbos.organico <= comAmbos.comLimpeza);
    assert.equal(semNenhum, null);
    void apenasUm;
  });

  it("LtvCaixaFaixaResult.faixa: ambos os campos presentes juntos, nunca um só", () => {
    const comAmbos: LtvCaixaFaixaResult["faixa"] = { min: 14, max: 16 };
    const semNenhum: LtvCaixaFaixaResult["faixa"] = null;
    // @ts-expect-error — não é permitido só um dos dois campos
    const apenasUm: LtvCaixaFaixaResult["faixa"] = { min: 14 };
    assert.ok(comAmbos.min <= comAmbos.max);
    assert.equal(semNenhum, null);
    void apenasUm;
  });
});

describe("computeArpu", () => {
  it("soma fontes com dado e divide pela base ativa", () => {
    const r = computeArpu({ revenueBySource: { "apoia-se": 468, amazon: 50 }, activeBase: 628 });
    assert.equal(r.totalRevenueBrl, 518);
    assert.ok(r.valor != null);
    assert.ok(Math.abs(r.valor - 518 / 628) < 1e-9);
    assert.equal(r.motivo, null);
    assert.deepEqual(r.fontesSemDado, []);
  });

  it("nunca fabrica 0 quando a base ativa está ausente", () => {
    const r = computeArpu({ revenueBySource: { "apoia-se": 100 }, activeBase: null });
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /base ativa/);
  });

  it("nunca fabrica 0 quando a base ativa é <= 0", () => {
    const r = computeArpu({ revenueBySource: { "apoia-se": 100 }, activeBase: 0 });
    assert.equal(r.valor, null);
  });

  it("cai em indeterminado quando NENHUMA fonte tem dado", () => {
    const r = computeArpu({ revenueBySource: { "apoia-se": null, amazon: null }, activeBase: 628 });
    assert.equal(r.valor, null);
    assert.equal(r.totalRevenueBrl, null);
    assert.match(r.motivo ?? "", /nenhuma fonte/);
  });

  it("vira PISO (nunca indeterminado) quando SÓ ALGUMAS fontes faltam", () => {
    const r = computeArpu({ revenueBySource: { "apoia-se": 468, amazon: null }, activeBase: 628 });
    assert.ok(r.valor != null);
    assert.equal(r.totalRevenueBrl, 468);
    assert.deepEqual(r.fontesSemDado, ["amazon"]);
    assert.match(r.motivo ?? "", /PISO/);
  });
});

describe("computeChurnRate", () => {
  it("separa saídas orgânicas de limpeza manual — orgânico <= com limpeza", () => {
    const exits = [
      { email: "a@x.com" },
      { email: "b@x.com" },
      { email: "manual1@x.com" },
      { email: "manual2@x.com" },
    ];
    const manualCleanupEmails = new Set(["manual1@x.com", "manual2@x.com"]);
    const r = computeChurnRate({ exits, manualCleanupEmails, periodMonths: 1, avgActiveBase: 100 });
    assert.equal(r.totalExits, 4);
    assert.equal(r.manualCleanupExits, 2);
    assert.equal(r.organicExits, 2);
    assert.ok(r.monthly != null);
    assert.ok(r.monthly.organico < r.monthly.comLimpeza);
    assert.ok(Math.abs(r.monthly.organico - 2 / 100) < 1e-9);
    assert.ok(Math.abs(r.monthly.comLimpeza - 4 / 100) < 1e-9);
  });

  it("reproduz a ordem de grandeza da issue: churn 'com limpeza' alto quando a maioria das saídas é limpeza", () => {
    // issue: 65 das 70 saídas jun→ago foram limpeza manual, ~5%/mês
    const exits = Array.from({ length: 70 }, (_, i) => ({ email: `s${i}@x.com` }));
    const manualCleanupEmails = new Set(exits.slice(0, 65).map((e) => e.email));
    const avgActiveBase = 466; // ordem de grandeza plausível pro período
    const r = computeChurnRate({ exits, manualCleanupEmails, periodMonths: 3, avgActiveBase });
    assert.ok(r.monthly != null);
    assert.ok(r.monthly.comLimpeza > 0.04 && r.monthly.comLimpeza < 0.06, `esperava ~5%, obteve ${r.monthly.comLimpeza}`);
  });

  it("nunca fabrica 0 quando avgActiveBase é null", () => {
    const r = computeChurnRate({ exits: [], manualCleanupEmails: new Set(), periodMonths: 1, avgActiveBase: null });
    assert.equal(r.monthly, null);
    assert.match(r.motivo ?? "", /inválida/);
  });

  it("nunca fabrica 0 quando periodMonths é 0", () => {
    const r = computeChurnRate({ exits: [], manualCleanupEmails: new Set(), periodMonths: 0, avgActiveBase: 100 });
    assert.equal(r.monthly, null);
  });

  it("indeterminado quando periodMonths é negativo (#8423 fleet review — must-add)", () => {
    const r = computeChurnRate({ exits: [{ email: "a@x.com" }], manualCleanupEmails: new Set(), periodMonths: -1, avgActiveBase: 100 });
    assert.equal(r.monthly, null);
    assert.match(r.motivo ?? "", /inválida/);
  });

  it("churn implausível (>100%/mês) vira indeterminado — snapshot suspeito, nunca número seco (#8423 fleet review item 6)", () => {
    const exits = Array.from({ length: 50 }, (_, i) => ({ email: `s${i}@x.com` }));
    // base ativa média de 10, 50 saídas num único mês -> 500%/mês, implausível
    const r = computeChurnRate({ exits, manualCleanupEmails: new Set(), periodMonths: 1, avgActiveBase: 10 });
    assert.equal(r.monthly, null);
    assert.match(r.motivo ?? "", /implausível/);
  });

  it("churn <= 100%/mês não é afetado pelo guard de implausibilidade", () => {
    const r = computeChurnRate({ exits: [{ email: "a@x.com" }], manualCleanupEmails: new Set(), periodMonths: 1, avgActiveBase: 100 });
    assert.ok(r.monthly != null);
    assert.ok(r.monthly.organico <= 1);
  });
});

describe("computeLtvCaixa", () => {
  it("LTV = ARPU × min(1/churn, horizonte)", () => {
    const r = computeLtvCaixa({ arpuMonthlyBrl: 0.78, churnMonthly: 0.05, horizonMonths: 24 });
    // 1/0.05 = 20 meses < 24 -> não truncado
    assert.ok(r.vidaUtilEsperadaMeses != null && Math.abs(r.vidaUtilEsperadaMeses - 20) < 1e-9);
    assert.ok(r.valor != null && Math.abs(r.valor - 0.78 * 20) < 1e-9);
    assert.equal(r.motivo, null);
  });

  it("trunca a vida útil no horizonte quando 1/churn excede o horizonte", () => {
    const r = computeLtvCaixa({ arpuMonthlyBrl: 0.78, churnMonthly: 0.024, horizonMonths: 24 });
    // 1/0.024 ≈ 41.7 meses > 24 -> truncado em 24
    assert.equal(r.vidaUtilEsperadaMeses, 24);
    assert.ok(r.valor != null && Math.abs(r.valor - 0.78 * 24) < 1e-9);
    assert.match(r.motivo ?? "", /truncada/);
  });

  it("churn <= 0 nunca produz LTV infinito — trunca no horizonte", () => {
    const r = computeLtvCaixa({ arpuMonthlyBrl: 1, churnMonthly: 0, horizonMonths: 24 });
    assert.equal(r.vidaUtilEsperadaMeses, 24);
    assert.equal(r.valor, 24);
    assert.match(r.motivo ?? "", /nunca tratada como infinita/);
  });

  it("nunca fabrica 0 quando ARPU é null", () => {
    const r = computeLtvCaixa({ arpuMonthlyBrl: null, churnMonthly: 0.05, horizonMonths: 24 });
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /ARPU/);
  });

  it("nunca fabrica 0 quando churn é null", () => {
    const r = computeLtvCaixa({ arpuMonthlyBrl: 1, churnMonthly: null, horizonMonths: 24 });
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /churn/);
  });

  it("usa LTV_DEFAULT_HORIZON_MONTHS = 24 (documentado na issue)", () => {
    assert.equal(LTV_DEFAULT_HORIZON_MONTHS, 24);
  });
});

describe("computeLtvCaixaFaixa", () => {
  it("devolve faixa: min (churn com limpeza, maior) <= max (churn orgânico, menor)", () => {
    const r = computeLtvCaixaFaixa({
      arpuMonthlyBrl: 0.78,
      churnOrganicoMonthly: 0.024,
      churnComLimpezaMonthly: 0.05,
      horizonMonths: 24,
    });
    assert.ok(r.faixa != null);
    assert.ok(r.faixa.min <= r.faixa.max);
    // sanity check de ordem de grandeza vs. a issue (~R$15-19, referência ~R$14-16)
    assert.ok(r.faixa.min > 10 && r.faixa.min < 20, `min fora da ordem de grandeza esperada: ${r.faixa.min}`);
    assert.ok(r.faixa.max > 10 && r.faixa.max < 20, `max fora da ordem de grandeza esperada: ${r.faixa.max}`);
  });

  it("nunca fabrica faixa quando um dos churns é indisponível", () => {
    const r = computeLtvCaixaFaixa({
      arpuMonthlyBrl: 0.78,
      churnOrganicoMonthly: null,
      churnComLimpezaMonthly: 0.05,
      horizonMonths: 24,
    });
    assert.equal(r.faixa, null);
    assert.ok(r.motivo);
  });
});

describe("computeConversaoApoiador", () => {
  it("calcula a razão e marca amostra ok quando n >= minN", () => {
    const r = computeConversaoApoiador({ apoiadores: 18, confirmados: 218 });
    assert.ok(Math.abs((r.valor ?? 0) - 18 / 218) < 1e-9);
    assert.equal(r.qualidadeAmostra, "ok");
    assert.equal(r.motivo, null);
  });

  it("marca amostra pequena quando n < minN (issue: 1 apoiador a menos/mais move dezenas de %)", () => {
    const r = computeConversaoApoiador({ apoiadores: 1, confirmados: 194 });
    assert.equal(r.qualidadeAmostra, "pequena");
    assert.match(r.motivo ?? "", /amostra de apoiadores pequena/);
    assert.equal(CONVERSAO_APOIADOR_MIN_N, 5);
  });

  it("nunca fabrica 0 quando o denominador é zero", () => {
    const r = computeConversaoApoiador({ apoiadores: 0, confirmados: 0 });
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /denominador/);
  });
});

describe("computeLtvPorOrigem", () => {
  it("reproduz a ordem de grandeza da coorte fria/paga da issue (~R$3/ativo)", () => {
    // issue: 0,5% × R$20 + Amazon(R$50/628), × 18 meses ≈ R$3/ativo
    const r = computeLtvPorOrigem({
      conversaoApoiador: 0.005,
      valorMedioApoiadorMensal: 20,
      outrasFontesPerAtivoMensal: 50 / 628,
      horizonMonths: 18,
    });
    assert.ok(r.valor != null);
    assert.ok(Math.abs(r.valor - 3) < 0.5, `esperava ~R$3, obteve ${r.valor}`);
  });

  it("nunca fabrica 0 quando conversão em apoiador é indisponível", () => {
    const r = computeLtvPorOrigem({
      conversaoApoiador: null,
      valorMedioApoiadorMensal: 20,
      horizonMonths: 18,
    });
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /conversão/);
  });

  it("nunca fabrica 0 quando valor médio do apoiador é indisponível", () => {
    const r = computeLtvPorOrigem({
      conversaoApoiador: 0.05,
      valorMedioApoiadorMensal: null,
      horizonMonths: 18,
    });
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /valor médio/);
  });

  it("trata outrasFontesPerAtivoMensal ausente como 0, nunca como indisponível", () => {
    const r = computeLtvPorOrigem({ conversaoApoiador: 0.1, valorMedioApoiadorMensal: 10, horizonMonths: 12 });
    assert.ok(r.valor != null);
    assert.ok(Math.abs(r.valor - 0.1 * 10 * 12) < 1e-9);
  });
});

describe("computeLtvCacRatio", () => {
  it("LTV ÷ CAC", () => {
    const r = computeLtvCacRatio({ ltvBrl: 15, custoPorLeitorBrl: 5 });
    assert.equal(r.valor, 3);
  });

  it("nunca fabrica 0/infinito quando CAC é null", () => {
    const r = computeLtvCacRatio({ ltvBrl: 15, custoPorLeitorBrl: null });
    assert.equal(r.valor, null);
  });

  it("nunca fabrica infinito quando CAC é 0", () => {
    const r = computeLtvCacRatio({ ltvBrl: 15, custoPorLeitorBrl: 0 });
    assert.equal(r.valor, null);
    assert.match(r.motivo ?? "", /<= 0/);
  });

  it("nunca fabrica 0 quando LTV é null", () => {
    const r = computeLtvCacRatio({ ltvBrl: null, custoPorLeitorBrl: 5 });
    assert.equal(r.valor, null);
  });
});

describe("summarizeApoiaSeMonthRevenue", () => {
  it("soma só quem pagou este mês e conta backers totais separadamente", () => {
    const cache = {
      "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 },
      "b@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 10 },
      "c@x.com": { isBacker: true, isPaidThisMonth: false },
      "d@x.com": { isBacker: false, isPaidThisMonth: false },
    };
    const r = summarizeApoiaSeMonthRevenue(cache);
    assert.equal(r.grossRevenueBrl, 35);
    assert.equal(r.payingBackersCount, 2);
    assert.equal(r.totalBackersCount, 3);
    assert.equal(r.avgPaidValueBrl, 17.5);
  });

  it("nunca fabrica 0/NaN pro valor médio quando ninguém pagou", () => {
    const cache = { "a@x.com": { isBacker: true, isPaidThisMonth: false } };
    const r = summarizeApoiaSeMonthRevenue(cache);
    assert.equal(r.grossRevenueBrl, 0);
    assert.equal(r.avgPaidValueBrl, null);
  });

  it("cache vazio nunca lança", () => {
    const r = summarizeApoiaSeMonthRevenue({});
    assert.equal(r.grossRevenueBrl, 0);
    assert.equal(r.payingBackersCount, 0);
    assert.equal(r.totalBackersCount, 0);
    assert.equal(r.avgPaidValueBrl, null);
    assert.equal(r.paidWithoutValueCount, 0);
  });

  it("isPaidThisMonth:true SEM thisMonthPaidValue nunca conta como R$0 pagante (#8423 fleet review item 5)", () => {
    const cache = {
      "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 },
      // paga mas sem valor reportado — inconsistência de dado da apoia.se
      "b@x.com": { isBacker: true, isPaidThisMonth: true },
    };
    const r = summarizeApoiaSeMonthRevenue(cache);
    assert.equal(r.grossRevenueBrl, 25); // "b" não entra como R$0
    assert.equal(r.payingBackersCount, 1); // "b" não conta como pagante
    assert.equal(r.avgPaidValueBrl, 25); // denominador não inflado por "b"
    assert.equal(r.paidWithoutValueCount, 1);
  });
});

describe("parseAmazonRevenueConfig", () => {
  it("aceita o shape esperado", () => {
    const r = parseAmazonRevenueConfig({ valorMensalBrl: 50, atualizadoEm: "2026-09-19T00:00:00.000Z" });
    assert.deepEqual(r, { valorMensalBrl: 50, atualizadoEm: "2026-09-19T00:00:00.000Z" });
  });

  it("nunca fabrica valor quando o JSON não é um objeto", () => {
    assert.equal(parseAmazonRevenueConfig(null), null);
    assert.equal(parseAmazonRevenueConfig("50"), null);
    assert.equal(parseAmazonRevenueConfig(50), null);
    assert.equal(parseAmazonRevenueConfig([1, 2]), null);
  });

  it("nunca fabrica valor quando falta um dos campos ou o tipo é errado", () => {
    assert.equal(parseAmazonRevenueConfig({ valorMensalBrl: 50 }), null);
    assert.equal(parseAmazonRevenueConfig({ atualizadoEm: "2026-09-19" }), null);
    assert.equal(parseAmazonRevenueConfig({ valorMensalBrl: "50", atualizadoEm: "2026-09-19" }), null);
    assert.equal(parseAmazonRevenueConfig({ valorMensalBrl: NaN, atualizadoEm: "2026-09-19" }), null);
    assert.equal(parseAmazonRevenueConfig({ valorMensalBrl: 50, atualizadoEm: "" }), null);
  });
});

describe("resolveApoiaSeCampaignName", () => {
  it("default 'diaria' quando env ausente", () => {
    assert.equal(resolveApoiaSeCampaignName({}), "diaria");
  });

  it("usa APOIA_SE_CAMPAIGN quando presente", () => {
    assert.equal(resolveApoiaSeCampaignName({ APOIA_SE_CAMPAIGN: "outra" }), "outra");
  });

  it("string vazia/espaços cai no default", () => {
    assert.equal(resolveApoiaSeCampaignName({ APOIA_SE_CAMPAIGN: "  " }), "diaria");
  });
});

describe("previousCompetenceMonth", () => {
  it("mês anterior dentro do mesmo ano", () => {
    assert.equal(previousCompetenceMonth(new Date("2026-09-15T12:00:00Z")), "2026-08");
  });

  it("virada de ano", () => {
    assert.equal(previousCompetenceMonth(new Date("2026-01-15T12:00:00Z")), "2025-12");
  });
});

describe("findChurnBaselineDate", () => {
  it("escolhe a data mais próxima de 30 dias antes da mais recente", () => {
    const dates = ["2026-07-01", "2026-08-10", "2026-08-20", "2026-09-09"];
    assert.equal(findChurnBaselineDate(dates, "2026-09-09", 30, 14), "2026-08-10");
  });

  it("ignora datas a menos de minDays de distância", () => {
    assert.equal(findChurnBaselineDate(["2026-09-01", "2026-09-05"], "2026-09-09", 30, 14), null);
  });

  it("null quando só há a própria data mais recente", () => {
    assert.equal(findChurnBaselineDate(["2026-09-09"], "2026-09-09"), null);
  });
});

describe("computeChurnExitsBetweenSnapshots", () => {
  it("quem era ativo no baseline e não está mais ativo no mais recente é saída", () => {
    const baseline = [{ email: "a@x.com", status: "active" }, { email: "b@x.com", status: "active" }];
    const latest = [{ email: "a@x.com", status: "active" }, { email: "b@x.com", status: "inactive" }];
    const { exits, avgActiveBase } = computeChurnExitsBetweenSnapshots(baseline, latest);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].email, "b@x.com");
    assert.equal(avgActiveBase, 1.5);
  });

  it("normaliza e-mail (trim + lowercase) na comparação", () => {
    const { exits } = computeChurnExitsBetweenSnapshots([{ email: " A@X.com ", status: "active" }], []);
    assert.equal(exits[0].email, "a@x.com");
  });
});
