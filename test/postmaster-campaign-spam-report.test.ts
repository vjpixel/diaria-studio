/**
 * test/postmaster-campaign-spam-report.test.ts (#4704 — spam POR CAMPANHA)
 *
 * Cobre as funções puras/injetáveis de scripts/postmaster-campaign-spam-report.ts
 * (`enrichWithCampaignMetadata`, `formatCampaignSpamReport`) — sem rede real
 * (nem Postmaster nem Brevo). `main()`/as chamadas de I/O (`queryDomainStatsV2`,
 * `brevoGetCampaign`) não são exercitadas aqui — cobertas indiretamente pelos
 * testes de `postmaster-v2-client.test.ts` e `brevo-client` (mesmo padrão de
 * `postmaster-spam-sync.test.ts`, que também só testa as funções puras do
 * script irmão).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enrichWithCampaignMetadata,
  formatCampaignSpamReport,
  type CampaignSpamReportRow,
} from "../scripts/postmaster-campaign-spam-report.ts";
import type { CampaignSpamAggregate } from "../scripts/lib/postmaster-campaign-spam.ts";

function agg(overrides: Partial<CampaignSpamAggregate> = {}): CampaignSpamAggregate {
  return {
    campaignId: 107,
    feedbackLoopId: "11130585_107",
    avgSpamRatePct: 0.463,
    peakSpamRatePct: 1.39,
    peakDate: "2026-08-02",
    daysWithData: 3,
    dailyReadings: [
      { date: "2026-08-01", spamRatePct: 0 },
      { date: "2026-08-02", spamRatePct: 1.39 },
      { date: "2026-08-03", spamRatePct: 0 },
    ],
    ...overrides,
  };
}

// ── enrichWithCampaignMetadata ──

test("enrichWithCampaignMetadata — resolveMetadata null (sem Brevo key) devolve as linhas sem name/subject", async () => {
  const rows = await enrichWithCampaignMetadata([agg()], null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].campaignName, undefined);
  assert.equal(rows[0].campaignSubject, undefined);
  assert.equal(rows[0].campaignId, 107); // resto do agregado preservado
});

test("enrichWithCampaignMetadata — resolveMetadata bem-sucedido popula name/subject", async () => {
  const rows = await enrichWithCampaignMetadata([agg()], async () => ({ name: "Variante C", subject: "Assunto C" }));
  assert.equal(rows[0].campaignName, "Variante C");
  assert.equal(rows[0].campaignSubject, "Assunto C");
});

test("enrichWithCampaignMetadata — resolveMetadata que LANÇA numa campanha não derruba o relatório (best-effort)", async () => {
  const rows = await enrichWithCampaignMetadata(
    [agg({ campaignId: 105 }), agg({ campaignId: 107 })],
    async (id) => {
      if (id === 105) throw new Error("Brevo 404");
      return { name: "Variante C" };
    },
  );
  assert.equal(rows.length, 2, "as 2 linhas sobrevivem mesmo com falha numa delas");
  assert.equal(rows[0].campaignName, undefined, "campanha que falhou fica sem nome, não some");
  assert.equal(rows[1].campaignName, "Variante C");
});

test("enrichWithCampaignMetadata — resolveMetadata que devolve null vira linha sem name/subject", async () => {
  const rows = await enrichWithCampaignMetadata([agg()], async () => null);
  assert.equal(rows[0].campaignName, undefined);
});

// ── formatCampaignSpamReport ──

test("formatCampaignSpamReport — lista vazia produz mensagem explícita, não relatório vazio silencioso", () => {
  const out = formatCampaignSpamReport([], 10);
  assert.match(out, /Nenhuma campanha/);
  assert.match(out, /10 dias/);
});

test("formatCampaignSpamReport — inclui campaignId, pico, média e série diária", () => {
  const rows: CampaignSpamReportRow[] = [agg()];
  const out = formatCampaignSpamReport(rows, 10);
  assert.match(out, /#107/);
  assert.match(out, /1\.390%/);
  assert.match(out, /2026-08-02/);
  assert.match(out, /0\.463%/);
});

test("formatCampaignSpamReport — sem campaignName usa fallback explícito 'nome indisponível'", () => {
  const out = formatCampaignSpamReport([agg()], 10);
  assert.match(out, /nome indisponível/);
});

test("formatCampaignSpamReport — com campaignName/subject, exibe os dois", () => {
  const out = formatCampaignSpamReport([agg({ campaignId: 107 }) as CampaignSpamReportRow].map((r) => ({ ...r, campaignName: "Variante C", campaignSubject: "Assunto C" })), 10);
  assert.match(out, /Variante C/);
  assert.match(out, /Assunto C/);
});
