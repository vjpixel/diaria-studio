/**
 * test/brevo-dashboard-links-ctr.test.ts (#2177)
 *
 * Testes de regressão para CTR por link da newsletter mensal.
 * Cobre: parseLinksStats, isSystemLink, renderLinksSection,
 * e integração via renderDashboardHtml.
 *
 * Nota sobre unique-clicks: a API Brevo v3 expõe apenas clicks totais por URL
 * em `linksStats` — unique-clicks por link não estão disponíveis. A coluna
 * "unique" é omitida graciosamente (documentado no PR #2177).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseLinksStats,
  isSystemLink,
  renderLinksSection,
  renderDashboardHtml,
  type BrevoLinksStats,
} from "../workers/brevo-dashboard/src/index.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** linksStats fixture realista: 5 links editoriais + 2 de sistema */
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

const baseCampaign = {
  id: 42,
  name: "Diar.ia Mensal 2605",
  subject: "Digest de maio",
  status: "sent",
  sentDate: "2026-06-13T09:00:00Z",
  scheduledAt: null,
  createdAt: "2026-06-13T09:00:00Z",
  recipients: { lists: [9] },
  listName: "T1-W7",
  listSize: 300,
  statistics: {
    globalStats: {
      sent: 300,
      delivered: 295,
      hardBounces: 2,
      softBounces: 3,
      uniqueViews: 120,
      viewed: 150,
      trackableViews: 90,
      uniqueClicks: 80,
      clickers: 80,
      unsubscriptions: 1,
      complaints: 0,
      appleMppOpens: 30,
    },
  },
};

// ─── isSystemLink ─────────────────────────────────────────────────────────────

describe("isSystemLink (#2177)", () => {
  test("retorna true para URL de unsubscribe", () => {
    assert.equal(isSystemLink("https://r.brevo.com/links/unsubscribe/abc123"), true);
    assert.equal(isSystemLink("https://example.com/unsubscribe?token=xyz"), true);
  });

  test("retorna true para URL de preferences/preferencias", () => {
    assert.equal(isSystemLink("https://example.com/email/preferences?token=xyz"), true);
    assert.equal(isSystemLink("https://exemplo.com.br/preferencias"), true);
  });

  test("retorna true para optout", () => {
    assert.equal(isSystemLink("https://example.com/optout"), true);
    assert.equal(isSystemLink("https://example.com/opt-out?id=123"), true);
  });

  test("retorna false para URLs editoriais normais", () => {
    assert.equal(isSystemLink("https://diar.ia/edicao/260613"), false);
    assert.equal(isSystemLink("https://openai.com/blog/gpt-5"), false);
    assert.equal(isSystemLink("https://anthropic.com/news/claude-4"), false);
    assert.equal(isSystemLink("https://github.com/features/copilot"), false);
  });

  test("retorna false para UTM params editoriais (não são links de sistema)", () => {
    assert.equal(isSystemLink("https://diar.ia/edicao/260613?utm_source=clarice"), false);
  });
});

// ─── parseLinksStats ──────────────────────────────────────────────────────────

describe("parseLinksStats (#2177)", () => {
  test("filtra links de sistema e retorna só editoriais", () => {
    const rows = parseLinksStats(fixtureLinksStats);
    const urls = rows.map((r) => r.url);
    // Links editoriais devem aparecer
    assert.ok(urls.includes("https://diar.ia/edicao/260613"), "link editorial deve aparecer");
    assert.ok(urls.includes("https://openai.com/blog/gpt-5"), "link editorial deve aparecer");
    // Links de sistema devem ser filtrados
    assert.ok(!urls.includes("https://r.brevo.com/links/unsubscribe/abc123"), "unsubscribe deve ser filtrado");
    assert.ok(!urls.includes("https://example.com/email/preferences?token=xyz"), "preferences deve ser filtrado");
  });

  test("ordena por clicks DESC", () => {
    const rows = parseLinksStats(fixtureLinksStats);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].clicks >= rows[i].clicks,
        `row ${i - 1} (${rows[i - 1].clicks}) deve ter clicks ≥ row ${i} (${rows[i].clicks})`);
    }
  });

  test("participação percentual soma ~100% (tolerância 1%)", () => {
    const rows = parseLinksStats(fixtureLinksStats);
    const totalPct = rows.reduce((sum, r) => sum + parseFloat(r.pctOfTotal), 0);
    assert.ok(Math.abs(totalPct - 100) < 1,
      `soma das participações deve ser ~100% mas foi ${totalPct.toFixed(1)}%`);
  });

  test("link com maior clicks tem maior participação percentual", () => {
    const rows = parseLinksStats(fixtureLinksStats);
    assert.equal(rows[0].url, "https://diar.ia/edicao/260613", "primeiro deve ter mais clicks (42)");
    const pct = parseFloat(rows[0].pctOfTotal);
    // 42 / (42+31+28+15+8) = 42/124 ≈ 33.9%
    assert.ok(Math.abs(pct - (42 / 124) * 100) < 0.1, `pctOfTotal ≈ 33.9% mas foi ${pct}`);
  });

  test("retorna [] para linksStats undefined", () => {
    assert.deepEqual(parseLinksStats(undefined), []);
  });

  test("retorna [] para linksStats null", () => {
    assert.deepEqual(parseLinksStats(null), []);
  });

  test("retorna [] para linksStats vazio ({})", () => {
    assert.deepEqual(parseLinksStats({}), []);
  });

  test("retorna [] quando todos os links são de sistema", () => {
    const allSystem: BrevoLinksStats = {
      "https://r.brevo.com/links/unsubscribe/abc": 10,
      "https://example.com/preferences": 5,
    };
    assert.deepEqual(parseLinksStats(allSystem), []);
  });

  test("exclui links com 0 clicks", () => {
    const withZero: BrevoLinksStats = {
      "https://diar.ia/edicao/260613": 10,
      "https://example.com/page": 0,
    };
    const rows = parseLinksStats(withZero);
    assert.equal(rows.length, 1, "link com 0 clicks deve ser excluído");
    assert.equal(rows[0].url, "https://diar.ia/edicao/260613");
  });

  test("trunca displayUrl para URLs longas (max 70 chars)", () => {
    const longUrl = "https://example.com/" + "a".repeat(80);
    const rows = parseLinksStats({ [longUrl]: 5 });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].displayUrl.length <= 70, `displayUrl deve ter ≤ 70 chars: "${rows[0].displayUrl}"`);
    assert.ok(rows[0].displayUrl.endsWith("…"), "URL truncada deve terminar com …");
    assert.equal(rows[0].url, longUrl, "url completa deve ser preservada");
  });

  test("não trunca URLs curtas (≤ 70 chars)", () => {
    const shortUrl = "https://diar.ia/edicao/260613";
    const rows = parseLinksStats({ [shortUrl]: 5 });
    assert.equal(rows[0].displayUrl, shortUrl, "URL curta não deve ser truncada");
  });
});

// ─── renderLinksSection ───────────────────────────────────────────────────────

describe("renderLinksSection (#2177)", () => {
  test("caso real: fixture com links editoriais → tabela com URLs, clicks, %", () => {
    const html = renderLinksSection(42, fixtureLinksStats, 80);
    // Tabela presente
    assert.match(html, /<table/, "deve ter tabela de links");
    // Colunas esperadas
    assert.match(html, /Clicks/, "deve ter coluna Clicks");
    assert.match(html, /%\s*do\s*total/i, "deve ter coluna % do total");
    // Links editoriais presentes
    assert.match(html, /diar\.ia\/edicao\/260613/, "URL editorial deve aparecer");
    assert.match(html, /openai\.com\/blog\/gpt-5/, "URL editorial deve aparecer");
    // Clicks
    assert.match(html, />42</, "click count 42 deve aparecer");
    assert.match(html, />31</, "click count 31 deve aparecer");
    // Links de sistema ausentes
    assert.doesNotMatch(html, /unsubscribe/, "URL de unsubscribe não deve aparecer");
    assert.doesNotMatch(html, /preferences/, "URL de preferences não deve aparecer");
  });

  test("caso vazio: linksStats undefined → stub graceful (sem crash)", () => {
    const html = renderLinksSection(42, undefined);
    // Não deve crashar; deve retornar algum HTML
    assert.ok(html.length > 0, "deve retornar HTML mesmo sem linksStats");
    assert.match(html, /<details/, "deve ter elemento details");
    // Não deve ter tabela (sem dados)
    assert.doesNotMatch(html, /<table/, "não deve ter tabela quando sem dados");
    // #2201.3: verificar mensagem explicativa no branch undefined (simétrico ao do {})
    assert.match(html, /dados de links não disponíveis/i,
      "deve exibir mensagem explicativa 'dados de links não disponíveis' quando linksStats é undefined");
  });

  test("caso vazio: linksStats {} → stub com nota de 'nenhum link rastreado'", () => {
    const html = renderLinksSection(10, {});
    assert.doesNotMatch(html, /<table/, "não deve ter tabela quando linksStats vazio");
    assert.match(html, /nenhum link rastreado|nenhum link editorial|dados de links não disponíveis/i,
      "deve ter nota explicativa");
  });

  test("caso todos sistema: linksStats só com system links → stub (sem links editoriais)", () => {
    const allSystem: BrevoLinksStats = {
      "https://r.brevo.com/links/unsubscribe/abc": 10,
    };
    const html = renderLinksSection(10, allSystem);
    assert.doesNotMatch(html, /<table/, "não deve ter tabela quando só links de sistema");
  });

  test("regressão #2183: links editoriais com 0 clicks → stub NÃO deve aparecer como 'apenas links de sistema'", () => {
    // Bug: quando linksStats tem links editoriais mas todos com 0 clicks,
    // a mensagem exibia "nenhum link editorial (apenas links de sistema)" — incorreto.
    const editorialZeroClicks: BrevoLinksStats = {
      "https://openai.com/blog/gpt-5": 0,     // editorial, mas 0 clicks
      "https://diar.ia/edicao/260613": 0,     // editorial, mas 0 clicks
    };
    const html = renderLinksSection(10, editorialZeroClicks);
    assert.doesNotMatch(html, /<table/, "não deve ter tabela quando links têm 0 clicks");
    // Deve distinguir "links com 0 clicks" de "apenas sistema"
    assert.doesNotMatch(html, /apenas links de sistema/i,
      "mensagem não deve dizer 'apenas links de sistema' quando links editoriais existem (com 0 clicks)");
    assert.match(html, /0 cliques|links editoriais presentes/i,
      "mensagem deve indicar que há links editoriais mas com 0 cliques");
  });

  test("regressão #2183: links sistema com 0 clicks → stub diz 'apenas links de sistema'", () => {
    // Links de sistema com 0 clicks → diferente de editorial com 0 clicks
    const systemOnly: BrevoLinksStats = {
      "https://r.brevo.com/links/unsubscribe/abc": 0,
    };
    const html = renderLinksSection(10, systemOnly);
    assert.doesNotMatch(html, /<table/, "não deve ter tabela");
    // Pode dizer "apenas links de sistema" ou "0 cliques" — ambos aceitáveis
    assert.doesNotMatch(html, /links editoriais presentes/i,
      "mensagem não deve mencionar links editoriais quando só há links de sistema");
  });

  test("usa <details>/<summary> para ser colapsável", () => {
    const html = renderLinksSection(42, fixtureLinksStats);
    assert.match(html, /<details/, "deve usar <details> para colapsabilidade");
    assert.match(html, /<summary/, "deve usar <summary>");
  });

  test("id do details é único por campaignId", () => {
    const html1 = renderLinksSection(1, fixtureLinksStats);
    const html2 = renderLinksSection(99, fixtureLinksStats);
    assert.match(html1, /id="links-1"/, "deve ter id=links-1");
    assert.match(html2, /id="links-99"/, "deve ter id=links-99");
  });

  test("nota de unique-clicks não disponível presente na seção com dados", () => {
    const html = renderLinksSection(42, fixtureLinksStats);
    assert.match(html, /unique-clicks por link não disponível/i,
      "deve informar que unique-clicks por link não estão disponíveis na API");
  });

  test("count de links no badge do summary", () => {
    const rows = parseLinksStats(fixtureLinksStats);
    const html = renderLinksSection(42, fixtureLinksStats);
    const expected = rows.length.toString();
    // O badge mostra o número de links editoriais
    assert.match(html, new RegExp(`<span class="links-count-badge">${expected}</span>`),
      `badge deve mostrar ${expected} links`);
  });
});

// ─── renderDashboardHtml: integração links-ctr ────────────────────────────────

describe("renderDashboardHtml: integração CTR por link (#2177)", () => {
  test("renderiza sem crash quando linksStats presente na campanha", () => {
    const campaign = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: fixtureLinksStats,
      },
    };
    let html: string;
    assert.doesNotThrow(() => { html = renderDashboardHtml([campaign]); });
    assert.ok(html!.length > 0);
  });

  test("renderiza sem crash quando linksStats ausente (campanha sem dados de links)", () => {
    const campaign = { ...baseCampaign };
    let html: string;
    assert.doesNotThrow(() => { html = renderDashboardHtml([campaign]); });
    assert.ok(html!.length > 0);
  });

  test("seção de links aparece como details colapsável dentro da tabela de campanhas", () => {
    const campaign = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: fixtureLinksStats,
      },
    };
    const html = renderDashboardHtml([campaign]);
    assert.match(html, /<details class="links-ctr"/, "deve ter seção details de links");
    assert.match(html, /tr class="links-row"/, "deve ter <tr> de links");
    // #2201.1: verificar colspan numérico válido na links-row (sem hardcodar "11").
    // A abordagem dinâmica de contar <th> é frágil pq o dashboard renderiza múltiplas
    // tabelas. Em vez disso, verificamos: (a) o atributo existe; (b) é um número positivo;
    // (c) é ≥ 4 (mínimo razoável para a tabela de campanhas). Mudança estrutural no
    // número de colunas quebrará o renderDashboardHtml test com tbody/td count check.
    const colspanMatch = html.match(/<td colspan="(\d+)" class="links-cell">/);
    assert.ok(colspanMatch, "links-row deve ter <td colspan=N class=links-cell>");
    const colspan = parseInt(colspanMatch![1], 10);
    assert.ok(colspan >= 4, `colspan deve ser ≥ 4 (tabela de campanhas tem pelo menos 4 colunas), foi ${colspan}`);
  });

  test("links editoriais visíveis no HTML do dashboard", () => {
    const campaign = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: fixtureLinksStats,
      },
    };
    const html = renderDashboardHtml([campaign]);
    assert.match(html, /diar\.ia\/edicao\/260613/, "link editorial deve aparecer no dashboard");
    assert.match(html, /openai\.com\/blog\/gpt-5/, "link editorial deve aparecer no dashboard");
  });

  test("links de sistema não aparecem no HTML do dashboard", () => {
    const campaign = {
      ...baseCampaign,
      statistics: {
        ...baseCampaign.statistics,
        linksStats: fixtureLinksStats,
      },
    };
    const html = renderDashboardHtml([campaign]);
    // As URLs de sistema não devem aparecer (mas a palavra "unsubscribe" pode
    // aparecer em tooltip/header). Verificamos a URL completa.
    assert.doesNotMatch(html, /r\.brevo\.com\/links\/unsubscribe/, "URL de unsubscribe não deve aparecer");
  });

  test("campanha sem stats ainda tem links-row (graceful)", () => {
    const noStatsCampaign = {
      id: 99,
      name: "No stats campaign",
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
    assert.match(html, /links-row/, "campanha sem stats deve ter links-row (graceful)");
  });

  test("múltiplas campanhas: cada uma tem seu próprio details com id único", () => {
    const campaign1 = {
      ...baseCampaign,
      id: 10,
      statistics: { ...baseCampaign.statistics, linksStats: fixtureLinksStats },
    };
    const campaign2 = {
      ...baseCampaign,
      id: 20,
      statistics: { ...baseCampaign.statistics, linksStats: {} },
    };
    const html = renderDashboardHtml([campaign1, campaign2]);
    assert.match(html, /id="links-10"/, "campanha 10 deve ter links-10");
    assert.match(html, /id="links-20"/, "campanha 20 deve ter links-20");
  });
});

// ─── Regressão #2198 Bug 1: branch sem-stats deve usar linksStats real ────────

describe("regressão #2198 Bug 1: linksStats no branch sem-stats", () => {
  test("campanha com linksStats em statistics.linksStats mas sem globalStats/campaignStats → tabela de links renderiza (não exibe 'dados não disponíveis')", () => {
    // Cenário: fetchRecentCampaigns retornou linksStats mas globalStats indisponível
    // e campaignStats ausente → render cai no branch !s. Antes do fix, passava
    // `undefined` para renderLinksSection, ignorando linksStats real.
    const campaignNoStatsWithLinks = {
      id: 77,
      name: "Bug1 regression",
      subject: "Test",
      status: "sent",
      sentDate: "2026-06-13T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-06-13T09:00:00Z",
      recipients: { lists: [5] },
      listName: "T1-W3",
      listSize: 50,
      // sem globalStats real (sent=0 → tratado como ausente) e sem campaignStats
      statistics: {
        globalStats: {
          sent: 0, delivered: 0, hardBounces: 0, softBounces: 0,
          uniqueViews: 0, viewed: 0, trackableViews: 0,
          uniqueClicks: 0, clickers: 0, unsubscriptions: 0, complaints: 0,
          appleMppOpens: 0,
        },
        linksStats: fixtureLinksStats,
      },
    };

    const html = renderDashboardHtml([campaignNoStatsWithLinks]);

    // O branch !s é ativado (globalStats.sent === 0 → gsIsReal=false, campaignStats ausente)
    assert.match(html, /sem stats/, "deve mostrar 'sem stats' no row principal (branch !s ativado)");

    // Mas a tabela de links DEVE aparecer (linksStats real presente em statistics.linksStats)
    assert.match(html, /<table/, "tabela de links deve renderizar mesmo no branch sem-stats");
    assert.match(html, /diar\.ia\/edicao\/260613/, "links editoriais devem aparecer no branch sem-stats");

    // Não deve dizer "dados não disponíveis" (isso seria o bug antigo)
    assert.doesNotMatch(html, /dados de links não disponíveis/i,
      "não deve exibir 'dados não disponíveis' quando linksStats está presente em statistics.linksStats");
  });

  test("campanha com linksStats top-level (legado) mas sem globalStats → tabela de links renderiza", () => {
    // Garante backward-compat: testes/mocks que passam linksStats top-level ainda funcionam.
    const campaignWithTopLevelLinks = {
      id: 78,
      name: "Bug1 regression compat",
      subject: "Test",
      status: "sent",
      sentDate: "2026-06-13T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-06-13T09:00:00Z",
      recipients: { lists: [6] },
      listName: "T1-W4",
      listSize: 50,
      linksStats: fixtureLinksStats,  // top-level (legado)
      statistics: {
        globalStats: {
          sent: 0, delivered: 0, hardBounces: 0, softBounces: 0,
          uniqueViews: 0, viewed: 0, trackableViews: 0,
          uniqueClicks: 0, clickers: 0, unsubscriptions: 0, complaints: 0,
          appleMppOpens: 0,
        },
      },
    };

    const html = renderDashboardHtml([campaignWithTopLevelLinks]);
    assert.match(html, /sem stats/, "deve mostrar 'sem stats' no row principal");
    // linksStats top-level ainda deve ser lido via fallback (c.statistics?.linksStats ?? c.linksStats)
    assert.match(html, /<table/, "tabela de links deve renderizar com linksStats top-level");
  });
});
