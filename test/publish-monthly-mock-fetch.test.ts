import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHmac } from "node:crypto";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { main } from "../scripts/publish-monthly.ts";
import { uploadEiaImages, uploadDestaqueImages, LIVROS_PROMO_FILENAME } from "../scripts/lib/mensal/monthly-image-upload.ts";

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

// ─── #2802: box de Livros com imagem no caminho de PUBLISH (Brevo) ─────────
//
// Bug: publish-monthly.ts renderizava o box de Livros (LIVROS no draft.md)
// mas NUNCA subia `04-livros-promo.jpg` pro KV nem passava `livrosImageUrl`
// pro draftToEmail — só o preview (monthly-preview-cloudflare.ts) fazia isso.
// Efeito: o email real saía sem a imagem do box, divergindo do preview.
//
// Fix: main() agora aceita um `uploadDeps` opcional (injeção de dependência,
// #2802) com overrides das 3 funções de upload de imagem — permite testar a
// wiring completa (upload → draftToEmail → htmlContent) SEM tocar rede real
// (GUARD DE PUBLICAÇÃO), injetando um fake `uploadLivrosImage` que retorna
// uma URL fake, e usando os uploaders reais de É IA?/destaque (que degradam
// pra {} sem crashar quando os arquivos de imagem não existem na fixture).
const DRAFT_WITH_LIVROS = `**ASSUNTO**

Edição de Teste

**PREVIEW**

Preview do teste.

**INTRO**

Sumário do mês de teste.

**\\[DESTAQUE 1\\] TESTE**

**Título do destaque de teste**

Body do destaque com [link](https://example.com).

**LIVROS**

**Descubra os livros do mês**

Uma seleção de livros recomendados pela redação.

**PARA ENCERRAR**

Fim da edição de teste.
`;

describe("publish-monthly main(): box de Livros com imagem (#2802)", () => {
  it("imagem presente + upload mockado → <img> do livros aparece no htmlContent enviado à Brevo", async () => {
    writeFileSync(join(tmpDir, "draft.md"), DRAFT_WITH_LIVROS);
    // Arquivo precisa existir pro fluxo real chegar a chamar o upload (mock só
    // troca o QUE o upload retorna, não a checagem de existência).
    writeFileSync(join(tmpDir, LIVROS_PROMO_FILENAME), Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // JPEG mínimo

    const FAKE_LIVROS_URL = "https://poll.diaria.workers.dev/img/img-260430-04-livros-promo-fake.jpg";

    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });

    let capturedBody = "";
    brevoMock.intercept({
      path: "/v3/emailCampaigns",
      method: "POST",
      body: (body: string) => {
        capturedBody = body;
        return true;
      },
    }).reply(201, { id: 200 }, { headers: { "content-type": "application/json" } });

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9"];

    await main(tmpDir, {
      // Sem 01-eia-*/04-d{N}-2x1.jpg na fixture → degradam pra {} sem network real.
      uploadEiaImages,
      uploadDestaqueImages,
      // Mock: simula upload bem-sucedido sem tocar rede/credenciais reais.
      uploadLivrosImage: async () => FAKE_LIVROS_URL,
    });

    assert.ok(capturedBody, "POST /emailCampaigns deve ter sido chamado");
    const parsed = JSON.parse(capturedBody) as { htmlContent: string };
    assert.match(parsed.htmlContent, /<img[^>]*src="[^"]*img-260430-04-livros-promo-fake\.jpg"/,
      "htmlContent deve conter <img> apontando pra URL retornada pelo upload de livros");
  });

  it("imagem ausente no dir → publish segue sem <img> do livros (degrade, sem crash)", async () => {
    writeFileSync(join(tmpDir, "draft.md"), DRAFT_WITH_LIVROS);
    // Deliberadamente SEM escrever 04-livros-promo.jpg em tmpDir.
    assert.equal(existsSync(join(tmpDir, LIVROS_PROMO_FILENAME)), false);

    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });

    let capturedBody = "";
    brevoMock.intercept({
      path: "/v3/emailCampaigns",
      method: "POST",
      body: (body: string) => {
        capturedBody = body;
        return true;
      },
    }).reply(201, { id: 201 }, { headers: { "content-type": "application/json" } });

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9"];

    // Deps default (reais) — CLOUDFLARE_ACCOUNT_ID/TOKEN vazios no env do describe
    // pai, mas isso é moot aqui: uploadLivrosImage nem tenta rede, pois o arquivo
    // não existe (curto-circuita no existsSync).
    await main(tmpDir);

    assert.ok(capturedBody, "POST /emailCampaigns deve ter sido chamado mesmo sem imagem");
    const parsed = JSON.parse(capturedBody) as { htmlContent: string };
    // Box de livros (kicker "Livros") ainda renderiza — só sem <img>.
    assert.match(parsed.htmlContent, /Livros/);
    assert.doesNotMatch(parsed.htmlContent, /04-livros-promo/,
      "sem upload bem-sucedido, htmlContent não deve referenciar a imagem de livros");
  });
});

// #2948: follow-up de #2709 — o suporte de render (opt-in) da linha
// "Resultado da última edição: X% acertaram" no bloco É IA? mensal já
// existia, mas nenhum caller buscava o dado real. Este describe cobre a
// WIRING: main() → fetchEiaPrevResultLine (injetável, #2948 espelha o
// padrão de uploadDeps do #2802) → draftToEmail → htmlContent.
const DRAFT_WITH_EIA = `**\\[ASSUNTO\\]**

1. Assunto de teste

**\\[É IA? — DESTAQUE DO MÊS\\]**

[placeholder a ser ignorado]
`;

describe("publish-monthly main(): % acertaram do É IA? anterior (#2948)", () => {
  it("dado presente (fetchEiaPrevResultLine mockado) → linha aparece no htmlContent", async () => {
    writeFileSync(join(tmpDir, "draft.md"), DRAFT_WITH_EIA);

    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });

    let capturedBody = "";
    brevoMock.intercept({
      path: "/v3/emailCampaigns",
      method: "POST",
      body: (body: string) => {
        capturedBody = body;
        return true;
      },
    }).reply(201, { id: 300 }, { headers: { "content-type": "application/json" } });

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9"];

    await main(tmpDir, {
      uploadEiaImages,
      uploadDestaqueImages,
      uploadLivrosImage: async () => undefined,
      // Mock: simula o fetch real (poll.diaria.workers.dev/stats?brand=clarice)
      // já tendo achado um ciclo anterior elegível — sem tocar rede real.
      fetchEiaPrevResultLine: async () => "Resultado da última edição: 83% das pessoas acertaram.",
    });

    assert.ok(capturedBody, "POST /emailCampaigns deve ter sido chamado");
    const parsed = JSON.parse(capturedBody) as { htmlContent: string };
    assert.match(
      parsed.htmlContent,
      /Resultado da última edição: 83% das pessoas acertaram\./,
      "htmlContent deve conter a linha de % acertaram vinda do fetch mockado",
    );
  });

  it("sem dado (deps default — fetch real bloqueado pelo MockAgent, sem interceptor pro poll worker) → degrade sem a linha", async () => {
    writeFileSync(join(tmpDir, "draft.md"), DRAFT_WITH_EIA);

    const brevoMock = mockAgent.get("https://api.brevo.com");
    brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
      id: 9, name: "T1-W1", totalSubscribers: 50,
    }, { headers: { "content-type": "application/json" } });

    let capturedBody = "";
    brevoMock.intercept({
      path: "/v3/emailCampaigns",
      method: "POST",
      body: (body: string) => {
        capturedBody = body;
        return true;
      },
    }).reply(201, { id: 301 }, { headers: { "content-type": "application/json" } });

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9"];

    // Deps default (reais): fetchEiaPrevResultLine não é sobrescrito → tenta o
    // fetch real do Worker poll. mockAgent.disableNetConnect() (setado no
    // before() do topo do arquivo) bloqueia por não haver interceptor
    // registrado pra poll.diaria.workers.dev — fetchPollStats nunca lança
    // (fail-soft), então o card renderiza normalmente, só sem a linha.
    await main(tmpDir);

    assert.ok(capturedBody, "POST /emailCampaigns deve ter sido chamado mesmo sem stats");
    const parsed = JSON.parse(capturedBody) as { htmlContent: string };
    // #recomendacao-leitura: ponto final removido permanentemente (diária + mensal).
    assert.match(parsed.htmlContent, /Clique na imagem que foi gerada por IA/, "card do É IA? ainda renderiza");
    assert.doesNotMatch(
      parsed.htmlContent,
      /acertaram/i,
      "sem dado real (fetch bloqueado), htmlContent não deve mencionar % acertaram",
    );
  });
});

// ─── #3226: registerEiaAnswer() usava POLL_SECRET (env var errada) pra ────
// calcular o HMAC admin do /admin/correct — Worker valida contra ADMIN_SECRET
// (workers/poll/src/index.ts:274/192), então toda tentativa de pré-registrar
// o gabarito É IA? mensal falhava com "invalid signature". close-poll.ts já
// tinha o fix certo desde #1176 (ADMIN_SECRET ?? POLL_ADMIN_SECRET); este PR
// aplica o mesmo padrão em publish-monthly.ts.
//
// mirrorAdminSig() replica localmente o algoritmo de close-poll.ts (linha
// "adminSig": createHmac("sha256", secret).update(`${edition}:${answer}`))
// — close-poll.ts não exporta essa função (nem main()), então não há um
// helper compartilhado pra importar; os outros testes de HMAC do repo (ex:
// test/workers-draft.test.ts) seguem o mesmo padrão de duplicar o algoritmo
// localmente em vez de importar internals não-exportados.
function mirrorAdminSig(secret: string, edition: string, answer: string): string {
  return createHmac("sha256", secret).update(`${edition}:${answer}`).digest("hex");
}

const EIA_ANSWER_SIDECAR = {
  edition: "260430",
  answer: { A: "ia", B: "real" },
  ai_side: "A",
};

/** Escreve o sidecar canônico (`lib/eia-answer.ts`) que registerEiaAnswer() lê primeiro. */
function writeEiaSidecar(dir: string): void {
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "_internal", "01-eia-answer.json"),
    JSON.stringify(EIA_ANSWER_SIDECAR, null, 2) + "\n",
    "utf8",
  );
}

/** Mocks mínimos da Brevo pra deixar main() completar (idênticos aos usados acima). */
function mockBrevoMinimalHappyPath(agent: MockAgent, campaignId: number): void {
  const brevoMock = agent.get("https://api.brevo.com");
  brevoMock.intercept({ path: "/v3/contacts/lists/9", method: "GET" }).reply(200, {
    id: 9, name: "T1-W1", totalSubscribers: 50,
  }, { headers: { "content-type": "application/json" } });
  brevoMock.intercept({ path: "/v3/emailCampaigns", method: "POST" }).reply(201, {
    id: campaignId,
  }, { headers: { "content-type": "application/json" } });
}

const POLL_WORKER_URL = "https://mock-poll-worker.invalid";
const SECRET_ENV_KEYS = ["ADMIN_SECRET", "POLL_ADMIN_SECRET", "POLL_SECRET"] as const;

function clearSecretEnv(): void {
  for (const k of SECRET_ENV_KEYS) delete process.env[k];
}

describe("publish-monthly main(): registerEiaAnswer() usa ADMIN_SECRET, não POLL_SECRET (#3226)", () => {
  afterEach(() => {
    clearSecretEnv();
    delete process.env.POLL_WORKER_URL;
  });

  it("ADMIN_SECRET presente → sig do /admin/correct bate com o algoritmo de close-poll.ts", async () => {
    writeEiaSidecar(tmpDir);
    clearSecretEnv();
    process.env.ADMIN_SECRET = "test-admin-secret-3226";
    process.env.POLL_WORKER_URL = POLL_WORKER_URL;

    mockBrevoMinimalHappyPath(mockAgent, 400);

    let capturedPath: string | null = null;
    mockAgent.get(POLL_WORKER_URL).intercept({
      path: (path) => {
        if (!path.startsWith("/admin/correct")) return false;
        capturedPath = path;
        return true;
      },
      method: "POST",
    }).reply(200, { ok: true, updated_votes: 3 }, { headers: { "content-type": "application/json" } });

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9"];
    await main(tmpDir);

    assert.ok(capturedPath, "registerEiaAnswer() deveria ter chamado POST /admin/correct");
    const url = new URL(capturedPath as string, POLL_WORKER_URL);
    const edition = url.searchParams.get("edition");
    const answer = url.searchParams.get("answer");
    const sig = url.searchParams.get("sig");
    assert.equal(answer, "A", "ai_side do sidecar (#927) deve ir como answer");
    assert.equal(url.searchParams.get("brand"), "clarice");
    assert.ok(edition, "edition deve estar presente na query");

    const expectedSig = mirrorAdminSig("test-admin-secret-3226", edition as string, answer as string);
    assert.equal(sig, expectedSig, "sig deve ser HMAC-SHA256(ADMIN_SECRET, `${edition}:${answer}`) — mesmo algoritmo de close-poll.ts");
  });

  it("POLL_ADMIN_SECRET (alias, sem ADMIN_SECRET) → mesmo fallback documentado em close-poll.ts", async () => {
    writeEiaSidecar(tmpDir);
    clearSecretEnv();
    process.env.POLL_ADMIN_SECRET = "test-alias-secret-3226";
    process.env.POLL_WORKER_URL = POLL_WORKER_URL;

    mockBrevoMinimalHappyPath(mockAgent, 401);

    let capturedPath: string | null = null;
    mockAgent.get(POLL_WORKER_URL).intercept({
      path: (path) => {
        if (!path.startsWith("/admin/correct")) return false;
        capturedPath = path;
        return true;
      },
      method: "POST",
    }).reply(200, { ok: true, updated_votes: 1 }, { headers: { "content-type": "application/json" } });

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9"];
    await main(tmpDir);

    assert.ok(capturedPath, "registerEiaAnswer() deveria ter chamado POST /admin/correct via alias POLL_ADMIN_SECRET");
    const url = new URL(capturedPath as string, POLL_WORKER_URL);
    const edition = url.searchParams.get("edition");
    const answer = url.searchParams.get("answer");
    const expectedSig = mirrorAdminSig("test-alias-secret-3226", edition as string, answer as string);
    assert.equal(url.searchParams.get("sig"), expectedSig);
  });

  it("só POLL_SECRET (env var antiga/errada, sem ADMIN_SECRET/POLL_ADMIN_SECRET) → gabarito NÃO é registrado (guarda contra regressão)", async () => {
    writeEiaSidecar(tmpDir);
    clearSecretEnv();
    process.env.POLL_SECRET = "wrong-var-for-admin-correct";
    process.env.POLL_WORKER_URL = POLL_WORKER_URL;

    mockBrevoMinimalHappyPath(mockAgent, 402);

    let pollWorkerCalled = false;
    mockAgent.get(POLL_WORKER_URL).intercept({
      path: (path) => path.startsWith("/admin/correct"),
      method: "POST",
    }).reply(() => {
      pollWorkerCalled = true;
      return { statusCode: 200, data: JSON.stringify({ ok: true, updated_votes: 0 }) };
    });

    process.argv = ["node", "publish-monthly.ts", "--yymm", "2604", "--list-id", "9"];
    await main(tmpDir);

    assert.equal(
      pollWorkerCalled,
      false,
      "sem ADMIN_SECRET/POLL_ADMIN_SECRET, registerEiaAnswer() deve retornar cedo (warn) sem tentar o fetch — a var antiga POLL_SECRET sozinha não deve bastar",
    );
  });
});
