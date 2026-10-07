/**
 * test/clarice-monthly-coverage-9837.test.ts
 *
 * #9837 — verificação determinística de cobertura do agregado mensal do
 * painel Clarice contra a listagem da Brevo (`scripts/lib/clarice-monthly-coverage.ts`
 * + `fetchAllSentCampaigns` do CLI). Reproduz o caso real da issue: setembro
 * com as campanhas de 01–05/09 fora da janela ao vivo e fora do arquivo.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildDashboardCoverage,
  compareMonthlyCoverage,
  formatMonthlyCoverageReport,
  type CoverageCampaign,
} from "../scripts/lib/clarice-monthly-coverage.ts";
import { fetchAllSentCampaigns } from "../scripts/verify-clarice-monthly-coverage.ts";

function c(id: number, sentDate: string | null): CoverageCampaign {
  return { id, sentDate };
}

describe("#9837 — buildDashboardCoverage", () => {
  test("janela ao vivo = primeiras N da listagem; arquivo só entra com stats", () => {
    const listing = [c(5, "2026-10-05T12:00:00Z"), c(4, "2026-10-04T12:00:00Z"), c(3, "2026-10-03T12:00:00Z")];
    const archive = [c(2, "2026-09-02T12:00:00Z"), c(1, "2026-09-01T12:00:00Z")];
    const r = buildDashboardCoverage(listing, archive, new Set([2]), 2);
    assert.deepEqual(r.campaigns.map((x) => x.id), [5, 4, 2]);
    assert.deepEqual(r.archivedWithoutStats, [1]);
  });
});

describe("#9837 — compareMonthlyCoverage", () => {
  test("caso da issue: setembro sem 01–05/09 diverge em contagem, 1º envio e ids faltantes", () => {
    // Brevo: 4 em set (01/09 06:51 BRT … 30/09) + 2 em out.
    const brevo = [
      c(106, "2026-10-07T12:10:00Z"),
      c(105, "2026-10-01T12:12:00Z"),
      c(104, "2026-09-30T21:03:00Z"),
      c(103, "2026-09-06T12:00:00Z"),
      c(102, "2026-09-03T12:00:00Z"),
      c(101, "2026-09-01T09:51:00Z"),
    ];
    // Painel: janela de 4 (106..103) e arquivo vazio → 101 e 102 somem.
    const dash = buildDashboardCoverage(brevo, [], new Set(), 4);
    const r = compareMonthlyCoverage(brevo, dash.campaigns);
    assert.equal(r.ok, false);
    const set = r.rows.find((x) => x.month === "2026-09")!;
    assert.equal(set.brevoCount, 4);
    assert.equal(set.dashboardCount, 2);
    assert.equal(set.brevoFirst, "2026-09-01T09:51:00Z");
    assert.equal(set.dashboardFirst, "2026-09-06T12:00:00Z");
    assert.deepEqual(set.missingIds, [101, 102]);
    assert.equal(r.rows.find((x) => x.month === "2026-10")!.ok, true);
  });

  test("tudo coberto (janela + arquivo com stats) → ok em todos os meses", () => {
    const brevo = [c(3, "2026-10-02T12:00:00Z"), c(2, "2026-09-02T12:00:00Z"), c(1, "2026-08-02T12:00:00Z")];
    const dash = buildDashboardCoverage(brevo, [c(2, "2026-09-02T12:00:00Z"), c(1, "2026-08-02T12:00:00Z")], new Set([1, 2]), 1);
    const r = compareMonthlyCoverage(brevo, dash.campaigns);
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows.map((x) => x.month), ["2026-10", "2026-09", "2026-08"]);
  });

  test("mês é chaveado em BRT: 01/10 00:30Z é setembro (mesma regra do aggregateByMonth)", () => {
    const brevo = [c(1, "2026-10-01T00:30:00Z")];
    const r = compareMonthlyCoverage(brevo, brevo);
    assert.deepEqual(r.rows.map((x) => x.month), ["2026-09"]);
  });

  test("duplicata no painel (janela + arquivo com a mesma campanha) não passa como ok", () => {
    const brevo = [c(2, "2026-09-02T12:00:00Z"), c(1, "2026-09-01T12:00:00Z")];
    const dash = buildDashboardCoverage(brevo, [c(2, "2026-09-02T12:00:00Z"), c(1, "2026-09-01T12:00:00Z")], new Set([1, 2]), 2);
    const r = compareMonthlyCoverage(brevo, dash.campaigns);
    assert.equal(r.ok, false);
    assert.deepEqual(r.rows[0].duplicateIds, [1, 2]);
  });

  test("campanha no arquivo que não existe mais na Brevo aparece como extra", () => {
    const brevo = [c(1, "2026-09-01T12:00:00Z")];
    const r = compareMonthlyCoverage(brevo, [c(1, "2026-09-01T12:00:00Z"), c(99, "2026-09-05T12:00:00Z")]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.rows[0].extraIds, [99]);
  });

  test("listagem da Brevo com a mesma campanha em 2 páginas é deduplicada", () => {
    const brevo = [c(1, "2026-09-01T12:00:00Z"), c(1, "2026-09-01T12:00:00Z")];
    assert.equal(compareMonthlyCoverage(brevo, [c(1, "2026-09-01T12:00:00Z")]).ok, true);
  });

  test("sem sentDate fica fora dos dois lados, mas é reportada", () => {
    const r = compareMonthlyCoverage([c(1, null), c(2, "2026-09-01T12:00:00Z")], [c(2, "2026-09-01T12:00:00Z")]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.brevoWithoutMonth, [1]);
  });

  test("relatório nomeia mês divergente e ids faltantes", () => {
    const brevo = [c(2, "2026-09-02T12:00:00Z"), c(1, "2026-09-01T12:00:00Z")];
    const out = formatMonthlyCoverageReport(compareMonthlyCoverage(brevo, [c(2, "2026-09-02T12:00:00Z")]), { archivedWithoutStats: [7] });
    assert.match(out, /2026-09 .*NÃO/);
    assert.match(out, /fora do painel — ids 1/);
    assert.match(out, /sem stats:\{id\}.*7/);
    assert.match(out, /DIVERGE/);
  });
});

describe("#9837 — fetchAllSentCampaigns (paginação, só leitura)", () => {
  test("pagina de 100 em 100 até a página curta", async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ id: 230 - i, sentDate: "2026-09-01T12:00:00Z" }));
    const offsets: number[] = [];
    const fetchPage = (async (_env: unknown, opts: { limit: number; offset: number }) => {
      offsets.push(opts.offset);
      return { campaigns: all.slice(opts.offset, opts.offset + opts.limit), count: all.length };
    }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const out = await fetchAllSentCampaigns({} as any, fetchPage); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(out.length, 230);
    assert.deepEqual(offsets, [0, 100, 200]);
  });

  test("para pelo count quando a última página vem cheia", async () => {
    const all = Array.from({ length: 200 }, (_, i) => ({ id: i, sentDate: null }));
    const offsets: number[] = [];
    const fetchPage = (async (_env: unknown, opts: { limit: number; offset: number }) => {
      offsets.push(opts.offset);
      return { campaigns: all.slice(opts.offset, opts.offset + opts.limit), count: 200 };
    }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    await fetchAllSentCampaigns({} as any, fetchPage); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(offsets, [0, 100]);
  });

  test("erro da Brevo propaga (o CLI sai com 2, nunca relata ok)", async () => {
    const fetchPage = (async () => {
      throw new Error("429");
    }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    await assert.rejects(fetchAllSentCampaigns({} as any, fetchPage), /429/); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});
