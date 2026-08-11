/**
 * test/brevo-dashboard-envios-spam-postmaster-4970.test.ts (#4970)
 *
 * A coluna Spam da tabela Envios trocou de fonte: era `complaints` da Brevo
 * (subconta o spam real em ~120×, #4063/#4972, e por isso NUNCA era
 * colorida), agora é o PICO por campanha do Google Postmaster Tools v2
 * (`PostmasterSpamEntry.campaignSpam`, mapa acumulado entre execuções do
 * sync — ver `scripts/lib/postmaster-campaign-spam.ts`).
 *
 * Este arquivo cobre os 2 níveis:
 *   1. `resolveEnvioCampaignSpamCell` (workers/brevo-dashboard/src/thresholds.ts)
 *      — a função PURA que decide o estado da célula (rate/pending/unavailable).
 *   2. `renderDashboardHtml` — integração ponta a ponta (o HTML de verdade
 *      da tabela Envios reflete os 3 estados, nunca célula em branco).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEnvioCampaignSpamCell,
  ENVIO_SPAM_PENDING_WINDOW_MS,
  DEFAULT_HEALTH_THRESHOLDS,
} from "../workers/brevo-dashboard/src/thresholds.ts";
import { renderDashboardHtml } from "../workers/brevo-dashboard/src/index.ts";
import type { PostmasterCampaignSpamRecord } from "../scripts/lib/dashboard-kv-types.ts";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function mkRecord(overrides: Partial<PostmasterCampaignSpamRecord> = {}): PostmasterCampaignSpamRecord {
  return {
    campaignId: 107,
    feedbackLoopId: "11130585_107",
    avgSpamRatePct: 0.2,
    peakSpamRatePct: 0.5,
    peakDate: "2026-08-05",
    daysWithData: 3,
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

// ── resolveEnvioCampaignSpamCell (pura) ──

test("resolveEnvioCampaignSpamCell — com registro no mapa, devolve state='rate' com o PICO da campanha", () => {
  const campaignSpam = { "107": mkRecord() };
  const cell = resolveEnvioCampaignSpamCell(107, "2026-08-05T09:00:00.000Z", campaignSpam, NOW);
  assert.equal(cell.state, "rate");
  assert.equal(cell.ratePct, 0.5);
  assert.equal(cell.daysWithData, 3);
  assert.equal(cell.peakDate, "2026-08-05");
});

test("resolveEnvioCampaignSpamCell — busca pela chave String(campaignId), não pelo feedbackLoopId", () => {
  const campaignSpam = { "107": mkRecord({ campaignId: 107 }) };
  // campaignId numérico 107 deve casar com a chave "107" — não com o
  // feedbackLoopId "11130585_107".
  const cell = resolveEnvioCampaignSpamCell(107, null, campaignSpam, NOW);
  assert.equal(cell.state, "rate");
});

test("resolveEnvioCampaignSpamCell — ratePct abaixo do threshold.yellow não é breach (sem alerta)", () => {
  const campaignSpam = { "107": mkRecord({ peakSpamRatePct: 0.05 }) };
  const cell = resolveEnvioCampaignSpamCell(107, null, campaignSpam, NOW);
  assert.equal(cell.breach, false);
});

test("resolveEnvioCampaignSpamCell — ratePct >= threshold.yellow (0.3%) é breach (alerta)", () => {
  const campaignSpam = { "107": mkRecord({ peakSpamRatePct: 0.3 }) };
  const cell = resolveEnvioCampaignSpamCell(107, null, campaignSpam, NOW, DEFAULT_HEALTH_THRESHOLDS);
  assert.equal(cell.breach, true, "0.3% é o boundary exato (>=), deve acionar breach");
});

test("resolveEnvioCampaignSpamCell — sem registro e campanha DENTRO da janela de pending (< ENVIO_SPAM_PENDING_WINDOW_MS) → state='pending'", () => {
  const recentIso = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 dias atrás
  const cell = resolveEnvioCampaignSpamCell(999, recentIso, null, NOW);
  assert.equal(cell.state, "pending");
  assert.equal(cell.breach, false);
  assert.equal(cell.ratePct, undefined);
});

test("resolveEnvioCampaignSpamCell — sem registro e campanha FORA da janela de pending → state='unavailable'", () => {
  const oldIso = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 dias atrás
  const cell = resolveEnvioCampaignSpamCell(999, oldIso, null, NOW);
  assert.equal(cell.state, "unavailable");
  assert.equal(cell.breach, false);
});

test("resolveEnvioCampaignSpamCell — boundary exato da janela de pending (ENVIO_SPAM_PENDING_WINDOW_MS - 1ms ainda é pending)", () => {
  const boundaryIso = new Date(NOW.getTime() - (ENVIO_SPAM_PENDING_WINDOW_MS - 1)).toISOString();
  const cell = resolveEnvioCampaignSpamCell(999, boundaryIso, null, NOW);
  assert.equal(cell.state, "pending");
});

test("resolveEnvioCampaignSpamCell — sem registro, sem data confiável (null/não-parseável) → state='unavailable' (nunca assume pending sem data)", () => {
  assert.equal(resolveEnvioCampaignSpamCell(999, null, null, NOW).state, "unavailable");
  assert.equal(resolveEnvioCampaignSpamCell(999, "data-invalida", null, NOW).state, "unavailable");
});

test("resolveEnvioCampaignSpamCell — campaignSpam null/undefined (entry pré-#4970) nunca lança, degrada pra pending/unavailable normalmente", () => {
  const recentIso = new Date(NOW.getTime() - 1000).toISOString();
  assert.equal(resolveEnvioCampaignSpamCell(999, recentIso, null, NOW).state, "pending");
  assert.equal(resolveEnvioCampaignSpamCell(999, recentIso, undefined, NOW).state, "pending");
});

// ── renderDashboardHtml (integração) ──

const baseCampaign = {
  id: 107,
  name: "Clarice News 2608 d05",
  subject: "Test subject",
  status: "sent",
  scheduledAt: null,
  createdAt: "2026-08-05T09:00:00Z",
  recipients: { lists: [9] },
  listName: "T1-W1 (top 50)",
  listSize: 50,
  statistics: {
    globalStats: {
      sent: 1000, delivered: 990, hardBounces: 0, softBounces: 0,
      uniqueViews: 300, viewed: 300, trackableViews: 200,
      uniqueClicks: 20, clickers: 20, unsubscriptions: 0,
      complaints: 0, appleMppOpens: 10,
    },
  },
};

function renderWithPostmasterSpam(campaigns: unknown[], postmasterSpam: unknown) {
  return renderDashboardHtml(
    campaigns as never,
    [],
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    postmasterSpam as never,
  );
}

test("renderDashboardHtml: com registro em campaignSpam, célula Spam mostra o PICO e NÃO tem class alert quando abaixo do threshold", () => {
  const campaigns = [{ ...baseCampaign, sentDate: "2026-08-05T09:00:00Z" }];
  const postmasterSpam = {
    date: "2026-08-05",
    spamRatePct: 0.1,
    recordedAt: NOW.toISOString(),
    campaignSpam: { "107": mkRecord({ peakSpamRatePct: 0.05 }) },
  };
  const html = renderWithPostmasterSpam(campaigns, postmasterSpam);
  assert.ok(/<td>0\.050%<br><small>3d · pico 2026-08-05<\/small><\/td>/.test(html),
    "célula Spam deve mostrar o pico '0.050%' + cobertura, sem class alert");
});

test("renderDashboardHtml: com registro em campaignSpam ACIMA do threshold, célula Spam ganha class alert (#4970 — coluna agora É colorida)", () => {
  const campaigns = [{ ...baseCampaign, sentDate: "2026-08-05T09:00:00Z" }];
  const postmasterSpam = {
    date: "2026-08-05",
    spamRatePct: 0.1,
    recordedAt: NOW.toISOString(),
    campaignSpam: { "107": mkRecord({ peakSpamRatePct: 1.39 }) },
  };
  const html = renderWithPostmasterSpam(campaigns, postmasterSpam);
  assert.ok(/<td class="alert">1\.390%<br><small>3d · pico 2026-08-05<\/small><\/td>/.test(html),
    "célula Spam deve ganhar class alert quando o pico cruza 0,3%");
});

test("renderDashboardHtml: campanha recente sem registro em campaignSpam mostra 'Aguardando publicação' (nunca célula em branco)", () => {
  const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 dia atrás
  const campaigns = [{ ...baseCampaign, id: 999, sentDate: recentIso }];
  const html = renderWithPostmasterSpam(campaigns, null);
  assert.ok(/<td style="[^"]*">Aguardando publicação<\/td>/.test(html),
    "campanha enviada há 1 dia sem dado no Postmaster deve mostrar 'Aguardando publicação'");
});

test("renderDashboardHtml: campanha antiga sem registro em campaignSpam mostra 'Sem dado atribuível' (nunca 0% inventado)", () => {
  const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 dias atrás
  const campaigns = [{ ...baseCampaign, id: 999, sentDate: oldIso }];
  const html = renderWithPostmasterSpam(campaigns, null);
  assert.ok(/<td style="[^"]*">Sem dado atribuível<\/td>/.test(html),
    "campanha antiga sem dado atribuível deve mostrar 'Sem dado atribuível', nunca 0%");
  assert.ok(!/<td>0\.000%/.test(html), "nunca deve inventar '0.000%' pra ausência de dado");
});

test("renderDashboardHtml: header/glossário da coluna Spam refletem a fonte nova (#4970) — não menciona mais 'complaints'/'~50×'", () => {
  const campaigns = [{ ...baseCampaign, sentDate: "2026-08-05T09:00:00Z" }];
  const html = renderWithPostmasterSpam(campaigns, null);
  assert.ok(!/subconta o spam real em ~50×/.test(html), "referência desatualizada '~50×' não deve mais aparecer");
  assert.ok(/Postmaster Tools v2/.test(html), "tooltip/glossário deve mencionar a nova fonte (Postmaster v2)");
});
