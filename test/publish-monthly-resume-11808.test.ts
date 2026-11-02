import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { main, parseArgs, readResumableCampaignId } from "../scripts/publish-monthly.ts";
import { CliExit } from "../scripts/lib/cli-exit.ts";

/**
 * #11808: 429 depois de criar a campanha deixava o rascunho sem registro.
 *
 * Evidência (ciclo 2610-11, 01/11/2026): `--send-test` criou a campanha 391,
 * levou 429 no /sendTest e abortou sem gravar 05-published.json — rodar de
 * novo criaria uma 2ª campanha. O fix grava o id logo depois do POST e a
 * re-execução faz PUT na campanha registrada (se ainda draft na Brevo).
 *
 * Toda chamada HTTP passa pelo MockAgent com disableNetConnect: um POST
 * /emailCampaigns inesperado na 2ª execução não tem interceptor e falha o
 * teste — é isso que discrimina "reaproveitou" de "duplicou".
 */

const FIXTURE_SRC = resolve(import.meta.dirname, "fixtures/publish-monthly/2604");
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

let tmpDir: string;
let mockAgent: MockAgent;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
const originalArgv = process.argv;
const originalEnv = { ...process.env };

before(() => {
  process.env.BREVO_CLARICE_API_KEY = "fake-test-key";
  process.env.CLOUDFLARE_ACCOUNT_ID = "";
  process.env.CLOUDFLARE_WORKERS_TOKEN = "";
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  process.argv = originalArgv;
  await mockAgent.close();
  setGlobalDispatcher(originalDispatcher);
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pm-resume-11808-"));
  copyFileSync(join(FIXTURE_SRC, "draft.md"), join(tmpDir, "draft.md"));
  mkdirSync(join(tmpDir, "_internal"), { recursive: true });
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function brevo() {
  const m = mockAgent.get("https://api.brevo.com");
  m.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
    id: 9, name: "T1-W1", totalSubscribers: 50,
  }, JSON_HEADERS);
  return m;
}

function readRecord(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpDir, "_internal", "05-published.json"), "utf8"));
}

function writeRecord(rec: Record<string, unknown>): void {
  writeFileSync(join(tmpDir, "_internal", "05-published.json"), JSON.stringify(rec));
}

const SEND_TEST_ARGV = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9", "--send-test"];

describe("publish-monthly #11808: 429 no /sendTest depois de criar a campanha", () => {
  it("1ª execução grava o id; 2ª reaproveita a campanha (PUT) em vez de criar outra", async () => {
    // ── 1ª execução: POST cria 391, /sendTest leva 429 com Retry-After acima
    // do orçamento (desiste na hora, sem dormir).
    const m1 = brevo();
    m1.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, { id: 391 }, JSON_HEADERS);
    m1.intercept({ path: "/v3/emailCampaigns/391/sendTest", method: "POST" })
      .reply(429, "Too Many Requests", { headers: { "retry-after": "3600" } });

    process.argv = [...SEND_TEST_ARGV];
    await assert.rejects(() => main(tmpDir), /429/);

    // O bug: 05-published.json não existia aqui.
    const rec1 = readRecord();
    assert.equal(rec1.campaign_id, 391);
    assert.equal(rec1.status, "draft");
    assert.match(String(rec1.error), /429/);

    // ── 2ª execução: GET confirma draft, PUT atualiza, /sendTest passa.
    // Nenhum interceptor de POST /emailCampaigns: se o fluxo criar outra
    // campanha, o MockAgent recusa e o main() lança.
    const m2 = brevo();
    m2.intercept({ path: "/v3/emailCampaigns/391", method: "GET" }).reply(200, {
      id: 391, name: "Diar.ia Mensal 2604", status: "draft",
    }, JSON_HEADERS);
    m2.intercept({ path: "/v3/emailCampaigns/391", method: "PUT" }).reply(204, "");
    m2.intercept({ path: "/v3/emailCampaigns/391/sendTest", method: "POST" }).reply(204, "");

    process.argv = [...SEND_TEST_ARGV];
    await main(tmpDir);

    const rec2 = readRecord();
    assert.equal(rec2.campaign_id, 391);
    assert.equal(rec2.status, "test_sent");
    assert.equal(rec2.updated_existing, true);
    assert.equal(rec2.error, undefined, "sucesso no resume limpa o erro anterior");
  });

  it("registro diz draft mas a Brevo diz sent → aborta (exit 1) sem criar campanha", async () => {
    writeRecord({ campaign_id: 391, status: "draft", error: "Brevo API 429" });
    const m = brevo();
    m.intercept({ path: "/v3/emailCampaigns/391", method: "GET" }).reply(200, {
      id: 391, name: "x", status: "sent",
    }, JSON_HEADERS);

    process.argv = [...SEND_TEST_ARGV];
    assert.equal(await main(tmpDir), 1);
    assert.equal(readRecord().campaign_id, 391, "registro anterior fica intacto");
  });

  it("campanha registrada apagada na Brevo (404) → cria campanha nova", async () => {
    writeRecord({ campaign_id: 391, status: "draft" });
    const m = brevo();
    m.intercept({ path: "/v3/emailCampaigns/391", method: "GET" }).reply(404, { code: "document_not_found" }, JSON_HEADERS);
    m.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, { id: 392 }, JSON_HEADERS);
    m.intercept({ path: "/v3/emailCampaigns/392/sendTest", method: "POST" }).reply(204, "");

    process.argv = [...SEND_TEST_ARGV];
    await main(tmpDir);
    const rec = readRecord();
    assert.equal(rec.campaign_id, 392);
    assert.equal(rec.updated_existing, undefined);
  });

  it("--new-campaign ignora o registro e cria campanha nova (sem GET)", async () => {
    writeRecord({ campaign_id: 391, status: "draft" });
    const m = brevo();
    m.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, { id: 393 }, JSON_HEADERS);
    m.intercept({ path: "/v3/emailCampaigns/393/sendTest", method: "POST" }).reply(204, "");

    process.argv = [...SEND_TEST_ARGV, "--new-campaign"];
    await main(tmpDir);
    assert.equal(readRecord().campaign_id, 393);
  });

  it("registro de campanha já agendada não é reaproveitado (cria nova, como antes)", async () => {
    writeRecord({ campaign_id: 391, status: "scheduled" });
    const m = brevo();
    m.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, { id: 394 }, JSON_HEADERS);
    m.intercept({ path: "/v3/emailCampaigns/394/sendTest", method: "POST" }).reply(204, "");

    process.argv = [...SEND_TEST_ARGV];
    await main(tmpDir);
    assert.equal(readRecord().campaign_id, 394);
  });

  it("falha no /sendNow também deixa o id registrado com o erro", async () => {
    const m = brevo();
    m.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, { id: 395 }, JSON_HEADERS);
    m.intercept({ path: "/v3/emailCampaigns/395/sendNow", method: "POST" }).reply(500, "Server Error");

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9", "--send-now"];
    await assert.rejects(() => main(tmpDir));
    const rec = readRecord();
    assert.equal(rec.campaign_id, 395);
    assert.equal(rec.status, "draft");
    assert.ok(rec.error);
  });
});

describe("readResumableCampaignId (#11808)", () => {
  it("draft e test_sent são reaproveitáveis; sent/scheduled/ausente/ilegível não", () => {
    const dir = join(tmpDir, "_internal");
    assert.equal(readResumableCampaignId(dir), null);
    writeRecord({ campaign_id: 7, status: "draft" });
    assert.equal(readResumableCampaignId(dir), 7);
    writeRecord({ campaign_id: 7, status: "test_sent" });
    assert.equal(readResumableCampaignId(dir), 7);
    writeRecord({ campaign_id: 7, status: "sent" });
    assert.equal(readResumableCampaignId(dir), null);
    writeRecord({ campaign_id: 7, status: "scheduled" });
    assert.equal(readResumableCampaignId(dir), null);
    writeRecord({ campaign_id: "7", status: "draft" });
    assert.equal(readResumableCampaignId(dir), null);
    writeFileSync(join(dir, "05-published.json"), "{not json");
    assert.equal(readResumableCampaignId(dir), null);
    assert.ok(existsSync(join(dir, "05-published.json")));
  });
});

describe("parseArgs --new-campaign (#11808)", () => {
  it("aceita --new-campaign e recusa junto com --update-existing", () => {
    assert.equal(parseArgs(["--yymm", "2604", "--new-campaign"]).newCampaign, true);
    assert.equal(parseArgs(["--yymm", "2604"]).newCampaign, false);
    const realStderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      assert.throws(
        () => parseArgs(["--yymm", "2604", "--new-campaign", "--update-existing", "5"]),
        (e: unknown) => e instanceof CliExit && e.code === 1,
      );
    } finally {
      process.stderr.write = realStderr;
    }
  });
});
