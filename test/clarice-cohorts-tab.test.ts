import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCohortsTabPanel,
  renderDashboardHtml,
  COHORT_DEVIATION_THRESHOLD_PP,
  type CohortStatsRow,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";

// #2864: aba "Cohorts" — comparativo de envio/engajamento por cohort.

test("renderCohortsTabPanel: stub gracioso quando cohortStats é undefined", () => {
  const html = renderCohortsTabPanel(undefined);
  assert.match(html, /id="cohorts-tab"/);
  assert.match(html, /Dados ainda não gerados/);
  assert.match(html, /clarice-db-summary\.ts/);
  assert.doesNotMatch(html, /undefined/);
});

test("renderCohortsTabPanel: stub gracioso quando cohortStats é objeto vazio", () => {
  const html = renderCohortsTabPanel({});
  assert.match(html, /Dados ainda não gerados/);
});

test("renderCohortsTabPanel: renderiza contatos/elegíveis/recebeu/envios e taxas calculadas", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 1200, eligible: 1190, received: 1000, sends_sum: 3000,
      opened: 800, clicked: 200, unsub_bounce: 10, mv_verified: 1150,
      priority_points_sum: 40000, // média = 40000/1000 = 40.0
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /Assinantes ativos/);
  assert.match(html, />1[.,]?200</, "contatos");
  assert.match(html, />1[.,]?190</, "elegíveis");
  assert.match(html, />1[.,]?000</, "recebeu ≥1");
  assert.match(html, />3[.,]?000</, "soma de envios");
  assert.match(html, />80\.0%</, "abertura 800/1000");
  assert.match(html, />20\.0%</, "clique 200/1000");
  assert.match(html, />1\.0%</, "unsub+bounce 10/1000");
  // mv verified é sobre TOTAL de contatos (1150/1200 = 95.8%), não sobre received.
  assert.match(html, />95\.8%</, "mv verified sobre o total de contatos");
  assert.match(html, />40\.0</, "priority_points médio de quem recebeu");
});

test("renderCohortsTabPanel: cohort sem ninguém 'recebeu' (received=0) mostra '—' nas taxas de engajamento, não NaN/Infinity", () => {
  const stats: Record<string, CohortStatsRow> = {
    "leads-2026-06": {
      contacts: 500, eligible: 480, received: 0, sends_sum: 0,
      opened: 0, clicked: 0, unsub_bounce: 0, mv_verified: 0,
      priority_points_sum: 0,
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /Infinity/);
  // Abertura/Clique/Unsub+Bounce/Pts médio → "—"; MV verified calcula sobre
  // contacts (denominador > 0), então tem valor real (0.0%).
  const dashCount = (html.match(/>—</g) ?? []).length;
  assert.ok(dashCount >= 4, `esperado ao menos 4 travessões (abertura/clique/unsub-bounce/pts médio), achou ${dashCount}`);
});

test("renderCohortsTabPanel: cohort 'null' (sem cohort atribuído) rotulado 'sem cohort'", () => {
  const stats: Record<string, CohortStatsRow> = {
    null: {
      contacts: 10, eligible: 10, received: 0, sends_sum: 0,
      opened: 0, clicked: 0, unsub_bounce: 0, mv_verified: 0,
      priority_points_sum: 0,
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, />sem cohort</);
});

test("renderCohortsTabPanel: ordena por cohortSendRank (assinantes-ativos < ex-assinantes < leads < caudão < null)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "leads-caudao": { contacts: 1, eligible: 1, received: 0, sends_sum: 0, opened: 0, clicked: 0, unsub_bounce: 0, mv_verified: 0, priority_points_sum: 0 },
    "ex-assinantes": { contacts: 1, eligible: 1, received: 0, sends_sum: 0, opened: 0, clicked: 0, unsub_bounce: 0, mv_verified: 0, priority_points_sum: 0 },
    "assinantes-ativos": { contacts: 1, eligible: 1, received: 0, sends_sum: 0, opened: 0, clicked: 0, unsub_bounce: 0, mv_verified: 0, priority_points_sum: 0 },
    null: { contacts: 1, eligible: 1, received: 0, sends_sum: 0, opened: 0, clicked: 0, unsub_bounce: 0, mv_verified: 0, priority_points_sum: 0 },
  };
  const html = renderCohortsTabPanel(stats);
  const idxAtivos = html.indexOf("Assinantes ativos");
  const idxEx = html.indexOf("Ex-assinantes");
  const idxCaudao = html.indexOf("caudão");
  const idxNull = html.indexOf("sem cohort");
  assert.ok(idxAtivos < idxEx, "assinantes-ativos antes de ex-assinantes");
  assert.ok(idxEx < idxCaudao, "ex-assinantes antes de leads-caudao");
  assert.ok(idxCaudao < idxNull, "leads-caudao antes de null (sem cohort)");
});

test("renderCohortsTabPanel: célula com desvio >20pp da média da coluna ganha class=\"alert\"", () => {
  // 2 cohorts: A com abertura 90%, B com abertura 10% → média = 50%; ambos
  // desviam 40pp (>20pp) → ambos devem ganhar destaque.
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 100, received: 100, sends_sum: 100,
      opened: 90, clicked: 0, unsub_bounce: 0, mv_verified: 0, priority_points_sum: 0,
    },
    "ex-assinantes": {
      contacts: 100, eligible: 100, received: 100, sends_sum: 100,
      opened: 10, clicked: 0, unsub_bounce: 0, mv_verified: 0, priority_points_sum: 0,
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<td class="alert">90\.0%<\/td>/, "90% (desvio +40pp) destacado");
  assert.match(html, /<td class="alert">10\.0%<\/td>/, "10% (desvio -40pp) destacado");
});

test("renderCohortsTabPanel: cohorts próximos da média (desvio <=20pp) NÃO ganham destaque", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 100, received: 100, sends_sum: 100,
      opened: 55, clicked: 0, unsub_bounce: 0, mv_verified: 0, priority_points_sum: 0,
    },
    "ex-assinantes": {
      contacts: 100, eligible: 100, received: 100, sends_sum: 100,
      opened: 45, clicked: 0, unsub_bounce: 0, mv_verified: 0, priority_points_sum: 0,
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /<td class="alert">55\.0%<\/td>/);
  assert.doesNotMatch(html, /<td class="alert">45\.0%<\/td>/);
});

test("COHORT_DEVIATION_THRESHOLD_PP é 20", () => {
  assert.equal(COHORT_DEVIATION_THRESHOLD_PP, 20);
});

test("renderDashboardHtml: inclui a aba Cohorts (radio + label + panel), CSS torna o painel visível quando selecionado", () => {
  const html = renderDashboardHtml([], [], null, null, null);
  assert.match(html, /id="tab-cohorts"/);
  assert.match(html, /id="panel-cohorts"/);
  assert.match(html, />Cohorts</);
  assert.match(html, /#tab-cohorts:checked ~ \.tab-panels #panel-cohorts/);
});

test("renderDashboardHtml: contactsSummary.cohort_stats popula a aba Cohorts sem novo parâmetro posicional", () => {
  const contactsSummary: ContactsSummary = {
    generated_at: "2026-07-02T12:00:00Z",
    total: 100,
    brevo: { synced_rows: 50, has_signal: true },
    eligibility: { eligible: 90, ineligible: 10, by_reason: {} },
    priority_points: { lt0: 0, eq0: 100, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 },
    mv: {},
    engagement: { with_opens: 0, with_clicks: 0 },
    cohort_stats: {
      "assinantes-ativos": {
        contacts: 100, eligible: 90, received: 80, sends_sum: 200,
        opened: 40, clicked: 5, unsub_bounce: 2, mv_verified: 70,
        priority_points_sum: 800,
      },
    },
  };
  const html = renderDashboardHtml([], [], null, null, contactsSummary);
  const panel = html.match(/id="panel-cohorts"[\s\S]*?(?=<\/div><!-- \/panel-cohorts -->)/)?.[0] ?? "";
  assert.match(panel, /Assinantes ativos/);
  assert.doesNotMatch(panel, /Dados ainda não gerados/);
});
