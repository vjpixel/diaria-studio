/**
 * test/ads-ingest-retry-exit-9071.test.ts (#9071, regressão #633)
 *
 * Achado da #9068 (#9012): o ingest Meta ganhou retry de rede + exit≠0 em
 * falha real, mas `google-ads-ingest-spend.ts` e
 * `microsoft-ads-ingest-spend.ts` continuavam (1) sem retry — um blip de
 * DNS como o de 29/09/2026 12:54 UTC derrubava o run do dia — e (2) com
 * exit 0 em TODA falha, então a unit systemd terminava "sucesso". Este
 * teste trava, pros dois CLIs:
 *
 *   1. blip de rede na 1ª chamada é retentado (`withFetchRetry` com
 *      `SPEND_INGEST_FETCH_RETRY`) e o run se recupera;
 *   2. falha persistente / credencial ausente sai com
 *      `SPEND_INGEST_FAILURE_EXIT_CODE`, `spend.csv` intocado;
 *   3. gasto zero real ("API respondeu, sem gasto") segue exit 0.
 *
 * Nunca chama API real — `fetch` mockado, `sleep` injetado.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SPEND_INGEST_FAILURE_EXIT_CODE, SPEND_INGEST_FETCH_RETRY } from "../scripts/lib/spend-ingest.ts";
import { withFetchRetry } from "../scripts/lib/fetch-retry.ts";
import {
  main as googleMain,
  exitCodeForFailureClass,
  GOOGLE_ADS_CANAL,
} from "../scripts/google-ads-ingest-spend.ts";
import { main as microsoftMain, isMicrosoftAdsRetriableStatus } from "../scripts/microsoft-ads-ingest-spend.ts";
import {
  META_ADS_FETCH_RETRY,
  META_ADS_INGEST_FAILURE_EXIT_CODE,
} from "../scripts/meta-ads-ingest-spend.ts";

function silenceConsole<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const out: string[] = [];
  const saved = { warn: console.warn, log: console.log, error: console.error };
  const push = (...a: unknown[]) => out.push(a.join(" "));
  console.warn = push;
  console.log = push;
  console.error = push;
  return fn()
    .then((result) => ({ result, out: out.join("\n") }))
    .finally(() => {
      console.warn = saved.warn;
      console.log = saved.log;
      console.error = saved.error;
    });
}

function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("#9071 — contrato compartilhado de retry/exit dos ingests de gasto", () => {
  it("Meta reusa as MESMAS constantes (alias, não cópia)", () => {
    assert.equal(META_ADS_INGEST_FAILURE_EXIT_CODE, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.equal(META_ADS_FETCH_RETRY, SPEND_INGEST_FETCH_RETRY);
    assert.notEqual(SPEND_INGEST_FAILURE_EXIT_CODE, 0);
  });

  it("withFetchRetry: 5xx retenta, 4xx não", async () => {
    const statuses = [503, 200];
    let calls = 0;
    const f = withFetchRetry(async () => new Response("x", { status: statuses[calls++] }), {
      attempts: 3,
      backoffMs: [1],
      sleep: async () => {},
    });
    assert.equal((await f("https://x")).status, 200);
    assert.equal(calls, 2);

    let calls4 = 0;
    const g = withFetchRetry(async () => {
      calls4++;
      return new Response("no", { status: 401 });
    }, { attempts: 3, sleep: async () => {} });
    assert.equal((await g("https://x")).status, 401);
    assert.equal(calls4, 1);
  });
});

describe("#9071 — google-ads-ingest-spend: retry + exit code", () => {
  let tmpDir: string;
  let spendPath: string;
  let restoreEnv: () => void;
  let sleeps: number[];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gads-9071-"));
    spendPath = join(tmpDir, "spend.csv");
    sleeps = [];
    restoreEnv = withEnv({
      GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
      GOOGLE_ADS_CLIENT_ID: "cid",
      GOOGLE_ADS_CLIENT_SECRET: "sec",
      GOOGLE_ADS_REFRESH_TOKEN: "rt",
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1112223333",
      GOOGLE_ADS_CUSTOMER_ID: "2369219639",
    });
  });

  afterEach(() => {
    restoreEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function googleFetch(opts: { tokenFailures?: number; results?: unknown[] }) {
    let tokenCalls = 0;
    const impl = async (url: string): Promise<Response> => {
      if (url.includes("oauth2")) {
        tokenCalls++;
        if (tokenCalls <= (opts.tokenFailures ?? 0)) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
      }
      if (url.includes("googleAds:search")) {
        return new Response(JSON.stringify({ results: opts.results ?? [] }), { status: 200 });
      }
      throw new Error(`URL inesperada no mock: ${url}`);
    };
    return { impl, tokenCalls: () => tokenCalls };
  }

  it("reproduz o blip de DNS: `fetch failed` no token, depois OK → grava spend.csv, exit 0", async () => {
    const f = googleFetch({
      tokenFailures: 1,
      results: [{ segments: { date: "2026-09-28" }, metrics: { costMicros: "42500000" } }],
    });
    const { result } = await silenceConsole(() => googleMain(["--spend", spendPath], { fetchImpl: f.impl, sleep }));
    assert.equal(result, 0);
    assert.equal(f.tokenCalls(), 2);
    assert.deepEqual(sleeps, [SPEND_INGEST_FETCH_RETRY.backoffMs[0]]);
    const csv = readFileSync(spendPath, "utf8");
    assert.ok(csv.includes(GOOGLE_ADS_CANAL));
    assert.ok(csv.includes("42.5"));
  });

  it("rede persistente (retry esgotado) → exit não-zero, spend.csv intocado", async () => {
    const f = googleFetch({ tokenFailures: Infinity });
    const { result, out } = await silenceConsole(() => googleMain(["--spend", spendPath], { fetchImpl: f.impl, sleep }));
    assert.equal(result, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.equal(f.tokenCalls(), SPEND_INGEST_FETCH_RETRY.attempts);
    assert.equal(existsSync(spendPath), false);
    assert.match(out, /fallback pro CSV manual/);
  });

  it("API respondeu sem gasto (empty) → exit 0", async () => {
    const f = googleFetch({ results: [] });
    const { result, out } = await silenceConsole(() => googleMain(["--spend", spendPath], { fetchImpl: f.impl, sleep }));
    assert.equal(result, 0);
    assert.match(out, /sem gasto no período/);
    assert.equal(existsSync(spendPath), false);
  });

  it("credencial ausente → exit não-zero (antes: 0)", async () => {
    const restore = withEnv({ GOOGLE_ADS_REFRESH_TOKEN: undefined });
    try {
      const { result } = await silenceConsole(() =>
        googleMain(["--spend", spendPath], { fetchImpl: googleFetch({}).impl, sleep }),
      );
      assert.equal(result, SPEND_INGEST_FAILURE_EXIT_CODE);
    } finally {
      restore();
    }
  });

  it("auth-pending (DEVELOPER_TOKEN_NOT_APPROVED) via CLI → exit não-zero, sem retry de 4xx", async () => {
    let searchCalls = 0;
    const impl = async (url: string): Promise<Response> => {
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
      searchCalls++;
      return new Response(JSON.stringify({ error: { details: [{ errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }] }] } }), { status: 403 });
    };
    const { result, out } = await silenceConsole(() => googleMain(["--spend", spendPath], { fetchImpl: impl, sleep }));
    assert.equal(result, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.equal(searchCalls, 1);
    assert.deepEqual(sleeps, []);
    assert.match(out, /acesso ainda não liberado/);
  });

  it("exitCodeForFailureClass: só `empty` é 0", () => {
    assert.equal(exitCodeForFailureClass("empty"), 0);
    for (const c of ["defect", "transient", "auth-pending"] as const) {
      assert.equal(exitCodeForFailureClass(c), SPEND_INGEST_FAILURE_EXIT_CODE, c);
    }
  });
});

describe("#9071 — microsoft-ads-ingest-spend: retry + exit code", () => {
  const SERVICE_URL = "https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc";
  let tmpDir: string;
  let spendPath: string;
  let restoreEnv: () => void;
  let sleeps: number[];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "msads-9071-"));
    spendPath = join(tmpDir, "spend.csv");
    sleeps = [];
    // Caminho Azure AD (token em login.microsoftonline.com); Google limpo
    // pra não depender do .env local.
    restoreEnv = withEnv({
      MICROSOFT_ADS_DEVELOPER_TOKEN: "dev",
      MICROSOFT_ADS_CUSTOMER_ID: "111",
      MICROSOFT_ADS_ACCOUNT_ID: "222",
      MICROSOFT_ADS_CLIENT_ID: "cid",
      MICROSOFT_ADS_REFRESH_TOKEN: "rt",
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN: undefined,
    });
  });

  afterEach(() => {
    restoreEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fluxo SOAP mínimo: Success sem ReportDownloadUrl = relatório sem
   *  linhas (comportamento real da API, #5928) → `empty`. */
  function msFetch(opts: { tokenFailures?: number }) {
    let tokenCalls = 0;
    const impl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("login.microsoftonline.com")) {
        tokenCalls++;
        if (tokenCalls <= (opts.tokenFailures ?? 0)) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      if (url === SERVICE_URL) {
        const body = String(init?.body ?? "");
        if (body.includes(">SubmitGenerateReport<")) {
          return new Response(
            `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SubmitGenerateReportResponse xmlns="https://bingads.microsoft.com/Reporting/v13"><ReportRequestId>req-1</ReportRequestId></SubmitGenerateReportResponse></s:Body></s:Envelope>`,
            { status: 200 },
          );
        }
        if (body.includes(">PollGenerateReport<")) {
          return new Response(
            `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><PollGenerateReportResponse xmlns="https://bingads.microsoft.com/Reporting/v13"><ReportRequestStatus><ReportRequestId>req-1</ReportRequestId><Status>Success</Status></ReportRequestStatus></PollGenerateReportResponse></s:Body></s:Envelope>`,
            { status: 200 },
          );
        }
      }
      throw new Error(`URL inesperada no mock: ${url}`);
    };
    return { impl, tokenCalls: () => tokenCalls };
  }

  it("blip de rede no token, depois API sem gasto → recupera, exit 0 com banner ✔ (não fallback)", async () => {
    const f = msFetch({ tokenFailures: 1 });
    const { result, out } = await silenceConsole(() => microsoftMain(["--spend", spendPath], { fetchImpl: f.impl, sleep }));
    assert.equal(result, 0);
    assert.equal(f.tokenCalls(), 2);
    // 1 backoff do retry; o poll resolve na 1ª tentativa (sem sleep de poll).
    assert.deepEqual(sleeps, [SPEND_INGEST_FETCH_RETRY.backoffMs[0]]);
    assert.match(out, /✔ API respondeu/);
    assert.doesNotMatch(out, /fallback pro CSV manual/);
    assert.equal(existsSync(spendPath), false);
  });

  it("HTTP 500 (SOAP Fault) no submit NÃO é retentado; 503 é", async () => {
    assert.equal(isMicrosoftAdsRetriableStatus(500), false);
    assert.equal(isMicrosoftAdsRetriableStatus(503), true);
    assert.equal(isMicrosoftAdsRetriableStatus(401), false);

    let submitCalls = 0;
    const base = msFetch({}).impl;
    const faulting = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === SERVICE_URL && String(init?.body ?? "").includes(">SubmitGenerateReport<")) {
        submitCalls++;
        return new Response(
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>InvalidCredentials</faultstring></s:Fault></s:Body></s:Envelope>`,
          { status: 500 },
        );
      }
      return base(url, init);
    };
    const { result } = await silenceConsole(() => microsoftMain(["--spend", spendPath], { fetchImpl: faulting, sleep }));
    assert.equal(result, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.equal(submitCalls, 1);
  });

  it("rede persistente (retry esgotado) → exit não-zero, spend.csv intocado", async () => {
    const f = msFetch({ tokenFailures: Infinity });
    const { result, out } = await silenceConsole(() => microsoftMain(["--spend", spendPath], { fetchImpl: f.impl, sleep }));
    assert.equal(result, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.equal(f.tokenCalls(), SPEND_INGEST_FETCH_RETRY.attempts);
    assert.equal(existsSync(spendPath), false);
    assert.match(out, /fallback pro CSV manual/);
  });

  it("credencial ausente → exit não-zero (antes: 0)", async () => {
    const restore = withEnv({ MICROSOFT_ADS_DEVELOPER_TOKEN: undefined });
    try {
      const { result } = await silenceConsole(() =>
        microsoftMain(["--spend", spendPath], { fetchImpl: msFetch({}).impl, sleep }),
      );
      assert.equal(result, SPEND_INGEST_FAILURE_EXIT_CODE);
    } finally {
      restore();
    }
  });
});
