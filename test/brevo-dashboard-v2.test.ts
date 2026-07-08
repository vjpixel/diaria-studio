/**
 * test/brevo-dashboard-v2.test.ts (#2207, #2211, #2212)
 *
 * Regressões e features do lote dashboard-v2:
 *  - #2207: NaN em aggregateAbcSummary com uniqueViews/delivered undefined;
 *           colspan no-stats testado só no <thead> (não na tabela interna de links);
 *           dead fallback linksStats top-level documentado.
 *  - #2211: Opens antes de Open rate no header E nas linhas de renderWeekdaySection.
 *  - #2212: aggregateLinksAcrossCampaigns + renderAggregatedLinksSection.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateAbcSummary,
  aggregateByWeekday,
  renderWeekdaySection,
  renderDashboardHtml,
  aggregateLinksAcrossCampaigns,
  renderAggregatedLinksSection,
  isSystemLink,
  type BrevoLinksStats,
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

function makeCampaign(
  id: number,
  name: string,
  sentDate: string,
  gsOverrides: Parameters<typeof makeGlobalStats>[0] = {},
) {
  return {
    id,
    name,
    subject: "Test",
    status: "sent",
    sentDate,
    scheduledAt: null as null,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    listName: `List ${id}`,
    listSize: 100,
    statistics: {
      globalStats: makeGlobalStats(gsOverrides),
    },
  };
}

const cycle2605Campaigns = [
  makeCampaign(38, "Clarice News 2605 d01-A (qua)", "2026-06-10T09:05:00Z", { sent: 117, delivered: 115, uniqueViews: 20, trackableViews: 11, appleMppOpens: 8 }),
  makeCampaign(39, "Clarice News 2605 d01-B (qua)", "2026-06-10T09:06:00Z", { sent: 117, delivered: 117, uniqueViews: 32, trackableViews: 21, appleMppOpens: 11 }),
  makeCampaign(40, "Clarice News 2605 d01-C (qua)", "2026-06-10T09:03:00Z", { sent: 116, delivered: 115, uniqueViews: 30, trackableViews: 21, appleMppOpens: 10 }),
  makeCampaign(41, "Clarice News 2605 d02-A (qui)", "2026-06-11T09:35:00Z", { sent: 184, delivered: 182, uniqueViews: 35, trackableViews: 26, appleMppOpens: 7 }),
  makeCampaign(42, "Clarice News 2605 d02-B (qui)", "2026-06-11T09:14:00Z", { sent: 183, delivered: 182, uniqueViews: 39, trackableViews: 30, appleMppOpens: 6 }),
  makeCampaign(43, "Clarice News 2605 d02-C (qui)", "2026-06-11T09:14:00Z", { sent: 183, delivered: 183, uniqueViews: 30, trackableViews: 19, appleMppOpens: 7 }),
];

const baseCampaign = {
  id: 1,
  name: "Test campaign",
  subject: "Test subject",
  status: "sent",
  sentDate: "2026-06-11T09:00:00Z",
  scheduledAt: null as null,
  createdAt: "2026-06-11T09:00:00Z",
  recipients: { lists: [1] },
  listName: "T1-W1",
  listSize: 50,
  statistics: {
    globalStats: makeGlobalStats({ sent: 50, delivered: 48, uniqueViews: 20, trackableViews: 15 }),
  },
};

const fixtureLinksStats: BrevoLinksStats = {
  "https://diar.ia/edicao/260613": 42,
  "https://openai.com/blog/gpt-5": 31,
  "https://anthropic.com/news/claude-4": 28,
  "https://github.com/features/copilot": 15,
  "https://techcrunch.com/2026/06/12/ai-funding": 8,
  // sistema — devem ser filtrados
  "https://r.brevo.com/links/unsubscribe/abc123": 5,
  "https://example.com/email/preferences?token=xyz": 3,
};

// ─── #2207-1: NaN em aggregateAbcSummary ──────────────────────────────────────

describe("#2207-1: aggregateAbcSummary NaN guard com ?? 0", () => {
  test("gs.uniqueViews=undefined com gs.sent>0 → não produz NaN (usa ?? 0)", () => {
    // Cenário: objeto Brevo parcial — sent preenchido mas uniqueViews ausente.
    // Antes do fix: `cells[cell].views += undefined` → NaN.
    // Após fix: `cells[cell].views += undefined ?? 0` → 0.
    const partialGsCampaign = {
      id: 96,
      name: "Clarice News 2605 d03-A (sex)",
      subject: "Test",
      status: "sent",
      sentDate: "2026-06-13T09:00:00Z",
      scheduledAt: null as null,
      createdAt: "2026-06-13T09:00:00Z",
      recipients: { lists: [196] },
      listName: "List 96",
      listSize: 100,
      statistics: {
        globalStats: {
          sent: 120,                                   // > 0 → não filtrado pelo guard
          delivered: 118,
          hardBounces: 1,
          softBounces: 1,
          uniqueViews: undefined as unknown as number, // parcial — campo ausente
          viewed: 30,
          trackableViews: 20,
          uniqueClicks: 5,
          clickers: 5,
          unsubscriptions: 0,
          complaints: 0,
          appleMppOpens: 5,
        },
      },
    };
    const campaigns = [partialGsCampaign, ...cycle2605Campaigns];
    const result = aggregateAbcSummary(campaigns, "2605");

    // Nenhuma célula deve ter openRate NaN
    for (const row of result) {
      assert.ok(!isNaN(row.openRate),
        `openRate da célula ${row.cell} não deve ser NaN (foi ${row.openRate})`);
      assert.ok(isFinite(row.openRate),
        `openRate da célula ${row.cell} deve ser finito`);
      assert.ok(!isNaN(row.totalViews),
        `totalViews da célula ${row.cell} não deve ser NaN`);
    }
    // Célula A: d03-A com uniqueViews=undefined contribui com 0 views (não NaN)
    const cellA = result.find((r) => r.cell === "A")!;
    assert.equal(cellA.campaignCount, 3, "d03-A deve ser contabilizada (sent>0)");
    assert.ok(!isNaN(cellA.totalViews), "totalViews de A não deve ser NaN");
    // MPP-incl (#2258): d01-A (20) + d02-A (35) + d03-A (0 por uniqueViews undefined→0) = 55
    assert.equal(cellA.totalViews, 20 + 35, "totalViews = 55 (d03-A contribui 0, não NaN)");
  });

  test("gs.delivered=undefined com gs.sent>0 → não produz NaN em openRate", () => {
    // Cenário: delivered ausente → openRate = opens/0 → mas com ?? 0, delivered=0 e openRate=0.
    const partialDelivered = {
      id: 97,
      name: "Clarice News 2605 d03-B (sex)",
      subject: "Test",
      status: "sent",
      sentDate: "2026-06-13T09:05:00Z",
      scheduledAt: null as null,
      createdAt: "2026-06-13T09:05:00Z",
      recipients: { lists: [197] },
      listName: "List 97",
      listSize: 100,
      statistics: {
        globalStats: {
          sent: 100,
          delivered: undefined as unknown as number, // parcial — campo ausente
          hardBounces: 1,
          softBounces: 1,
          uniqueViews: 30,
          viewed: 35,
          trackableViews: 20,
          uniqueClicks: 3,
          clickers: 3,
          unsubscriptions: 0,
          complaints: 0,
          appleMppOpens: 5,
        },
      },
    };
    const result = aggregateAbcSummary([partialDelivered, ...cycle2605Campaigns], "2605");
    for (const row of result) {
      assert.ok(!isNaN(row.openRate),
        `openRate da célula ${row.cell} não deve ser NaN (foi ${row.openRate})`);
    }
  });
});

// ─── #2207-2: colspan no-stats testado escopo <thead> ─────────────────────────

describe("#2207-2: colspan no-stats — contagem de <th> só no <thead> da tabela de campanhas", () => {
  const noStatsCampaign = {
    id: 99,
    name: "No stats campaign",
    subject: "Subj",
    status: "sent",
    sentDate: "2026-06-11T09:00:00Z",
    scheduledAt: null as null,
    createdAt: "2026-06-11T09:00:00Z",
    recipients: { lists: [1] },
    listName: "T1-W2",
    listSize: 30,
  };

  test("colspan na linha 'sem stats' igual ao número de <th> no <thead> da tabela de campanhas (não conta links-table)", () => {
    const html = renderDashboardHtml([noStatsCampaign]);

    // Extrair APENAS o <thead>...</thead> da tabela de campanhas (dentro de id="campaigns-table").
    // Isso evita contar os <th> da links-table interna (que fica dentro de <td class="links-cell">).
    const campaignsSection = html.match(/id="campaigns-table"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.ok(campaignsSection.length > 0, "deve encontrar a seção campaigns-table no HTML");

    const thead = campaignsSection.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    assert.ok(thead.length > 0, "deve encontrar o <thead> dentro de campaigns-table");

    // Contar <th (com espaço) dentro do thead — exclui qualquer <th> de tabelas aninhadas
    const thCount = (thead.match(/<th /g) ?? []).length;
    assert.ok(thCount > 0, `deve encontrar <th> no <thead>, encontrou ${thCount}`);

    // O colspan na linha sem-stats deve igualar (total_colunas - colunas_fixas).
    // Colunas fixas: ID(1) + Lista(2) + Enviado(3) + "—"(4) = 4. Total = thCount.
    const expectedColspan = thCount - 4;
    const colspanMatch = html.match(/colspan="(\d+)" style="color:[^"]+;opacity:0.6;font-style:italic;">/);
    assert.ok(colspanMatch, "deve ter colspan na linha 'sem stats'");
    const actualColspan = parseInt(colspanMatch![1], 10);
    assert.equal(
      actualColspan,
      expectedColspan,
      `colspan (${actualColspan}) deve ser ${expectedColspan} (${thCount} colunas − 4 fixas) — ` +
      "IMPORTANTE: contagem restrita ao <thead> da tabela de campanhas, sem links-table interna",
    );
  });

  test("<thead> da tabela de campanhas NÃO inclui <th> da tabela interna de links (#2207-2 anti-regressão)", () => {
    // Anti-regressão: garante que o escopo de contagem é o <thead> canônico,
    // não a seção inteira (que contém a links-table com seus próprios <th>).
    const campaignWithLinks = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: fixtureLinksStats,
      },
    };
    const html = renderDashboardHtml([campaignWithLinks]);

    const campaignsSection = html.match(/id="campaigns-table"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.ok(campaignsSection.length > 0, "deve encontrar a seção campaigns-table no HTML");

    const thead = campaignsSection.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    assert.ok(thead.length > 0, "deve encontrar o <thead> dentro de campaigns-table");

    // O <thead> da tabela principal não deve conter class="link-url-th" (header da links-table)
    assert.doesNotMatch(thead, /link-url-th/,
      "<thead> da tabela de campanhas não deve conter <th> da links-table interna");

    // Contar <th> SOMENTE no <thead> escopado a campaigns-table — exclui links-tables aninhadas.
    // Usar count exato (não `< totalThInHtml`) para pegar adição/remoção de coluna nesta tabela.
    // Colunas actuais (10): ID | Lista | Enviado | Sent | Delivered | Opens | Clicks | Bounces | Unsub | Spam
    // #3040: coluna Trackable standalone foi removida (dado incorporado ao parêntese de Opens).
    // Se uma coluna for adicionada ou removida, este teste QUEBRA — atualizar o número e esta lista.
    const EXPECTED_CAMPAIGNS_TABLE_TH = 10;
    const thCount = (thead.match(/<th /g) ?? []).length;
    assert.equal(
      thCount,
      EXPECTED_CAMPAIGNS_TABLE_TH,
      `<thead> da tabela de campanhas deve ter exatamente ${EXPECTED_CAMPAIGNS_TABLE_TH} <th> ` +
      `(ID | Lista | Enviado | Sent | Delivered | Opens | Clicks | Bounces | Unsub | Spam). ` +
      `Encontrou ${thCount} — se adicionou/removeu coluna, atualizar EXPECTED_CAMPAIGNS_TABLE_TH e esta lista`,
    );
  });
});

// ─── #2211: Opens ANTES de Open rate ──────────────────────────────────────────

describe("#2211: renderWeekdaySection — Opens antes de Open rate no header e nas linhas", () => {
  function makeWeekdayRows() {
    return aggregateByWeekday(cycle2605Campaigns, "2605").rows;
  }

  test("header: Opens aparece ANTES de Open rate no <thead>", () => {
    const rows = makeWeekdayRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");

    // Extrair só o <thead> para posicionar com precisão
    const thead = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    assert.ok(thead.length > 0, "deve ter <thead>");

    const posOpens = thead.indexOf(">Opens<");
    const posOpenRate = thead.indexOf(">Open rate agr.<");
    assert.ok(posOpens > -1, "header deve conter 'Opens'");
    assert.ok(posOpenRate > -1, "header deve conter 'Open rate agr.'");
    assert.ok(posOpens < posOpenRate,
      `"Opens" deve aparecer ANTES de "Open rate agr." no header (Opens em pos ${posOpens}, Open rate em ${posOpenRate})`);
  });

  test("linhas de dados: coluna Opens aparece ANTES de Open rate (posição DOM)", () => {
    const rows = makeWeekdayRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");

    // Buscar na primeira <tr> do <tbody>
    const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[0] ?? "";
    assert.ok(tbody.length > 0, "deve ter <tbody>");

    const firstRow = tbody.match(/<tr>([\s\S]*?)<\/tr>/)?.[0] ?? "";
    assert.ok(firstRow.length > 0, "deve ter pelo menos 1 linha no tbody");

    // A coluna Opens é <td>NNN</td> (número de opens)
    // A coluna Open rate tem class="metric" (e o valor com %)
    // Na nova ordem: Dia | Campanhas | Delivered | Opens | Open rate
    // Vamos verificar posição relativa no firstRow
    const posMetric = firstRow.indexOf('class="metric"');  // Open rate tem class metric
    // Na nova ordem, o <td> de Opens deve aparecer ANTES do <td class="metric">
    // O <td> de Opens contém um número (toLocaleString)
    // Como a linha tem format `<td>NNN</td>` antes de `<td class="metric">...`, verificamos índices.
    assert.ok(posMetric > -1, "linha deve ter <td class=\"metric\"> para o Open rate");

    // Localizar a posição do número de opens (ex: 82 para Qui ou 104 para Qua)
    // Sabemos que opens é o count de uniqueViews. Vamos buscar uma <td> simples antes de metric.
    // Estratégia: extrair o texto antes do <td class="metric"> e verificar que há um <td> numérico
    const beforeMetric = firstRow.slice(0, posMetric);
    // Deve ter pelo menos 3 <td> antes do metric: Dia, Campanhas, Delivered
    // E o Opens deve ser o 4º <td> (index 3 from start)
    const tds = beforeMetric.match(/<td[^>]*>/g) ?? [];
    assert.ok(tds.length >= 4,
      `antes de <td class="metric"> deve haver pelo menos 4 <td>s (Dia, Campanhas, Delivered, Opens), encontrou ${tds.length}`);
  });

  test("header: Delivered aparece ANTES de Opens que aparece ANTES de Open rate agr.", () => {
    // Verifica a ordem completa: Dia → Campanhas → Delivered → Opens → Open rate agr.
    const rows = makeWeekdayRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");
    const thead = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";

    const posDelivered = thead.indexOf(">Delivered<");
    const posOpens = thead.indexOf(">Opens<");
    const posOpenRate = thead.indexOf(">Open rate agr.<");

    assert.ok(posDelivered > -1, "header deve ter 'Delivered'");
    assert.ok(posOpens > -1, "header deve ter 'Opens'");
    assert.ok(posOpenRate > -1, "header deve ter 'Open rate agr.'");
    assert.ok(posDelivered < posOpens,
      `"Delivered" (${posDelivered}) deve vir ANTES de "Opens" (${posOpens})`);
    assert.ok(posOpens < posOpenRate,
      `"Opens" (${posOpens}) deve vir ANTES de "Open rate agr." (${posOpenRate})`);
  });

  test("valores corretos são mantidos após reordenação (open rate ainda usa delivered como denominador)", () => {
    // Regressão: reordenar colunas não deve alterar valores calculados
    // Qua: 82 opens / 347 delivered ≈ 23.6%
    const rows = makeWeekdayRows();
    const qua = rows.find((r) => r.weekday === 2)!;
    const expectedRate = (82 / 347) * 100;
    assert.ok(Math.abs(qua.openRate - expectedRate) < 0.01,
      `open rate de Qua deve ser ${expectedRate.toFixed(2)}%, foi ${qua.openRate.toFixed(2)}%`);
    const html = renderWeekdaySection(rows, "ciclo 2605");
    assert.match(html, /23\.[0-9]%/, "taxa open rate correta deve aparecer no HTML");
    // Opens de Qua = 82
    assert.match(html, /<td[^>]*>82<\/td>/, "opens de Qua deve aparecer em célula <td>");
  });

  test("MELHOR DIA ainda na coluna Open rate (class metric) após reordenação — não na coluna Opens", () => {
    // MELHOR DIA deve estar na <td class="metric"> (Open rate), não na <td> de Opens.
    // Após reordenação: Dia | Campanhas | Delivered | Opens | Open rate (metric).
    // O <td> de Opens é <td>NNN</td> — sem class, sem MELHOR DIA.
    // O <td class="metric"> vem depois e contém a tag MELHOR DIA.
    const rows = makeWeekdayRows();
    const html = renderWeekdaySection(rows, "ciclo 2605");

    // MELHOR DIA deve existir
    const tagIdx = html.indexOf("▲ MELHOR DIA");
    assert.ok(tagIdx > -1, "deve ter tag MELHOR DIA");

    // Encontrar o <td> mais próximo que precede a tag
    const htmlBefore = html.slice(0, tagIdx);
    const lastTdOpenIdx = htmlBefore.lastIndexOf("<td");
    const lastTdSnippet = html.slice(lastTdOpenIdx, lastTdOpenIdx + 30);
    // O <td> imediatamente antes da tag deve ter class="metric" (coluna Open rate)
    assert.match(lastTdSnippet, /class="metric"/,
      `MELHOR DIA deve estar dentro de <td class="metric"> (coluna Open rate), mas o <td> anterior foi: "${lastTdSnippet}"`);
  });
});

// ─── #2212: aggregateLinksAcrossCampaigns ─────────────────────────────────────

describe("#2212: aggregateLinksAcrossCampaigns", () => {
  // #2216 finding #5: variável morta removida do describe-scope.
  // Os testes que precisam de campaign com linksStats constroem inline.

  test("agrega clicks de mesmo URL entre campanhas", () => {
    // Duas campanhas com o mesmo link — deve somar clicks
    const campaign1 = {
      ...baseCampaign,
      id: 10,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: { "https://diar.ia/edicao/260613": 20, "https://openai.com/gpt": 5 } as BrevoLinksStats,
      },
    };
    const campaign2 = {
      ...baseCampaign,
      id: 11,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: { "https://diar.ia/edicao/260613": 15, "https://anthropic.com/news": 8 } as BrevoLinksStats,
      },
    };
    const rows = aggregateLinksAcrossCampaigns([campaign1, campaign2]);

    // #2263: agrupado por origin — diar.ia/edicao/260613 → https://diar.ia
    const diaria = rows.find((r) => r.url === "https://diar.ia");
    assert.ok(diaria, "origin diar.ia deve aparecer no resultado");
    assert.equal(diaria!.totalClicks, 35, "deve somar 20+15=35 clicks do mesmo origin");
    assert.equal(diaria!.campaignCount, 2, "deve contar 2 campanhas para o mesmo origin");
  });

  test("filtra links de sistema reutilizando isSystemLink (sem duplicar lógica)", () => {
    // Verifica que isSystemLink é de fato reusado (confirma que URLs de sistema saem)
    const campaign = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: fixtureLinksStats,
      },
    };
    const rows = aggregateLinksAcrossCampaigns([campaign]);
    const urls = rows.map((r) => r.url);
    // Links de sistema NÃO devem aparecer
    assert.ok(!urls.includes("https://r.brevo.com/links/unsubscribe/abc123"),
      "unsubscribe deve ser filtrado por isSystemLink");
    assert.ok(!urls.includes("https://example.com/email/preferences?token=xyz"),
      "preferences deve ser filtrado por isSystemLink");
    // Links editoriais SIM (por origin — #2263)
    assert.ok(urls.includes("https://diar.ia"), "origin editorial deve aparecer");
    assert.ok(urls.includes("https://openai.com"), "origin editorial deve aparecer");
  });

  test("ordena por totalClicks DESC", () => {
    const campaign = { ...baseCampaign, statistics: { ...baseCampaign.statistics, linksStats: fixtureLinksStats } };
    const rows = aggregateLinksAcrossCampaigns([campaign]);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].totalClicks >= rows[i].totalClicks,
        `row ${i - 1} (${rows[i - 1].totalClicks}) deve ter totalClicks ≥ row ${i} (${rows[i].totalClicks})`);
    }
    // O origin com mais clicks (42) deve ser primeiro (#2263)
    assert.equal(rows[0].url, "https://diar.ia",
      "origin com mais clicks (42) deve ser primeiro");
  });

  test("graceful: sem dados → retorna []", () => {
    const campaignNoLinks = { ...baseCampaign };
    const rows = aggregateLinksAcrossCampaigns([campaignNoLinks]);
    assert.deepEqual(rows, []);
  });

  test("graceful: lista vazia → retorna []", () => {
    assert.deepEqual(aggregateLinksAcrossCampaigns([]), []);
  });

  test("exclui links com 0 clicks", () => {
    const campaign = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: { "https://diar.ia/ok": 5, "https://diar.ia/zero": 0 } as BrevoLinksStats,
      },
    };
    const rows = aggregateLinksAcrossCampaigns([campaign]);
    // #2263: /ok e /zero colapsam em https://diar.ia; /zero (0 clicks) é excluído
    assert.equal(rows.length, 1, "link com 0 clicks deve ser excluído");
    assert.equal(rows[0].url, "https://diar.ia");
    assert.equal(rows[0].totalClicks, 5, "só o /ok (5) conta");
  });

  test("displayUrl é o origin (sem path/query, sem truncamento) (#2263)", () => {
    const longUrl = "https://example.com/" + "a".repeat(80) + "?utm_source=x";
    const campaign = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: { [longUrl]: 5 } as BrevoLinksStats,
      },
    };
    const rows = aggregateLinksAcrossCampaigns([campaign]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "https://example.com", "url reduzida ao origin");
    assert.equal(rows[0].displayUrl, "https://example.com", "displayUrl = origin (sem path/truncamento)");
  });

  test("campaignCount correto: link em 1 campanha vs 2 campanhas", () => {
    const campaign1 = {
      ...baseCampaign, id: 20,
      statistics: { ...baseCampaign.statistics, linksStats: { "https://only-one.com": 10 } as BrevoLinksStats },
    };
    const campaign2 = {
      ...baseCampaign, id: 21,
      statistics: { ...baseCampaign.statistics, linksStats: {
        "https://only-one.com": 5,
        "https://two-campaigns.com": 8,
      } as BrevoLinksStats },
    };
    const campaign3 = {
      ...baseCampaign, id: 22,
      statistics: { ...baseCampaign.statistics, linksStats: { "https://two-campaigns.com": 3 } as BrevoLinksStats },
    };
    const rows = aggregateLinksAcrossCampaigns([campaign1, campaign2, campaign3]);
    const onlyOne = rows.find((r) => r.url === "https://only-one.com");
    const twoCamp = rows.find((r) => r.url === "https://two-campaigns.com");
    assert.ok(onlyOne, "only-one.com deve aparecer");
    assert.equal(onlyOne!.campaignCount, 2, "only-one.com está em 2 campanhas");
    assert.equal(onlyOne!.totalClicks, 15, "only-one.com tem 10+5=15 clicks");
    assert.ok(twoCamp, "two-campaigns.com deve aparecer");
    assert.equal(twoCamp!.campaignCount, 2, "two-campaigns.com está em 2 campanhas");
    assert.equal(twoCamp!.totalClicks, 11, "two-campaigns.com tem 8+3=11 clicks");
  });

  test("lê linksStats de statistics.linksStats (canônico)", () => {
    const campaign = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: { "https://via-statistics.com": 7 } as BrevoLinksStats,
      },
    };
    const rows = aggregateLinksAcrossCampaigns([campaign]);
    assert.ok(rows.some((r) => r.url === "https://via-statistics.com"),
      "deve ler linksStats de statistics.linksStats");
  });

  test("fallback: lê linksStats top-level quando statistics.linksStats ausente", () => {
    // Backward compat: `getCampaignLinksStats` em index.ts faz
    //   c.statistics?.linksStats ?? c.linksStats
    // O fallback pra top-level é intencional — guard contra dados de fixture/cache legado
    // ou campanhas antigas onde o worker gravou linksStats no top-level (pré-#2199.3).
    // Se o fallback for removido da produção, remover este teste junto.
    const campaign = {
      ...baseCampaign,
      linksStats: { "https://via-toplevel.com": 9 } as BrevoLinksStats,
    };
    const rows = aggregateLinksAcrossCampaigns([campaign]);
    assert.ok(rows.some((r) => r.url === "https://via-toplevel.com"),
      "deve ler linksStats top-level via fallback");
  });
});

// ─── #2212: renderAggregatedLinksSection ──────────────────────────────────────

describe("#2212: renderAggregatedLinksSection", () => {
  function makeRows() {
    const campaign = {
      ...baseCampaign,
      statistics: { ...baseCampaign.statistics, linksStats: fixtureLinksStats },
    };
    return aggregateLinksAcrossCampaigns([campaign]);
  }

  test("renderiza seção com id='links-agregados'", () => {
    const rows = makeRows();
    const html = renderAggregatedLinksSection(rows);
    assert.match(html, /id="links-agregados"/, "deve ter id links-agregados para âncora");
  });

  test("tabela contém colunas Link, Clicks, %, Envios", () => {
    const rows = makeRows();
    const html = renderAggregatedLinksSection(rows);
    assert.match(html, /<table/, "deve ter tabela");
    assert.match(html, /Clicks/, "deve ter coluna Clicks");
    assert.match(html, /Envios/, "deve ter coluna Envios (#2422)");
  });

  test("links editoriais aparecem na tabela", () => {
    const rows = makeRows();
    const html = renderAggregatedLinksSection(rows);
    assert.match(html, /https:\/\/diar\.ia\b/, "origin editorial deve aparecer");
    assert.match(html, /https:\/\/openai\.com\b/, "origin editorial deve aparecer");
    assert.doesNotMatch(html, /edicao\/260613/, "path NÃO deve aparecer (só origin)");
  });

  test("links de sistema NÃO aparecem na tabela", () => {
    const rows = makeRows();
    const html = renderAggregatedLinksSection(rows);
    assert.doesNotMatch(html, /r\.brevo\.com\/links\/unsubscribe/,
      "URL de unsubscribe não deve aparecer");
    assert.doesNotMatch(html, /email\/preferences/,
      "URL de preferences não deve aparecer");
  });

  test("links ordenados por clicks DESC (maior primeiro)", () => {
    const rows = makeRows();
    const html = renderAggregatedLinksSection(rows);
    const pos42 = html.indexOf("https://diar.ia"); // 42 clicks (origin #2263)
    const pos8 = html.indexOf("techcrunch.com");          // 8 clicks
    assert.ok(pos42 > -1, "diar.ia (42 clicks) deve aparecer");
    assert.ok(pos8 > -1, "techcrunch (8 clicks) deve aparecer");
    assert.ok(pos42 < pos8, "link com mais clicks (42) deve aparecer antes do link com menos (8)");
  });

  test("graceful: sem dados → stub sem crash (never empty section)", () => {
    const html = renderAggregatedLinksSection([]);
    assert.ok(html.length > 0, "deve retornar HTML mesmo sem links");
    assert.match(html, /id="links-agregados"/, "deve ter âncora mesmo sem dados");
    assert.match(html, /Sem dados|sem dados/i, "deve indicar ausência de dados");
    assert.doesNotMatch(html, /<table/, "não deve ter tabela quando sem dados");
  });

  test("exibe título 'Links mais clicados do período'", () => {
    const html = renderAggregatedLinksSection(makeRows());
    assert.match(html, /Links mais clicados do período/, "deve ter título correto");
  });

  test("click count e número de campanhas aparecem nas células", () => {
    const row1 = { url: "https://test.com", displayUrl: "https://test.com", totalClicks: 42, campaignCount: 3 };
    const row2 = { url: "https://other.com", displayUrl: "https://other.com", totalClicks: 10, campaignCount: 1 };
    const html = renderAggregatedLinksSection([row1, row2]);
    assert.match(html, /<td[^>]*>42<\/td>/, "deve mostrar 42 clicks");
    assert.match(html, /<td>3<\/td>/, "deve mostrar 3 campanhas");
  });

  test("% do total correto (participação relativa)", () => {
    // 42 de (42+10) = 42/52 ≈ 80.8%
    const row1 = { url: "https://test.com", displayUrl: "https://test.com", totalClicks: 42, campaignCount: 1 };
    const row2 = { url: "https://other.com", displayUrl: "https://other.com", totalClicks: 10, campaignCount: 1 };
    const html = renderAggregatedLinksSection([row1, row2]);
    assert.match(html, /80\.[0-9]%/, "deve mostrar ~80.8% de participação para o link com 42 clicks");
  });
});

// ─── #2212: integração com renderDashboardHtml ───────────────────────────────

describe("#2212: renderDashboardHtml — integração seção links-agregados", () => {
  test("seção links-agregados aparece sempre (mesmo sem dados de links)", () => {
    // Seção deve ser SEMPRE visível (graceful stub quando sem dados)
    const html = renderDashboardHtml([baseCampaign]);
    assert.match(html, /id="links-agregados"/, "seção links-agregados deve aparecer mesmo sem linksStats");
  });

  test("seção links-agregados aparece com dados quando campanhas têm linksStats", () => {
    const campaignWithLinks = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: fixtureLinksStats,
      },
    };
    const html = renderDashboardHtml([campaignWithLinks]);
    assert.match(html, /id="links-agregados"/, "seção deve aparecer");
    // #3081: renderDashboardHtml agora passa campaignCount (campaigns.length) —
    // título reflete a janela agregada, não mais "do período" (que exigia
    // edicaoLabel null E campaignCount omitido; aqui campaignCount=1 sempre).
    assert.match(html, /Links mais clicados \(janela de 1 campanhas\)/, "título deve refletir a janela agregada");
    assert.match(html, /diar\.ia\/edicao\/260613/, "link editorial deve aparecer na seção agregada");
  });

  test("múltiplas campanhas com mesmo link: clicks somados corretamente", () => {
    const campaign1 = {
      ...baseCampaign, id: 30,
      statistics: { ...baseCampaign.statistics, linksStats: { "https://shared-link.com": 20 } as BrevoLinksStats },
    };
    const campaign2 = {
      ...baseCampaign, id: 31,
      statistics: { ...baseCampaign.statistics, linksStats: { "https://shared-link.com": 15 } as BrevoLinksStats },
    };
    const html = renderDashboardHtml([campaign1, campaign2]);
    // Total = 35 clicks
    assert.match(html, /35/, "soma de 20+15=35 clicks deve aparecer na seção agregada");
  });
});
