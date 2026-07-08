/**
 * Regression test for #3082: a tabela "Envios" (aba Visão geral) identificava
 * cada linha só por ID + Lista. Com um teste A/B/C do mesmo dia, as 3
 * campanhas caem sob o mesmo nome de lista genérico (ex: "Engajados") e ficam
 * indistinguíveis exceto pelas estatísticas — não dá pra saber qual linha é a
 * célula A, B ou C sem abrir o Brevo.
 *
 * Fix: a célula "Lista" ganha uma 2ª linha <small> com o nome de edição +
 * célula derivado do nome da campanha (reusa `deriveEditionName`, já usado na
 * aba Agendamento/weekly-plan.ts) — ex: "Clarice News 2606-07 — B". Campanhas
 * SEM célula (envio único, ou nome que não segue o padrão Clarice News) não
 * ganham a linha extra — não haveria nada pra desambiguar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../workers/brevo-dashboard/src/index.ts";

const baseCampaign = {
  subject: "Test subject",
  status: "sent",
  scheduledAt: null,
  createdAt: "2026-07-08T00:00:00Z",
  recipients: { lists: [9] },
  listName: "Engajados",
  listSize: 500,
};

function statsFor(sent: number, delivered: number, uniqueViews: number) {
  return {
    globalStats: {
      sent,
      delivered,
      uniqueViews,
      uniqueClicks: 10,
      hardBounces: 0,
      softBounces: 0,
      complaints: 0,
      unsubscriptions: 0,
      appleMppOpens: 0,
    },
  };
}

test("Envios: campanha de teste A/B/C ganha 2ª linha <small> com edição + célula (#3082)", () => {
  const campaigns = [
    {
      ...baseCampaign,
      id: 1,
      name: "Clarice News 2606-07 — A · dom",
      sentDate: "2026-07-08T09:00:00Z",
      statistics: statsFor(300, 297, 60),
    },
    {
      ...baseCampaign,
      id: 2,
      name: "Clarice News 2606-07 — B · dom",
      sentDate: "2026-07-08T09:00:00Z",
      statistics: statsFor(300, 297, 60),
    },
    {
      ...baseCampaign,
      id: 3,
      name: "Clarice News 2606-07 — C · dom",
      sentDate: "2026-07-08T09:00:00Z",
      statistics: statsFor(300, 297, 60),
    },
  ];

  const html = renderDashboardHtml(campaigns as any);

  // As 3 linhas devem carregar rótulos DISTINTOS de célula — é isso que
  // resolve a ambiguidade descrita na issue.
  assert.match(html, /Clarice News 2606-07 — A</, "célula A deve aparecer no rótulo");
  assert.match(html, /Clarice News 2606-07 — B</, "célula B deve aparecer no rótulo");
  assert.match(html, /Clarice News 2606-07 — C</, "célula C deve aparecer no rótulo");

  // O rótulo deve estar dentro de um <small> na célula Lista (padrão
  // taxa-em-cima/detalhe-embaixo já usado nas outras colunas da tabela).
  assert.match(
    html,
    /<strong>Engajados<\/strong><br><small>Clarice News 2606-07 — A<\/small>/,
    "rótulo de edição deve vir como <small> logo após o nome da lista",
  );
});

test("Envios: campanha SEM célula (envio único) não ganha linha extra vazia/lixo (#3082)", () => {
  const campaigns = [
    {
      ...baseCampaign,
      id: 10,
      name: "Clarice News 2607 d05 (seg)",
      sentDate: "2026-07-08T09:00:00Z",
      statistics: statsFor(300, 297, 60),
    },
  ];

  const html = renderDashboardHtml(campaigns as any);

  // Sem célula A/B/C — nada a desambiguar, então a célula Lista deve continuar
  // no formato antigo: só o nome da lista, sem <small> extra pendurado nela.
  assert.match(html, /<strong>Engajados<\/strong><\/td>/, "sem célula, a célula Lista termina logo após o </strong>, sem <small> extra");
  assert.doesNotMatch(html, /<small>Clarice News/, "nenhum rótulo de edição deve aparecer para envio sem célula");
});

test("Envios: nome de campanha que não segue o padrão Clarice News não quebra (fallback null, #3082)", () => {
  const campaigns = [
    {
      ...baseCampaign,
      id: 20,
      name: "Campanha qualquer sem padrão reconhecido",
      sentDate: "2026-07-08T09:00:00Z",
      statistics: statsFor(300, 297, 60),
    },
  ];

  const html = renderDashboardHtml(campaigns as any);

  assert.match(html, /<strong>Engajados<\/strong><\/td>/, "nome não reconhecido não deve gerar linha extra");
});
