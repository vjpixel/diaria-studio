/**
 * test/brevo-dashboard-fase2.test.ts (#2086)
 *
 * Testes unitários para os helpers de agregação da Fase 2 mínima:
 *  - extractClariceCell / parseClariceCampaignKey
 *  - aggregateAbcSummary
 *  - calcCumulativeSent
 *  - detectActiveCycle
 *  - buildTrendRows
 *  - renderAbcSection / renderTrendSection (smoke de HTML)
 *
 * Todos os helpers são funções puras exportadas de workers/brevo-dashboard/src/index.ts.
 * Não requerem mock de rede — usam fixtures locais do shape real da Brevo API.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractClariceCell,
  parseClariceCampaignKey,
  aggregateAbcSummary,
  calcCumulativeSent,
  detectActiveCycle,
  buildTrendRows,
  renderAbcSection,
  renderTrendSection,
  renderDashboardHtml,
  CLARICE_PLAN_TOTAL,
  CLARICE_PLAN_S1,
} from "../workers/brevo-dashboard/src/index.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeGlobalStats(overrides: Partial<{
  sent: number; delivered: number; hardBounces: number; softBounces: number;
  uniqueViews: number; viewed: number; trackableViews: number;
  uniqueClicks: number; clickers: number; unsubscriptions: number;
  complaints: number; appleMppOpens: number;
}> = {}) {
  return {
    sent: 100, delivered: 98, hardBounces: 1, softBounces: 1,
    uniqueViews: 25, viewed: 30, trackableViews: 18,
    uniqueClicks: 3, clickers: 3, unsubscriptions: 0, complaints: 0,
    appleMppOpens: 5,
    ...overrides,
  };
}

function makeCampaign(id: number, name: string, sentDate: string, gsOverrides: Parameters<typeof makeGlobalStats>[0] = {}) {
  return {
    id,
    name,
    subject: "Test",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    listName: `List ${id}`,
    listSize: 100,
    statistics: {
      globalStats: makeGlobalStats(gsOverrides),
    },
  };
}

/** Campanhas representativas do ciclo 2605 (Clarice News) */
const cycle2605Campaigns = [
  makeCampaign(38, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:05:00Z", { sent: 117, delivered: 115, uniqueViews: 20, trackableViews: 11, appleMppOpens: 8 }),
  makeCampaign(39, "Clarice News 2605 d01-B (qua)", "2026-06-10T09:06:00Z", { sent: 117, delivered: 117, uniqueViews: 32, trackableViews: 21, appleMppOpens: 11 }),
  makeCampaign(40, "Clarice News 2605 d01-C (qua)", "2026-06-10T09:03:00Z", { sent: 116, delivered: 115, uniqueViews: 30, trackableViews: 21, appleMppOpens: 10 }),
  makeCampaign(41, "Clarice News 2605 d02-A (qui)", "2026-06-11T09:35:00Z", { sent: 184, delivered: 182, uniqueViews: 35, trackableViews: 26, appleMppOpens: 7 }),
  makeCampaign(42, "Clarice News 2605 d02-B (qui)", "2026-06-11T09:14:00Z", { sent: 183, delivered: 182, uniqueViews: 39, trackableViews: 30, appleMppOpens: 6 }),
  makeCampaign(43, "Clarice News 2605 d02-C (qui)", "2026-06-11T09:14:00Z", { sent: 183, delivered: 183, uniqueViews: 30, trackableViews: 19, appleMppOpens: 7 }),
];

/** Campanhas T1 (digest mensal) — não são Clarice News */
const t1Campaigns = [
  makeCampaign(29, "Diar.ia Mensal 2604 [list 9 W1] — 2026-05-08 19:24", "2026-05-08T22:24:00Z", { sent: 50, delivered: 48, uniqueViews: 26, trackableViews: 14, appleMppOpens: 7 }),
  makeCampaign(34, "Diar.ia Mensal 2604 — 2026-05-14 19:26", "2026-05-15T09:48:00Z", { sent: 300, delivered: 297, uniqueViews: 138, trackableViews: 93, appleMppOpens: 44 }),
];

const allCampaigns = [...cycle2605Campaigns, ...t1Campaigns];

// ─── extractClariceCell ───────────────────────────────────────────────────────

describe("extractClariceCell", () => {
  test("extrai A de nome d01-A", () => {
    assert.equal(extractClariceCell("Clarice News 2605 d01-A (qua)"), "A");
  });

  test("extrai B de nome d02-B", () => {
    assert.equal(extractClariceCell("Clarice News 2605 d02-B (qui)"), "B");
  });

  test("extrai C de nome d07-C", () => {
    assert.equal(extractClariceCell("Clarice News 2605 d07-C (ter)"), "C");
  });

  test("retorna null para campanha T1", () => {
    assert.equal(extractClariceCell("Diar.ia Mensal 2604 — 2026-05-14 19:26"), null);
  });

  test("retorna null para string vazia", () => {
    assert.equal(extractClariceCell(""), null);
  });
});

// ─── parseClariceCampaignKey ──────────────────────────────────────────────────

describe("parseClariceCampaignKey", () => {
  test("parseia d01-A corretamente", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d01-A (qua)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 1, cell: "A" });
  });

  test("parseia d02-C corretamente", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d02-C (qui)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 2, cell: "C" });
  });

  test("parseia d07-B — último dia S1", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d07-B (ter)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 7, cell: "B" });
  });

  test("parseia d08-A — dia S2 (dayNum > 7, fora do S1)", () => {
    const r = parseClariceCampaignKey("Clarice News 2605 d08-A (qua)");
    assert.deepEqual(r, { cycle: "2605", dayNum: 8, cell: "A" });
  });

  test("retorna null para campanha T1", () => {
    assert.equal(parseClariceCampaignKey("Diar.ia Mensal 2604 [list 9 W1] — 2026-05-08"), null);
  });
});

// ─── aggregateAbcSummary ──────────────────────────────────────────────────────

describe("aggregateAbcSummary", () => {
  test("agrega open rate por célula corretamente (fixtures reais d01+d02)", () => {
    const result = aggregateAbcSummary(allCampaigns, "2605");
    const a = result.find((r) => r.cell === "A")!;
    const b = result.find((r) => r.cell === "B")!;
    const c = result.find((r) => r.cell === "C")!;

    // A: d01-A (20 views / 115 del) + d02-A (35 views / 182 del) = 55/297
    assert.equal(a.totalViews, 20 + 35);
    assert.equal(a.totalDelivered, 115 + 182);
    assert.ok(Math.abs(a.openRate - (55 / 297) * 100) < 0.01, `A openRate deve ser ~18.5% mas foi ${a.openRate}`);
    assert.equal(a.campaignCount, 2);

    // B: d01-B (32 views / 117 del) + d02-B (39 views / 182 del) = 71/299
    assert.equal(b.totalViews, 32 + 39);
    assert.equal(b.totalDelivered, 117 + 182);
    assert.ok(Math.abs(b.openRate - (71 / 299) * 100) < 0.01);
    assert.equal(b.campaignCount, 2);

    // C: d01-C (30 views / 115 del) + d02-C (30 views / 183 del) = 60/298
    assert.equal(c.totalViews, 30 + 30);
    assert.equal(c.totalDelivered, 115 + 183);
    assert.equal(c.campaignCount, 2);
  });

  test("retorna sempre as 3 células mesmo com ciclo sem dados", () => {
    const result = aggregateAbcSummary(allCampaigns, "9999");
    assert.equal(result.length, 3);
    for (const r of result) {
      assert.equal(r.totalViews, 0);
      assert.equal(r.totalDelivered, 0);
      assert.equal(r.openRate, 0);
      assert.equal(r.campaignCount, 0);
    }
  });

  test("exclui dias S2 (dayNum > 7) da agregação S1", () => {
    const s2Campaign = makeCampaign(50, "Clarice News 2605 d08-A (qui)", "2026-06-12T09:00:00Z",
      { sent: 200, delivered: 198, uniqueViews: 50 });
    const result = aggregateAbcSummary([...cycle2605Campaigns, s2Campaign], "2605");
    const a = result.find((r) => r.cell === "A")!;
    // d08-A NÃO deve entrar: só d01-A e d02-A (count=2, não 3)
    assert.equal(a.campaignCount, 2);
    assert.equal(a.totalViews, 20 + 35); // apenas d01-A + d02-A
  });

  test("exclui campanhas T1 (não Clarice News) da agregação", () => {
    const result = aggregateAbcSummary(t1Campaigns, "2604");
    // T1 campaigns não casam com parseClariceCampaignKey → count 0
    assert.ok(result.every((r) => r.campaignCount === 0));
  });

  test("exclui stats zeradas (gs.sent = 0)", () => {
    const zeroStatsCampaign = {
      ...makeCampaign(99, "Clarice News 2605 d03-A (sex)", "2026-06-13T09:00:00Z"),
      statistics: {
        globalStats: makeGlobalStats({ sent: 0, delivered: 0, uniqueViews: 0 }),
      },
    };
    const result = aggregateAbcSummary([...cycle2605Campaigns, zeroStatsCampaign], "2605");
    const a = result.find((r) => r.cell === "A")!;
    // d03-A com sent=0 não deve entrar
    assert.equal(a.campaignCount, 2); // só d01-A e d02-A
  });
});

// ─── calcCumulativeSent ───────────────────────────────────────────────────────

describe("calcCumulativeSent", () => {
  test("soma sent de todas as campanhas Clarice News do ciclo", () => {
    const total = calcCumulativeSent(cycle2605Campaigns, "2605");
    // sent: 117 + 117 + 116 + 184 + 183 + 183 = 900
    assert.equal(total, 117 + 117 + 116 + 184 + 183 + 183);
  });

  test("ignora campanhas T1 (não são Clarice News do ciclo)", () => {
    const total = calcCumulativeSent(allCampaigns, "2605");
    assert.equal(total, 117 + 117 + 116 + 184 + 183 + 183);
  });

  test("retorna 0 para ciclo sem campanhas", () => {
    assert.equal(calcCumulativeSent(allCampaigns, "9999"), 0);
  });

  test("CLARICE_PLAN_TOTAL é 40000", () => {
    assert.equal(CLARICE_PLAN_TOTAL, 40_000);
  });

  test("CLARICE_PLAN_S1 é 5600", () => {
    assert.equal(CLARICE_PLAN_S1, 5_600);
  });
});

// ─── detectActiveCycle ────────────────────────────────────────────────────────

describe("detectActiveCycle", () => {
  test("detecta 2605 como ciclo ativo (mais recente)", () => {
    assert.equal(detectActiveCycle(allCampaigns), "2605");
  });

  test("retorna null quando lista vazia", () => {
    assert.equal(detectActiveCycle([]), null);
  });

  test("retorna null quando só há campanhas T1", () => {
    assert.equal(detectActiveCycle(t1Campaigns), null);
  });

  test("prefere o ciclo lexicograficamente maior", () => {
    const mixed = [
      makeCampaign(1, "Clarice News 2604 d01-A (seg)", "2026-05-01T09:00:00Z"),
      makeCampaign(2, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z"),
    ];
    assert.equal(detectActiveCycle(mixed), "2605");
  });
});

// ─── buildTrendRows ───────────────────────────────────────────────────────────

describe("buildTrendRows", () => {
  test("ordena por sentDate ASC (mais antigas primeiro)", () => {
    const rows = buildTrendRows(allCampaigns);
    // Primeiro deve ser T1-W1 (2026-05-08), último deve ser uma campanha 2605 d02
    assert.ok(rows.length >= 2);
    const first = rows[0];
    const last = rows[rows.length - 1];
    const firstDate = first.sentDate ? Date.parse(first.sentDate) : 0;
    const lastDate = last.sentDate ? Date.parse(last.sentDate) : 0;
    assert.ok(firstDate <= lastDate, "primeira linha deve ser anterior à última");
  });

  test("label de Clarice News é compacto (ex: '2605 d01-A')", () => {
    const rows = buildTrendRows(cycle2605Campaigns);
    const clariceRows = rows.filter((r) => r.label.startsWith("2605"));
    assert.ok(clariceRows.length > 0, "deve ter rows com label 2605 dXX-Y");
    for (const r of clariceRows) {
      assert.match(r.label, /2605 d\d{2}-[ABC]/, `label '${r.label}' deve ter formato '2605 dNN-Y'`);
    }
  });

  test("label de Mensal inclui 'Mensal' e o ciclo", () => {
    const rows = buildTrendRows(t1Campaigns);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.match(r.label, /Mensal 2604/, `label '${r.label}' deve conter 'Mensal 2604'`);
    }
  });

  test("calcula openRate e bounceRate corretamente", () => {
    const campaign = makeCampaign(1, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:00:00Z",
      { sent: 100, delivered: 98, uniqueViews: 30, hardBounces: 2, softBounces: 1 });
    const rows = buildTrendRows([campaign]);
    assert.equal(rows.length, 1);
    // openRate = 30/98 * 100 ≈ 30.61%
    assert.ok(Math.abs(rows[0].openRate - (30 / 98) * 100) < 0.01);
    // bounceRate = 3/100 * 100 = 3%
    assert.ok(Math.abs(rows[0].bounceRate - 3.0) < 0.01);
  });

  test("exclui campanhas sem sentDate", () => {
    const noDate = { ...makeCampaign(99, "Clarice News 2605 d05-A (seg)", ""), sentDate: null };
    const rows = buildTrendRows([...cycle2605Campaigns, noDate]);
    const noDateRow = rows.find((r) => r.label === "2605 d05-A");
    assert.equal(noDateRow, undefined, "campanha sem sentDate não deve aparecer na trend");
  });

  test("exclui campanhas sem stats reais (sent=0)", () => {
    const zeroStats = {
      ...makeCampaign(99, "Clarice News 2605 d05-A (seg)", "2026-06-15T09:00:00Z"),
      statistics: { globalStats: makeGlobalStats({ sent: 0, delivered: 0, uniqueViews: 0 }) },
    };
    const rows = buildTrendRows([...cycle2605Campaigns, zeroStats]);
    const zeroRow = rows.find((r) => r.label === "2605 d05-A");
    assert.equal(zeroRow, undefined, "campanha com sent=0 não deve aparecer na trend");
  });
});

// ─── renderAbcSection ─────────────────────────────────────────────────────────

describe("renderAbcSection", () => {
  test("retorna string vazia quando todos os campaignCounts são 0", () => {
    const emptyRows = [
      { cell: "A" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0 },
      { cell: "B" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0 },
      { cell: "C" as const, totalViews: 0, totalDelivered: 0, openRate: 0, campaignCount: 0 },
    ];
    assert.equal(renderAbcSection(emptyRows, 0), "");
  });

  test("contém as 3 células no HTML", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows, 900);
    assert.match(html, /Célula A/);
    assert.match(html, /Célula B/);
    assert.match(html, /Célula C/);
  });

  test("exibe volume cumulativo vs plano", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows, 900);
    // Deve mostrar o volume e o total 40.000
    assert.match(html, /900/, "deve mostrar 900 enviados");
    assert.match(html, /40\.000/, "deve mostrar meta 40.000");
  });

  test("marca vencedor provisório quando ≥2 células têm dados", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows, 900);
    assert.match(html, /LÍDER/, "deve mostrar tag LÍDER no vencedor provisório");
  });

  test("contém id='abc-summary' para âncora", () => {
    const rows = aggregateAbcSummary(cycle2605Campaigns, "2605");
    const html = renderAbcSection(rows, 900);
    assert.match(html, /id="abc-summary"/);
  });
});

// ─── renderTrendSection ───────────────────────────────────────────────────────

describe("renderTrendSection", () => {
  test("retorna string vazia quando rows está vazio", () => {
    assert.equal(renderTrendSection([]), "");
  });

  test("contém id='wave-trend' para âncora", () => {
    const rows = buildTrendRows(allCampaigns);
    const html = renderTrendSection(rows);
    assert.match(html, /id="wave-trend"/);
  });

  test("usa class 'alert' para open rate < 15%", () => {
    const rows: Parameters<typeof renderTrendSection>[0] = [
      { label: "Test", sentDate: "2026-06-10T09:00:00Z", openRate: 8, bounceRate: 1, sent: 100, delivered: 98 },
    ];
    const html = renderTrendSection(rows);
    assert.match(html, /class="alert"/, "open 8% deve gerar class alert");
  });

  test("usa class 'alert' para bounce rate ≥ 3%", () => {
    const rows: Parameters<typeof renderTrendSection>[0] = [
      { label: "Test", sentDate: "2026-06-10T09:00:00Z", openRate: 25, bounceRate: 3.5, sent: 100, delivered: 96 },
    ];
    const html = renderTrendSection(rows);
    assert.match(html, /class="alert"/, "bounce 3.5% deve gerar class alert");
  });

  test("NÃO usa class alert quando métricas saudáveis", () => {
    const rows: Parameters<typeof renderTrendSection>[0] = [
      { label: "Test", sentDate: "2026-06-10T09:00:00Z", openRate: 25, bounceRate: 1, sent: 100, delivered: 99 },
    ];
    const html = renderTrendSection(rows);
    assert.doesNotMatch(html, /class="alert"/, "métricas saudáveis não devem gerar alerta");
  });
});

// ─── renderDashboardHtml: integração das novas seções ────────────────────────

describe("renderDashboardHtml: integração fase 2 (#2086)", () => {
  const baseCampaign = {
    id: 1,
    name: "Test",
    subject: "Subj",
    status: "sent",
    sentDate: "2026-06-11T09:00:00Z",
    scheduledAt: null,
    createdAt: "2026-06-11T09:00:00Z",
    recipients: { lists: [1] },
    listName: "T1-W1",
    listSize: 50,
    statistics: {
      globalStats: makeGlobalStats({ sent: 50, delivered: 48, uniqueViews: 20, trackableViews: 15 }),
    },
  };

  test("coluna Trackable aparece no header da tabela principal", () => {
    const html = renderDashboardHtml([baseCampaign]);
    assert.match(html, /Trackable/, "deve ter coluna Trackable no header");
  });

  test("coluna Trackable exibe taxa e count na linha de dados", () => {
    const html = renderDashboardHtml([baseCampaign]);
    // trackableRate = 15/48 = 31.25%
    assert.match(html, /31\.3%/, "deve exibir taxa trackable correta (15/48 ≈ 31.3%)");
    // count trackable como <small>
    assert.match(html, /<small>15<\/small>/, "deve exibir count trackableViews=15");
  });

  test("seção abc-summary aparece quando há campanhas Clarice News", () => {
    const html = renderDashboardHtml(cycle2605Campaigns);
    assert.match(html, /abc-summary/, "deve conter a seção abc-summary");
    assert.match(html, /Resumo A\/B\/C/, "deve ter título 'Resumo A/B/C'");
  });

  test("seção wave-trend aparece com campanhas", () => {
    const html = renderDashboardHtml(allCampaigns);
    assert.match(html, /wave-trend/, "deve conter a seção wave-trend");
    assert.match(html, /Tend.ncia entre waves/, "deve ter título da seção");
  });

  test("sem campanhas Clarice News: seção abc-summary ausente", () => {
    const html = renderDashboardHtml(t1Campaigns);
    assert.doesNotMatch(html, /abc-summary/, "seção abc deve estar ausente sem Clarice News");
  });

  test("colspan da linha 'sem stats' atualizado para 7 (10 colunas - 3 fixas)", () => {
    // Após adicionar coluna Trackable, colspan deve ser 7 (era 6)
    const noStatsCampaign = {
      id: 99,
      name: "No stats",
      subject: "Subj",
      status: "sent",
      sentDate: "2026-06-11T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-06-11T09:00:00Z",
      recipients: { lists: [1] },
      listName: "T1-W2",
      listSize: 30,
    };
    const html = renderDashboardHtml([noStatsCampaign]);
    assert.match(html, /colspan="7"/, "linha 'sem stats' deve ter colspan=7 (tabela tem 11 colunas, 4 fixas + 7 de métricas)");
  });

  test("existentes: tabela de campanhas tem 11 colunas no header", () => {
    const html = renderDashboardHtml([baseCampaign]);
    // Extrair só a seção de campanhas (entre id="campaigns-table" e o próximo <section)
    const tableSection = html.match(/id="campaigns-table"[\s\S]*?<\/section>/)?.[0] ?? "";
    const thCount = (tableSection.match(/<th /g) || []).length;
    // 11 colunas: ID, Lista, Enviado, Sent, Delivered, Opens, Clicks, Trackable, Bounces, Unsub, Spam
    assert.equal(thCount, 11, `tabela de campanhas deve ter 11 <th> mas encontrou ${thCount}`);
  });
});
