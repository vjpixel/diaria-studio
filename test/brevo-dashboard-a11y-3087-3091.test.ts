/**
 * Regression tests for a batch of 5 a11y/contrast fixes on clarice-dashboard
 * (workers/brevo-dashboard), all landed together (same worker, no line
 * conflicts between them, same Fable review pass):
 *
 *  - #3087: `weekly-plan.ts` hardcoded its own `STATUS_COLOR` (green/yellow/
 *    red) with a red (#c0392b) that diverged from `DS.alert` (#C00000, used
 *    everywhere else) and a yellow (#b07a00, ~3.7:1) below WCAG AA (4.5:1).
 *    Fix: consolidated into a single `STATUS_COLOR` export in render-links.ts
 *    (next to `DS.alert`) — red reuses `DS.alert` directly, yellow/green
 *    darkened to cross 4.5:1 over `--card` (#FFFFFF).
 *  - #3088: teal (`--brand`, #00A0A0) measures ~3.2:1 over white/`--card` —
 *    below AA for normal-size text. Used in `td.metric`, link click counts,
 *    and winner tags ("▲ LÍDER"/"▲ MELHOR DIA"/etc). Fix: these text/numeric
 *    highlights revert to `--ink` (bold + monospace/symbol already
 *    differentiate visually); teal stays reserved for graphical elements
 *    (links, progress bar, active tab state — 3:1 is acceptable for those).
 *  - #3089: `.links-note`/`.links-empty` used `opacity: 0.5` at ~11.5px,
 *    measuring ~3.5:1 (below AA). Fix: opacity 0.7 (~5.6-6.8:1). `.sub`/
 *    `td small` at opacity 0.6 passed AA (~4.7:1) but with no margin — bumped
 *    to 0.65 (~5.6-5.7:1) for safety margin.
 *  - #3090: column semantics lived only in `title=` (hover-only, inaccessible
 *    on touch/mobile — the editor's real workflow is on a phone). Fix: added
 *    a `<details>` "Glossário das colunas" per table (Envios, Cohorts,
 *    aggregated Links), generated from the SAME `{label, tooltip}` constants
 *    used in the `<th title=...>` attributes (no text duplication). `title=`
 *    attributes remain as a desktop hover convenience.
 *  - #3091: the Cohorts table used red/`class="alert"` for BOTH "crossed
 *    circuit breaker" (convention everywhere else) AND "deviates >20pp from
 *    the column average — including a POSITIVE deviation" (painting the BEST
 *    row red). Fix: deviation direction now considered per metric (higher-
 *    is-better for abertura/clique, lower-is-better for unsub/bounce) —
 *    favorable deviation gets "▲" (ink, no alarm), unfavorable gets "▼" +
 *    class="alert" (red). Red goes back to meaning only "bad" site-wide; the
 *    footer's "exception" disclaimer for the Cohorts table was removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderDashboardHtml,
  renderWeeklyPlanTabPanel,
  renderCohortsTabPanel,
  renderAggregatedLinksSection,
  renderColumnGlossary,
  STATUS_COLOR,
  DS,
  ENVIOS_COLUMNS,
  COHORTS_COLUMNS,
  AGGREGATED_LINKS_COLUMNS,
  type BrevoCampaign,
  type CohortStatsRow,
  type AggregatedLinkRow,
} from "../workers/brevo-dashboard/src/index.ts";

// ---------------------------------------------------------------------------
// #3087 — STATUS_COLOR consolidado num único lugar
// ---------------------------------------------------------------------------

test("#3087: STATUS_COLOR.red reusa DS.alert (mesmo vermelho do resto do dashboard)", () => {
  assert.equal(STATUS_COLOR.red, DS.alert);
  assert.equal(STATUS_COLOR.red, "#C00000");
});

test("#3087: STATUS_COLOR.yellow/green cruzam AA (4.5:1) — não são mais #b07a00/#158a4a", () => {
  assert.notEqual(STATUS_COLOR.yellow, "#b07a00", "amarelo antigo (~3.7:1, abaixo de AA) não deve mais ser usado");
  assert.notEqual(STATUS_COLOR.red, "#c0392b", "vermelho antigo divergente de DS.alert não deve mais ser usado");
  assert.equal(STATUS_COLOR.yellow, "#8A6100");
  assert.equal(STATUS_COLOR.green, "#0E6B39");
});

test("#3087: renderWeeklyPlanTabPanel usa o STATUS_COLOR consolidado (não uma cópia local)", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  const camp: BrevoCampaign = {
    id: 1,
    name: "Clarice News 2607 d05",
    subject: "subject",
    status: "sent",
    sentDate: new Date(now.getTime() - 60 * 60 * 60 * 1000).toISOString(),
    scheduledAt: null,
    createdAt: now.toISOString(),
    recipients: { lists: [1] },
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990, hardBounces: 2, softBounces: 2,
        uniqueViews: 270, viewed: 270, trackableViews: 270,
        uniqueClicks: 10, clickers: 10, unsubscriptions: 31, complaints: 0, appleMppOpens: 0,
      },
    },
  } as unknown as BrevoCampaign;
  const html = renderWeeklyPlanTabPanel([camp], now);
  assert.match(html, new RegExp(STATUS_COLOR.green), "verde consolidado aparece no render");
  assert.match(html, new RegExp(STATUS_COLOR.red), "vermelho consolidado (DS.alert) aparece no render");
});

// ---------------------------------------------------------------------------
// #3088 — teal (--brand) fora de elementos gráficos vira --ink
// ---------------------------------------------------------------------------

test("#3088: td.metric usa --ink, não --brand (teal falha AA em texto pequeno)", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  const rule = styleBlock.match(/(?<!\.links-table )td\.metric\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /color:\s*var\(--ink\)/, "td.metric deve usar --ink (#3088)");
  assert.doesNotMatch(rule, /color:\s*var\(--brand\)/, "td.metric NÃO deve mais usar --brand (#3088)");
});

test("#3088: .links-table td.link-clicks usa --ink, não --brand", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  const rule = styleBlock.match(/\.links-table td\.link-clicks\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /color:\s*var\(--ink\)/, "link-clicks deve usar --ink (#3088)");
});

test("#3088: teal (--brand) continua reservado a elementos gráficos — link, progress bar, aba ativa", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  assert.match(
    styleBlock,
    /\.links-table td\.link-url a \{ color: var\(--brand\)/,
    "hyperlink de link continua teal (elemento gráfico/interativo)",
  );
  assert.match(
    styleBlock,
    /\.spark-bar \{[^}]*color: var\(--brand\)/,
    "barra de progresso (spark-bar) continua teal (elemento gráfico)",
  );
  assert.match(
    styleBlock,
    /color: var\(--brand\); border-bottom-color: var\(--paper\);/,
    "estado ativo de aba continua teal (elemento gráfico)",
  );
});

test("#3088: tag '▲ LÍDER' (Resumo A/B/C) usa --ink, não --brand", () => {
  const camp: BrevoCampaign = {
    id: 1,
    name: "Clarice News 2607 d01-A",
    subject: "s",
    status: "sent",
    sentDate: "2026-07-08T09:00:00Z",
    scheduledAt: null,
    createdAt: "2026-07-08T09:00:00Z",
    recipients: { lists: [1] },
    statistics: {
      globalStats: {
        sent: 100, delivered: 98, hardBounces: 0, softBounces: 0,
        uniqueViews: 50, viewed: 50, trackableViews: 50,
        uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0, appleMppOpens: 0,
      },
    },
  } as unknown as BrevoCampaign;
  const html = renderDashboardHtml([camp]);
  if (html.includes("▲ LÍDER")) {
    assert.match(html, new RegExp(`style="color:${DS.ink}">▲ LÍDER`), "▲ LÍDER deve usar DS.ink (#3088)");
    assert.doesNotMatch(html, new RegExp(`style="color:${DS.brand}">▲ LÍDER`), "▲ LÍDER NÃO deve mais usar DS.brand");
  }
});

// ---------------------------------------------------------------------------
// #3089 — opacity de textos secundários sobe pra manter AA com folga
// ---------------------------------------------------------------------------

test("#3089: .links-note e .links-empty usam opacity 0.7 (não mais 0.5)", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  const noteRule = styleBlock.match(/\.links-note\s*\{[^}]*\}/)?.[0] ?? "";
  const emptyRule = styleBlock.match(/\.links-empty\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(noteRule, /opacity:\s*0\.7/, "#3089: .links-note deve ter opacity 0.7");
  assert.match(emptyRule, /opacity:\s*0\.7/, "#3089: .links-empty deve ter opacity 0.7");
});

test("#3089: .sub e td small sobem de opacity 0.6 para 0.65 (mais folga de contraste)", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  const subRule = styleBlock.match(/\.sub\s*\{[^}]*\}/)?.[0] ?? "";
  const tdSmallRule = styleBlock.match(/td small\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(subRule, /opacity:\s*0\.65/, "#3089: .sub deve ter opacity 0.65");
  assert.match(tdSmallRule, /opacity:\s*0\.65/, "#3089: td small deve ter opacity 0.65");
});

// ---------------------------------------------------------------------------
// #3090 — glossário de colunas (sempre visível, não hover-only)
// ---------------------------------------------------------------------------

test("#3090: renderColumnGlossary gera um <details> reusando .links-ctr/.links-summary a partir das mesmas entradas dos title=", () => {
  const html = renderColumnGlossary("teste", [
    { label: "Foo", tooltip: "Descrição de foo" },
    { label: "Bar", tooltip: "Descrição de bar" },
  ]);
  assert.match(html, /<details class="links-ctr" id="glossary-teste">/);
  assert.match(html, /<summary class="links-summary">Glossário das colunas<\/summary>/);
  assert.match(html, /<dt>Foo<\/dt><dd>Descrição de foo<\/dd>/);
  assert.match(html, /<dt>Bar<\/dt><dd>Descrição de bar<\/dd>/);
});

test("#3090: renderColumnGlossary com lista vazia retorna string vazia (graceful)", () => {
  assert.equal(renderColumnGlossary("vazio", []), "");
});

test("#3090: a tabela Envios (Visão Geral) tem um glossário gerado de ENVIOS_COLUMNS, com o mesmo texto do title= do header", () => {
  const html = renderDashboardHtml([]);
  assert.match(html, /<details class="links-ctr" id="glossary-envios">/, "glossário da tabela Envios presente");
  for (const col of ENVIOS_COLUMNS) {
    // O <th title=...> usa o texto (possivelmente escapado por escHtml); o
    // glossário usa a MESMA string — checamos que ambos contêm o rótulo.
    assert.ok(html.includes(`<dt>${col.label}</dt>`), `glossário deve listar a coluna ${col.label}`);
  }
  // Sanity: o header <th> continua presente (title= como conveniência desktop).
  // #3081: tooltip atualizado — ID agora é link pro report da Brevo.
  assert.match(html, /<th title="ID do envio no Brevo — link direto pro report da campanha na UI da Brevo\.">ID<\/th>/);
});

test("#3090: a tabela Cohorts tem um glossário gerado de COHORTS_COLUMNS", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 90, received: 50, opened: 40, clicked: 10, unsub: 1, hard_bounce: 0,
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<details class="links-ctr" id="glossary-cohorts">/);
  for (const col of COHORTS_COLUMNS) {
    assert.ok(html.includes(`<dt>${col.label}</dt>`), `glossário Cohorts deve listar ${col.label}`);
  }
});

test("#3090: a tabela de Links agregados tem um glossário gerado de AGGREGATED_LINKS_COLUMNS", () => {
  const rows: AggregatedLinkRow[] = [
    { url: "https://exemplo.com", displayUrl: "https://exemplo.com", totalClicks: 10, campaignCount: 2 },
  ];
  const html = renderAggregatedLinksSection(rows, null);
  assert.match(html, /<details class="links-ctr" id="glossary-links-agregados">/);
  for (const col of AGGREGATED_LINKS_COLUMNS) {
    assert.ok(html.includes(`<dt>${col.label}</dt>`), `glossário Links deve listar ${col.label}`);
  }
});

// ---------------------------------------------------------------------------
// #3091 — vermelho da tabela Cohorts volta a significar só "ruim"
// ---------------------------------------------------------------------------

const mk = (o: Partial<CohortStatsRow>): CohortStatsRow => ({
  contacts: 0, eligible: 0, received: 0, opened: 0, clicked: 0, unsub: 0, hard_bounce: 0, ...o,
});

test("#3091: desvio FAVORÁVEL (abertura acima da média) ganha ▲, nunca class=\"alert\"", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 100, received: 100, opened: 90 }), // 90%, bem acima
    "ex-assinantes": mk({ contacts: 100, eligible: 100, received: 100, opened: 10 }), // 10%, bem abaixo
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<td><strong>▲ 90\.0%<\/strong><\/td>/, "melhor linha (90%, acima da média) NÃO deve ser vermelha");
  assert.doesNotMatch(html, /<td class="alert">90\.0%<\/td>/, "regressão do bug original: melhor linha pintada de vermelho");
});

test("#3091: desvio DESFAVORÁVEL (abertura abaixo da média) ganha ▼ + class=\"alert\" (vermelho)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 100, received: 100, opened: 90 }),
    "ex-assinantes": mk({ contacts: 100, eligible: 100, received: 100, opened: 10 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<td class="alert">▼ 10\.0%<\/td>/, "pior linha (10%, abaixo da média) deve continuar vermelha");
});

test("#3091: unsub/bounce são lower-is-better — valor ALTO (acima da média) é desfavorável (▼ vermelho), valor BAIXO é favorável (▲)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 100, received: 100, unsub: 1 }), // 1%
    "ex-assinantes": mk({ contacts: 100, eligible: 100, received: 100, unsub: 50 }), // 50%
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<td><strong>▲ 1\.0%<\/strong><\/td>/, "unsub baixo (favorável) ganha ▲, sem vermelho");
  assert.match(html, /<td class="alert">▼ 50\.0%<\/td>/, "unsub alto (desfavorável) ganha ▼ + vermelho");
});

test("#3091: desvio dentro do threshold (<=20pp) não ganha marcação nenhuma (nem ▲ nem ▼)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 100, received: 100, opened: 55 }),
    "ex-assinantes": mk({ contacts: 100, eligible: 100, received: 100, opened: 45 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /▲ 55\.0%/);
  assert.doesNotMatch(html, /▼ 45\.0%/);
  assert.match(html, /<td>55\.0%<\/td>/);
  assert.match(html, /<td>45\.0%<\/td>/);
});

test("#3091: linha Total nunca ganha marcação de desvio (▲/▼)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 100, received: 100, opened: 90 }),
    "ex-assinantes": mk({ contacts: 100, eligible: 100, received: 100, opened: 10 }),
  };
  const html = renderCohortsTabPanel(stats);
  const totalRowHtml = html.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)?.[1] ?? "";
  assert.doesNotMatch(totalRowHtml, /▲|▼/, "linha Total não deve ter símbolos de desvio");
  assert.doesNotMatch(totalRowHtml, /class="alert"/, "linha Total não deve ter class=alert");
});

test("#3091: footer não tem mais o disclaimer de 'outro significado' pra tabela Cohorts", () => {
  const html = renderDashboardHtml([], [], null, null, null);
  const footer = html.match(/<p class="footer">[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.doesNotMatch(footer, /outro significado/, "disclaimer antigo removido (#3091)");
  assert.match(footer, /Vermelho sempre significa/i, "footer afirma que vermelho é sempre 'ruim' (#3091)");
});

// ---------------------------------------------------------------------------
// sanity: os 5 fixes coexistem sem colisão (mesmo worker, mesma revisão)
// ---------------------------------------------------------------------------

test("sanity: renderDashboardHtml renderiza sem lançar com todos os 5 fixes aplicados juntos", () => {
  const contactsSummary = {
    generated_at: "2026-07-08T12:00:00Z",
    total: 10,
    brevo: { synced_rows: 5, has_signal: true },
    eligibility: { eligible: 9, ineligible: 1, by_reason: {} },
    priority_points: { lt0: 0, eq0: 10, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 },
    mv: {},
    engagement: { with_opens: 0, with_clicks: 0 },
    cohort_stats: {
      "assinantes-ativos": mk({ contacts: 10, eligible: 9, received: 9, opened: 8, clicked: 2, unsub: 0 }),
    },
  } as any;
  assert.doesNotThrow(() => renderDashboardHtml([], [], null, null, contactsSummary));
});
