/**
 * test/microsoft-ads-editorial-reasons-cli-9091.test.ts (#9091)
 *
 * Contrato de saída do CLI `scripts/microsoft-ads-editorial-reasons.ts`,
 * alinhado aos ingests de gasto (#9012/#9071): falha real sai com
 * `SPEND_INGEST_FAILURE_EXIT_CODE` (antes: exit 0 silencioso), caso vazio
 * legítimo sai 0 e grava snapshot, rede/5xx é retentada (500 não — SOAP
 * Fault), e o caminho de identidade Google é montado a partir do ambiente.
 * Nunca chama a API real; sleep injetado, env salvo/restaurado.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { main } from "../scripts/microsoft-ads-editorial-reasons.ts";
import { SPEND_INGEST_FAILURE_EXIT_CODE, SPEND_INGEST_FETCH_RETRY } from "../scripts/lib/spend-ingest.ts";
import { CAMPAIGN_MANAGEMENT_NAMESPACE } from "../scripts/lib/microsoft-ads-editorial-reasons.ts";

const RELEVANT_VARS = [
  "MICROSOFT_ADS_DEVELOPER_TOKEN",
  "MICROSOFT_ADS_CUSTOMER_ID",
  "MICROSOFT_ADS_ACCOUNT_ID",
  "MICROSOFT_ADS_CLIENT_ID",
  "MICROSOFT_ADS_CLIENT_SECRET",
  "MICROSOFT_ADS_REFRESH_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN",
] as const;

const ALWAYS = {
  MICROSOFT_ADS_DEVELOPER_TOKEN: "dev-token",
  MICROSOFT_ADS_CUSTOMER_ID: "255014657",
  MICROSOFT_ADS_ACCOUNT_ID: "189335528",
};
const AZURE = { MICROSOFT_ADS_CLIENT_ID: "azure-client", MICROSOFT_ADS_REFRESH_TOKEN: "azure-refresh" };
const GOOGLE = {
  GOOGLE_CLIENT_ID: "g-client",
  GOOGLE_CLIENT_SECRET: "g-secret",
  MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN: "g-refresh",
};

const xmlReasons = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetAssetGroupsEditorialReasonsResponse xmlns="${CAMPAIGN_MANAGEMENT_NAMESPACE}">
      ${inner}
    </GetAssetGroupsEditorialReasonsResponse>
  </s:Body>
</s:Envelope>`;
const ONE_REASON = xmlReasons(`<EditorialReasonCollection><EditorialReasons>
  <ReasonCode>702</ReasonCode><Location>AdGroup</Location><PublisherCountries>BR</PublisherCountries>
  <Term>promo</Term><AppealStatus>Appealable</AppealStatus>
</EditorialReasons></EditorialReasonCollection>`);
const NO_REASONS = xmlReasons("");
const FAULT = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
<faultcode>s:Client</faultcode><faultstring>Invalid Credentials</faultstring>
</s:Fault></s:Body></s:Envelope>`;

const isToken = (url: string) =>
  url.includes("login.microsoftonline.com") || url.includes("oauth2.googleapis.com");
const tokenOk = () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
const noSleep = async () => {};

let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of RELEVANT_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "msads-editorial-9091-"));
});
afterEach(() => {
  for (const k of RELEVANT_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function setEnv(vars: Record<string, string>): void {
  Object.assign(process.env, vars);
}

describe("#9091 — microsoft-ads-editorial-reasons CLI: contrato retry + exit≠0", () => {
  it("credencial ausente → exit não-zero, nada escrito, fetch nunca chamado", async () => {
    const out = join(dir, "out.json");
    let calls = 0;
    const code = await main(["--output", out], {
      fetchImpl: async () => {
        calls++;
        return tokenOk();
      },
      sleep: noSleep,
    });
    assert.equal(code, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.notEqual(code, 0);
    assert.equal(calls, 0);
    assert.equal(existsSync(out), false);
  });

  it("caminho Google montado do ambiente (sem as vars Azure) → token Google + exit 0", async () => {
    setEnv({ ...ALWAYS, ...GOOGLE });
    const out = join(dir, "out.json");
    const urls: string[] = [];
    const code = await main(["--output", out], {
      fetchImpl: async (url: string) => {
        urls.push(url);
        return isToken(url) ? tokenOk() : new Response(ONE_REASON, { status: 200 });
      },
      sleep: noSleep,
    });
    assert.equal(code, 0);
    assert.ok(
      urls.some((u) => u.includes("oauth2.googleapis.com")),
      `esperava token Google, veio ${urls.join(", ")}`,
    );
    const payload = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(payload.count, 1);
  });

  it("caso vazio legítimo (0 motivos) → exit 0 e snapshot vazio gravado", async () => {
    setEnv({ ...ALWAYS, ...AZURE });
    const out = join(dir, "out.json");
    const code = await main(["--output", out], {
      fetchImpl: async (url: string) =>
        isToken(url) ? tokenOk() : new Response(NO_REASONS, { status: 200 }),
      sleep: noSleep,
    });
    assert.equal(code, 0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(payload.count, 0);
    assert.deepEqual(payload.reasons, []);
  });

  it("SOAP Fault (HTTP 500) → exit não-zero, SEM retry (determinístico)", async () => {
    setEnv({ ...ALWAYS, ...AZURE });
    const out = join(dir, "out.json");
    let soapCalls = 0;
    const code = await main(["--output", out], {
      fetchImpl: async (url: string) => {
        if (isToken(url)) return tokenOk();
        soapCalls++;
        return new Response(FAULT, { status: 500 });
      },
      sleep: noSleep,
    });
    assert.equal(code, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.equal(soapCalls, 1);
    assert.equal(existsSync(out), false);
  });

  it("503 transitório → retentado e recupera (exit 0)", async () => {
    setEnv({ ...ALWAYS, ...AZURE });
    const out = join(dir, "out.json");
    let soapCalls = 0;
    const sleeps: number[] = [];
    const code = await main(["--output", out], {
      fetchImpl: async (url: string) => {
        if (isToken(url)) return tokenOk();
        soapCalls++;
        return soapCalls === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(ONE_REASON, { status: 200 });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(code, 0);
    assert.equal(soapCalls, 2);
    assert.deepEqual(sleeps, [SPEND_INGEST_FETCH_RETRY.backoffMs[0]]);
  });

  it("erro de rede persistente → esgota as tentativas e sai não-zero", async () => {
    setEnv({ ...ALWAYS, ...AZURE });
    const out = join(dir, "out.json");
    let calls = 0;
    const code = await main(["--output", out], {
      fetchImpl: async () => {
        calls++;
        throw new Error("ECONNRESET");
      },
      sleep: noSleep,
    });
    assert.equal(code, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.equal(calls, SPEND_INGEST_FETCH_RETRY.attempts);
    assert.equal(existsSync(out), false);
  });

  it("falha escrevendo o snapshot → exit não-zero", async () => {
    setEnv({ ...ALWAYS, ...AZURE });
    // "Diretório pai" do output é um arquivo — o write falha.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const code = await main(["--output", join(blocker, "out.json")], {
      fetchImpl: async (url: string) =>
        isToken(url) ? tokenOk() : new Response(NO_REASONS, { status: 200 }),
      sleep: noSleep,
    });
    assert.equal(code, SPEND_INGEST_FAILURE_EXIT_CODE);
  });
});

describe("#9091 — review: 200 com shape inesperado e prioridade de identidade", () => {
  it("HTTP 200 sem GetAssetGroupsEditorialReasonsResponse → exit não-zero, nada escrito (não é vazio legítimo)", async () => {
    setEnv({ ...ALWAYS, ...AZURE });
    const out = join(dir, "out.json");
    const code = await main(["--output", out], {
      fetchImpl: async (url: string) =>
        isToken(url) ? tokenOk() : new Response("<html>gateway ok</html>", { status: 200 }),
      sleep: noSleep,
    });
    assert.equal(code, SPEND_INGEST_FAILURE_EXIT_CODE);
    assert.equal(existsSync(out), false);
  });

  it("os 2 caminhos configurados → Google vence (token Google, nunca Azure)", async () => {
    setEnv({ ...ALWAYS, ...AZURE, ...GOOGLE });
    const out = join(dir, "out.json");
    const urls: string[] = [];
    const code = await main(["--output", out], {
      fetchImpl: async (url: string) => {
        urls.push(url);
        return isToken(url) ? tokenOk() : new Response(NO_REASONS, { status: 200 });
      },
      sleep: noSleep,
    });
    assert.equal(code, 0);
    assert.ok(urls.some((u) => u.includes("oauth2.googleapis.com")));
    assert.ok(!urls.some((u) => u.includes("login.microsoftonline.com")));
  });
});
