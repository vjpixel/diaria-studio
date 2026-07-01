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

test("renderContactsSummarySection: total 0 (objeto válido) renderiza, não vira stub", () => {
  // store legitimamente vazio é dado válido, não ausência de dado (#2660 review)
  const html = renderContactsSummarySection({ ...sample, total: 0 });
  assert.doesNotMatch(html, /Dados ainda não gerados/);
  assert.match(html, /Banco de contatos/);
});

test("renderContactsSummarySection: payload parcial/stale (sem subobjetos) não lança", () => {
  // simula um contacts:summary de versão antiga do script — o handler casta sem
  // validar shape; o render NÃO pode crashar e derrubar o dashboard.
  const partial = { generated_at: "2026-06-29T12:00:00Z", total: 5 } as ContactsSummary;
  assert.doesNotThrow(() => renderContactsSummarySection(partial));
  assert.match(renderContactsSummarySection(partial), /Banco de contatos/);
});

test("renderDashboardHtml: CSS torna o painel Contatos visível quando selecionado", () => {
  // regressão do bug crítico: o painel ficaria display:none sem a regra CSS
  const html = renderDashboardHtml([], [], null, null, sample);
  assert.match(html, /#tab-contatos:checked ~ \.tab-panels #panel-contatos/);
});

test("renderContactsSummarySection: renderiza tier/razões/pontos/mv/engajamento", () => {
  const html = renderContactsSummarySection(sample);
  assert.match(html, /T01/); // tier 1 relabel
  assert.match(html, /T02/);
  assert.match(html, /sem tier/); // tier null
  assert.match(html, /mv_rejected/);
  assert.match(html, /41–80/); // faixa de priority_points
  // locale-robusto: pt-BR "29.600", en-US "29,600" ou raw "29600" (small-icu no CI)
  assert.match(html, /29[.,]?600/); // brevo synced
  assert.match(html, /2[.,]?219/); // engajamento with_opens
});

test("renderContactsSummarySection: label do by_tier deixa explícito o escopo 1º envio (#2732)", () => {
  // #2732: tier só é preditor válido pra quem NUNCA recebeu email
  // (segmentFromStore/computeStoreSummary já excluem sends_count>0 do by_tier
  // upstream) — o label da seção precisa deixar isso auditável na UI, não só
  // no dado. Reforça a decisão de modelagem: uma vez enviado, o eixo correto
  // de segmentação é priority_points, nunca mais tier.
  const html = renderContactsSummarySection(sample);
  assert.match(html, /Por tier \(1º envio\)/);
});

test("renderContactsSummarySection: branch has_signal=false mostra alerta", () => {
  const html = renderContactsSummarySection({
    ...sample,
    brevo: { synced_rows: 0, has_signal: false },
  });
  assert.match(html, /sem sinal Brevo ainda/);
  assert.match(html, /var\(--alert\)/);
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
