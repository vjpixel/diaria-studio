/**
 * clarice-engagement-cohorts-v2.test.ts (#4451 Fase 1)
 *
 * Testes PUROS, sem rede (#633) — cobrem só a Fase 1 do redesenho:
 *   - csvRowToFlags: linha do CSV de exportRecipients → flags per-campanha.
 *   - buildCampaignCache / aggregateCampaignCaches: agregação por email,
 *     inclusive across-campaign (2 campanhas diferentes acumulam).
 *   - getOrFetchCampaignCache: cache existente NUNCA dispara novo
 *     exportRecipients (mock do client, assert 0 chamadas).
 *   - computeCohorts (import direto de clarice-engagement-cohorts.ts): sem
 *     regressão — mesmo comportamento de hoje, alimentado pelo agregado v2.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  csvRowToFlags,
  normalizeEmail,
  buildCampaignCache,
  aggregateCampaignCaches,
  getOrFetchCampaignCache,
  pollExportUntilDone,
  buildCohortsV2,
  campaignCachePath,
  type CampaignExportClient,
  type CampaignCache,
  type SentCampaignRef,
} from "../scripts/clarice-engagement-cohorts-v2.ts";
import { computeCohorts } from "../scripts/clarice-engagement-cohorts.ts";

const GEN = "2026-08-02T00:00:00.000Z";

// ─── csvRowToFlags ────────────────────────────────────────────────────────

test("csvRowToFlags: Delivered_Date preenchido → delivered=true", () => {
  const f = csvRowToFlags({ Email_ID: "a@x.com", Delivered_Date: "2026-07-01 10:00:00" });
  assert.equal(f.delivered, true);
});

test("csvRowToFlags: Delivered_Date vazio/ausente → delivered=false", () => {
  assert.equal(csvRowToFlags({ Email_ID: "a@x.com", Delivered_Date: "" }).delivered, false);
  assert.equal(csvRowToFlags({ Email_ID: "a@x.com" }).delivered, false);
});

test("csvRowToFlags: Total Opens > 0 → opened=true; 0 ou ausente → opened=false", () => {
  assert.equal(csvRowToFlags({ "Total Opens": "3" }).opened, true);
  assert.equal(csvRowToFlags({ "Total Opens": "1" }).opened, true);
  assert.equal(csvRowToFlags({ "Total Opens": "0" }).opened, false);
  assert.equal(csvRowToFlags({}).opened, false);
});

test("csvRowToFlags: Hard_Bounce_Date OU Soft_Bounce_Date preenchido → bounced=true", () => {
  assert.equal(csvRowToFlags({ Hard_Bounce_Date: "2026-07-01" }).bounced, true);
  assert.equal(csvRowToFlags({ Soft_Bounce_Date: "2026-07-01" }).bounced, true);
  assert.equal(csvRowToFlags({ Hard_Bounce_Date: "", Soft_Bounce_Date: "" }).bounced, false);
});

test("csvRowToFlags: Unsubscribe_Date preenchido → unsubscribed=true", () => {
  assert.equal(csvRowToFlags({ Unsubscribe_Date: "2026-07-01" }).unsubscribed, true);
  assert.equal(csvRowToFlags({ Unsubscribe_Date: "" }).unsubscribed, false);
});

test("csvRowToFlags: linha 'limpa' (entregue, sem abertura, sem saída)", () => {
  const f = csvRowToFlags({ Email_ID: "a@x.com", Delivered_Date: "2026-07-01", "Total Opens": "0" });
  assert.deepEqual(f, { delivered: true, opened: false, bounced: false, unsubscribed: false });
});

// ─── normalizeEmail ───────────────────────────────────────────────────────

test("normalizeEmail: trim + lowercase; ausente vira string vazia", () => {
  assert.equal(normalizeEmail("  A@X.COM  "), "a@x.com");
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(normalizeEmail(null), "");
});

// ─── buildCampaignCache ───────────────────────────────────────────────────

test("buildCampaignCache: agrega linhas por email normalizado", () => {
  const cache = buildCampaignCache(
    [
      { Email_ID: "A@x.com", Delivered_Date: "2026-07-01", "Total Opens": "2" },
      { Email_ID: "b@x.com", Delivered_Date: "2026-07-01", "Total Opens": "0" },
    ],
    40,
    "Clarice News 2605 d01-C",
    GEN,
  );
  assert.equal(cache.campaignId, 40);
  assert.equal(Object.keys(cache.recipients).length, 2);
  assert.deepEqual(cache.recipients["a@x.com"], { delivered: true, opened: true, bounced: false, unsubscribed: false });
  assert.deepEqual(cache.recipients["b@x.com"], { delivered: true, opened: false, bounced: false, unsubscribed: false });
});

test("buildCampaignCache: linha sem Email_ID é ignorada (sem chave vazia no mapa)", () => {
  const cache = buildCampaignCache(
    [{ Delivered_Date: "2026-07-01" }, { Email_ID: "", Delivered_Date: "2026-07-01" }],
    41,
    "x",
    GEN,
  );
  assert.equal(Object.keys(cache.recipients).length, 0);
});

test("buildCampaignCache: email duplicado na MESMA campanha faz OR-merge defensivo", () => {
  const cache = buildCampaignCache(
    [
      { Email_ID: "a@x.com", Delivered_Date: "2026-07-01", "Total Opens": "0" },
      { Email_ID: "a@x.com", Delivered_Date: "2026-07-01", "Total Opens": "1" },
    ],
    42,
    "x",
    GEN,
  );
  assert.deepEqual(cache.recipients["a@x.com"], { delivered: true, opened: true, bounced: false, unsubscribed: false });
});

// ─── aggregateCampaignCaches — acumulação cross-campanha ─────────────────

test("aggregateCampaignCaches: mesmo email em 2 campanhas acumula receivedCount e openedCampaignsCount", () => {
  const c1: CampaignCache = {
    campaignId: 1,
    campaignName: "camp1",
    exportedAt: GEN,
    recipients: { "a@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false } },
  };
  const c2: CampaignCache = {
    campaignId: 2,
    campaignName: "camp2",
    exportedAt: GEN,
    recipients: { "a@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: false } },
  };
  const agg = aggregateCampaignCaches([c1, c2]);
  assert.deepEqual(agg.get("a@x.com"), { received: 2, opened: 1, bounced: false, optedOut: false });
});

test("aggregateCampaignCaches: bounced/optedOut são OR entre campanhas (setados 1x, persistem)", () => {
  const c1: CampaignCache = {
    campaignId: 1,
    campaignName: "camp1",
    exportedAt: GEN,
    recipients: { "a@x.com": { delivered: true, opened: false, bounced: true, unsubscribed: false } },
  };
  const c2: CampaignCache = {
    campaignId: 2,
    campaignName: "camp2",
    exportedAt: GEN,
    recipients: { "a@x.com": { delivered: false, opened: false, bounced: false, unsubscribed: true } },
  };
  const agg = aggregateCampaignCaches([c1, c2]);
  assert.deepEqual(agg.get("a@x.com"), { received: 1, opened: 0, bounced: true, optedOut: true });
});

test("aggregateCampaignCaches: emails distintos entre campanhas não se misturam", () => {
  const c1: CampaignCache = {
    campaignId: 1,
    campaignName: "camp1",
    exportedAt: GEN,
    recipients: { "a@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false } },
  };
  const c2: CampaignCache = {
    campaignId: 2,
    campaignName: "camp2",
    exportedAt: GEN,
    recipients: { "b@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: false } },
  };
  const agg = aggregateCampaignCaches([c1, c2]);
  assert.equal(agg.size, 2);
  assert.deepEqual(agg.get("a@x.com"), { received: 1, opened: 1, bounced: false, optedOut: false });
  assert.deepEqual(agg.get("b@x.com"), { received: 1, opened: 0, bounced: false, optedOut: false });
});

// ─── computeCohorts (v1, sem mudança) alimentado pelo agregado v2 — sem regressão ──

test("computeCohorts sobre o agregado v2 produz a mesma partição de sempre (sem regressão)", () => {
  const c1: CampaignCache = {
    campaignId: 1,
    campaignName: "camp1",
    exportedAt: GEN,
    recipients: {
      "opens2@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false },
      "opens1@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false },
      "opens0@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: false },
      "exit@x.com": { delivered: true, opened: true, bounced: true, unsubscribed: false },
    },
  };
  const c2: CampaignCache = {
    campaignId: 2,
    campaignName: "camp2",
    exportedAt: GEN,
    recipients: {
      "opens2@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false },
      "opens1@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: false },
      "opens0@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: false },
    },
  };
  const agg = aggregateCampaignCaches([c1, c2]);
  const r = computeCohorts(Array.from(agg.values()), GEN);
  assert.equal(r.universe, 4);
  assert.equal(r.opened2plus, 1); // opens2
  assert.equal(r.opened1, 1); // opens1
  assert.equal(r.received1_opened0, 0);
  assert.equal(r.received2_opened0, 1); // opens0 (recebeu 2, abriu 0)
  assert.equal(r.exits, 1); // exit (bounce tem precedência mesmo tendo opened=1 numa campanha)
  assert.equal(r.exitsBreakdown.bounced, 1);
});

// ─── getOrFetchCampaignCache — cache "skip forever" (#4451 Fase 1) ────────

function makeMockClient(overrides: Partial<CampaignExportClient> = {}): {
  client: CampaignExportClient;
  calls: { exportRecipients: number; pollProcess: number; downloadCsv: number; listSentCampaigns: number };
} {
  const calls = { exportRecipients: 0, pollProcess: 0, downloadCsv: 0, listSentCampaigns: 0 };
  const client: CampaignExportClient = {
    listSentCampaigns: async () => {
      calls.listSentCampaigns++;
      return overrides.listSentCampaigns ? await overrides.listSentCampaigns() : [];
    },
    exportRecipients: async (id: number) => {
      calls.exportRecipients++;
      return overrides.exportRecipients ? await overrides.exportRecipients(id) : { processId: 999 };
    },
    pollProcess: async (id) => {
      calls.pollProcess++;
      return overrides.pollProcess
        ? await overrides.pollProcess(id)
        : { status: "completed", exportUrl: "https://example.com/export.csv" };
    },
    downloadCsv: async (url: string) => {
      calls.downloadCsv++;
      return overrides.downloadCsv
        ? await overrides.downloadCsv(url)
        : 'Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,1\n';
    },
  };
  return { client, calls };
}

function withTmpCacheDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cohorts-v2-cache-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("getOrFetchCampaignCache: sem cache, chama export→poll→download e persiste", async () => {
  await withTmpCacheDir(async (dir) => {
    const { client, calls } = makeMockClient();
    const campaign: SentCampaignRef = { id: 40, name: "Clarice News 2605 d01-C" };
    const { cache, fromCache } = await getOrFetchCampaignCache(client, campaign, { cacheDir: dir, now: () => GEN });
    assert.equal(fromCache, false);
    assert.equal(calls.exportRecipients, 1);
    assert.equal(calls.pollProcess, 1);
    assert.equal(calls.downloadCsv, 1);
    assert.deepEqual(cache.recipients["a@x.com"], { delivered: true, opened: true, bounced: false, unsubscribed: false });
    // Persistiu no disco no path esperado.
    const fs = await import("node:fs");
    assert.ok(fs.existsSync(campaignCachePath(40, dir)));
  });
});

test("getOrFetchCampaignCache: campanha JÁ cacheada NUNCA dispara novo exportRecipients (0 chamadas)", async () => {
  await withTmpCacheDir(async (dir) => {
    const { client: clientFirst } = makeMockClient();
    const campaign: SentCampaignRef = { id: 40, name: "Clarice News 2605 d01-C" };
    // 1ª chamada popula o cache em disco.
    await getOrFetchCampaignCache(clientFirst, campaign, { cacheDir: dir, now: () => GEN });

    // 2ª chamada, client NOVO que lançaria se qualquer método fosse invocado —
    // prova que o cache em disco é consultado ANTES de qualquer chamada de rede.
    const throwingClient: CampaignExportClient = {
      listSentCampaigns: async () => {
        throw new Error("não deveria ser chamado");
      },
      exportRecipients: async () => {
        throw new Error("exportRecipients não deveria ser chamado — campanha já cacheada");
      },
      pollProcess: async () => {
        throw new Error("pollProcess não deveria ser chamado — campanha já cacheada");
      },
      downloadCsv: async () => {
        throw new Error("downloadCsv não deveria ser chamado — campanha já cacheada");
      },
    };
    const { fromCache } = await getOrFetchCampaignCache(throwingClient, campaign, { cacheDir: dir });
    assert.equal(fromCache, true);
  });
});

// ─── pollExportUntilDone ──────────────────────────────────────────────────

test("pollExportUntilDone: retorna exportUrl assim que status='completed'", async () => {
  let attempts = 0;
  const client = {
    pollProcess: async () => {
      attempts++;
      return attempts < 3
        ? { status: "in_process" }
        : { status: "completed", exportUrl: "https://example.com/x.csv" };
    },
  };
  const noSleep = async () => {};
  const url = await pollExportUntilDone(client, 1, { sleep: noSleep, maxAttempts: 10 });
  assert.equal(url, "https://example.com/x.csv");
  assert.equal(attempts, 3);
});

test("pollExportUntilDone: status='failed' lança imediatamente (não espera maxAttempts)", async () => {
  const client = { pollProcess: async () => ({ status: "failed" }) };
  await assert.rejects(() => pollExportUntilDone(client, 1, { sleep: async () => {}, maxAttempts: 10 }));
});

test("pollExportUntilDone: esgota maxAttempts sem completar → lança", async () => {
  const client = { pollProcess: async () => ({ status: "in_process" }) };
  await assert.rejects(() => pollExportUntilDone(client, 1, { sleep: async () => {}, maxAttempts: 3 }));
});

test("pollExportUntilDone: completed sem exportUrl é erro (contrato quebrado da API)", async () => {
  const client = { pollProcess: async () => ({ status: "completed" }) };
  await assert.rejects(() => pollExportUntilDone(client, 1, { sleep: async () => {}, maxAttempts: 3 }));
});

// ─── buildCohortsV2 — orquestração fim-a-fim com mocks ───────────────────

test("buildCohortsV2: processa campanhas listadas, agrega e roda computeCohorts sem tocar rede real", async () => {
  await withTmpCacheDir(async (dir) => {
    const csvByCampaign: Record<number, string> = {
      1: "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,1\nb@x.com,2026-07-01,0\n",
      2: "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-15,1\n",
    };
    const { client, calls } = makeMockClient({
      listSentCampaigns: async () => [
        { id: 1, name: "camp1" },
        { id: 2, name: "camp2" },
      ],
      exportRecipients: async (id) => ({ processId: id }),
      pollProcess: async (id) => ({ status: "completed", exportUrl: `https://example.com/${id}.csv` }),
      downloadCsv: async (url) => {
        const id = Number(url.split("/").pop()!.replace(".csv", ""));
        return csvByCampaign[id];
      },
    });

    const result = await buildCohortsV2(client, GEN, { cacheDir: dir, concurrency: 2 });
    assert.equal(result.campaignsTotal, 2);
    assert.equal(result.campaignsFetched, 2);
    assert.equal(result.campaignsFromCache, 0);
    assert.equal(result.campaignsFailed.length, 0);
    // a@x.com recebeu 2 campanhas e abriu as 2 → opened2plus.
    assert.equal(result.cohorts.opened2plus, 1);
    // b@x.com recebeu 1, abriu 0 → received1_opened0.
    assert.equal(result.cohorts.received1_opened0, 1);
    assert.equal(calls.exportRecipients, 2);
  });
});

test("buildCohortsV2: --limit corta a lista de campanhas ANTES de exportar (nunca busca as excedentes)", async () => {
  await withTmpCacheDir(async (dir) => {
    const { client, calls } = makeMockClient({
      listSentCampaigns: async () => [
        { id: 1, name: "camp1" },
        { id: 2, name: "camp2" },
        { id: 3, name: "camp3" },
      ],
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,0\n",
    });
    const result = await buildCohortsV2(client, GEN, { cacheDir: dir, limit: 1 });
    assert.equal(result.campaignsTotal, 1);
    assert.equal(calls.exportRecipients, 1);
  });
});

test("buildCohortsV2: campanha que falha no export não derruba as demais (isolamento de erro)", async () => {
  await withTmpCacheDir(async (dir) => {
    const { client } = makeMockClient({
      listSentCampaigns: async () => [
        { id: 1, name: "camp-ok" },
        { id: 2, name: "camp-falha" },
      ],
      exportRecipients: async (id) => {
        if (id === 2) throw new Error("Brevo 500 simulado");
        return { processId: id };
      },
      pollProcess: async (id) => ({ status: "completed", exportUrl: `https://example.com/${id}.csv` }),
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,1\n",
    });
    const result = await buildCohortsV2(client, GEN, { cacheDir: dir });
    assert.equal(result.campaignsFailed.length, 1);
    assert.equal(result.campaignsFailed[0].campaignId, 2);
    assert.equal(result.campaignsFetched, 1);
    // A campanha OK ainda entra no agregado final.
    assert.equal(result.cohorts.universe, 1);
  });
});
