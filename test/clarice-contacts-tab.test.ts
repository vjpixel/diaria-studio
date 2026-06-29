import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderContactsSummarySection,
  renderDashboardHtml,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";

const sample: ContactsSummary = {
  generated_at: "2026-06-29T12:00:00Z",
  total: 427528,
  brevo: { synced_rows: 29600, has_signal: true },
  by_tier: { "1": 1167, "2": 7269, null: 131 },
  eligibility: { eligible: 422961, ineligible: 4567, by_reason: { mv_rejected: 4452, dispute: 115 } },
  priority_points: { lt0: 1, eq0: 427520, p1_40: 5, p41_80: 1, gt80: 0, optin: 3 },
  mv: { verified: 81425, none: 340731, rejected: 4452, unknown: 920 },
  engagement: { with_opens: 2219, with_clicks: 74 },
};

test("renderContactsSummarySection: stub gracioso quando null", () => {
  const html = renderContactsSummarySection(null);
  assert.match(html, /Dados ainda não gerados/);
  assert.match(html, /clarice-db-summary\.ts/);
});

test("renderContactsSummarySection: total 0 também cai no stub", () => {
  const html = renderContactsSummarySection({ ...sample, total: 0 });
  assert.match(html, /Dados ainda não gerados/);
});

test("renderContactsSummarySection: renderiza tier/razões/pontos/mv/engajamento", () => {
  const html = renderContactsSummarySection(sample);
  assert.match(html, /T01/); // tier 1 relabel
  assert.match(html, /T02/);
  assert.match(html, /sem tier/); // tier null
  assert.match(html, /mv_rejected/);
  assert.match(html, /41–80/); // faixa de priority_points
  assert.match(html, /29\.600|29600/); // brevo synced (pt-BR ou raw)
  assert.match(html, /2\.219|2219/); // engajamento with_opens
});

test("renderDashboardHtml: inclui a aba Contatos (radio + label + panel)", () => {
  const html = renderDashboardHtml([], [], null, null, sample);
  assert.match(html, /id="tab-contatos"/);
  assert.match(html, /id="panel-contatos"/);
  assert.match(html, />Contatos</);
});

test("renderDashboardHtml: sem summary → aba presente mas com stub", () => {
  const html = renderDashboardHtml([], [], null, null, null);
  assert.match(html, /id="panel-contatos"/);
  assert.match(html, /Dados ainda não gerados/);
});
