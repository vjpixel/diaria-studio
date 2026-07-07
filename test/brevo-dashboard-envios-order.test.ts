/**
 * Regression test for #3017: a tabela "Envios" (#campaigns-table) não estava
 * ordenada por data de envio — as rows seguiam a ordem em que `campaigns`
 * chegava da API/cache da Brevo, não a ordem cronológica.
 *
 * Fix: renderDashboardHtml agora ordena por sentDate (fallback scheduledAt
 * quando sentDate for null) em ordem decrescente — mais recente primeiro —
 * antes de montar as <tr>, mesmo padrão de comparação usado em
 * groupMonthlyAbcTests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../workers/brevo-dashboard/src/index.ts";

const baseCampaign = {
  name: "Test campaign",
  subject: "Test subject",
  status: "sent",
  scheduledAt: null,
  createdAt: "2026-05-08T22:24:00Z",
  recipients: { lists: [9] },
  listName: "T1-W1 (top 50)",
  listSize: 50,
};

test("renderDashboardHtml ordena a tabela Envios por sentDate decrescente (#3017)", () => {
  // Entrada deliberadamente embaralhada (nem crescente nem decrescente) —
  // a ordem de chegada da API não deve influenciar a ordem de exibição.
  const campaigns = [
    { ...baseCampaign, id: 10, sentDate: "2026-05-10T10:00:00Z" }, // meio
    { ...baseCampaign, id: 30, sentDate: "2026-05-30T10:00:00Z" }, // mais recente
    { ...baseCampaign, id: 20, sentDate: "2026-05-01T10:00:00Z" }, // mais antigo
  ];

  const html = renderDashboardHtml(campaigns);

  const pos30 = html.indexOf("<td>30</td>");
  const pos10 = html.indexOf("<td>10</td>");
  const pos20 = html.indexOf("<td>20</td>");

  assert.ok(pos30 !== -1 && pos10 !== -1 && pos20 !== -1, "todas as 3 campaigns devem renderizar uma row");
  assert.ok(pos30 < pos10, "campaign mais recente (id 30, 30/05) deve vir ANTES da do meio (id 10, 10/05)");
  assert.ok(pos10 < pos20, "campaign do meio (id 10, 10/05) deve vir ANTES da mais antiga (id 20, 01/05)");
});

test("renderDashboardHtml usa scheduledAt como fallback quando sentDate é null (#3017)", () => {
  // Campanha sem sentDate (ainda não processado no fetch, ou dado ausente)
  // deve cair pro scheduledAt na hora de ordenar — mesmo padrão de fallback
  // usado em groupMonthlyAbcTests.
  const campaigns = [
    { ...baseCampaign, id: 1, sentDate: "2026-06-01T10:00:00Z", scheduledAt: null },
    { ...baseCampaign, id: 2, sentDate: null, scheduledAt: "2026-06-15T10:00:00Z" }, // mais recente via fallback
  ];

  const html = renderDashboardHtml(campaigns);

  const pos2 = html.indexOf("<td>2</td>");
  const pos1 = html.indexOf("<td>1</td>");

  assert.ok(pos2 !== -1 && pos1 !== -1, "ambas as campaigns devem renderizar uma row");
  assert.ok(pos2 < pos1, "campaign com scheduledAt mais recente (id 2, fallback de sentDate null) deve vir ANTES de sentDate=01/06 (id 1)");
});
