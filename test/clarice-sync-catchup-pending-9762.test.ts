/**
 * #9762 — resíduo depois do PR #9766: o catch-up do store Clarice perdia
 * campanhas e descadastros.
 *
 * 1. Export que não completava (`PollBudgetExhaustedError`, CSV 404, 429)
 *    era redisparado do zero no run seguinte — o processo anterior terminava
 *    sozinho e ninguém o lia, e a campanha podia sair da janela sem nunca ser
 *    lida. Agora o `processId` fica PENDENTE em disco e é retomado; o cache
 *    antigo vale como fallback; um 429 suspende exports novos no run.
 * 2. Contato com `emailBlacklisted=true` na Brevo seguia `send_eligible=1`:
 *    (a) quem dava bounce num envio não era re-buscado pelo catch-up (não
 *    aparece como entregue nem como abertura); (b) a âncora do incremental
 *    vinha de MAX(brevo_modified_at), que avança com contatos buscados DEPOIS
 *    da listagem — tudo modificado nesse intervalo era pulado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  runOpensCatchup,
  collectSuppressedEmails,
  anchorForIncremental,
  loadWatermark,
  loadPendingExport,
  pendingExportPath,
  checkpointPathsForDb,
  main,
  CSV_404_RETRY_DELAYS_MS,
} from "../scripts/clarice-sync-brevo.ts";
import {
  loadCampaignCache,
  saveCampaignCache,
  type CampaignExportClient,
  type SentCampaignRef,
} from "../scripts/clarice-engagement-cohorts-v2.ts";
import { BrevoRateLimitError } from "../scripts/lib/brevo-client.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";

const noSleep = async (): Promise<void> => {};
const FAST_POLL = { maxAttempts: 2, intervalMs: 1, sleep: noSleep };

function campaign(id: number, ageDays: number): SentCampaignRef {
  return { id, name: `Campanha ${id}`, sentDate: new Date(Date.now() - ageDays * 86_400_000).toISOString() };
}

const CSV = "Email_ID,Delivered_Date,Total Opens\na@x.com,2026-10-01 10:00:00,1\n";

function tmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

// ─── Item 1: export pendente ──────────────────────────────────────────────

test("#9762: export que esgota o poll fica PENDENTE e o run seguinte retoma o MESMO processo, sem redisparar", async () => {
  const cacheDir = tmp("catchup-9762-pending-");
  const c1 = campaign(1, 2);
  let exportCalls = 0;
  let brevoDone = false;
  const client: CampaignExportClient = {
    async listSentCampaigns() {
      return [c1];
    },
    async exportRecipients() {
      exportCalls++;
      return { processId: 4285 };
    },
    async pollProcess(pid) {
      assert.equal(pid, 4285, "o run 2 consulta o processo disparado no run 1");
      return brevoDone ? { status: "completed", exportUrl: "fake://4285" } : { status: "in_process" };
    },
    async downloadCsv() {
      return CSV;
    },
  };
  const deps = {
    client,
    fetchContact: async (email: string) => ({ email, statistics: {} }),
    upsert: () => {},
    cacheDir,
    poll: FAST_POLL,
    sleep: noSleep,
  };

  const run1 = await runOpensCatchup(deps);
  assert.equal(run1.campaignsFailed, 1);
  assert.equal(run1.campaignsPending, 1);
  assert.equal(loadPendingExport(1, cacheDir)?.processId, 4285);
  assert.equal(loadCampaignCache(1, cacheDir), null, "nada gravado como sincronizado");

  brevoDone = true; // a Brevo terminou o export entre um run e outro
  const run2 = await runOpensCatchup(deps);
  assert.equal(exportCalls, 1, "nenhum export novo — o pendente foi retomado");
  assert.equal(run2.campaignsFailed, 0);
  assert.equal(run2.campaignsPending, 0);
  assert.equal(run2.openersFound, 1);
  assert.equal(existsSync(pendingExportPath(1, cacheDir)), false, "pendência limpa após ler o CSV");
  assert.ok(loadCampaignCache(1, cacheDir), "cache gravado só depois do export lido");
});

test("#9762: export pendente é retomado mesmo depois que a campanha saiu da janela de dias", async () => {
  const cacheDir = tmp("catchup-9762-outside-");
  const old = campaign(9, 20); // fora da janela default de 7 dias
  mkdirSync(resolve(cacheDir, "pending"), { recursive: true });
  writeFileSync(
    pendingExportPath(9, cacheDir),
    JSON.stringify({ campaignId: 9, processId: 77, requestedAt: new Date(Date.now() - 86_400_000).toISOString() }),
  );
  let exportCalls = 0;
  const client: CampaignExportClient = {
    async listSentCampaigns() {
      return [old];
    },
    async exportRecipients() {
      exportCalls++;
      return { processId: 1 };
    },
    async pollProcess() {
      return { status: "completed", exportUrl: "fake://77" };
    },
    async downloadCsv() {
      return CSV;
    },
  };
  const r = await runOpensCatchup({
    client,
    fetchContact: async (email) => ({ email, statistics: {} }),
    upsert: () => {},
    cacheDir,
    poll: FAST_POLL,
  });
  assert.equal(r.campaignsInWindow, 0);
  assert.equal(r.campaignsPendingOutsideWindow, 1);
  assert.equal(r.campaignsFailed, 0);
  assert.equal(r.openersFound, 1);
  assert.equal(exportCalls, 0);
});

test("#9762: refresh que falha cai no cache antigo (sem tocar exportedAt) e a campanha segue contando como falha", async () => {
  const cacheDir = tmp("catchup-9762-stale-");
  const c1 = campaign(1, 2);
  saveCampaignCache(
    {
      campaignId: 1,
      campaignName: "Campanha 1",
      exportedAt: "2026-10-01T00:00:00.000Z",
      recipients: { "velho@x.com": { delivered: true, opened: true, bounced: false, unsubscribed: false } },
    },
    cacheDir,
  );
  const client: CampaignExportClient = {
    async listSentCampaigns() {
      return [c1];
    },
    async exportRecipients() {
      throw new Error("falha de rede");
    },
    async pollProcess() {
      throw new Error("não deveria chegar aqui");
    },
    async downloadCsv() {
      throw new Error("não deveria chegar aqui");
    },
  };
  const upserted: string[] = [];
  const r = await runOpensCatchup({
    client,
    fetchContact: async (email) => ({ email, statistics: {} }),
    upsert: (cols) => upserted.push(cols.email),
    cacheDir,
    maxRefreshPerRun: 0, // força refresh de toda campanha da janela
  });
  assert.equal(r.campaignsFailed, 1, "o alarme (#5339) continua vendo a falha");
  assert.equal(r.campaignsStaleFallback, 1);
  assert.deepEqual(upserted, ["velho@x.com"], "destinatários do cache antigo ainda são re-buscados");
  assert.equal(loadCampaignCache(1, cacheDir)?.exportedAt, "2026-10-01T00:00:00.000Z");
});

test("#9762: 429 abre o circuito — nenhum export NOVO é disparado no resto do run", async () => {
  const cacheDir = tmp("catchup-9762-429-");
  let exportCalls = 0;
  const client: CampaignExportClient = {
    async listSentCampaigns() {
      return [campaign(1, 1), campaign(2, 2), campaign(3, 3)];
    },
    async exportRecipients() {
      exportCalls++;
      throw new BrevoRateLimitError("Brevo POST HTTP 429 — Retry-After 2730s", 2730);
    },
    async pollProcess() {
      throw new Error("não deveria chegar aqui");
    },
    async downloadCsv() {
      throw new Error("não deveria chegar aqui");
    },
  };
  const r = await runOpensCatchup({
    client,
    fetchContact: async (email) => ({ email, statistics: {} }),
    upsert: () => {},
    cacheDir,
    concurrency: 1,
  });
  assert.equal(exportCalls, 1, "só o 1º export bate na Brevo; os demais esperam o próximo run");
  assert.equal(r.rateLimited, true);
  assert.equal(r.campaignsFailed, 3);
});

test("#9762: CSV que devolve 404 logo após o processo completar é baixado de novo antes de desistir", async () => {
  const cacheDir = tmp("catchup-9762-404-");
  let downloads = 0;
  const slept: number[] = [];
  const client: CampaignExportClient = {
    async listSentCampaigns() {
      return [campaign(1, 1)];
    },
    async exportRecipients() {
      return { processId: 5 };
    },
    async pollProcess() {
      return { status: "completed", exportUrl: "https://storage.example/1.csv" };
    },
    async downloadCsv(url) {
      downloads++;
      if (downloads === 1) throw new Error(`Download do CSV de export falhou (404): ${url}`);
      return CSV;
    },
  };
  const r = await runOpensCatchup({
    client,
    fetchContact: async (email) => ({ email, statistics: {} }),
    upsert: () => {},
    cacheDir,
    poll: FAST_POLL,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(r.campaignsFailed, 0);
  assert.equal(downloads, 2);
  assert.deepEqual(slept, [CSV_404_RETRY_DELAYS_MS[0]]);
});

// ─── Item 2: supressão chegando ao store ──────────────────────────────────

test("#9762: collectSuppressedEmails pega bounce e descadastro, não quem só recebeu", () => {
  const s = collectSuppressedEmails([
    {
      campaignId: 1,
      campaignName: "A",
      exportedAt: "2026-10-01T00:00:00.000Z",
      recipients: {
        "bounce@x.com": { delivered: false, opened: false, bounced: true, unsubscribed: false },
        "unsub@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: true },
        "ok@x.com": { delivered: true, opened: false, bounced: false, unsubscribed: false },
      },
    },
  ]);
  assert.deepEqual([...s].sort(), ["bounce@x.com", "unsub@x.com"]);
});

test("#9762: catch-up re-busca quem deu hard bounce (não entregue, não abriu) e leva o blacklist ao store", async () => {
  const cacheDir = tmp("catchup-9762-bounce-");
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
      return "Email_ID,Delivered_Date,Total Opens,Hard_Bounce_Date\nbounce@x.com,,0,2026-10-03 06:04:30\n";
    },
  };
  const saved: Array<{ email: string; email_blacklisted: number }> = [];
  const r = await runOpensCatchup({
    client,
    fetchContact: async (email) => ({ email, emailBlacklisted: true, statistics: { hardBounces: [{}] } }),
    upsert: (cols) => saved.push({ email: cols.email, email_blacklisted: cols.email_blacklisted }),
    cacheDir,
    poll: FAST_POLL,
  });
  assert.equal(r.suppressedFound, 1);
  assert.deepEqual(saved, [{ email: "bounce@x.com", email_blacklisted: 1 }]);
});

test("#9762: anchorForIncremental usa a marca d'água (listagem do último run) em vez do MAX(brevo_modified_at)", () => {
  // MAX avançou 2h além da listagem porque o catch-up re-buscou contatos depois.
  assert.equal(
    anchorForIncremental(null, "2026-10-05T13:59:21.962Z", undefined, "2026-10-05T11:30:05.000Z"),
    "2026-10-05T11:25:05.000Z",
  );
  // checkpoint pendente continua vencendo (resume).
  assert.equal(
    anchorForIncremental("2026-10-01T11:20:26.866Z", "2026-10-05T13:59:21.962Z", undefined, "2026-10-05T11:30:05.000Z"),
    "2026-10-01T11:20:26.866Z",
  );
  // sem marca d'água → comportamento anterior.
  assert.equal(anchorForIncremental(null, "2026-10-05T13:59:21.962Z"), "2026-10-05T13:54:21.962Z");
});

test("#9762: loadWatermark ignora arquivo ausente ou corrompido", () => {
  const dir = tmp("catchup-9762-wm-");
  assert.equal(loadWatermark(resolve(dir, "nada.json")), null);
  writeFileSync(resolve(dir, "ruim.json"), "{nao-json");
  assert.equal(loadWatermark(resolve(dir, "ruim.json")), null);
  writeFileSync(resolve(dir, "data-ruim.json"), JSON.stringify({ listingStartedAt: "03-10-2026" }));
  assert.equal(loadWatermark(resolve(dir, "data-ruim.json")), null);
});

test("#9762 REGRESSÃO: main() --incremental ancora o run seguinte no início da listagem, não no MAX que o run deixou", async (t) => {
  const dir = tmp("sync-brevo-9762-");
  const dbPath = resolve(dir, "store.db");
  const setup = openClariceDb(dbPath);
  setup
    .prepare("INSERT INTO clarice_users (email, tier, brevo_modified_at) VALUES ('a@x.com', 2, '2026-10-01T00:00:00.000Z')")
    .run();
  setup.close();

  // O contato buscado no run 1 foi modificado 2h DEPOIS do início da
  // listagem (no 300, é o catch-up re-buscando contatos horas depois).
  const futureModifiedAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const listingUrls: string[] = [];
  const origFetch = globalThis.fetch;
  const origKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "test-key-9762";
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/contacts?")) {
      listingUrls.push(u);
      return new Response(JSON.stringify({ contacts: [{ id: 1, email: "a@x.com" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/contacts/1")) {
      return new Response(
        JSON.stringify({ email: "a@x.com", emailBlacklisted: false, listIds: [], modifiedAt: futureModifiedAt, statistics: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`fetch inesperado no mock: ${u}`);
  }) as unknown as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origKey;
  });
  const logMock = t.mock.method(console, "log", () => {});

  const before = Date.now();
  await main(["--db", dbPath, "--incremental", "--no-catch-opens"]);
  const after = Date.now();

  const { watermark } = checkpointPathsForDb(dbPath);
  const wm = JSON.parse(readFileSync(watermark, "utf8")).listingStartedAt as string;
  assert.ok(Date.parse(wm) >= before && Date.parse(wm) <= after, "marca d'água = início da listagem do run 1");

  await main(["--db", dbPath, "--incremental", "--no-catch-opens"]);
  logMock.mock.restore();
  const since = new URL(listingUrls[listingUrls.length - 1]).searchParams.get("modifiedSince");
  assert.equal(
    since,
    new Date(Date.parse(wm) - 5 * 60_000).toISOString(),
    "run 2 lista desde a marca d'água − 5min; MAX − 5min pularia as 2h entre a listagem e o último GET",
  );
});
