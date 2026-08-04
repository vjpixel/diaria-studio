/**
 * test/clarice-schedule-ramp-4612.test.ts (#4612)
 *
 * `clarice-schedule-ramp.ts` (`main()`, ramo "sem --volumes explícito")
 * chamava `extractDashboardStaleInfo(res)` e, se presente, só fazia
 * `console.error(...)` — o sinal nunca chegava a `RampVolumeResult`, ao JSON
 * impresso (dry-run OU modo-ação — este `main()` não imprimia JSON nenhum no
 * modo-ação) nem a `ramp-summary.json`/`RampWaveEntry` (o estado que
 * `--import`/`--create`/`--schedule` releem depois, possivelmente dias
 * depois, numa invocação SEPARADA). Achado do fleet review da PR #4611
 * (#4543), fora de escopo daquela PR.
 *
 * Este arquivo cobre os 3 itens do escopo:
 *   1. `stale` persistido em CADA `RampWaveEntry` de `ramp-summary.json`.
 *   2. `X-Dashboard-Stale-Since` capturado (`DashboardStaleInfo.since`) e
 *      `describeStaleAge` usando a idade REAL em vez de só citar o teto
 *      pessimista de 24h (`LASTGOOD_TTL`) — ver `scripts/clarice-schedule-ramp.ts`.
 *   3. Cobertura do call site em `main()` — extraído pra `resolveAutoRampVolumes`
 *      (fetchImpl injetável, mesmo padrão de `checkSemaphore` em
 *      `clarice-check-semaphore.ts`) + teste de `main()` ponta-a-ponta via
 *      `globalThis.fetch` monkey-patched (mesmo padrão de
 *      `test/clarice-check-semaphore-4347.test.ts` e
 *      `test/clarice-build-segment.test.ts`).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  resolveAutoRampVolumes,
  extractDashboardStaleInfo,
  describeStaleAge,
  main,
  type RampWaveEntry,
} from "../scripts/clarice-schedule-ramp.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { clariceRampDir } from "../scripts/lib/clarice-paths.ts";

// Campanha "sent"/madura (>48h) o bastante pra `deriveRampVolumes` resolver
// `ok:true` — mesma fixture de `test/clarice-check-semaphore-4347.test.ts`
// ("checkSemaphore: recordedAt fresco mas date stale"), sem o Postmaster.
const matureSentDate = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
const healthyCampaign = {
  name: "cold 4612-test",
  subject: "x",
  status: "sent",
  sentDate: matureSentDate,
  scheduledAt: null,
  createdAt: matureSentDate,
  recipients: { lists: [1] },
  statistics: {
    globalStats: {
      sent: 1000, delivered: 990, hardBounces: 2, softBounces: 1, uniqueViews: 300, viewed: 300,
      trackableViews: 300, uniqueClicks: 50, clickers: 40, unsubscriptions: 1, complaints: 0, appleMppOpens: 10,
    },
  },
};

const STALE_HEADERS = {
  "X-Dashboard-Stale": "upstream-error",
  "X-Dashboard-Upstream-Status": "503",
  "X-Dashboard-Stale-Since": "2026-08-01T09:00:00.000Z",
};
const EXPECTED_STALE = { kind: "upstream-error", upstreamStatus: "503", since: "2026-08-01T09:00:00.000Z" };

// ---------------------------------------------------------------------------
// extractDashboardStaleInfo — `since` (#4612)
// ---------------------------------------------------------------------------

describe("extractDashboardStaleInfo: X-Dashboard-Stale-Since (#4612)", () => {
  test("presente -> `since` populado", () => {
    const res = new Response(null, { headers: STALE_HEADERS });
    assert.deepEqual(extractDashboardStaleInfo(res), EXPECTED_STALE);
  });

  test("ausente (ex: kind=inflight-coalesced) -> `since` fica ausente, não polui o resultado", () => {
    const res = new Response(null, { headers: { "X-Dashboard-Stale": "inflight-coalesced" } });
    const info = extractDashboardStaleInfo(res);
    assert.deepEqual(info, { kind: "inflight-coalesced", upstreamStatus: "unknown" });
    assert.equal("since" in (info ?? {}), false);
  });
});

// ---------------------------------------------------------------------------
// describeStaleAge — idade REAL vs teto pessimista de 24h (#4612)
// ---------------------------------------------------------------------------

describe("describeStaleAge (#4612)", () => {
  test("since ausente -> cai no teto pessimista de 24h, denuncia que a idade real é desconhecida", () => {
    assert.match(describeStaleAge(undefined), /desconhecida/);
    assert.match(describeStaleAge(undefined), /até 24h/);
  });

  test("since inválido -> cai no teto pessimista, mas denuncia o valor inválido (não finge saber)", () => {
    assert.match(describeStaleAge("not-a-date"), /inválido/);
    assert.match(describeStaleAge("not-a-date"), /até 24h/);
  });

  test("since < 60min atrás -> idade em minutos, não o teto de 24h", () => {
    const now = new Date("2026-08-04T12:00:00.000Z");
    const since = new Date("2026-08-04T11:45:00.000Z").toISOString();
    const label = describeStaleAge(since, now);
    assert.match(label, /~15min stale/);
    assert.doesNotMatch(label, /24h/);
  });

  test("since >= 60min atrás -> idade em horas (ex: 23h stale != 3min stale, ambos < 24h)", () => {
    const now = new Date("2026-08-04T12:00:00.000Z");
    const since = new Date("2026-08-03T13:00:00.000Z").toISOString(); // 23h atrás
    assert.match(describeStaleAge(since, now), /~23\.0h stale/);
  });
});

// ---------------------------------------------------------------------------
// resolveAutoRampVolumes — fetchImpl injetável (#4612, mesmo padrão de
// checkSemaphore em clarice-check-semaphore.ts)
// ---------------------------------------------------------------------------

describe("resolveAutoRampVolumes (#4612)", () => {
  test("GET não-2xx -> {ok:false, reason}, NÃO lança nem chama process.exit (main() decide)", async () => {
    const fetchImpl = (async () => new Response("erro interno", { status: 500 })) as typeof fetch;
    const result = await resolveAutoRampVolumes("https://fake-dashboard", 50, fetchImpl);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /falhou \(500\)/);
    assert.equal(result.stale, undefined);
  });

  test("REGRESSÃO (#4612): X-Dashboard-Stale presente -> `stale` chega no RampVolumeResult (não só no console.error)", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/campaigns")) {
        return new Response(JSON.stringify([healthyCampaign]), {
          status: 200,
          headers: { "content-type": "application/json", ...STALE_HEADERS },
        });
      }
      return new Response("not found", { status: 404 }); // /api/postmaster-spam
    }) as typeof fetch;

    const result = await resolveAutoRampVolumes("https://fake-dashboard", 50, fetchImpl);
    assert.equal(result.ok, true);
    assert.deepEqual(result.stale, EXPECTED_STALE);
    if (result.ok) assert.equal(result.plan.volumes.length, 3);
  });

  test("`stale` sobrevive mesmo quando deriveRampVolumes falha (ok:false — sem envio maduro)", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/campaigns")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json", "X-Dashboard-Stale": "inflight-coalesced" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await resolveAutoRampVolumes("https://fake-dashboard", 50, fetchImpl);
    assert.equal(result.ok, false);
    assert.deepEqual(result.stale, { kind: "inflight-coalesced", upstreamStatus: "unknown" });
  });

  test("sem X-Dashboard-Stale -> `stale` ausente (resultado não fica poluído em toda chamada)", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/campaigns")) {
        return new Response(JSON.stringify([healthyCampaign]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await resolveAutoRampVolumes("https://fake-dashboard", 50, fetchImpl);
    assert.equal(result.stale, undefined);
  });
});

// ---------------------------------------------------------------------------
// main() ponta-a-ponta — JSON impresso + ramp-summary.json (#4612)
//
// Mesmo padrão de `test/clarice-check-semaphore-4347.test.ts` (monkey-patch
// de `globalThis.fetch`) e `test/clarice-build-segment.test.ts` (`--data-root`
// isolando a escrita real num tmpdir + `captureLogs`).
// ---------------------------------------------------------------------------

function mockFetchRouter(campaignsHeaders: Record<string, string> = {}): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/campaigns")) {
      return new Response(JSON.stringify([healthyCampaign]), {
        status: 200,
        headers: { "content-type": "application/json", ...campaignsHeaders },
      });
    }
    if (u.includes("/v3/account")) {
      return new Response(JSON.stringify({ plan: [{ creditsType: "sendLimit", credits: 10_000_000 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/emailCampaigns")) {
      // fetchQueuedCampaignListIds / fetchSentCampaignListIds (--build-audience)
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 }); // /api/postmaster-spam
  }) as typeof fetch;
}

async function captureLogs(fn: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

test("REGRESSÃO (#4612): main() dry-run imprime `stale` no JSON de stdout, não só no console.error", async () => {
  const prevFetch = globalThis.fetch;
  const prevErr = console.error;
  globalThis.fetch = mockFetchRouter(STALE_HEADERS);
  console.error = () => {};
  try {
    const logs = await captureLogs(() => main(["--cycle", "2606-07"]));
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.mode, "dry-run");
    assert.deepEqual(out.stale, EXPECTED_STALE);
  } finally {
    globalThis.fetch = prevFetch;
    console.error = prevErr;
  }
});

test("main() dry-run COM --volumes explícito: nunca há fetch, `stale` nem aparece no JSON", async () => {
  const prevFetch = globalThis.fetch;
  const prevErr = console.error;
  // fetch não deveria nem ser chamado neste ramo — quebra o teste se for.
  globalThis.fetch = (async () => { throw new Error("fetch não deveria ser chamado com --volumes explícito"); }) as typeof fetch;
  console.error = () => {};
  try {
    const logs = await captureLogs(() => main(["--cycle", "2606-07", "--volumes", "10,10,10"]));
    const out = JSON.parse(logs.join("\n"));
    assert.deepEqual(out.volumes, [10, 10, 10]);
    assert.equal("stale" in out, false);
  } finally {
    globalThis.fetch = prevFetch;
    console.error = prevErr;
  }
});

async function withFakeBrevoFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.BREVO_CLARICE_API_KEY;
  const prevFetch = globalThis.fetch;
  const prevErr = console.error;
  process.env.BREVO_CLARICE_API_KEY = "test-fake-key";
  globalThis.fetch = fetchImpl;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    console.error = prevErr;
    if (prevKey !== undefined) process.env.BREVO_CLARICE_API_KEY = prevKey;
    else delete process.env.BREVO_CLARICE_API_KEY;
  }
}

test("REGRESSÃO (#4612): main() --build-audience — `stale` chega no JSON impresso E em CADA entry de ramp-summary.json", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ramp-4612-stale-"));
  const dbPath = resolve(dir, "store.db");
  openClariceDb(dbPath).close(); // schema vazio — a asserção é sobre a proveniência stale, não sobre a audiência

  const logs = await withFakeBrevoFetch(mockFetchRouter(STALE_HEADERS), () =>
    captureLogs(() => main(["--cycle", "2606-07", "--db", dbPath, "--data-root", dir, "--build-audience"])),
  );

  // 2. JSON impresso (modo-ação) carrega `stale` — antes deste PR, o resumo
  // final de main() (já existente) não carregava esse sinal em lugar nenhum
  // (nem top-level, nem por-entry), só o console.error de
  // `resolveAutoRampVolumes`.
  assert.equal(logs.length, 1);
  const printed = JSON.parse(logs[0]);
  assert.deepEqual(printed.stale, EXPECTED_STALE);
  assert.equal(printed.entries.length, 3);
  for (const entry of printed.entries) {
    assert.deepEqual(entry.stale, EXPECTED_STALE, `${entry.key} deveria carregar a proveniência stale no resumo também`);
  }

  // 3. ramp-summary.json — o estado que --import/--create/--schedule releem
  // depois, possivelmente em invocações SEPARADAS dias depois.
  const rampDir = clariceRampDir("2606-07", dir);
  const summaryPath = resolve(rampDir, "ramp-summary.json");
  assert.equal(existsSync(summaryPath), true);
  const entries = JSON.parse(readFileSync(summaryPath, "utf8")) as RampWaveEntry[];
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.deepEqual(entry.stale, EXPECTED_STALE, `${entry.key} deveria carregar a proveniência stale`);
  }
});

test("main() --build-audience: SEM X-Dashboard-Stale, nenhuma entry carrega o campo `stale` (não polui o estado toda vez)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ramp-4612-fresh-"));
  const dbPath = resolve(dir, "store.db");
  openClariceDb(dbPath).close();

  await withFakeBrevoFetch(mockFetchRouter(), () =>
    captureLogs(() => main(["--cycle", "2606-07", "--db", dbPath, "--data-root", dir, "--build-audience"])),
  );

  const rampDir = clariceRampDir("2606-07", dir);
  const entries = JSON.parse(readFileSync(resolve(rampDir, "ramp-summary.json"), "utf8")) as RampWaveEntry[];
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "stale"), false, `${entry.key} não deveria ter a chave 'stale'`);
  }
});
