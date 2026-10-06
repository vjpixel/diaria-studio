/**
 * #9762 — findings do review de fleet da PR #9782 sobre o export pendente
 * retomável e a marca d'água do incremental (complementa
 * `clarice-sync-catchup-pending-9762.test.ts`).
 *
 * Letras = findings consolidados do review (A–M).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  runOpensCatchup,
  loadPendingExport,
  pendingExportPath,
  checkpointPathsForDb,
  sweepExpiredPendingExports,
  isAccountRateLimit,
  main,
  PENDING_EXPORT_MAX_AGE_MS,
  PENDING_EXPORT_MAX_5XX_RUNS,
} from "../scripts/clarice-sync-brevo.ts";
import {
  loadCampaignCache,
  saveCampaignCache,
  campaignCachePath,
  type CampaignExportClient,
  type SentCampaignRef,
} from "../scripts/clarice-engagement-cohorts-v2.ts";
import { BrevoRateLimitError, brevoGet } from "../scripts/lib/brevo-client.ts";
import { extractOpensCatchupStatus } from "../scripts/lib/extract-opens-catchup-status.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";

const noSleep = async (): Promise<void> => {};
const FAST_POLL = { maxAttempts: 2, intervalMs: 1, sleep: noSleep };
const CSV = "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-10-01 10:00:00,1\n";

function campaign(id: number, ageDays: number): SentCampaignRef {
  return { id, name: `Campanha ${id}`, sentDate: new Date(Date.now() - ageDays * 86_400_000).toISOString() };
}
function tmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}
function writePending(cacheDir: string, campaignId: number, processId: number, ageMs: number, extra = {}): void {
  mkdirSync(resolve(cacheDir, "pending"), { recursive: true });
  writeFileSync(
    pendingExportPath(campaignId, cacheDir),
    JSON.stringify({ campaignId, processId, requestedAt: new Date(Date.now() - ageMs).toISOString(), ...extra }),
  );
}
function baseDeps(client: CampaignExportClient, cacheDir: string) {
  return {
    client,
    fetchContact: async (email: string) => ({ email, statistics: {} }),
    upsert: () => {},
    cacheDir,
    poll: FAST_POLL,
    sleep: noSleep,
  };
}

/** Cliente fake: processos por pid, contadores de chamada. */
function fakeClient(opts: {
  campaigns: SentCampaignRef[];
  newPid?: number;
  poll?: (pid: number | string) => Promise<{ status: string; exportUrl?: string }>;
  exportRecipients?: (id: number) => Promise<{ processId: number }>;
}) {
  const calls = { exports: [] as number[], polls: [] as Array<number | string> };
  const client: CampaignExportClient = {
    async listSentCampaigns() {
      return opts.campaigns;
    },
    async exportRecipients(id) {
      calls.exports.push(id);
      return opts.exportRecipients ? opts.exportRecipients(id) : { processId: opts.newPid ?? 900 + id };
    },
    async pollProcess(pid) {
      calls.polls.push(pid);
      return opts.poll ? opts.poll(pid) : { status: "completed", exportUrl: `fake://${pid}` };
    },
    async downloadCsv() {
      return CSV;
    },
  };
  return { client, calls };
}

// ─── B: 5xx não é 429 ─────────────────────────────────────────────────────

test("#9762 B: brevoGet marca o status que esgotou o retry (5xx ≠ 429)", async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  let seq: number[] = [];
  globalThis.fetch = (async () => {
    const status = seq.shift() ?? 503;
    return new Response("", { status });
  }) as unknown as typeof globalThis.fetch;

  seq = [503, 503, 503, 503];
  const e5 = await brevoGet("k", "/processes/1", noSleep).catch((e) => e);
  assert.ok(e5 instanceof BrevoRateLimitError);
  assert.equal(e5.status, 503);
  assert.equal(isAccountRateLimit(e5), false, "5xx repetido não abre o circuito de rate limit");

  seq = [429, 503, 503, 503];
  const e4 = await brevoGet("k", "/processes/1", noSleep).catch((e) => e);
  assert.equal(e4.status, 429, "qualquer 429 na invocação vence");
  assert.equal(isAccountRateLimit(e4), true);
});

test("#9762 B: 5xx num export NÃO suspende os exports das demais campanhas", async () => {
  const cacheDir = tmp("catchup-9762b-5xx-");
  const { client, calls } = fakeClient({
    campaigns: [campaign(1, 1), campaign(2, 2), campaign(3, 3)],
    exportRecipients: async (id) => {
      if (id === 1) throw new BrevoRateLimitError("Brevo GET HTTP 503", null, 503);
      return { processId: 900 + id };
    },
  });
  const r = await runOpensCatchup({ ...baseDeps(client, cacheDir), concurrency: 1 });
  assert.deepEqual(calls.exports, [1, 2, 3]);
  assert.equal(r.rateLimited, false);
  assert.equal(r.campaignsFailed, 1);
});

test("#9762 B: pendente com 5xx segue pendente com contador e é descartado no limite (1 export novo)", async () => {
  const cacheDir = tmp("catchup-9762b-pending5xx-");
  writePending(cacheDir, 1, 77, 86_400_000);
  const { client, calls } = fakeClient({
    campaigns: [campaign(1, 1)],
    poll: async (pid) => {
      if (pid === 77) throw new BrevoRateLimitError("Brevo GET /processes/77 HTTP 502", null, 502);
      return { status: "completed", exportUrl: `fake://${pid}` };
    },
  });
  for (let run = 1; run < PENDING_EXPORT_MAX_5XX_RUNS; run++) {
    const r = await runOpensCatchup(baseDeps(client, cacheDir));
    assert.equal(r.campaignsFailed, 1);
    assert.equal(r.campaignsPending, 1);
    assert.equal(r.rateLimited, false);
    assert.equal(loadPendingExport(1, cacheDir)?.serverErrors, run);
  }
  assert.equal(calls.exports.length, 0, "enquanto dentro do limite, nenhum export novo");
  const last = await runOpensCatchup(baseDeps(client, cacheDir));
  assert.equal(calls.exports.length, 1, "no limite: descarta e dispara exatamente 1 export novo");
  assert.equal(last.campaignsFailed, 0);
  assert.equal(existsSync(pendingExportPath(1, cacheDir)), false);
});

// ─── C: pendente que falha não vira sucesso silencioso via cache ──────────

test("#9762 C: pendente que falha (não-retryable) não retorna o cache antigo como sucesso", async () => {
  const cacheDir = tmp("catchup-9762c-");
  saveCampaignCache(
    { campaignId: 1, campaignName: "C1", exportedAt: "2026-10-01T00:00:00.000Z", recipients: {} },
    cacheDir,
  );
  writePending(cacheDir, 1, 77, 86_400_000);
  const { client } = fakeClient({
    campaigns: [campaign(1, 1)],
    poll: async () => {
      throw new Error("GET /processes/77 retornou 404 (processo desconhecido).");
    },
    exportRecipients: async () => {
      throw new Error("falha de rede no export novo");
    },
  });
  const r = await runOpensCatchup({ ...baseDeps(client, cacheDir), maxRefreshPerRun: 1 });
  assert.equal(r.campaignsFailed, 1, "o alarme precisa ver a falha");
  assert.equal(r.campaignsStaleFallback, 1);
});

// ─── D: exportedAt do pendente retomado ───────────────────────────────────

test("#9762 D: pendente retomado grava exportedAt = requestedAt (não agora)", async () => {
  const cacheDir = tmp("catchup-9762d-");
  writePending(cacheDir, 1, 77, 3 * 86_400_000);
  const requestedAt = loadPendingExport(1, cacheDir)!.requestedAt;
  const { client } = fakeClient({ campaigns: [campaign(1, 1)] });
  await runOpensCatchup({ ...baseDeps(client, cacheDir), now: () => "2099-01-01T00:00:00.000Z" });
  assert.equal(loadCampaignCache(1, cacheDir)?.exportedAt, requestedAt);
});

// ─── G/J: pendente expirado, inválido, corrompido, 404 ────────────────────

test("#9762 G: pendente expirado é descartado e a campanha da janela recebe 1 export novo", async () => {
  const cacheDir = tmp("catchup-9762g-expired-");
  writePending(cacheDir, 1, 77, PENDING_EXPORT_MAX_AGE_MS + 3_600_000);
  const { client, calls } = fakeClient({ campaigns: [campaign(1, 1)] });
  const r = await runOpensCatchup(baseDeps(client, cacheDir));
  assert.deepEqual(calls.exports, [1]);
  assert.ok(!calls.polls.includes(77), "o processo expirado nunca é consultado");
  assert.equal(r.campaignsFailed, 0);
});

test("#9762: pendente cujo processo dá 404 → descartado e exatamente 1 export novo", async () => {
  const cacheDir = tmp("catchup-9762-404pid-");
  writePending(cacheDir, 1, 77, 86_400_000);
  const { client, calls } = fakeClient({
    campaigns: [campaign(1, 1)],
    poll: async (pid) => {
      if (pid === 77) throw new Error("GET /processes/77 retornou 404 (processo desconhecido).");
      return { status: "completed", exportUrl: `fake://${pid}` };
    },
  });
  const r = await runOpensCatchup(baseDeps(client, cacheDir));
  assert.deepEqual(calls.exports, [1]);
  assert.equal(r.campaignsFailed, 0);
  assert.equal(r.openersFound, 1);
  assert.equal(existsSync(pendingExportPath(1, cacheDir)), false);
});

test("#9762 F/G: pendente com JSON corrompido é descartado com log e não derruba o run", async (t) => {
  const cacheDir = tmp("catchup-9762-corrupt-");
  mkdirSync(resolve(cacheDir, "pending"), { recursive: true });
  writeFileSync(pendingExportPath(1, cacheDir), "{nao-json");
  const errs: string[] = [];
  t.mock.method(console, "error", (m: string) => errs.push(String(m)));
  const { client, calls } = fakeClient({ campaigns: [campaign(1, 1)] });
  const r = await runOpensCatchup(baseDeps(client, cacheDir));
  assert.deepEqual(calls.exports, [1]);
  assert.equal(r.campaignsFailed, 0);
  assert.ok(errs.some((m) => m.includes("pendente da campanha 1") && m.includes("descartado")));
});

test("#9762 F: pendente com campaignId/requestedAt inválidos é rejeitado", () => {
  const cacheDir = tmp("catchup-9762-invalid-");
  mkdirSync(resolve(cacheDir, "pending"), { recursive: true });
  writeFileSync(pendingExportPath(1, cacheDir), JSON.stringify({ campaignId: 2, processId: 5, requestedAt: new Date().toISOString() }));
  assert.equal(loadPendingExport(1, cacheDir), null);
  writeFileSync(pendingExportPath(1, cacheDir), JSON.stringify({ campaignId: 1, processId: 5, requestedAt: "ontem" }));
  assert.equal(loadPendingExport(1, cacheDir), null);
});

test("#9762 G: campanha FORA da janela com pendente inválido nunca dispara export novo (e conta como falha)", async () => {
  const cacheDir = tmp("catchup-9762g-outside-");
  mkdirSync(resolve(cacheDir, "pending"), { recursive: true });
  writeFileSync(pendingExportPath(9, cacheDir), "{nao-json");
  const { client, calls } = fakeClient({ campaigns: [campaign(9, 20)] });
  const r = await runOpensCatchup(baseDeps(client, cacheDir));
  assert.equal(calls.exports.length, 0);
  assert.equal(r.campaignsFailed, 1);
  assert.equal(existsSync(pendingExportPath(9, cacheDir)), false, "arquivo inválido removido");
});

test("#9762 J: varredura apaga pendente expirado mesmo de campanha que sumiu da listagem", () => {
  const cacheDir = tmp("catchup-9762j-");
  writePending(cacheDir, 404, 1, PENDING_EXPORT_MAX_AGE_MS + 60_000);
  writePending(cacheDir, 405, 2, 60_000);
  mkdirSync(resolve(cacheDir, "pending"), { recursive: true });
  const corruptOld = resolve(cacheDir, "pending", "406.json");
  writeFileSync(corruptOld, "{x");
  const old = (Date.now() - PENDING_EXPORT_MAX_AGE_MS - 60_000) / 1000;
  utimesSync(corruptOld, old, old);
  const removed = sweepExpiredPendingExports(cacheDir, Date.now());
  assert.equal(removed, 2);
  assert.equal(existsSync(pendingExportPath(404, cacheDir)), false);
  assert.equal(existsSync(pendingExportPath(405, cacheDir)), true, "pendente recente fica");
  assert.equal(existsSync(corruptOld), false, "ilegível velho (pelo mtime) sai");
});

// ─── H: erro local no resume ─────────────────────────────────────────────

test("#9762 H: falha LOCAL ao gravar o cache no resume mantém o pendente e não dispara export novo", async () => {
  const cacheDir = tmp("catchup-9762h-");
  writePending(cacheDir, 1, 77, 86_400_000);
  // Diretório no lugar do arquivo de cache → a gravação falha (erro local).
  mkdirSync(campaignCachePath(1, cacheDir), { recursive: true });
  const { client, calls } = fakeClient({ campaigns: [campaign(1, 1)] });
  const r = await runOpensCatchup(baseDeps(client, cacheDir));
  assert.equal(calls.exports.length, 0);
  assert.equal(r.campaignsFailed, 1);
  assert.equal(r.campaignsPending, 1);
  assert.equal(loadPendingExport(1, cacheDir)?.processId, 77);
});

// ─── K: circuito aberto não consulta pendentes; pendentes contam no teto ──

test("#9762 K: depois de um 429, pendentes não são consultados", async () => {
  const cacheDir = tmp("catchup-9762k-429-");
  writePending(cacheDir, 2, 77, 86_400_000);
  const { client, calls } = fakeClient({
    campaigns: [campaign(1, 1), campaign(2, 2)],
    exportRecipients: async () => {
      throw new BrevoRateLimitError("Brevo API 429", 2730, 429);
    },
  });
  const r = await runOpensCatchup({ ...baseDeps(client, cacheDir), concurrency: 1 });
  assert.equal(r.rateLimited, true);
  assert.deepEqual(calls.polls, [], "GET /processes também gasta quota — não consulta com o circuito aberto");
  assert.equal(loadPendingExport(2, cacheDir)?.processId, 77, "pendente preservado pro próximo run");
});

test("#9762 K: pendentes consomem o teto maxRefreshPerRun antes das re-exportações forçadas", async () => {
  const cacheDir = tmp("catchup-9762k-cap-");
  for (const id of [1, 2, 3]) {
    saveCampaignCache(
      { campaignId: id, campaignName: `C${id}`, exportedAt: "2026-10-01T00:00:00.000Z", recipients: {} },
      cacheDir,
    );
  }
  writePending(cacheDir, 9, 77, 86_400_000); // fora da janela
  const { client, calls } = fakeClient({ campaigns: [campaign(1, 1), campaign(2, 2), campaign(3, 3), campaign(9, 20)] });
  const r = await runOpensCatchup({ ...baseDeps(client, cacheDir), maxRefreshPerRun: 2 });
  assert.equal(calls.exports.length, 1, "teto 2 − 1 pendente = 1 re-export forçado");
  assert.deepEqual(calls.polls.filter((p) => p === 77), [77]);
  assert.equal(r.campaignsFailed, 0);
});

// ─── L: --limit prioriza supressões ──────────────────────────────────────

test("#9762 L: com --limit, quem tem bounce/descadastro é re-buscado primeiro", async () => {
  const cacheDir = tmp("catchup-9762l-");
  const client: CampaignExportClient = {
    async listSentCampaigns() {
      return [campaign(1, 1)];
    },
    async exportRecipients() {
      return { processId: 1 };
    },
    async pollProcess() {
      return { status: "completed", exportUrl: "fake://1" };
    },
    async downloadCsv() {
      return (
        "Email_ID,Delivered_Date,Total Opens,Hard_Bounce_Date\n" +
        "abre@x.com,2026-10-01 10:00:00,1,\n" +
        "bounce@x.com,,0,2026-10-03 06:04:30\n"
      );
    },
  };
  const fetched: string[] = [];
  await runOpensCatchup({
    ...baseDeps(client, cacheDir),
    fetchContact: async (email) => {
      fetched.push(email);
      return { email, statistics: {} };
    },
    limit: 1,
  });
  assert.deepEqual(fetched, ["bounce@x.com"]);
});

// ─── M: denominador do alarme ────────────────────────────────────────────

test("#9762 M: status do catch-up inclui pendentes fora da janela no denominador", () => {
  const log = JSON.stringify({
    opens_catchup: { ok: true, result: { campaignsFailed: 3, campaignsInWindow: 2, campaignsPendingOutsideWindow: 1 } },
  });
  const s = extractOpensCatchupStatus(log, new Date("2026-10-06T00:00:00Z"));
  assert.equal(s.status, "error");
  assert.match(s.error ?? "", /3\/3 campanha\(s\) processada\(s\) \(1 pendente\(s\) fora da janela\)/);
});

// ─── A/E: quando a marca d'água NÃO pode avançar ──────────────────────────

async function withMainMocks(
  t: import("node:test").TestContext,
  contacts: Array<{ id: number; email: string }>,
  contactFetch: (id: number) => Response,
): Promise<{ dbPath: string; watermark: string; checkpointInc: string; listingUrls: string[] }> {
  const dir = tmp("sync-brevo-9762-review-");
  const dbPath = resolve(dir, "store.db");
  const setup = openClariceDb(dbPath);
  setup
    .prepare("INSERT INTO clarice_users (email, tier, brevo_modified_at) VALUES ('a@x.com', 2, '2026-10-01T00:00:00.000Z')")
    .run();
  setup.close();
  const listingUrls: string[] = [];
  const origFetch = globalThis.fetch;
  const origKey = process.env.BREVO_CLARICE_API_KEY;
  const origExit = process.exitCode;
  process.env.BREVO_CLARICE_API_KEY = "test-key-9762";
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/contacts?")) {
      listingUrls.push(u);
      return new Response(JSON.stringify({ contacts }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const m = /\/contacts\/(\d+)/.exec(u);
    if (m) return contactFetch(Number(m[1]));
    throw new Error(`fetch inesperado no mock: ${u}`);
  }) as unknown as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = origFetch;
    process.exitCode = origExit;
    if (origKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origKey;
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const { watermark, checkpointInc } = checkpointPathsForDb(dbPath);
  return { dbPath, watermark, checkpointInc, listingUrls };
}

const okContact = (id: number): Response =>
  new Response(
    JSON.stringify({ email: `c${id}@x.com`, emailBlacklisted: false, listIds: [], modifiedAt: "2026-10-02T00:00:00.000Z", statistics: {} }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

test("#9762 A: --modified-since explícito não avança a marca d'água existente", async (t) => {
  const { dbPath, watermark } = await withMainMocks(t, [{ id: 1, email: "a@x.com" }], okContact);
  writeFileSync(watermark, JSON.stringify({ listingStartedAt: "2026-09-01T00:00:00.000Z" }));
  await main(["--db", dbPath, "--modified-since", "2026-10-05T00:00:00.000Z", "--no-catch-opens"]);
  assert.equal(JSON.parse(readFileSync(watermark, "utf8")).listingStartedAt, "2026-09-01T00:00:00.000Z");
});

test("#9762 E: run interrompido (exitCode 2) não grava marca d'água", async (t) => {
  const { dbPath, watermark } = await withMainMocks(t, [{ id: 1, email: "a@x.com" }], () => {
    throw new Error("boom no GET do contato");
  });
  await main(["--db", dbPath, "--incremental", "--no-catch-opens"]);
  assert.equal(process.exitCode, 2);
  assert.equal(existsSync(watermark), false);
});

test("#9762 E: --limit não grava marca d'água", async (t) => {
  const { dbPath, watermark } = await withMainMocks(
    t,
    [
      { id: 1, email: "a@x.com" },
      { id: 2, email: "b@x.com" },
    ],
    okContact,
  );
  await main(["--db", dbPath, "--incremental", "--no-catch-opens", "--limit", "1"]);
  assert.equal(existsSync(watermark), false);
});

test("#9762 E: checkpoint legado (sem listingStartedAt) não grava marca d'água", async (t) => {
  const { dbPath, watermark, checkpointInc, listingUrls } = await withMainMocks(t, [], okContact);
  writeFileSync(
    checkpointInc,
    JSON.stringify({
      listingComplete: true,
      ids: [{ id: 1, email: "a@x.com" }],
      doneIds: [],
      modifiedSince: "2026-09-30T00:00:00.000Z",
    }),
  );
  await main(["--db", dbPath, "--incremental", "--no-catch-opens"]);
  assert.equal(listingUrls.length, 0, "retomou o checkpoint (listagem já completa)");
  assert.equal(existsSync(checkpointInc), false, "run concluído limpou o checkpoint");
  assert.equal(existsSync(watermark), false);
});

// ─── #9783: resíduos do re-review ─────────────────────────────────────────

test("#9783 1: resume por --incremental de checkpoint de --modified-since explícito não avança a marca d'água", async (t) => {
  const { dbPath, watermark, checkpointInc } = await withMainMocks(t, [], okContact);
  writeFileSync(watermark, JSON.stringify({ listingStartedAt: "2026-09-01T00:00:00.000Z" }));
  writeFileSync(
    checkpointInc,
    JSON.stringify({
      listingComplete: true,
      ids: [{ id: 1, email: "a@x.com" }],
      doneIds: [],
      modifiedSince: "2026-10-05T00:00:00.000Z",
      listingStartedAt: "2026-10-06T00:00:00.000Z",
      explicit: true,
    }),
  );
  await main(["--db", dbPath, "--incremental", "--no-catch-opens"]);
  assert.equal(existsSync(checkpointInc), false, "run concluiu");
  assert.equal(JSON.parse(readFileSync(watermark, "utf8")).listingStartedAt, "2026-09-01T00:00:00.000Z");
});

test("#9783 1: checkpoint incremental sem `explicit` ainda avança a marca d'água", async (t) => {
  const { dbPath, watermark, checkpointInc } = await withMainMocks(t, [], okContact);
  writeFileSync(
    checkpointInc,
    JSON.stringify({
      listingComplete: true,
      ids: [{ id: 1, email: "a@x.com" }],
      doneIds: [],
      modifiedSince: "2026-09-30T00:00:00.000Z",
      listingStartedAt: "2026-10-06T00:00:00.000Z",
    }),
  );
  await main(["--db", dbPath, "--incremental", "--no-catch-opens"]);
  assert.equal(JSON.parse(readFileSync(watermark, "utf8")).listingStartedAt, "2026-10-06T00:00:00.000Z");
});

test("#9783 2: blip de rede (TypeError) no poll mantém o pendente fora da janela", async () => {
  const cacheDir = tmp("catchup-9783-net-");
  writePending(cacheDir, 1, 77, 86_400_000);
  const { client, calls } = fakeClient({
    campaigns: [campaign(1, 60)],
    poll: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const r = await runOpensCatchup({ ...baseDeps(client, cacheDir), windowDays: 7 } as never);
  assert.equal(r.campaignsFailed, 1);
  assert.equal(calls.exports.length, 0);
  assert.equal(loadPendingExport(1, cacheDir)?.serverErrors, 1, "pendente preservado com contador");
});
