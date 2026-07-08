/**
 * Regression tests for a batch of 4 mobile/CSS fixes on clarice-dashboard
 * (workers/brevo-dashboard), all landed together (same worker, no line
 * conflicts between them):
 *
 *  - #3083: `.tab-bar` wrapped labels in 2 lines on mobile (~400-560px),
 *    "Cupons" got cut off, and the overflow stretched the whole body
 *    horizontally. Fix: `.tab-bar` becomes its own horizontal-scroll area
 *    (overflow-x auto + flex-wrap nowrap); `.tab-label` never wraps/shrinks.
 *  - #3084: the Opens cell ("27.4% (20.6% sem MPP · 17.1% trackable)") wrapped
 *    into up to 4 lines on mobile, stretching the Envios table rows. Fix:
 *    `.rate-inline` gets `white-space: nowrap`, and the "· Z% trackable" member
 *    is wrapped in a `.trackable-clause` span hidden under the existing
 *    `@media (max-width: 700px)` block.
 *  - #3085: the first column (row label) of wide scrollable tables (Envios,
 *    Totais por mês, Cohorts) wasn't sticky, so it scrolled away horizontally.
 *    Fix: `.table-wrap td:first-child`/`th:first-child` get `position: sticky;
 *    left: 0`, layered with z-index so the top-left corner cell (sticky on
 *    BOTH axes at once) renders above everything else.
 *  - #3086: the "Rampa" (Agendamento) tab had 2 tables without the
 *    `.table-wrap` card wrapper used everywhere else (#3026), and its 2
 *    `<details>` summaries were missing the `.links-summary` class already
 *    used by other collapsibles. Mechanical fix: wrap + add the class.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderDashboardHtml,
  renderWeeklyPlanTabPanel,
  type BrevoCampaign,
} from "../workers/brevo-dashboard/src/index.ts";

test("#3083: .tab-bar vira scroll horizontal próprio e .tab-label nunca quebra/encolhe em mobile", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";

  const tabBarRule = styleBlock.match(/\.tab-bar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(tabBarRule, /overflow-x:\s*auto/, ".tab-bar deve ter overflow-x: auto (#3083)");
  assert.match(tabBarRule, /flex-wrap:\s*nowrap/, ".tab-bar deve ter flex-wrap: nowrap (#3083)");
  assert.match(tabBarRule, /scrollbar-width:\s*none/, ".tab-bar deve esconder a scrollbar (#3083)");

  const tabLabelRule = styleBlock.match(/\.tab-label\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(tabLabelRule, /white-space:\s*nowrap/, ".tab-label nunca deve quebrar em 2 linhas (#3083)");
  assert.match(tabLabelRule, /flex-shrink:\s*0/, ".tab-label nunca deve encolher a ponto de cortar texto (#3083)");
});

test("#3084: .rate-inline tem white-space:nowrap e .trackable-clause é escondido em mobile", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";

  const rateInlineRule = styleBlock.match(/td \.rate-inline\s*\{[^}]*white-space[^}]*\}/)?.[0] ?? "";
  assert.match(rateInlineRule, /white-space:\s*nowrap/, "td .rate-inline deve ter white-space: nowrap (#3084)");

  // .trackable-clause só deve ser escondido DENTRO do media query mobile
  // existente — não escondido globalmente (isso apagaria o dado em desktop).
  const mediaBlock = styleBlock.match(/@media \(max-width: 700px\)\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? "";
  assert.match(mediaBlock, /\.trackable-clause\s*\{\s*display:\s*none;?\s*\}/, ".trackable-clause deve ser escondido no media query mobile (#3084)");
  assert.doesNotMatch(
    styleBlock.replace(mediaBlock, ""),
    /\.trackable-clause\s*\{\s*display:\s*none/,
    ".trackable-clause não deve ser escondido fora do media query (#3084)",
  );
});

test("#3084: célula Opens com sem-MPP+trackable envolve o membro trackable num span.trackable-clause", () => {
  const baseCampaign = {
    id: 1,
    name: "Test campaign",
    subject: "subject",
    status: "sent",
    sentDate: "2026-07-08T09:00:00Z",
    scheduledAt: null,
    createdAt: "2026-07-08T09:00:00Z",
    recipients: { lists: [9] },
    listName: "Engajados",
    listSize: 500,
    statistics: {
      globalStats: {
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 0,
        uniqueViews: 26,
        viewed: 26,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
        appleMppOpens: 6,
      },
    },
  };

  const html = renderDashboardHtml([baseCampaign as any]);

  // O membro "· Z% trackable" precisa estar dentro de um span.trackable-clause
  // ANINHADO dentro do span.rate-inline (não substituindo-o) — o "X% sem MPP"
  // sozinho continua fora do span escondível, pra sempre sobrar algo legível
  // em mobile.
  assert.match(
    html,
    /<span class="rate-inline">\([\d.]+% sem MPP<span class="trackable-clause"> · [\d.]+% trackable<\/span>\)<\/span>/,
    "o membro trackable deve estar num span.trackable-clause aninhado dentro de .rate-inline (#3084)",
  );
});

test("#3085: primeira coluna de .table-wrap é sticky, canto superior-esquerdo por cima de tudo", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";

  const tdFirstChild = styleBlock.match(/\.table-wrap td:first-child\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(tdFirstChild, /position:\s*sticky/, "1ª coluna do corpo deve ser sticky (#3085)");
  assert.match(tdFirstChild, /left:\s*0/, "1ª coluna do corpo deve fixar left:0 (#3085)");

  const thFirstChild = styleBlock.match(/\.table-wrap th:first-child\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(thFirstChild, /position:\s*sticky/, "canto superior-esquerdo (th:first-child) deve ser sticky (#3085)");
  assert.match(thFirstChild, /left:\s*0/, "canto superior-esquerdo deve fixar left:0 (#3085)");

  // z-index em camadas: corner (th:first-child) > header genérico (th) >
  // 1ª coluna do corpo (td:first-child) > células normais (z-index: auto) —
  // sem isso o corner cell (sticky NOS DOIS eixos ao mesmo tempo) pode ficar
  // atrás do resto do header ou da 1ª coluna ao rolar nas duas direções.
  const genericTh = styleBlock.match(/\n\s*th \{[^}]*\}/)?.[0] ?? "";
  const zGeneric = Number(genericTh.match(/z-index:\s*(\d+)/)?.[1] ?? "-1");
  const zTdFirst = Number(tdFirstChild.match(/z-index:\s*(\d+)/)?.[1] ?? "-1");
  const zThFirst = Number(thFirstChild.match(/z-index:\s*(\d+)/)?.[1] ?? "-1");
  assert.ok(zGeneric >= 0 && zTdFirst >= 0 && zThFirst >= 0, "todas as 3 regras precisam de z-index explícito (#3085)");
  assert.ok(zThFirst > zGeneric, "corner cell deve ficar acima do header genérico (#3085)");
  assert.ok(zGeneric > zTdFirst, "header genérico deve ficar acima da 1ª coluna do corpo (#3085)");
});

function campaignSentAt(iso: string, overrides: Partial<BrevoCampaign> = {}): BrevoCampaign {
  return {
    id: overrides.id ?? Math.round(Math.random() * 1e6),
    name: overrides.name ?? "Clarice News 2607 d05",
    subject: "subject",
    status: "sent",
    sentDate: iso,
    scheduledAt: null,
    createdAt: iso,
    recipients: { lists: [1] },
    statistics: {
      globalStats: {
        sent: 1000,
        delivered: 980,
        hardBounces: 5,
        softBounces: 5,
        uniqueViews: 200,
        viewed: 200,
        trackableViews: 200,
        uniqueClicks: 10,
        clickers: 10,
        unsubscriptions: 2,
        complaints: 0,
        appleMppOpens: 0,
      },
    },
    ...overrides,
  } as BrevoCampaign;
}

test("#3086: tabela 'aguardando maturar' (sem envio maduro ainda) fica dentro de .table-wrap", () => {
  // Envio recentíssimo (<48h) → cai no branch `mature.length === 0` (linha
  // "Nenhum envio maduro ainda" / tabela de espera).
  const now = new Date("2026-07-10T12:00:00.000Z");
  const recent = campaignSentAt(new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString());

  const html = renderWeeklyPlanTabPanel([recent], now);

  assert.match(html, /aguardando maturar/, "sanity check — deve cair no branch de espera de maturação");
  assert.match(
    html,
    /<div class="table-wrap">\s*<table><thead><tr><th>Campanha<\/th><th>Enviado<\/th><\/tr><\/thead><tbody>/,
    "tabela de campanhas aguardando maturar deve estar dentro de .table-wrap (#3086)",
  );
});

test("#3086: tabela 'Recomendação — próximos 3 envios' fica dentro de .table-wrap", () => {
  // 11 dias de envio maduro (>48h cada) — suficiente pra `mature.length > 0` e
  // `baseVolume > 0`, entrando no branch que renderiza a recomendação.
  const now = new Date("2026-07-20T12:00:00.000Z");
  const campaigns: BrevoCampaign[] = [];
  for (let i = 0; i < 11; i++) {
    const daysAgo = 3 + i; // tudo > 48h maduro
    campaigns.push(
      campaignSentAt(new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(), { id: 100 + i }),
    );
  }

  const html = renderWeeklyPlanTabPanel(campaigns, now);

  assert.match(html, /Recomendação — próximos 3 envios/, "sanity check — deve cair no branch de recomendação");
  const recSection = html.split("Recomendação — próximos 3 envios")[1] ?? "";
  assert.match(
    recSection.slice(0, 200),
    /<div class="table-wrap">\s*<table>\s*<thead><tr><th>Envio<\/th>/,
    "tabela de recomendação deve estar dentro de .table-wrap (#3086)",
  );
});

test("#3086: os 2 <details> da aba Rampa (incluídos/excluídos) usam summary.links-summary + .table-wrap", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const campaigns: BrevoCampaign[] = [];
  for (let i = 0; i < 11; i++) {
    const daysAgo = 3 + i;
    campaigns.push(
      campaignSentAt(new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(), { id: 200 + i }),
    );
  }

  const html = renderWeeklyPlanTabPanel(campaigns, now);

  assert.match(
    html,
    /<summary class="links-summary">Dias de envio incluídos no agregado/,
    "summary de 'incluídos' deve usar a classe links-summary já usada em outros colapsáveis (#3086)",
  );
  assert.match(
    html,
    /<summary class="links-summary">Excluídos por imaturidade/,
    "summary de 'excluídos' deve usar a classe links-summary já usada em outros colapsáveis (#3086)",
  );
  assert.match(
    html,
    /<summary class="links-summary">Dias de envio incluídos no agregado \(\d+\)<\/summary>\s*<div class="table-wrap">/,
    "tabela de dias incluídos deve estar dentro de .table-wrap (#3086)",
  );
  assert.match(
    html,
    /<summary class="links-summary">Excluídos por imaturidade \(&lt;48h\) \(\d+\)<\/summary>\s*<div class="table-wrap">/,
    "tabela de dias excluídos deve estar dentro de .table-wrap (#3086)",
  );
});

test("sanity: fixes independentes não colidem — overflow-x do .tab-bar não vaza pro .table-wrap/tabelas da Rampa", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";

  // .table-wrap continua com sua PRÓPRIA regra de overflow-x (já existia antes
  // deste batch) — o fix do #3083 é escopado só a .tab-bar/.tab-label, não
  // reescreve .table-wrap.
  const tableWrapRule = styleBlock.match(/\.table-wrap\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(tableWrapRule, /overflow-x:\s*auto/, ".table-wrap deve manter seu próprio overflow-x (não removido pelo #3083)");

  const tabBarRule = styleBlock.match(/\.tab-bar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(tabBarRule, /table/, ".tab-bar não deve referenciar seletores de tabela");
});
