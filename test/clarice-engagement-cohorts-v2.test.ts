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
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  DEFAULT_REFETCH_WINDOW_DAYS,
  main,
  type CampaignExportClient,
  type CampaignCache,
  type SentCampaignRef,
} from "../scripts/clarice-engagement-cohorts-v2.ts";
import { computeCohorts, type ContactEngagement } from "../scripts/clarice-engagement-cohorts.ts";
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

test("fetchAdminOptOutEmails: lê email_blacklisted=1 OU unsubscribed=1 do store local", async () => {
  await withTmpDbDir((dbPath) => {
    const db = openClariceDb(dbPath);
    const now = new Date().toISOString();
    db.exec(
      `INSERT INTO clarice_users (email, email_blacklisted, unsubscribed, updated_at) VALUES
        ('blacklisted@x.com', 1, 0, '${now}'),
        ('UNSUB@X.COM', 0, 1, '${now}'),
        ('clean@x.com', 0, 0, '${now}')`,
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
        `INSERT INTO clarice_users (email, email_blacklisted, unsubscribed, updated_at) VALUES
          ('nunca-exportado@x.com', 1, 0, '${new Date().toISOString()}')`,
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

test("main: --limit inválido (typo de valor) LANÇA — não vira 'sem limite' silenciosamente (#4497)", async () => {
  // getIntArg lança ANTES do check de BREVO_CLARICE_API_KEY (não precisa
  // mockar client/fetch nem definir a key pra provar o throw).
  await assert.rejects(main(["--limit", "abc"]), /inteiro/);
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
