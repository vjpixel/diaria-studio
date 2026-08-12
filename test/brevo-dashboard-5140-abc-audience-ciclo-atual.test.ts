/**
 * test/brevo-dashboard-5140-abc-audience-ciclo-atual.test.ts (#5140 Parte 2)
 *
 * Regressão (#633) para a decisão do editor de 12/08/2026: o "Resumo A/B/C
 * por Audiência" deve mostrar SÓ o ciclo mensal atual.
 *
 * O bug: `monthlyAbcCycles` era o `Set` de TODOS os ciclos já vistos em
 * `monthlyAbcGroups`, e cada um virava um bloco permanente de 3 tabelas. Em
 * 12/08/2026 o painel ainda servia "Resumo A/B/C por Audiência (2606-07 ·
 * envios de jul/2026)" — ciclo encerrado, de um teste que o editor encerrou
 * (#5055). Sem este teste, qualquer refactor que volte a mapear o Set inteiro
 * ressuscita a tabela sem ninguém perceber (a UI só cresce, nunca reclama).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { renderDashboardHtml } from "../workers/brevo-dashboard/src/sections-core.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

function makeCampaign(id: number, name: string, sentDate: string): BrevoCampaign {
  return {
    id,
    name,
    subject: "s",
    status: "sent",
    sentDate,
    scheduledAt: sentDate,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990, hardBounces: 1, softBounces: 1,
        uniqueViews: 250, viewed: 250, trackableViews: 200,
        uniqueClicks: 40, clickers: 40, unsubscriptions: 5, complaints: 0, appleMppOpens: 10,
      },
    },
  } as unknown as BrevoCampaign;
}

/** Dois ciclos mensais com teste A/B/C: um antigo (2606-07) e o atual (2607-08). */
function doisCiclos(): BrevoCampaign[] {
  return [
    makeCampaign(1, "cold 2606-07 — A: s", "2026-07-05T09:00:00Z"),
    makeCampaign(2, "cold 2606-07 — B: s", "2026-07-05T09:01:00Z"),
    makeCampaign(3, "cold 2606-07 — C: s", "2026-07-05T09:02:00Z"),
    makeCampaign(4, "cold 2607-08 — A: s", "2026-08-05T09:00:00Z"),
    makeCampaign(5, "cold 2607-08 — B: s", "2026-08-05T09:01:00Z"),
    makeCampaign(6, "cold 2607-08 — C: s", "2026-08-05T09:02:00Z"),
  ];
}

const TITULO = /Resumo A\/B\/C por Audiência \((\d{4}-\d{2})/g;

test("#5140: com 2 ciclos mensais, o Resumo A/B/C por Audiência renderiza só o mais recente", () => {
  const html = renderDashboardHtml(doisCiclos());
  const ciclos = [...html.matchAll(TITULO)].map((m) => m[1]);

  assert.ok(ciclos.length > 0, "o resumo por audiência deveria renderizar ao menos uma vez");
  assert.ok(
    ciclos.every((c) => c === "2607-08"),
    `só o ciclo atual deveria aparecer, veio: ${[...new Set(ciclos)].join(", ")}`,
  );
  assert.ok(
    !ciclos.includes("2606-07"),
    "REGRESSÃO: o ciclo encerrado 2606-07 voltou ao Resumo A/B/C por Audiência",
  );
});

test("#5140: com um ciclo só, ele continua sendo renderizado (o filtro não esvazia a seção)", () => {
  // O modo de falha oposto ao do bug: um filtro cedo demais (ex: comparar com
  // `detectActiveCycle`, que ignora campanhas MENSAIS de propósito) apagaria a
  // seção inteira em vez de reduzi-la a um ciclo.
  const html = renderDashboardHtml(doisCiclos().slice(3));
  const ciclos = [...html.matchAll(TITULO)].map((m) => m[1]);

  assert.ok(ciclos.includes("2607-08"), "o único ciclo presente deveria renderizar");
});

test("#5140: sem nenhum teste A/B/C mensal, a seção não renderiza e nada quebra", () => {
  const html = renderDashboardHtml([]);
  assert.equal([...html.matchAll(TITULO)].length, 0);
});
