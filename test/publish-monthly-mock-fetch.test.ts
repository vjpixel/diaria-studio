import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { main } from "../scripts/publish-monthly.ts";

/**
 * Integration test do main() do publish-monthly com mock fetch (#1029).
 *
 * Cobre as 6 áreas que ficaram pendentes em PR #1035 (que só usou --dry-run):
 *   - POST /emailCampaigns (criar)
 *   - PUT /emailCampaigns/{id} (update + schedule)
 *   - /sendTest e /sendNow
 *   - Test counter timing
 *   - Status pre-check em --update-existing
 *   - Persist 05-published.json com fields corretos
 *
 * Estratégia:
 *   - undici MockAgent intercepta fetch globalmente
 *   - Fixture sem imagens → upload Cloudflare é skipped (try/catch + warn)
 *   - process.env.BREVO_CLARICE_API_KEY set pra test
 *   - process.argv mockado pra cada test
 */

const FIXTURE_SRC = resolve(import.meta.dirname, "fixtures/publish-monthly/2604");

let tmpDir: string;
let mockAgent: MockAgent;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
const originalArgv = process.argv;
const originalEnv = { ...process.env };
const originalExit = process.exit;
let exitCode: number | null = null;

function setupTmpDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "pm-mock-fetch-"));
  copyFileSync(join(FIXTURE_SRC, "draft.md"), join(tmp, "draft.md"));
  mkdirSync(join(tmp, "_internal"), { recursive: true });
  return tmp;
}

function mockExit(): void {
  exitCode = null;
  // @ts-expect-error mocking
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__mocked_exit__");
  };
}

function restoreExit(): void {
  process.exit = originalExit;
}

before(() => {
  // Setup env: API key fictícia + skip Cloudflare (sem token = não tenta upload)
  process.env.BREVO_CLARICE_API_KEY = "fake-test-key";
  process.env.CLOUDFLARE_ACCOUNT_ID = "";
  process.env.CLOUDFLARE_WORKERS_TOKEN = "";

  // Mock global fetch via undici
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  // Restore tudo. process.env é proxied — limpa adições e reinjeta originais
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  process.argv = originalArgv;
  // Cleanup ordenado: close mock + restore antes de qualquer outra suite rodar
  await mockAgent.close();
  setGlobalDispatcher(originalDispatcher);
});

beforeEach(() => {
  tmpDir = setupTmpDir();
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("publish-monthly main(): --send-test happy path (#1029)", () => {
  it("cria campanha + envia test email + persiste 05-published.json", async () => {
    const brevoMock = mockAgent.get("https://api.brevo.com");

    // 1. GET /contacts/lists/9 (lookup destinatário)
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });

    // 2. POST /emailCampaigns (cria)
    brevoMock.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, {
      id: 99,
    }, { headers: { "content-type": "application/json" } });

    // 3. POST /emailCampaigns/99/sendTest
    brevoMock.intercept({ path: "/v3/emailCampaigns/99/sendTest", method: "POST" }).reply(204, "");

    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "9",
      "--send-test",
    ];

    await main(tmpDir);

    // Verifica output: 05-published.json escrito com status test_sent
    const outPath = join(tmpDir, "_internal", "05-published.json");
    assert.ok(existsSync(outPath), "05-published.json deve existir");
    const out = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(out.campaign_id, 99);
    assert.equal(out.status, "test_sent");
    assert.equal(out.list_id, 9);
    assert.equal(out.list_name, "T1-W1");
    assert.equal(out.list_subscribers, 50);
    assert.ok(out.test_sent_at, "test_sent_at deve estar populado");
  });
});

describe("publish-monthly main(): --send-test-to override (#1029)", () => {
  it("envia test pra email custom (não default), persiste em test_email", async () => {
    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, {
      id: 110,
    }, { headers: { "content-type": "application/json" } });
    // Mock ACEITA qualquer body — não temos como validar emailTo via undici simples,
    // mas o status persistido provará que o flow rodou.
    brevoMock.intercept({ path: "/v3/emailCampaigns/110/sendTest", method: "POST" }).reply(204, "");

    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "9",
      "--send-test",
      "--send-test-to", "felipe@clarice.ai",
    ];
    await main(tmpDir);

    const out = JSON.parse(readFileSync(join(tmpDir, "_internal", "05-published.json"), "utf8"));
    assert.equal(out.test_email, "felipe@clarice.ai", "test_email deve refletir override");
  });
});

describe("publish-monthly main(): --send-now happy path (#1029)", () => {
  it("cria campanha + dispara + status sent", async () => {
    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, {
      id: 100,
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/emailCampaigns/100/sendNow", method: "POST" }).reply(204, "");

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9", "--send-now"];
    await main(tmpDir);

    const out = JSON.parse(readFileSync(join(tmpDir, "_internal", "05-published.json"), "utf8"));
    assert.equal(out.campaign_id, 100);
    assert.equal(out.status, "sent");
    assert.ok(out.sent_at);
  });
});

describe("publish-monthly main(): --schedule-at happy path (#1029)", () => {
  it("cria campanha + PUT scheduledAt + status scheduled", async () => {
    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, {
      id: 101,
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/emailCampaigns/101", method: "PUT" }).reply(204, "");

    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "9",
      "--schedule-at", "2099-01-01T00:00:00Z",
    ];
    await main(tmpDir);

    const out = JSON.parse(readFileSync(join(tmpDir, "_internal", "05-published.json"), "utf8"));
    assert.equal(out.campaign_id, 101);
    assert.equal(out.status, "scheduled");
    assert.match(out.scheduled_at, /^2099-01-01/);
  });
});

describe("publish-monthly main(): --update-existing válido (#1029)", () => {
  it("PUT em campanha draft + envia test", async () => {
    const brevoMock = mockAgent.get("https://api.brevo.com");
    // GET pre-check: campanha 50 está draft
    brevoMock.intercept({ path: "/v3/emailCampaigns/50", method: "GET" }).reply(200, {
      id: 50, name: "Old draft", status: "draft",
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });
    // PUT atualiza
    brevoMock.intercept({ path: "/v3/emailCampaigns/50", method: "PUT" }).reply(204, "");
    // sendTest
    brevoMock.intercept({ path: "/v3/emailCampaigns/50/sendTest", method: "POST" }).reply(204, "");

    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "9",
      "--update-existing", "50",
      "--send-test",
    ];
    await main(tmpDir);

    const out = JSON.parse(readFileSync(join(tmpDir, "_internal", "05-published.json"), "utf8"));
    assert.equal(out.campaign_id, 50);
    assert.equal(out.status, "test_sent");
    assert.equal(out.updated_existing, true);
  });
});

describe("publish-monthly main(): --update-existing em campanha terminal (#1029)", () => {
  it("aborta com exit 1 quando campanha está sent", async () => {
    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/emailCampaigns/50", method: "GET" }).reply(200, {
      id: 50, name: "Already sent", status: "sent",
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });

    process.argv = [
      "node", "publish-monthly.ts",
      "--yymm", "2604",
      "--list-id", "9",
      "--update-existing", "50",
      "--send-test",
    ];
    mockExit();
    try {
      await main(tmpDir);
      assert.fail("Esperava throw via mocked exit");
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__mocked_exit__") throw e;
      assert.equal(exitCode, 1, "Deve sair com code 1");
    } finally {
      restoreExit();
    }

    // 05-published.json NÃO deve ter sido escrito (script abortou antes)
    assert.equal(existsSync(join(tmpDir, "_internal", "05-published.json")), false);
  });
});

describe("publish-monthly main(): test counter timing (#1029)", () => {
  it("counter incrementa SÓ após sucesso /sendTest", async () => {
    const counterPath = join(tmpDir, "_internal", "test-counter.txt");
    writeFileSync(counterPath, "5", "utf8"); // counter inicial

    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, {
      id: 102,
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/emailCampaigns/102/sendTest", method: "POST" }).reply(204, "");

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9", "--send-test"];
    await main(tmpDir);

    // Counter deve ser 6 (5 + 1)
    const newCounter = readFileSync(counterPath, "utf8").trim();
    assert.equal(newCounter, "6", "Counter deve ter incrementado pra 6 após sucesso");
  });

  it("counter NÃO incrementa se /sendTest falha", async () => {
    const counterPath = join(tmpDir, "_internal", "test-counter.txt");
    writeFileSync(counterPath, "10", "utf8"); // counter inicial

    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });
    brevoMock.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, {
      id: 103,
    }, { headers: { "content-type": "application/json" } });
    // sendTest FALHA com 500
    brevoMock.intercept({ path: "/v3/emailCampaigns/103/sendTest", method: "POST" }).reply(500, "Server Error");

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9", "--send-test"];

    let threw = false;
    try {
      await main(tmpDir);
    } catch {
      threw = true;
    }
    assert.ok(threw, "Esperava throw quando /sendTest retorna 500");

    // Counter deve continuar em 10 (não incrementou)
    const counter = readFileSync(counterPath, "utf8").trim();
    assert.equal(counter, "10", "Counter NÃO deve ter incrementado quando /sendTest falha");
  });
});
