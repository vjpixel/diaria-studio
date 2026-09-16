/**
 * test/brevo-monthly-totals-archive-8115.test.ts
 *
 * Regressão do RESÍDUO do #8115 (commit 171ab9a0 implementou medição +
 * paginação + backfill throttled/resumável, mas deixou "REFS #8115, NÃO
 * CLOSES — falta integrar o resultado no render de Totais por mês"). Cobre
 * a integração:
 *
 *   (A) `loadMonthlyTotalsArchive` (brevo-api.ts) — reconstrói campanhas
 *       históricas a partir de `CAMPAIGNS_ARCHIVE_INDEX_KV_KEY` + `stats:{id}`,
 *       ZERO chamadas de rede (só leitura de KV mockado).
 *   (B) `renderDashboardHtml`/`aggregateByMonth` — o mês arquivado (fora da
 *       janela ao vivo) volta a aparecer em "Totais por mês", e o rótulo
 *       "(parcial)" só continua aparecendo quando o backfill AINDA NÃO
 *       terminou (`backfillIncomplete: true`) — desaparece quando o backfill
 *       alcançou o início do histórico (`backfillIncomplete: false`), mesmo
 *       com a janela ao vivo cheia. Sem `opts.monthlyArchive` (call site
 *       pré-#8115), o comportamento é idêntico ao anterior (regressão).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadMonthlyTotalsArchive,
  CAMPAIGNS_ARCHIVE_INDEX_KV_KEY,
  CAMPAIGNS_BACKFILL_CURSOR_KV_KEY,
  type ArchivedCampaignMeta,
} from "../workers/brevo-dashboard/src/brevo-api.ts";
import { renderDashboardHtml } from "../workers/brevo-dashboard/src/sections-core.ts";
import type { BrevoGlobalStats, BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

// ─── helpers (mesmo padrão de test/brevo-campaigns-backfill-8115.test.ts) ──

function makeKvMock(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  return {
    store,
    kv: {
      get: async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const fakeGs: BrevoGlobalStats = {
  sent: 200,
  delivered: 190,
  hardBounces: 3,
  softBounces: 1,
  uniqueViews: 60,
  viewed: 65,
  trackableViews: 50,
  uniqueClicks: 12,
  clickers: 10,
  unsubscriptions: 1,
  complaints: 0,
  appleMppOpens: 4,
};

function makeArchiveMeta(id: number, sentDate: string): ArchivedCampaignMeta {
  return { id, name: `Campanha ${id}`, sentDate, listIds: [9] };
}

function makeWindowCampaign(id: number, sentDate: string): BrevoCampaign {
  return {
    id,
    name: `Campanha ${id}`,
    subject: "s",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [9] },
    statistics: { globalStats: fakeGs },
  };
}

// ─── (A) loadMonthlyTotalsArchive ──────────────────────────────────────────

describe("#8115 — loadMonthlyTotalsArchive", () => {
  test("sem archive/cursor gravados (backfill nunca rodou) — campaigns vazio, backfillIncomplete=true, knownOffset=100 (default)", async () => {
    const { kv } = makeKvMock();
    const result = await loadMonthlyTotalsArchive({ STATS_CACHE: kv });
    assert.deepEqual(result.campaigns, []);
    assert.equal(result.backfillIncomplete, true);
    assert.equal(result.knownOffset, 100);
  });

  test("env.STATS_CACHE ausente (fail-soft) — nunca lança, mesmo resultado do KV vazio", async () => {
    const result = await loadMonthlyTotalsArchive({ STATS_CACHE: undefined as unknown as never });
    assert.deepEqual(result.campaigns, []);
    assert.equal(result.backfillIncomplete, true);
  });

  test("archive com 2 entradas, só 1 com stats:{id} cacheado — só a com stats entra em campaigns", async () => {
    const { kv } = makeKvMock({
      [CAMPAIGNS_ARCHIVE_INDEX_KV_KEY]: [
        makeArchiveMeta(501, "2026-07-15T09:00:00Z"),
        makeArchiveMeta(502, "2026-07-20T09:00:00Z"), // sem stats:502 no KV
      ],
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: { offset: 130, totalCount: 500, done: false, updatedAt: "2026-09-14T00:00:00Z" },
      "stats:501": { gs: fakeGs },
    });
    const result = await loadMonthlyTotalsArchive({ STATS_CACHE: kv });
    assert.equal(result.campaigns.length, 1, "só a campanha 501 (com stats) deve entrar");
    assert.equal(result.campaigns[0].id, 501);
    assert.deepEqual(result.campaigns[0].statistics?.globalStats, fakeGs);
    assert.equal(result.campaigns[0].sentDate, "2026-07-15T09:00:00Z");
    assert.equal(result.backfillIncomplete, true);
    assert.equal(result.knownOffset, 130);
  });

  test("cursor.done=true — backfillIncomplete=false (histórico completo conhecido)", async () => {
    const { kv } = makeKvMock({
      [CAMPAIGNS_ARCHIVE_INDEX_KV_KEY]: [makeArchiveMeta(601, "2026-06-01T09:00:00Z")],
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: { offset: 340, totalCount: 340, done: true, updatedAt: "2026-09-14T00:00:00Z" },
      "stats:601": { gs: fakeGs },
    });
    const result = await loadMonthlyTotalsArchive({ STATS_CACHE: kv });
    assert.equal(result.backfillIncomplete, false);
    assert.equal(result.campaigns.length, 1);
  });
});

// ─── (B) integração em renderDashboardHtml → "Totais por mês" ─────────────

describe("#8115 — integração no render de Totais por mês", () => {
  const windowCampaigns = [
    makeWindowCampaign(1, "2026-09-05T09:00:00Z"),
    makeWindowCampaign(2, "2026-09-10T09:00:00Z"),
  ]; // 2 campanhas na janela ao vivo — Set/2026

  const archivedCampaign = makeWindowCampaign(99, "2026-08-01T09:00:00Z"); // fora da janela — Ago/2026

  test("SEM opts.monthlyArchive (call site pré-#8115) — só o mês da janela ao vivo aparece; aviso de parcial aparece (regressão pré-#8115 preservada)", () => {
    const html = renderDashboardHtml(
      windowCampaigns, [], null, null, null, null, null, null, null,
      2, // campaignsWindowLimit — janela CHEIA (2 campanhas, limite 2)
      null,
      {}, // sem monthlyArchive
    );
    assert.match(html, /Set\/2026/, "mês da janela ao vivo deve aparecer");
    assert.doesNotMatch(html, /Ago\/2026/, "mês arquivado não deve aparecer sem opts.monthlyArchive");
    assert.match(html, /\(parcial — janela de 2 campanhas\)/, "aviso de parcial preservado quando não há dado de backfill");
  });

  test("COM opts.monthlyArchive (backfillIncomplete=true) — mês arquivado aparece, aviso de parcial segue no mês mais antigo com o knownOffset como N", () => {
    const html = renderDashboardHtml(
      windowCampaigns, [], null, null, null, null, null, null, null,
      2,
      null,
      {
        monthlyArchive: { campaigns: [archivedCampaign], backfillIncomplete: true, knownOffset: 140 },
      },
    );
    assert.match(html, /Set\/2026/, "mês da janela ao vivo deve aparecer");
    assert.match(html, /Ago\/2026/, "mês arquivado (backfill) deve aparecer agora");
    // aviso deve estar preso à linha do mês mais ANTIGO conhecido (Ago/2026), não a Set/2026
    const idx = html.indexOf("Ago/2026");
    assert.ok(idx >= 0);
    const afterAgo = html.slice(idx, idx + 400);
    assert.match(afterAgo, /parcial — janela de 140 campanhas/, "N do aviso deve refletir knownOffset (maior que campaignsWindowLimit)");
    const idxSet = html.indexOf("Set/2026");
    const afterSet = html.slice(idxSet, idxSet + 400);
    assert.doesNotMatch(afterSet, /parcial — janela de/, "aviso não deve grudar no mês mais recente");
  });

  test("COM opts.monthlyArchive (backfillIncomplete=false) — mês arquivado aparece, aviso de parcial DESAPARECE mesmo com janela ao vivo cheia", () => {
    const html = renderDashboardHtml(
      windowCampaigns, [], null, null, null, null, null, null, null,
      2, // janela ao vivo CHEIA
      null,
      {
        monthlyArchive: { campaigns: [archivedCampaign], backfillIncomplete: false, knownOffset: 340 },
      },
    );
    assert.match(html, /Ago\/2026/, "mês arquivado deve aparecer");
    assert.doesNotMatch(html, /parcial — janela de/, "backfill completo (done) — nunca mais mostra o aviso, mesmo com janela cheia");
  });

  test("monthlyArchive.campaigns vazio (backfill nunca achou nada além da janela, ex: conta nova) — comportamento idêntico a não ter monthlyArchive, mas respeita backfillIncomplete", () => {
    const html = renderDashboardHtml(
      windowCampaigns, [], null, null, null, null, null, null, null,
      2,
      null,
      { monthlyArchive: { campaigns: [], backfillIncomplete: false, knownOffset: 2 } },
    );
    assert.doesNotMatch(html, /Ago\/2026/, "sem campanhas arquivadas, nada novo aparece");
    assert.doesNotMatch(html, /parcial — janela de/, "backfill já confirmado 'done' suprime o aviso mesmo sem histórico extra");
  });
});
