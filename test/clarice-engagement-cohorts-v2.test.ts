/**
 * clarice-engagement-cohorts-v2.test.ts (#4451 Fase 1 + Fase 2)
 *
 * Testes PUROS, sem rede (#633) — cobrem Fase 1 + Fase 2 do redesenho:
 *   - csvRowToFlags: linha do CSV de exportRecipients → flags per-campanha.
 *   - buildCampaignCache / aggregateCampaignCaches: agregação por email,
 *     inclusive across-campaign (2 campanhas diferentes acumulam).
 *   - getOrFetchCampaignCache: cache existente NUNCA dispara novo
 *     exportRecipients (mock do client, assert 0 chamadas) — salvo
 *     `forceRefresh` (Fase 2), que sempre busca de novo e sobrescreve.
 *   - isWithinRefetchWindow: campanha recente/antiga/sem sentDate (Fase 2).
 *   - fetchAdminOptOutEmails / applyAdminOptOuts: gap de blacklist
 *     administrativo fechado via store local, fail-soft quando ausente
 *     (Fase 2).
 *   - computeCohorts (import direto de clarice-engagement-cohorts.ts): sem
 *     regressão — mesmo comportamento de hoje, alimentado pelo agregado v2.
 *
 * #6222: guard de rede file-wide (`installNetworkRequestGuard`, ver
 * test/_helpers/network-guard.ts) instalado em `test.before`/`test.after`
 * abaixo — nenhum teste deste arquivo pode alcançar `https.request`/
 * `http.request` reais, nem os que mockam só `globalThis.fetch` (que não
 * cobre `node:https`, o caminho que `uploadTextToWorkerKV` usa e que
 * vazava pra rede real da Cloudflare quando `data/` tinha opt-outs
 * administrativos reais).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installNetworkRequestGuard } from "./_helpers/network-guard.ts";

let restoreNetworkGuard: () => void;
before(() => {
  restoreNetworkGuard = installNetworkRequestGuard();
});
after(() => {
  restoreNetworkGuard();
});
import {
  csvRowToFlags,
  normalizeEmail,
  buildCampaignCache,
  aggregateCampaignCaches,
  getOrFetchCampaignCache,
  pollExportUntilDone,
  buildCohortsV2,
  campaignCachePath,
  isWithinRefetchWindow,
  fetchAdminOptOutEmails,
  applyAdminOptOuts,
  makeRealCampaignExportClient,
  DEFAULT_REFETCH_WINDOW_DAYS,
  DOWNLOAD_CSV_TIMEOUT_MS,
  pushCohortsToKV, // #5015
  main,
  type CampaignExportClient,
  type CampaignCache,
  type SentCampaignRef,
} from "../scripts/clarice-engagement-cohorts-v2.ts";
import {
  computeCohorts,
  COHORTS_KV_KEY,
  DASHBOARD_KV_NAMESPACE_ID,
  type ContactEngagement,
  type EngagementCohorts,
} from "../scripts/clarice-engagement-cohorts.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";

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

// ASYNC de propósito (mesmo motivo de withTmpDbDir, ver comentário abaixo): o
// cleanup precisa aguardar o callback resolver ANTES de apagar o diretório —
// se fosse síncrono, `finally` rodaria assim que o callback suspendesse no
// primeiro `await` interno, apagando o dir ANTES das escritas reais
// acontecerem. Hoje isso só não quebra porque `saveCampaignCache` recria o
// diretório via `mkdirSync(recursive:true)` antes de escrever — mascarando,
// não corrigindo.
async function withTmpCacheDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cohorts-v2-cache-"));
  try {
    return await fn(dir);
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

// ─── isWithinRefetchWindow (#4451 Fase 2) ──────────────────────────────────

const NOW_MS = Date.parse("2026-08-02T12:00:00.000Z");

test("isWithinRefetchWindow: campanha enviada ontem está DENTRO da janela default (30d)", () => {
  assert.equal(
    isWithinRefetchWindow({ sentDate: "2026-08-01T00:00:00.000Z" }, NOW_MS),
    true,
  );
});

test("isWithinRefetchWindow: campanha enviada há 60 dias está FORA da janela default (30d)", () => {
  assert.equal(
    isWithinRefetchWindow({ sentDate: "2026-06-03T00:00:00.000Z" }, NOW_MS),
    false,
  );
});

test("isWithinRefetchWindow: exatamente no limite da janela conta como FORA (< estrito)", () => {
  const exactly30dAgo = new Date(NOW_MS - 30 * 86_400_000).toISOString();
  assert.equal(isWithinRefetchWindow({ sentDate: exactly30dAgo }, NOW_MS, 30), false);
});

test("isWithinRefetchWindow: janela customizada é respeitada", () => {
  const tenDaysAgo = new Date(NOW_MS - 10 * 86_400_000).toISOString();
  assert.equal(isWithinRefetchWindow({ sentDate: tenDaysAgo }, NOW_MS, 7), false);
  assert.equal(isWithinRefetchWindow({ sentDate: tenDaysAgo }, NOW_MS, 15), true);
});

test("isWithinRefetchWindow: sentDate ausente ou inválido → DENTRO por padrão conservador", () => {
  assert.equal(isWithinRefetchWindow({ sentDate: undefined }, NOW_MS), true);
  assert.equal(isWithinRefetchWindow({ sentDate: "não é uma data" }, NOW_MS), true);
});

test("DEFAULT_REFETCH_WINDOW_DAYS é 30 (chute inicial documentado na issue #4451)", () => {
  assert.equal(DEFAULT_REFETCH_WINDOW_DAYS, 30);
});

// ─── getOrFetchCampaignCache com forceRefresh (#4451 Fase 2) ──────────────

test("getOrFetchCampaignCache: forceRefresh=true SEMPRE busca de novo, mesmo com cache existente", async () => {
  await withTmpCacheDir(async (dir) => {
    const campaign: SentCampaignRef = { id: 50, name: "camp-recente" };
    const { client: firstClient } = makeMockClient({
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,0\n",
    });
    // 1ª chamada popula o cache (a@x.com sem abertura).
    await getOrFetchCampaignCache(firstClient, campaign, { cacheDir: dir, now: () => GEN });

    // 2ª chamada com forceRefresh: mesmo tendo cache, busca de novo — e desta
    // vez o CSV mostra abertura tardia (engajamento capturado depois do envio).
    const { client: secondClient, calls } = makeMockClient({
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,3\n",
    });
    const { cache, fromCache } = await getOrFetchCampaignCache(secondClient, campaign, {
      cacheDir: dir,
      forceRefresh: true,
      now: () => GEN,
    });
    assert.equal(fromCache, false);
    assert.equal(calls.exportRecipients, 1);
    // Cache em disco foi SOBRESCRITO com o dado novo (abertura tardia).
    assert.deepEqual(cache.recipients["a@x.com"], { delivered: true, opened: true, bounced: false, unsubscribed: false });
  });
});

test("getOrFetchCampaignCache: forceRefresh=true com cache VÁLIDO em disco, mas export falha → lança (não cai de volta pro cache velho; documenta o comportamento atual, fallback fica pra Fase 4)", async () => {
  await withTmpCacheDir(async (dir) => {
    const campaign: SentCampaignRef = { id: 60, name: "camp-com-cache" };
    const { client: seedClient } = makeMockClient();
    // Popula um cache válido em disco.
    await getOrFetchCampaignCache(seedClient, campaign, { cacheDir: dir, now: () => GEN });

    // forceRefresh=true ignora esse cache válido inteiramente — se o export
    // falhar, a chamada lança (não há fallback silencioso pro cache antigo).
    const { client: failingClient } = makeMockClient({
      exportRecipients: async () => {
        throw new Error("Brevo 500 simulado no refresh forçado");
      },
    });
    await assert.rejects(
      () => getOrFetchCampaignCache(failingClient, campaign, { cacheDir: dir, forceRefresh: true, now: () => GEN }),
      /Brevo 500 simulado/,
    );
  });
});

test("buildCohortsV2: campanha DENTRO da janela com cache válido em disco, cujo refresh forçado falha → some do agregado (sem fallback pro cache velho, comportamento atual)", async () => {
  await withTmpCacheDir(async (dir) => {
    const recentSent = new Date(NOW_MS - 5 * 86_400_000).toISOString(); // dentro da janela → forceRefresh

    const { client: seedClient } = makeMockClient({
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,1\n",
    });
    await getOrFetchCampaignCache(seedClient, { id: 1, name: "camp1" }, { cacheDir: dir, now: () => GEN });

    const { client } = makeMockClient({
      listSentCampaigns: async () => [{ id: 1, name: "camp1", sentDate: recentSent }],
      exportRecipients: async () => {
        throw new Error("Brevo 500 simulado no refresh");
      },
    });

    const result = await buildCohortsV2(client, GEN, { cacheDir: dir, nowMs: NOW_MS, includeAdminOptOuts: false });

    assert.equal(result.campaignsFailed.length, 1);
    assert.equal(result.campaignsFailed[0].campaignId, 1);
    // A campanha some do agregado inteiramente — o cache válido em disco NÃO
    // é reaproveitado como fallback quando o refresh forçado falha.
    assert.equal(result.cohorts.universe, 0);
  });
});

test("buildCohortsV2: campanha DENTRO da janela é re-exportada mesmo já cacheada; fora da janela usa cache", async () => {
  await withTmpCacheDir(async (dir) => {
    const recentSent = new Date(NOW_MS - 5 * 86_400_000).toISOString(); // 5d atrás — dentro da janela 30d
    const oldSent = new Date(NOW_MS - 200 * 86_400_000).toISOString(); // 200d atrás — fora

    // Pré-popula o cache das 2 campanhas com um estado "antigo" (sem abertura).
    const { client: seedClient } = makeMockClient({
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,0\n",
    });
    await getOrFetchCampaignCache(seedClient, { id: 1, name: "recente" }, { cacheDir: dir, now: () => GEN });
    await getOrFetchCampaignCache(seedClient, { id: 2, name: "antiga" }, { cacheDir: dir, now: () => GEN });

    // Run de produção: a campanha "recente" tem abertura NOVA no export;
    // a "antiga" teria abertura nova também, mas como está fora da janela,
    // o cache velho (sem abertura) deve prevalecer.
    const { client, calls } = makeMockClient({
      listSentCampaigns: async () => [
        { id: 1, name: "recente", sentDate: recentSent },
        { id: 2, name: "antiga", sentDate: oldSent },
      ],
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,5\n",
    });

    const result = await buildCohortsV2(client, GEN, {
      cacheDir: dir,
      nowMs: NOW_MS,
      includeAdminOptOuts: false,
    });

    // Só a campanha recente disparou um novo export.
    assert.equal(calls.exportRecipients, 1);
    assert.equal(result.campaignsFetched, 1);
    assert.equal(result.campaignsFromCache, 1);
  });
});

// ─── fetchAdminOptOutEmails / applyAdminOptOuts (#4451 Fase 2 — gap de blacklist) ──

test("applyAdminOptOuts: contato já no agregado tem optedOut forçado (OR, nunca reverte)", () => {
  const aggregate = new Map<string, ContactEngagement>([
    ["a@x.com", { received: 2, opened: 1, bounced: false, optedOut: false }],
    ["b@x.com", { received: 1, opened: 0, bounced: false, optedOut: true }],
  ]);
  const out = applyAdminOptOuts(aggregate, new Set(["a@x.com"]));
  assert.deepEqual(out.get("a@x.com"), { received: 2, opened: 1, bounced: false, optedOut: true });
  assert.deepEqual(out.get("b@x.com"), { received: 1, opened: 0, bounced: false, optedOut: true });
});

test("applyAdminOptOuts: contato AUSENTE do agregado (nunca apareceu em export) entra como saída pura", () => {
  const aggregate = new Map<string, ContactEngagement>();
  const out = applyAdminOptOuts(aggregate, new Set(["nunca-exportado@x.com"]));
  assert.deepEqual(out.get("nunca-exportado@x.com"), {
    received: 0,
    opened: 0,
    bounced: false,
    optedOut: true,
  });
  // computeCohorts conta esse contato em exits (precedência de saída), mesmo
  // sem received/opened — a razão de existir deste mecanismo.
  const cohorts = computeCohorts(Array.from(out.values()), GEN);
  assert.equal(cohorts.universe, 1);
  assert.equal(cohorts.exits, 1);
  assert.equal(cohorts.exitsBreakdown.optedOut, 1);
});

test("applyAdminOptOuts: não muta o Map original (retorna cópia)", () => {
  const aggregate = new Map<string, ContactEngagement>([
    ["a@x.com", { received: 1, opened: 0, bounced: false, optedOut: false }],
  ]);
  applyAdminOptOuts(aggregate, new Set(["a@x.com"]));
  assert.equal(aggregate.get("a@x.com")!.optedOut, false, "original não deve ser mutado");
});

// ASYNC pelo mesmo motivo de withTmpCacheDir acima: o cleanup precisa
// aguardar o callback resolver ANTES de apagar o diretório — se fosse
// síncrono, `finally` rodaria assim que o callback suspendesse no primeiro
// `await` interno (ex: dentro de buildCohortsV2), apagando o .db ANTES de
// fetchAdminOptOutEmails chegar a lê-lo (visto falhar ao vivo nesta sessão:
// available=false por causa da ordem errada).
async function withTmpDbDir<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cohorts-v2-db-"));
  try {
    return await fn(resolve(dir, "clarice-users.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fetchAdminOptOutEmails: lê email_blacklisted=1 OU unsubscribed=1 do store local, entre quem já recebeu e-mail (sends_count > 0)", async () => {
  await withTmpDbDir((dbPath) => {
    const db = openClariceDb(dbPath);
    const now = new Date().toISOString();
    db.exec(
      `INSERT INTO clarice_users (email, email_blacklisted, unsubscribed, sends_count, updated_at) VALUES
        ('blacklisted@x.com', 1, 0, 3, '${now}'),
        ('UNSUB@X.COM', 0, 1, 1, '${now}'),
        ('clean@x.com', 0, 0, 5, '${now}')`,
    );
    db.close();

    const result = fetchAdminOptOutEmails(dbPath);
    assert.equal(result.available, true);
    if (!result.available) throw new Error("esperado available=true");
    assert.equal(result.emails.size, 2);
    assert.ok(result.emails.has("blacklisted@x.com"));
    assert.ok(result.emails.has("unsub@x.com")); // normalizado (lowercase)
    assert.ok(!result.emails.has("clean@x.com"));
  });
});

test("fetchAdminOptOutEmails: exclui blacklisted/unsub com sends_count=0 — nunca recebeu e-mail, fora do universo do v1 (#4451 fleet review #4479 achado 3)", async () => {
  await withTmpDbDir((dbPath) => {
    const db = openClariceDb(dbPath);
    const now = new Date().toISOString();
    db.exec(
      `INSERT INTO clarice_users (email, email_blacklisted, unsubscribed, sends_count, updated_at) VALUES
        ('blacklisted-nunca-enviado@x.com', 1, 0, 0, '${now}'),
        ('unsub-nunca-enviado@x.com', 0, 1, 0, '${now}'),
        ('blacklisted-ja-enviado@x.com', 1, 0, 2, '${now}')`,
    );
    db.close();

    const result = fetchAdminOptOutEmails(dbPath);
    assert.equal(result.available, true);
    if (!result.available) throw new Error("esperado available=true");
    // Só o contato que já recebeu ao menos 1 e-mail entra — os outros dois
    // nunca foram destinatário de campanha alguma, então nem pertenceriam ao
    // universo do v1 (fetchEmailedContactIds); incluí-los inflaria `exits`
    // no v2 sem equivalente no v1 (a divergência que este fix fecha).
    assert.equal(result.emails.size, 1);
    assert.ok(result.emails.has("blacklisted-ja-enviado@x.com"));
    assert.ok(!result.emails.has("blacklisted-nunca-enviado@x.com"));
    assert.ok(!result.emails.has("unsub-nunca-enviado@x.com"));
  });
});

test("fetchAdminOptOutEmails: store inexistente → fail-soft, available=false (nunca lança)", () => {
  const missingPath = resolve(mkdtempSync(join(tmpdir(), "cohorts-v2-missing-")), "não-existe", "clarice-users.db");
  const result = fetchAdminOptOutEmails(missingPath);
  assert.equal(result.available, false);
  if (result.available) throw new Error("esperado available=false");
  assert.ok(result.unavailableReason.length > 0);
});

test("buildCohortsV2: aplica opt-outs administrativos do store quando disponível", async () => {
  await withTmpCacheDir(async (dir) => {
    await withTmpDbDir(async (dbPath) => {
      const db = openClariceDb(dbPath);
      db.exec(
        // sends_count > 0: já recebeu e-mail (por alguma campanha fora do
        // conjunto exportado nesta rodada), então continua no universo do
        // gap administrativo mesmo após o filtro do achado 3 (#4479).
        `INSERT INTO clarice_users (email, email_blacklisted, unsubscribed, sends_count, updated_at) VALUES
          ('nunca-exportado@x.com', 1, 0, 1, '${new Date().toISOString()}')`,
      );
      db.close();

      const { client } = makeMockClient({
        listSentCampaigns: async () => [{ id: 1, name: "camp1", sentDate: GEN }],
        downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,1\n",
      });

      const result = await buildCohortsV2(client, GEN, { cacheDir: dir, dbPath, nowMs: NOW_MS });
      assert.equal(result.adminOptOutsAvailable, true);
      assert.equal(result.adminOptOutsApplied, 1);
      // universo = a@x.com (opened1) + nunca-exportado@x.com (exit) = 2
      assert.equal(result.cohorts.universe, 2);
      assert.equal(result.cohorts.exits, 1);
    });
  });
});

test("buildCohortsV2: --no-admin-optouts (includeAdminOptOuts=false) não toca o store", async () => {
  await withTmpCacheDir(async (dir) => {
    const { client } = makeMockClient({
      listSentCampaigns: async () => [{ id: 1, name: "camp1", sentDate: GEN }],
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,1\n",
    });
    const result = await buildCohortsV2(client, GEN, {
      cacheDir: dir,
      nowMs: NOW_MS,
      includeAdminOptOuts: false,
      dbPath: "/path/que/nunca/deveria/ser/lido.db",
    });
    assert.equal(result.adminOptOutsAvailable, false);
    assert.equal(result.adminOptOutsApplied, 0);
    assert.equal(result.adminOptOutsUnavailableReason, undefined); // desligado via flag, não "indisponível"
    assert.equal(result.cohorts.universe, 1); // só a@x.com, sem opt-out administrativo
  });
});

test("buildCohortsV2: store administrativo indisponível propaga o motivo real (não some atrás de um aviso genérico)", async () => {
  await withTmpCacheDir(async (dir) => {
    const { client } = makeMockClient({
      listSentCampaigns: async () => [{ id: 1, name: "camp1", sentDate: GEN }],
      downloadCsv: async () => "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-07-01,1\n",
    });
    const result = await buildCohortsV2(client, GEN, {
      cacheDir: dir,
      nowMs: NOW_MS,
      dbPath: resolve(dir, "não-existe", "clarice-users.db"), // store ausente, mas SEM --no-admin-optouts
    });
    assert.equal(result.adminOptOutsAvailable, false);
    assert.ok(
      result.adminOptOutsUnavailableReason && result.adminOptOutsUnavailableReason.includes("store não encontrado"),
      `esperava motivo real, recebeu: ${result.adminOptOutsUnavailableReason}`,
    );
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

    const result = await buildCohortsV2(client, GEN, { cacheDir: dir, concurrency: 2, includeAdminOptOuts: false });
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
    const result = await buildCohortsV2(client, GEN, { cacheDir: dir, limit: 1, includeAdminOptOuts: false });
    assert.equal(result.campaignsTotal, 1);
    assert.equal(calls.exportRecipients, 1);
  });
});

test("main: --limit inválido (typo de valor) LANÇA — não vira 'sem limite' silenciosamente (#4497)", async () => {
  // getIntArg lança ANTES do check de BREVO_CLARICE_API_KEY (não precisa
  // mockar client/fetch nem definir a key pra provar o throw).
  await assert.rejects(main(["--limit", "abc"]), /inteiro/);
});

// ─── --refetch-window-days (#4451 achado 4 do fleet review em #4479) ─────

test("main: --refetch-window-days inválido (typo de valor) LANÇA — não colapsa pro default 30 em silêncio", async () => {
  await assert.rejects(main(["--refetch-window-days", "abc"]), /inteiro/);
});

test("main: --refetch-window-days sem valor (fim do argv) LANÇA", async () => {
  await assert.rejects(main(["--refetch-window-days"]), /sem valor/);
});

test("main: --refetch-window-days=0 é aceito (não colapsa pro default 30 — antes do fix, '0' era falsy)", async () => {
  // getIntArg aceita 0 (min default é 0) e NÃO lança — a chamada só falha
  // depois, no check de BREVO_CLARICE_API_KEY (que também lança, mas com
  // mensagem DIFERENTE de "inteiro"/"sem valor"), provando que "0" passou
  // pela validação numérica sem virar erro nem colapsar pro default.
  const originalKey = process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  try {
    let exitCode: number | undefined;
    const originalExit = process.exit;
    // @ts-expect-error — mock de process.exit só para este teste
    process.exit = (code?: number) => {
      exitCode = code;
      throw new Error("__exit__");
    };
    try {
      await assert.rejects(main(["--refetch-window-days", "0"]), /__exit__/);
    } finally {
      process.exit = originalExit;
    }
    assert.equal(exitCode, 1); // saiu pelo check de API key, não por erro de parsing de --refetch-window-days
  } finally {
    if (originalKey !== undefined) process.env.BREVO_CLARICE_API_KEY = originalKey;
  }
});

// ─── downloadCsv timeout (#4451 achado 5 do fleet review em #4479) ───────

test("makeRealCampaignExportClient.downloadCsv: AbortError (timeout) vira mensagem amigável citando o timeout configurado", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;
  try {
    const client = makeRealCampaignExportClient("fake-key");
    await assert.rejects(
      () => client.downloadCsv("https://example.com/export.csv"),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes(String(DOWNLOAD_CSV_TIMEOUT_MS)) &&
        e.message.toLowerCase().includes("excedeu"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("makeRealCampaignExportClient.downloadCsv: erro de rede genérico (não abort) propaga sem reescrever a mensagem", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const client = makeRealCampaignExportClient("fake-key");
    await assert.rejects(() => client.downloadCsv("https://example.com/export.csv"), /network down/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("makeRealCampaignExportClient.downloadCsv: sucesso retorna o texto do CSV (timer é limpo, não vaza)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Email_ID\na@x.com\n", { status: 200 })) as typeof fetch;
  try {
    const client = makeRealCampaignExportClient("fake-key");
    const text = await client.downloadCsv("https://example.com/export.csv");
    assert.ok(text.includes("a@x.com"));
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    const result = await buildCohortsV2(client, GEN, { cacheDir: dir, includeAdminOptOuts: false });
    assert.equal(result.campaignsFailed.length, 1);
    assert.equal(result.campaignsFailed[0].campaignId, 2);
    assert.equal(result.campaignsFetched, 1);
    // A campanha OK ainda entra no agregado final.
    assert.equal(result.cohorts.universe, 1);
  });
});

// ─── pushCohortsToKV (#5015 — porta a lógica de escrita KV do v1) ─────────

function makeCohorts(overrides: Partial<EngagementCohorts> = {}): EngagementCohorts {
  return {
    generatedAt: GEN,
    universe: 0,
    opened2plus: 0,
    opened1: 0,
    received1_opened0: 0,
    received2_opened0: 0,
    exits: 0,
    exitsBreakdown: { bounced: 0, optedOut: 0 },
    maxReceived: 0,
    ...overrides,
  };
}

test("pushCohortsToKV: universe=0 NÃO chama uploadFn — mesmo guard anti-clobber do v1", async () => {
  const cohorts = makeCohorts({ universe: 0 });
  let uploadCalls = 0;
  const uploadFn = (async () => {
    uploadCalls++;
  }) as typeof import("../scripts/lib/cloudflare-kv-upload.ts").uploadTextToWorkerKV;
  const result = await pushCohortsToKV(cohorts, { accountId: "acc", token: "tok" }, uploadFn);
  assert.equal(result.pushed, false);
  assert.match(result.reason ?? "", /universe 0/);
  assert.equal(uploadCalls, 0);
});

test("pushCohortsToKV: universe>0 chama uploadFn com a MESMA chave/namespace/shape gravados pelo v1", async () => {
  const cohorts = makeCohorts({
    universe: 3,
    opened2plus: 1,
    opened1: 1,
    received1_opened0: 1,
    maxReceived: 2,
  });
  const calls: { value: string; key: string; cfg: any }[] = [];
  const uploadFn = (async (value: string, key: string, cfg: any) => {
    calls.push({ value, key, cfg });
  }) as typeof import("../scripts/lib/cloudflare-kv-upload.ts").uploadTextToWorkerKV;
  const result = await pushCohortsToKV(cohorts, { accountId: "acc-123", token: "tok-456" }, uploadFn);
  assert.equal(result.pushed, true);
  assert.equal(calls.length, 1);
  // Mesma chave KV que o v1 (clarice-engagement-cohorts.ts) grava — o worker
  // clarice-dashboard lê essa chave sem saber se foi v1 ou v2 quem escreveu.
  assert.equal(calls[0].key, COHORTS_KV_KEY);
  assert.equal(calls[0].cfg.kvNamespaceId, DASHBOARD_KV_NAMESPACE_ID);
  assert.equal(calls[0].cfg.accountId, "acc-123");
  assert.equal(calls[0].cfg.token, "tok-456");
  assert.equal(calls[0].cfg.contentType, "application/json");
  // Payload é o EngagementCohorts puro (sem wrapper de diagnostics — isso é
  // só pro --out local/compare-cohorts.ts, nunca pro KV real).
  assert.deepEqual(JSON.parse(calls[0].value), cohorts);
});

test("pushCohortsToKV: erro do uploadFn propaga (nunca engole silenciosamente)", async () => {
  const cohorts = makeCohorts({ universe: 1, received1_opened0: 1 });
  const uploadFn = (async () => {
    throw new Error("Cloudflare KV upload de 'cohorts:engagement' falhou (500): boom");
  }) as typeof import("../scripts/lib/cloudflare-kv-upload.ts").uploadTextToWorkerKV;
  await assert.rejects(
    pushCohortsToKV(cohorts, { accountId: "acc", token: "tok" }, uploadFn),
    /falhou \(500\)/,
  );
});

// ─── main + --push, fim-a-fim com fetch mockado (#5015) ───────────────────
//
// `fetch` global é mockado (mesmo padrão já usado pelos testes de
// downloadCsv acima) pra servir uma lista de campanhas VAZIA — o backfill
// completa em 0 campanhas (universe=0), sem nenhum export/poll/download
// real. `uploadTextToWorkerKV` usa `node:https` (não `fetch`), então mesmo
// com --push nenhum desses 2 testes chega a tocar rede de escrita real: o
// caminho sem --push nunca invoca pushCohortsToKV, e o caminho com --push
// aciona o guard anti-clobber (universe=0) ANTES de chamar uploadFn.
//
// #6222: os dois testes abaixo passam `--db-path` apontando pra um path
// dentro de um tmpdir isolado (nunca criado, sempre "ausente" pro
// `fetchAdminOptOutEmails`) — SEM isso, `main()` cai no `DEFAULT_DB_PATH`
// real. Numa máquina onde `data/` existe (editor, `helios`), o store de
// produção tem opt-outs administrativos reais (`sends_count > 0` +
// blacklisted/unsubscribed), e `applyAdminOptOuts` os ADICIONA ao
// agregado mesmo com campanhas=[] — `cohorts.universe` deixa de ser 0, o
// guard anti-clobber NUNCA dispara, e (no teste com `--push`) o código
// segue até `uploadTextToWorkerKV` com credenciais fake, batendo na API
// real da Cloudflare (404). `--db-path` isolado torna os dois testes
// determinísticos independente da forma do ambiente (`data/` presente ou
// não) — ver `main: --db-path aponta pra store isolado…` abaixo pro
// cenário inverso (opt-outs presentes) coberto explicitamente.

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) originals[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("main: sem --push, backfill real (mockado) completa sem NUNCA acionar o guard/escrita de KV — dry-run preservado (#5015)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ campaigns: [] }), { status: 200 })) as typeof fetch;
  try {
    await withTmpDbDir(async (dbPath) => {
      await withEnv(
        { BREVO_CLARICE_API_KEY: "fake-key-test", CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_WORKERS_TOKEN: undefined },
        async () => {
          // Sem --push, o guard de credenciais Cloudflare (que lançaria) nem é
          // avaliado — completa normalmente mesmo com as credenciais ausentes.
          // --db-path isolado (#6222): nunca lê o DEFAULT_DB_PATH real.
          await main(["--db-path", dbPath]);
        },
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("main: --push com backfill vazio (universe=0) aciona o guard anti-clobber e sai (exit 1) — nunca chega a gravar no KV (#5015)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ campaigns: [] }), { status: 200 })) as typeof fetch;
  let exitCode: number | undefined;
  const originalExit = process.exit;
  // @ts-expect-error — mock de process.exit só para este teste
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  try {
    await withTmpDbDir(async (dbPath) => {
      await withEnv(
        {
          BREVO_CLARICE_API_KEY: "fake-key-test",
          CLOUDFLARE_ACCOUNT_ID: "fake-account",
          CLOUDFLARE_WORKERS_TOKEN: "fake-token",
        },
        async () => {
          // --db-path isolado (#6222): nunca lê o DEFAULT_DB_PATH real —
          // sem opt-outs administrativos reais, universe permanece 0 e o
          // guard dispara determinísticamente independente do ambiente.
          await assert.rejects(main(["--push", "--db-path", dbPath]), /__exit__/);
        },
      );
    });
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
    globalThis.fetch = originalFetch;
  }
});

test("main: --push sem CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN falha ANTES do backfill (fail-fast, mesmo racional do v1)", async () => {
  let exitCode: number | undefined;
  const originalExit = process.exit;
  // @ts-expect-error — mock de process.exit só para este teste
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  try {
    await withEnv(
      {
        BREVO_CLARICE_API_KEY: "fake-key-test",
        CLOUDFLARE_ACCOUNT_ID: undefined,
        CLOUDFLARE_WORKERS_TOKEN: undefined,
      },
      async () => {
        // Sem mock de fetch: se o código chegasse a tentar o backfill, este
        // teste falharia por rede real indisponível/lenta — a ausência do
        // mock É a prova de que o fail-fast acontece antes de qualquer rede.
        await assert.rejects(main(["--push"]), /__exit__/);
      },
    );
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});

// ─── Regressão #6222 — reprodução determinística do "grupo A" via fixture ──
//
// Reproduz, sem tocar `data/` real nem rede, o cenário exato que o #6222
// documentou: um store com opt-outs administrativos reais (`sends_count >
// 0` + blacklisted/unsubscribed) faz `applyAdminOptOuts` ADICIONAR entradas
// ao agregado mesmo com `listSentCampaigns` mockado pra `[]` —
// `cohorts.universe` deixa de ser 0, o guard anti-clobber (linha ~755)
// NUNCA dispara, e `--push` segue até `uploadTextToWorkerKV` (node:https,
// fora do mock de `fetch`). Duas garantias nesta ordem:
//   1. `--db-path` (fixture isolada) reproduz a condição "data/ real" sem
//      depender da forma do ambiente — passa igual em CI, na máquina do
//      editor, ou num worktree limpo.
//   2. O `installNetworkRequestGuard` file-wide (topo do arquivo) intercepta
//      `https.request` ANTES de qualquer socket abrir — a asserção espera o
//      erro do PRÓPRIO guard (`[network-guard #6222]`), nunca um erro de
//      rede real (timeout, DNS, 404 da Cloudflare) — prova que a chamada é
//      barrada em processo, não que ela "aconteceu e falhou".
test("main: opt-outs administrativos reais (via --db-path) tornam universe != 0 e o código chega em uploadTextToWorkerKV — bloqueado pelo guard de rede, nunca pelo anti-clobber (#6222)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ campaigns: [] }), { status: 200 })) as typeof fetch;
  let exitCode: number | undefined;
  const originalExit = process.exit;
  // @ts-expect-error — mock de process.exit só para este teste
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  try {
    await withTmpDbDir(async (dbPath) => {
      const db = openClariceDb(dbPath);
      db.exec(
        `INSERT INTO clarice_users (email, email_blacklisted, unsubscribed, sends_count, updated_at) VALUES
          ('opt-out-administrativo@x.com', 1, 0, 1, '${new Date().toISOString()}')`,
      );
      db.close();

      await withEnv(
        {
          BREVO_CLARICE_API_KEY: "fake-key-test",
          CLOUDFLARE_ACCOUNT_ID: "fake-account",
          CLOUDFLARE_WORKERS_TOKEN: "fake-token",
        },
        async () => {
          // Confirma a pré-condição do cenário ANTES de rodar main(): com
          // este store, o agregado não fica vazio mesmo com campanhas=[].
          const admin = fetchAdminOptOutEmails(dbPath);
          if (!admin.available) throw new Error("esperado available=true (pré-condição do cenário)");
          assert.equal(admin.emails.size, 1, "pré-condição do cenário: opt-out real presente no store");

          // Se o guard anti-clobber (bug do #6222) disparasse aqui, o erro
          // seria "__exit__" com exitCode 1 SEM nunca tocar https.request —
          // a asserção abaixo espera o erro do NETWORK GUARD, provando que
          // o código passou do guard anti-clobber e tentou mesmo escrever.
          await assert.rejects(main(["--push", "--db-path", dbPath]), /\[network-guard #6222\]/);
        },
      );
    });
  } finally {
    process.exit = originalExit;
    globalThis.fetch = originalFetch;
  }
  assert.equal(exitCode, undefined, "process.exit nunca deveria ter sido chamado — o guard de rede lança antes");
});
