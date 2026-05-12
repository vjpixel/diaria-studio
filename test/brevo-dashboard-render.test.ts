/**
 * Regression test for #1141 fix: dashboard worker showed numbers
 * different from Brevo Web UI because it was reading campaignStats[0]
 * (which excludes Apple MPP opens) instead of globalStats (which
 * includes them).
 *
 * Fix: renderDashboardHtml prefers globalStats over campaignStats[0],
 * with campaignStats[0] as fallback when globalStats is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../workers/brevo-dashboard/src/index.ts";

const baseCampaign = {
  id: 29,
  name: "Test campaign",
  subject: "Test subject",
  status: "sent",
  sentDate: "2026-05-08T22:24:00Z",
  scheduledAt: null,
  createdAt: "2026-05-08T22:24:00Z",
  recipients: { lists: [9] },
  listName: "T1-W1 (top 50)",
  listSize: 50,
};

test("renderDashboardHtml prefers globalStats (with MPP) over campaignStats[0]", () => {
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 2,
        uniqueViews: 26,           // <-- com MPP
        viewed: 34,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
        appleMppOpens: 6,
      },
      campaignStats: [{
        listId: 9,
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 2,
        deferred: 0,
        uniqueViews: 18,           // <-- SEM MPP (número antigo, errado)
        viewed: 19,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
      }],
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // 26 opens com MPP / 48 delivered = 54.2%
  // 20 opens reais (26 - 6 MPP) / 48 = 41.7%
  // Layout top: "54.2% (41.7%)" — com MPP primeiro, sem MPP em parens
  // Layout bottom: "26 (20)" — total primeiro, sem MPP em parens

  // Rate com MPP no topo (bold/teal via .metric)
  assert.ok(html.includes("54.2%"), "deveria mostrar open rate com MPP = 54.2% (26/48)");

  // Rate sem MPP em parens, normal-color (.rate-inline)
  assert.ok(/54\.2% <span class="rate-inline">\(41\.7%\)<\/span>/.test(html),
    "rate sem MPP deve aparecer em '(41.7%)' com class rate-inline");

  // Count na linha de baixo: total (sem MPP)
  assert.ok(/<small>26 \(20\)<\/small>/.test(html),
    "count deve mostrar '26 (20)' — total e (sem MPP) em parens");

  // Não deve mostrar formato antigo "X + Y MPP"
  assert.ok(!/\+\s*\d+\s*MPP/.test(html), "não deve usar mais o formato 'N + N MPP'");
});

test("renderDashboardHtml fallback pra campaignStats[0] quando globalStats ausente", () => {
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      // sem globalStats — simula falha do fetch individual
      campaignStats: [{
        listId: 9,
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 2,
        deferred: 0,
        uniqueViews: 18,
        viewed: 19,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
      }],
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Sem globalStats → cai pro campaignStats. Deve mostrar 18.
  assert.ok(html.includes("18"), "fallback deve mostrar uniqueViews=18 do campaignStats[0]");

  // Open rate 18/48 = 37.5%
  assert.ok(html.includes("37.5%"), "open rate fallback deveria ser 37.5%");

  // Sem MPP no data row no fallback. "· N MPP" só aparece na célula do row.
  // (A palavra "MPP" aparece em texto explicativo do header — não conta.)
  assert.ok(!/\+\s*\d+\s*MPP/.test(html), "fallback não deve ter anotação '+ N MPP' na célula");
});

test("renderDashboardHtml detecta globalStats zeroed e cai pra campaignStats (#1148 defense-in-depth)", () => {
  // Cenário real verificado 2026-05-12: o listing /v3/emailCampaigns
  // retorna `globalStats: { sent: 0, delivered: 0, ... }` (zeroed, não
  // undefined) pra TODAS as campaigns. fetchRecentCampaigns filtra esse
  // caso. Mas se zeroed escapar pro render (regressão futura, race
  // condition, etc), o render trata `sent=0` como "stats indisponível"
  // e cai pro campaignStats[0]. Sem isso, dashboard mostra todos zeros
  // pra campaigns onde o GET individual falhou — exatamente o bug
  // identificado no review do PR.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 0,
        delivered: 0,
        hardBounces: 0,
        softBounces: 0,
        uniqueViews: 0,
        viewed: 0,
        trackableViews: 0,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
        appleMppOpens: 0,
      },
      campaignStats: [{
        listId: 9,
        sent: 50,
        delivered: 48,
        hardBounces: 0,
        softBounces: 2,
        deferred: 0,
        uniqueViews: 18,
        viewed: 19,
        trackableViews: 14,
        uniqueClicks: 0,
        clickers: 0,
        unsubscriptions: 0,
        complaints: 0,
      }],
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Render deve usar campaignStats[0] (18 opens, 37.5%), NÃO o zeroed globalStats.
  assert.ok(html.includes("18"), "deveria mostrar uniqueViews=18 do campaignStats (não zeros do globalStats fake)");
  assert.ok(html.includes("37.5%"), "deveria mostrar open rate 37.5% do campaignStats");

  // Sem anotação MPP — campaignStats não tem o campo, e o gsIsReal detectou
  // que globalStats é fake.
  assert.ok(!/\+\s*\d+\s*MPP/.test(html), "não deve anotar MPP quando o globalStats é fake (sent=0)");
});

test("renderDashboardHtml não mostra 'X subs' na coluna Lista", () => {
  // Pedido editorial: coluna Lista mostra só o nome, sem subscriber count
  // (informação redundante — listSize já implícito no Sent).
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 26, viewed: 34, trackableViews: 14,
        uniqueClicks: 0, clickers: 0, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 6,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  assert.ok(!/\d+\s+subs/.test(html), "não deve mostrar 'N subs' em nenhum lugar do HTML");
});

test("renderDashboardHtml: layout SEM MPP é simples — taxa única + count único, sem parens redundantes", () => {
  // Quando appleMppOpens=0, não tem sentido mostrar "20 (20)" ou "X% (X%)".
  // Layout simples: só "X%" no top e só "20" no bottom.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 20, viewed: 22, trackableViews: 20,
        uniqueClicks: 0, clickers: 0, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 0,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Taxa única no topo (20/48 = 41.7%), sem span rate-inline pra parens
  assert.ok(html.includes("41.7%"), "deveria mostrar 41.7% (20/48)");
  assert.ok(!/<span class="rate-inline">/.test(html),
    "não deve ter span rate-inline (usado pra parens) quando appleMppOpens=0");

  // Count único embaixo (20), sem parens
  assert.ok(/<small>20<\/small>/.test(html), "count deve ser '20' puro, sem parens");
  assert.ok(!/<small>20 \(20\)<\/small>/.test(html),
    "não deve mostrar '20 (20)' — redundante quando appleMppOpens=0");

  // Nenhuma anotação MPP no row
  assert.ok(!/\+\s*\d+\s*MPP/.test(html), "não deve ter '+ N MPP' quando appleMppOpens=0");
});

test("renderDashboardHtml: coluna chama-se 'Spam' (não 'Compl.')", () => {
  // A coluna foi renomeada de "Compl." pra "Spam" — mais direto.
  // Se alguém regredir pra abreviação, este teste pega.
  const campaigns = [{
    ...baseCampaign,
    statistics: {
      globalStats: {
        sent: 50, delivered: 48, hardBounces: 0, softBounces: 2,
        uniqueViews: 26, viewed: 34, trackableViews: 14,
        uniqueClicks: 0, clickers: 0, unsubscriptions: 0,
        complaints: 0, appleMppOpens: 6,
      },
    },
  }];

  const html = renderDashboardHtml(campaigns);

  // Header da última coluna deve dizer "Spam"
  assert.ok(/>Spam<\/th>/.test(html), "última coluna deve ser 'Spam'");
  // E não pode ter o antigo "Compl."
  assert.ok(!/>Compl\.</.test(html), "não deve ter mais o header antigo 'Compl.'");
});
