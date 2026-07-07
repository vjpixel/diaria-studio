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

test("renderDashboardHtml ordena corretamente mesmo com formatos de data MISTOS (#3057)", () => {
  // #3057: comparação lexicográfica de string ISO pode ordenar errado quando
  // os formatos divergem entre linhas — sentDate tipicamente sem ms
  // ("...T09:00:00Z"), scheduledAt pode ter ms e/ou offset explícito
  // ("...T09:00:00.000Z", "...T06:00:00.000-03:00"). O fix normaliza via
  // Date.parse antes de comparar. Este teste usa campanhas representando o
  // MESMO instante cronológico (ou próximo) em formatos diferentes, mais uma
  // claramente mais recente e uma claramente mais antiga — se a comparação
  // fosse lexicográfica, o "." presente nas strings com ms poderia inverter
  // a ordem esperada.
  const campaigns = [
    // sentDate sem ms, UTC — instante T
    { ...baseCampaign, id: 100, sentDate: "2026-06-11T09:00:00Z", scheduledAt: null },
    // scheduledAt (fallback, sentDate null) COM ms e offset BRT explícito —
    // 06:00 BRT-03:00 = 09:00 UTC = MESMO instante T acima, mas string bem diferente.
    { ...baseCampaign, id: 200, sentDate: null, scheduledAt: "2026-06-11T06:00:00.000-03:00" },
    // sentDate com ms, claramente mais recente (1h depois de T)
    { ...baseCampaign, id: 300, sentDate: "2026-06-11T10:00:00.000Z", scheduledAt: null },
    // sentDate sem ms, claramente mais antiga (1 dia antes de T)
    { ...baseCampaign, id: 400, sentDate: "2026-06-10T09:00:00Z", scheduledAt: null },
  ];

  const html = renderDashboardHtml(campaigns);

  const pos300 = html.indexOf("<td>300</td>");
  const pos100 = html.indexOf("<td>100</td>");
  const pos200 = html.indexOf("<td>200</td>");
  const pos400 = html.indexOf("<td>400</td>");

  assert.ok(
    [pos300, pos100, pos200, pos400].every((p) => p !== -1),
    "todas as 4 campaigns devem renderizar uma row",
  );
  // 300 (10:00 UTC) é a mais recente — deve vir primeiro, mesmo tendo ms na string.
  assert.ok(pos300 < pos100, "campaign mais recente (id 300, ms na string) deve vir ANTES do instante T (id 100)");
  assert.ok(pos300 < pos200, "campaign mais recente (id 300) deve vir ANTES do instante T via fallback com offset (id 200)");
  // 100 e 200 representam o MESMO instante (T) em formatos diferentes — ambas
  // devem vir depois de 300 e antes de 400, sem uma "vencer" a outra por
  // artefato de comparação de string.
  assert.ok(pos100 < pos400, "instante T (id 100) deve vir ANTES da mais antiga (id 400)");
  assert.ok(pos200 < pos400, "instante T via fallback com offset (id 200) deve vir ANTES da mais antiga (id 400)");
});
