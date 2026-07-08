/**
 * test/brevo-dashboard-3092-consistency.test.ts (#3092 grab-bag — consistência/estilos)
 *
 * Regressão (#633) para o bloco de consistência da issue #3092:
 *  - `loginPage()` (workers/brevo-dashboard/src/index.ts) usava cores
 *    Cloudflare hardcoded (#f6821f/#f5f6f7/#dc2626) que nenhuma outra
 *    superfície do dashboard usa — trocado por tokens do DS
 *    (DS.brand/DS.paper/DS.alert/DS_FONTS.sans).
 *  - `tr` de totalização (tfoot de Coortes, Total de 3 envios na aba
 *    Agendamento) reimplementava `.total-row` via style inline em vez de usar
 *    a classe já existente.
 *  - Tabela MillionVerifier (bucket): chave vazia `""` no mapa `mv` (estado
 *    real e distinto de NULL, ver scripts/lib/clarice-db.ts) renderizava
 *    linha com rótulo em branco — agora mapeada para rótulo explícito.
 *  - Notas de Cupons usavam `style="opacity:0.6;font-size:13px"` inline em
 *    vez de `.section-note`, e vazavam número de issue interna (#2750) pro
 *    editor no texto visível.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loginPage } from "../workers/brevo-dashboard/src/index.ts";
import {
  DS,
  DS_FONTS,
  renderContactsSummarySection,
  renderEngagementCohortsSection,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";
import { renderWeeklyPlanTabPanel } from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

// ---------------------------------------------------------------------------
// loginPage() usa tokens do DS, não cores Cloudflare hardcoded
// ---------------------------------------------------------------------------

test("#3092: loginPage() não usa mais as cores Cloudflare hardcoded (#f6821f/#f5f6f7/#dc2626)", async () => {
  const html = await loginPage().text();
  assert.doesNotMatch(html, /#f6821f/i, "laranja Cloudflare não deve mais aparecer");
  assert.doesNotMatch(html, /#f5f6f7/i, "cinza Cloudflare não deve mais aparecer");
  assert.doesNotMatch(html, /#dc2626/i, "vermelho Cloudflare não deve mais aparecer");
});

test("#3092: loginPage() usa DS.brand/DS.paper/DS.alert/DS_FONTS.sans", async () => {
  const html = await loginPage().text();
  assert.match(html, new RegExp(DS.brand), "DS.brand deve aparecer (botão/foco)");
  assert.match(html, new RegExp(DS.paper), "DS.paper deve aparecer (fundo da página)");
  assert.match(html, new RegExp(DS.alert), "DS.alert deve aparecer (mensagem de erro)");
  assert.ok(html.includes(DS_FONTS.sans), "DS_FONTS.sans deve aparecer (font-family)");
});

// ---------------------------------------------------------------------------
// total-row via classe, não style inline duplicado
// ---------------------------------------------------------------------------

test("#3092: tfoot de Coortes de engajamento usa class=\"total-row\", não style inline duplicado", () => {
  const cohorts = {
    generatedAt: "2026-07-08T12:00:00Z",
    universe: 100,
    opened2plus: 20,
    opened1: 20,
    received1_opened0: 20,
    received2_opened0: 20,
    exits: 20,
    exitsBreakdown: { bounced: 10, optedOut: 10 },
  };
  const html = renderEngagementCohortsSection(cohorts as any, new Date("2026-07-08T12:00:00Z"));
  assert.match(html, /<tr class="total-row">/, "linha Total deve usar class=\"total-row\"");
  assert.doesNotMatch(html, /<tr style="font-weight:700;border-top:2px solid var\(--rule\)/, "não deve mais reimplementar total-row via style inline");
});

test("#3092: 'Total (3 envios)' na aba Agendamento usa class=\"total-row\", não style inline duplicado", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const campaigns: BrevoCampaign[] = [];
  for (let i = 0; i < 11; i++) {
    const daysAgo = 3 + i;
    campaigns.push({
      id: 100 + i,
      name: `Clarice News 2607 d${String(i + 1).padStart(2, "0")}`,
      subject: "s",
      status: "sent",
      sentDate: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
      scheduledAt: null,
      createdAt: now.toISOString(),
      recipients: { lists: [1] },
      statistics: {
        globalStats: {
          sent: 1000, delivered: 990, hardBounces: 0, softBounces: 0,
          uniqueViews: 270, viewed: 270, trackableViews: 270,
          uniqueClicks: 10, clickers: 10, unsubscriptions: 5, complaints: 0, appleMppOpens: 0,
        },
      },
    } as unknown as BrevoCampaign);
  }
  const html = renderWeeklyPlanTabPanel(campaigns, now);
  assert.match(html, /<tr class="total-row"><td>Total \(3 envios\)<\/td>/, "linha Total (3 envios) deve usar class=\"total-row\"");
  assert.doesNotMatch(html, /<tr style="font-weight:700;border-top:2px solid var\(--rule\)"><td>Total \(3 envios\)/, "não deve mais reimplementar total-row via style inline");
});

// ---------------------------------------------------------------------------
// MillionVerifier (bucket): chave vazia "" mapeada pra rótulo explícito
// ---------------------------------------------------------------------------

const sample: ContactsSummary = {
  generated_at: "2026-06-29T12:00:00Z",
  total: 100,
  brevo: { synced_rows: 50, has_signal: true },
  eligibility: { eligible: 90, ineligible: 10, by_reason: {} },
  priority_points: { lt0: 0, eq0: 100, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 },
  mv: { verified: 40, none: 30, "": 30 },
  engagement: { with_opens: 0, with_clicks: 0 },
};

test("#3092: mv[\"\"] (chave vazia — estado real, distinto de NULL) NÃO renderiza rótulo em branco", () => {
  const html = renderContactsSummarySection(sample);
  assert.doesNotMatch(html, /<td><\/td>/, "nenhuma célula da tabela deve ficar com rótulo vazio");
  assert.match(html, /não verificado \(sem bucket\)/, "chave vazia deve virar rótulo explícito");
});

test("#3092: kvTable sem emptyKeyLabel (ex: 'Inelegíveis por razão') preserva comportamento anterior — chave vazia não quebra", () => {
  const withEmptyReason: ContactsSummary = {
    ...sample,
    eligibility: { eligible: 90, ineligible: 10, by_reason: { "": 5, dispute: 5 } },
  };
  assert.doesNotThrow(() => renderContactsSummarySection(withEmptyReason));
});
