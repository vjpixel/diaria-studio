/**
 * test/brevo-dashboard-3092-a11y.test.ts (#3092 grab-bag — ARIA/acessibilidade)
 *
 * Regressão (#633) para o bloco ARIA da issue #3092:
 *  - `<th>` sem `scope="col"` em toda a dashboard (leitor de tela não associa
 *    a célula de dado à coluna correta em tabelas largas/roláveis).
 *  - `.spark-bar` (barra de progresso ASCII "████░░░") sem `aria-hidden="true"`
 *    — leitor de tela lia os blocos literalmente; a % já está no texto ao lado.
 *  - Emoji semafórico (🟢/🟡) como ÚNICO diferenciador entre 2 headers com o
 *    mesmo rótulo textual ("Alvo 🟢" / "Alvo 🟡") — sem `role="img"` +
 *    `aria-label`, um leitor de tela que pula emoji anuncia "Alvo"/"Alvo" (as
 *    2 colunas soam idênticas).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml, renderWeeklyPlanTabPanel, renderVolumeSection, billingCycleWindow } from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

// ---------------------------------------------------------------------------
// th scope="col"
// ---------------------------------------------------------------------------

test("#3092: nenhum <th> da dashboard (render vazio) fica sem scope=\"col\"", () => {
  const html = renderDashboardHtml([]);
  // Remove o <style> antes de escanear — comentários de código dentro do CSS
  // (ex: "tratamento tipo <th>") mencionam a tag em prosa, não são elementos
  // reais; escaná-los geraria falso-positivo.
  const bodyOnly = html.replace(/<style>[\s\S]*?<\/style>/, "");
  const allTh = bodyOnly.match(/<th\b[^>]*>/g) ?? [];
  assert.ok(allTh.length > 0, "sanity: deve haver pelo menos um <th> no render");
  for (const th of allTh) {
    assert.match(th, /scope="col"/, `<th> sem scope="col": ${th}`);
  }
});

test("#3092: <th> da tabela 'Alvo' (aba Agendamento) tem scope=\"col\"", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const camp: BrevoCampaign = {
    id: 1,
    name: "Clarice News 2607 d05",
    subject: "s",
    status: "sent",
    sentDate: new Date(now.getTime() - 60 * 60 * 60 * 1000).toISOString(),
    scheduledAt: null,
    createdAt: now.toISOString(),
    recipients: { lists: [1] },
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990, hardBounces: 2, softBounces: 2,
        uniqueViews: 270, viewed: 270, trackableViews: 270,
        uniqueClicks: 10, clickers: 10, unsubscriptions: 5, complaints: 0, appleMppOpens: 0,
      },
    },
  } as unknown as BrevoCampaign;
  const html = renderWeeklyPlanTabPanel([camp], now);
  const allTh = html.match(/<th\b[^>]*>/g) ?? [];
  assert.ok(allTh.length > 0);
  for (const th of allTh) {
    assert.match(th, /scope="col"/, `<th> sem scope="col": ${th}`);
  }
});

// ---------------------------------------------------------------------------
// spark-bar aria-hidden
// ---------------------------------------------------------------------------

test("#3092: .spark-bar (barra ASCII de progresso) tem aria-hidden=\"true\"", () => {
  const window = billingCycleWindow(new Date("2026-06-15T12:00:00Z"));
  const html = renderVolumeSection(5292, window, 34708);
  assert.match(html, /class="spark-bar"/, "sanity: barra deve estar presente com planCredits > 0");
  assert.match(html, /<span class="spark-bar" aria-hidden="true"/, 'spark-bar deve ter aria-hidden="true" — leitor de tela não deve ler "████░░░" literalmente (a % já está no texto ao lado)');
});

// ---------------------------------------------------------------------------
// emoji semafórico — role="img" + aria-label
// ---------------------------------------------------------------------------

test("#3092: header 'Alvo 🟢'/'Alvo 🟡' usa role=\"img\" + aria-label (emoji não é único diferenciador silencioso)", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const camp: BrevoCampaign = {
    id: 1,
    name: "Clarice News 2607 d05",
    subject: "s",
    status: "sent",
    sentDate: new Date(now.getTime() - 60 * 60 * 60 * 1000).toISOString(),
    scheduledAt: null,
    createdAt: now.toISOString(),
    recipients: { lists: [1] },
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990, hardBounces: 2, softBounces: 2,
        uniqueViews: 270, viewed: 270, trackableViews: 270,
        uniqueClicks: 10, clickers: 10, unsubscriptions: 5, complaints: 0, appleMppOpens: 0,
      },
    },
  } as unknown as BrevoCampaign;
  const html = renderWeeklyPlanTabPanel([camp], now);
  assert.match(html, /Alvo <span role="img" aria-label="verde">🟢<\/span>/);
  assert.match(html, /Alvo <span role="img" aria-label="amarelo">🟡<\/span>/);
});
