/**
 * test/meta-ads-ingest-retry-9012.test.ts (#9012, regressão #633)
 *
 * Alarme `ads-spend-ingest` de 29/09/2026 12:54 UTC: o `300` perdeu DNS por
 * alguns minutos e a ÚNICA chamada à Graph API de
 * `scripts/meta-ads-ingest-spend.ts` (caminho headless) falhou com
 * `fetch failed` — sem retry, spend.csv não atualizou, e o script saiu
 * exit 0 (unit systemd "sucesso"). Este teste trava as duas correções:
 *
 *   1. blip de rede/5xx é retentado (`withMetaAdsFetchRetry`) — o run do
 *      dia se recupera sozinho em vez de cair no fallback;
 *   2. falha real (rede persistente após esgotar o retry, `--input`
 *      ausente) sai com `META_ADS_INGEST_FAILURE_EXIT_CODE`, não 0.
 *
 * Nunca chama a Graph API real — `fetch` mockado, `sleep` injetado.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_ADS_FETCH_RETRY,
  META_ADS_INGEST_FAILURE_EXIT_CODE,
  main,
  runHeadless,
} from "../scripts/meta-ads-ingest-spend.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const OK_BODY = {
  data: [{ date_start: "2026-09-28", spend: "42.50", clicks: "3", impressions: "300" }],
  paging: {},
};

function silenceConsole<T>(fn: () => Promise<T>): Promise<{ result: T; warn: string; log: string }> {
  const warn: string[] = [];
  const log: string[] = [];
  const ow = console.warn;
  const ol = console.log;
  console.warn = (...a: unknown[]) => warn.push(a.join(" "));
  console.log = (...a: unknown[]) => log.push(a.join(" "));
  return fn()
    .then((result) => ({ result, warn: warn.join("\n"), log: log.join("\n") }))
    .finally(() => {
      console.warn = ow;
      console.log = ol;
    });
}

describe("#9012 — Meta Ads ingest: retry de blip de rede + exit code fail-loud", () => {
  let tmpDir: string;
  let spendPath: string;
  let savedToken: string | undefined;
  let sleeps: number[];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "meta-ads-9012-"));
    spendPath = join(tmpDir, "spend.csv");
    savedToken = process.env.META_ADS_ACCESS_TOKEN;
    process.env.META_ADS_ACCESS_TOKEN = "tok-fake-nunca-logado";
    sleeps = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
    else process.env.META_ADS_ACCESS_TOKEN = savedToken;
  });

  it("reproduz o run de 29/09: `fetch failed` (DNS) na 1ª tentativa, depois OK → recupera, grava spend.csv, exit 0", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(200, OK_BODY);
    }) as typeof fetch;

    const { result: code, warn } = await silenceConsole(() => runHeadless(spendPath, fetchImpl, { sleep }));

    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [META_ADS_FETCH_RETRY.backoffMs[0]]);
    assert.ok(existsSync(spendPath), "spend.csv deveria ser gravado depois do retry");
    assert.match(readFileSync(spendPath, "utf8"), /Meta Ads \(teste 2608\),2026-09,BRL,42\.5,/);
    // Nenhum banner de fallback — é o que o alarme lê como defeito.
    assert.doesNotMatch(warn, /fallback pro CSV manual/);
  });

  it("HTTP 5xx transitório também é retentado", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls <= 2) return jsonResponse(503, { error: { message: "Service Unavailable" } });
      return jsonResponse(200, OK_BODY);
    }) as typeof fetch;

    const { result: code } = await silenceConsole(() => runHeadless(spendPath, fetchImpl, { sleep }));

    assert.equal(code, 0);
    assert.equal(calls, 3);
    assert.ok(existsSync(spendPath));
  });

  it("rede fora durante TODAS as tentativas → fallback no log + exit NÃO-ZERO, spend.csv intocado", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const { result: code, warn } = await silenceConsole(() => runHeadless(spendPath, fetchImpl, { sleep }));

    assert.equal(code, META_ADS_INGEST_FAILURE_EXIT_CODE);
    assert.notEqual(code, 0);
    assert.equal(calls, META_ADS_FETCH_RETRY.attempts);
    assert.equal(sleeps.length, META_ADS_FETCH_RETRY.attempts - 1);
    assert.equal(existsSync(spendPath), false);
    assert.match(warn, /fallback pro CSV manual/);
    assert.match(warn, /fetch failed/);
  });

  it("gasto zero real (API OK, sem linhas) segue exit 0 — não é falha", async () => {
    const fetchImpl = (async () => jsonResponse(200, { data: [], paging: {} })) as typeof fetch;
    const { result: code } = await silenceConsole(() => runHeadless(spendPath, fetchImpl, { sleep }));
    assert.equal(code, 0);
    assert.equal(sleeps.length, 0);
  });

  it("paginação: `fetch failed` na página 2 é retentado com o header Authorization preservado, e o token nunca vai pro log", async () => {
    const seen: Array<{ url: string; auth: string | null; hasSignal: boolean }> = [];
    let page2Calls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("Authorization"), hasSignal: init?.signal instanceof AbortSignal });
      if (url.startsWith("https://next.example/page2")) {
        page2Calls++;
        if (page2Calls === 1) throw new TypeError("fetch failed");
        return jsonResponse(200, OK_BODY);
      }
      return jsonResponse(200, {
        data: [{ date_start: "2026-09-27", spend: "10", clicks: "1", impressions: "10" }],
        paging: { next: "https://next.example/page2" },
      });
    }) as typeof fetch;

    const { result: code, warn, log } = await silenceConsole(() => runHeadless(spendPath, fetchImpl, { sleep }));

    assert.equal(code, 0);
    assert.equal(page2Calls, 2);
    assert.ok(seen.every((s) => s.auth === "Bearer tok-fake-nunca-logado"), "Authorization em toda tentativa/página");
    assert.ok(seen.every((s) => s.hasSignal), "signal do retry chega ao fetchImpl");
    assert.match(readFileSync(spendPath, "utf8"), /Meta Ads \(teste 2608\),2026-09,BRL,52\.5,/);
    assert.doesNotMatch(warn + log, /tok-fake-nunca-logado/);
  });

  it("caminho manual: --input com envelope válido sem gasto → exit 0 (gasto zero não é falha)", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "meta-ads", "ad-entities-empty.json");
    const savedArgv = process.argv;
    process.argv = [savedArgv[0], "meta-ads-ingest-spend.ts", "--input", fixture, "--spend", spendPath];
    try {
      const { result: code, warn } = await silenceConsole(() => main());
      assert.equal(code, 0);
      assert.doesNotMatch(warn, /fallback pro CSV manual/);
    } finally {
      process.argv = savedArgv;
    }
    assert.equal(existsSync(spendPath), false);
  });

  it("caminho manual: --input inexistente → exit NÃO-ZERO", async () => {
    const savedArgv = process.argv;
    process.argv = [savedArgv[0], "meta-ads-ingest-spend.ts", "--input", join(tmpDir, "nao-existe.json"), "--spend", spendPath];
    try {
      const { result: code } = await silenceConsole(() => main());
      assert.equal(code, META_ADS_INGEST_FAILURE_EXIT_CODE);
    } finally {
      process.argv = savedArgv;
    }
    assert.equal(existsSync(spendPath), false);
  });
});
