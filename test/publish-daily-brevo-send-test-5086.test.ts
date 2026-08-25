/**
 * test/publish-daily-brevo-send-test-5086.test.ts (#5086)
 *
 * Teste de integração de ponta a ponta pra `main()` de `publish-daily-brevo.ts`
 * cobrindo a flag `--send-test`/`--send-test-to` (espelha `publish-monthly.ts`,
 * ver docstring do módulo). As checagens de unidade dos guards puros
 * (`checkSendTestGuards`/`resolveSendTestRecipient`) vivem em
 * `publish-daily-brevo-4266.test.ts`; este arquivo cobre o WIRING —
 * `POST /emailCampaigns/{id}/sendTest` de fato disparado com o payload certo
 * DEPOIS do rascunho criado, e o estado persistido em
 * `<edition-dir>/_internal/brevo-diaria-published.json`.
 *
 * Mesma estrutura de fixture/router mockado de
 * `publish-daily-brevo-integration-4532.test.ts` (não importado daqui —
 * mesmo padrão de duplicação já usado entre os testes de integração deste
 * script; cada arquivo de teste de integração no repo monta seu próprio
 * router, ver también select-linkedin-weekly-integration.test.ts).
 *
 * GUARD DE PUBLICAÇÃO: nenhuma chamada de rede real acontece aqui —
 * `globalThis.fetch` é sempre mockado, nunca a Brevo real.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type BrevoDiariaPublished } from "../scripts/publish-daily-brevo.ts";

const LIST_ID = 42;
const API_KEY_ENV = "TEST_BREVO_DIARIA_API_KEY_5086";
const API_KEY = "fake_brevo_key";
const EDITION_DATE = "260812";

const originalExit = process.exit;
const originalArgv = process.argv;
const ENV_KEYS = [API_KEY_ENV, "POLL_SECRET", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_WORKERS_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};

let exitCode: number | null = null;

function mockProcessExit(): void {
  exitCode = null;
  // @ts-expect-error mocking
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__mocked_exit__");
  };
}

function restoreProcessExit(): void {
  process.exit = originalExit;
}

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

after(() => {
  process.argv = originalArgv;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "publish-daily-brevo-send-test-"));
}

function writePlatformConfig(root: string, overrides: Record<string, unknown> = {}): void {
  const cfg = {
    brevo_diaria: {
      api_key_env: API_KEY_ENV,
      list_id: LIST_ID,
      sender_email: "editor@diar.ia.br",
      sender_name: "diar.ia.br",
      daily_send_cap: 300,
      test_email: "vjpixel@gmail.com",
      ...overrides,
    },
  };
  writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg), "utf8");
}

/** Mesmo fixture mínimo de publish-daily-brevo-integration-4532.test.ts. */
const REVIEWED_MD = [
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[Título um](https://example.com/1)**",
  "",
  "Corpo do destaque um com contexto suficiente pra render.",
  "",
  "Por que isso importa: razão um.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | RADAR**",
  "",
  "**[Título dois](https://example.com/2)**",
  "",
  "Corpo dois.",
  "",
  "Por que isso importa: razão dois.",
  "",
].join("\n");

/** Fixture mínima do bloco de intro obrigatório do segmento Pending (#4266
 * item 5) — sem ela `buildDailyBrevoHtml` lança (erro duro de compliance).
 * `data/snippets/` é gitignored/junction OneDrive (#5227), ausente neste
 * root de teste; escrever a fixture aqui é o mesmo padrão de DI já usado
 * pelos demais loaders de snippet (ex: encerramento-social-apoio-3219.test.ts). */
const PENDING_INTRO_FIXTURE = [
  "<!-- fixture de teste, não é a cópia real revisada pelo editor -->",
  "",
  "Você está recebendo este e-mail porque se inscreveu na diar.ia.br.",
  "",
  "→ [Confirmar meu cadastro](https://reativar.diaria.workers.dev/?email={{ contact.EMAIL }})",
  "",
  "Se preferir, você pode se [descadastrar]({{ unsubscribe }}) a qualquer momento.",
  "",
].join("\n");

function writeEdition(root: string, date: string): void {
  const dir = join(root, "data/editions", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD, "utf8");
  writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
  const snippetsDir = join(root, "data/snippets");
  mkdirSync(snippetsDir, { recursive: true });
  writeFileSync(join(snippetsDir, "brevo-diaria-pending-intro.md"), PENDING_INTRO_FIXTURE, "utf8");
}

function jsonRes(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
    json: async () => body,
    body: { cancel: async () => {} },
  } as unknown as Response;
}

function noContentRes(status = 204): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => "",
    body: { cancel: async () => {} },
  } as unknown as Response;
}

interface Call {
  method: string;
  hostname: string;
  pathname: string;
  body: unknown;
}

let calls: Call[] = [];
let originalFetch: typeof fetch;

function installRouter(opts: { totalSubscribers: number; contactsPages: Array<Array<{ email?: string; attributes?: Record<string, unknown> }>> }): void {
  calls = [];
  const { totalSubscribers, contactsPages } = opts;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? typeof init.body === "string"
        ? (() => {
            try {
              return JSON.parse(init.body as string);
            } catch {
              return init.body;
            }
          })()
        : init.body
      : undefined;
    calls.push({ method, hostname: url.hostname, pathname: url.pathname, body });

    if (url.hostname === "api.brevo.com") {
      if (method === "GET" && url.pathname === `/v3/contacts/lists/${LIST_ID}`) {
        return jsonRes(200, { id: LIST_ID, name: "diária", totalSubscribers });
      }
      if (method === "GET" && url.pathname === "/v3/contacts/attributes") {
        return jsonRes(200, { attributes: [{ name: "POLL_TOKEN", category: "normal", type: "text" }] });
      }
      if (method === "POST" && url.pathname === "/v3/contacts/attributes/normal/POLL_TOKEN") {
        return jsonRes(201, { name: "POLL_TOKEN" });
      }
      if (method === "GET" && url.pathname === `/v3/contacts/lists/${LIST_ID}/contacts`) {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const pageIdx = offset / limit;
        const page = contactsPages[pageIdx] ?? [];
        return jsonRes(200, { contacts: page, count: contactsPages.flat().length });
      }
      if (method === "PUT" && url.pathname.startsWith("/v3/contacts/") && !url.pathname.startsWith("/v3/contacts/lists")) {
        return noContentRes(204);
      }
      if (method === "POST" && url.pathname === "/v3/emailCampaigns") {
        return jsonRes(201, { id: 999 });
      }
      if (method === "PUT" && url.pathname === "/v3/emailCampaigns/999") {
        return noContentRes(204);
      }
      if (method === "POST" && url.pathname === "/v3/emailCampaigns/999/sendTest") {
        return jsonRes(204, {});
      }
      // #6146 — guard de cota da CONTA. Conta zerada (`requests: 0`) é o dia
      // normal; estes casos seguem testando o que sempre testaram.
      if (method === "GET" && url.pathname === "/v3/smtp/statistics/aggregatedReport") {
        return jsonRes(200, { requests: 0 });
      }
      if (method === "GET" && url.pathname === "/v3/account") {
        return jsonRes(200, { plan: [{ type: "free", credits: 0, creditsType: "sendLimit" }] });
      }
    }
    if (url.hostname === "api.cloudflare.com" && method === "PUT" && url.pathname.includes("/storage/kv/namespaces/")) {
      return jsonRes(200, { success: true, result: {} });
    }
    throw new Error(`unexpected fetch: ${method} ${url.hostname}${url.pathname}${url.search}`);
  }) as typeof fetch;
}

function setAllCredentials(): void {
  process.env[API_KEY_ENV] = API_KEY;
  process.env.POLL_SECRET = "test_poll_secret";
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  process.env.CLOUDFLARE_WORKERS_TOKEN = "kvtoken";
}

const SIX_CONTACTS = [
  { email: "ok@x.com", attributes: {} },
  { email: "ok2@x.com", attributes: {} },
  { email: "ok3@x.com", attributes: {} },
  { email: "ok4@x.com", attributes: {} },
  { email: "ok5@x.com", attributes: {} },
  { email: "ok6@x.com", attributes: {} },
];

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreProcessExit();
  process.exitCode = undefined;
});

describe("publish-daily-brevo.ts main() — --send-test (#5086)", () => {
  it("--send-test sem --send-test-to nem test_email configurado → aborta ANTES de qualquer fetch (exit 1), nunca cria a campanha", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root, { test_email: null });
      writeEdition(root, EDITION_DATE);
      setAllCredentials();
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy", "--send-test"];
      mockProcessExit();

      await assert.rejects(main(root), /__mocked_exit__/);
      assert.equal(exitCode, 1, "guard de --send-test sem destinatário deveria abortar com exit(1)");
      assert.equal(calls.length, 0, "nenhuma chamada de rede deveria ter acontecido — guard é pré-await");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--send-test-to sem --send-test → aborta ANTES de qualquer fetch (exit 1)", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = [
        "node",
        "publish-daily-brevo.ts",
        `data/editions/${EDITION_DATE}`,
        "--i-reviewed-the-copy",
        "--send-test-to",
        "outro@example.com",
      ];
      mockProcessExit();

      await assert.rejects(main(root), /__mocked_exit__/);
      assert.equal(exitCode, 1);
      assert.equal(calls.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run --send-test: loga o destinatário resolvido, mas NUNCA chama sendTest nem cria campanha", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--dry-run", "--send-test"];
      mockProcessExit();

      await main(root);

      assert.equal(exitCode, null, "dry-run não deveria abortar");
      assert.equal(calls.length, 0, "--dry-run nunca toca a rede, mesmo com --send-test");
      const publishedPath = join(root, "data/editions", EDITION_DATE, "_internal/brevo-diaria-published.json");
      assert.equal(existsSync(publishedPath), false, "--dry-run não persiste estado de teste");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--send-test com destinatário via brevo_diaria.test_email (default): cria a campanha, dispara sendTest, persiste estado", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root, { test_email: "vjpixel@gmail.com" });
      writeEdition(root, EDITION_DATE);
      setAllCredentials();
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy", "--send-test"];
      mockProcessExit();

      await main(root);

      assert.equal(exitCode, null, "não deveria ter chamado process.exit em nenhum momento");

      const campaignCall = calls.find((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns");
      assert.ok(campaignCall, "POST /emailCampaigns deveria ter sido disparado");

      const sendTestCall = calls.find((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns/999/sendTest");
      assert.ok(sendTestCall, `POST /emailCampaigns/999/sendTest deveria ter sido disparado: ${JSON.stringify(calls)}`);
      assert.deepEqual((sendTestCall!.body as { emailTo: string[] }).emailTo, ["vjpixel@gmail.com"]);

      // Ordem: sendTest só depois da campanha já existir.
      const campaignIdx = calls.indexOf(campaignCall!);
      const sendTestIdx = calls.indexOf(sendTestCall!);
      assert.ok(sendTestIdx > campaignIdx, "sendTest deveria ser chamado DEPOIS da campanha criada");

      const publishedPath = join(root, "data/editions", EDITION_DATE, "_internal/brevo-diaria-published.json");
      assert.ok(existsSync(publishedPath), "estado do teste deveria ter sido persistido");
      const published = JSON.parse(readFileSync(publishedPath, "utf8")) as BrevoDiariaPublished;
      assert.equal(published.campaign_id, 999);
      assert.equal(published.status, "test_sent");
      assert.equal(published.test_email, "vjpixel@gmail.com");
      assert.equal(published.list_id, LIST_ID);
      assert.ok(published.test_sent_at, "test_sent_at deveria estar presente");
      assert.ok(!Number.isNaN(Date.parse(published.test_sent_at)), "test_sent_at deveria ser um timestamp ISO válido");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--send-test-to sobrepõe brevo_diaria.test_email (prioridade #5086)", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root, { test_email: "default@example.com" });
      writeEdition(root, EDITION_DATE);
      setAllCredentials();
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = [
        "node",
        "publish-daily-brevo.ts",
        `data/editions/${EDITION_DATE}`,
        "--i-reviewed-the-copy",
        "--send-test",
        "--send-test-to",
        "override@example.com",
      ];
      mockProcessExit();

      await main(root);

      assert.equal(exitCode, null);
      const sendTestCall = calls.find((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns/999/sendTest");
      assert.ok(sendTestCall);
      assert.deepEqual((sendTestCall!.body as { emailTo: string[] }).emailTo, ["override@example.com"]);

      const publishedPath = join(root, "data/editions", EDITION_DATE, "_internal/brevo-diaria-published.json");
      const published = JSON.parse(readFileSync(publishedPath, "utf8")) as BrevoDiariaPublished;
      assert.equal(published.test_email, "override@example.com");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#5086 self-review: --send-test-to ANTES do <edition-dir> posicional não rouba o slot do edition-dir (regressão do argv.find ingênuo)", async () => {
    // Antes deste fix, `editionDirArg = argv.find((a) => !a.startsWith("--"))`
    // casava com o PRIMEIRO token sem "--" em qualquer posição do argv — com
    // `--send-test-to <email>` introduzindo o 1º flag-de-valor deste script,
    // `--send-test-to voce@x.com <edition-dir>` resolvia editionDirArg como
    // "voce@x.com" (o valor do flag), não o path da edição. Fix: usa
    // `parseCliArgs(argv).positional[0]`, que já separa flag-values de
    // positional corretamente (mesmo parser usado por --send-test-to).
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = [
        "node",
        "publish-daily-brevo.ts",
        "--send-test-to",
        "override@example.com",
        `data/editions/${EDITION_DATE}`,
        "--i-reviewed-the-copy",
        "--send-test",
      ];
      mockProcessExit();

      await main(root);

      assert.equal(exitCode, null, "edition-dir deveria ter sido resolvido corretamente, sem abortar");
      assert.ok(
        calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"),
        "campanha deveria ter sido criada — se editionDirArg tivesse virado 'override@example.com', extractContent teria lançado antes de qualquer fetch",
      );
      const sendTestCall = calls.find((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns/999/sendTest");
      assert.deepEqual((sendTestCall!.body as { emailTo: string[] }).emailTo, ["override@example.com"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem --send-test: nenhum sendTest disparado; brevo-diaria-published.json É escrito como status draft (#5677 — antes ficava sem rastro, o que causava campanha duplicada no --send-test seguinte)", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();

      await main(root);

      assert.equal(exitCode, null);
      assert.ok(calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"));
      assert.ok(!calls.some((c) => c.pathname.endsWith("/sendTest")), "sendTest nunca deveria ser chamado sem --send-test");

      const publishedPath = join(root, "data/editions", EDITION_DATE, "_internal/brevo-diaria-published.json");
      assert.ok(existsSync(publishedPath), "#5677: o rascunho criado precisa deixar rastro, senão uma invocação futura não sabe reaproveitá-lo");
      const published = JSON.parse(readFileSync(publishedPath, "utf8")) as BrevoDiariaPublished;
      assert.equal(published.status, "draft");
      assert.equal(published.campaign_id, 999);
      assert.equal(published.test_email, undefined, "status draft não tem test_email ainda");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#5677: 2ª invocação com --send-test reaproveita a campanha do rascunho já criado, não cria uma 2ª (regressão do incidente 260819, ids 24/25)", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      // 1ª invocação: só cria o rascunho (sem --send-test).
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();
      await main(root);
      assert.equal(exitCode, null);
      const firstCampaignCalls = calls.filter((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns");
      assert.equal(firstCampaignCalls.length, 1, "1ª invocação deveria criar exatamente 1 campanha");

      // 2ª invocação: --send-test. Router reinstalado (calls zerado) pra
      // isolar as chamadas desta invocação especificamente.
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = [
        "node",
        "publish-daily-brevo.ts",
        `data/editions/${EDITION_DATE}`,
        "--i-reviewed-the-copy",
        "--send-test",
      ];
      mockProcessExit();
      await main(root);
      assert.equal(exitCode, null);

      const secondCampaignCalls = calls.filter((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns");
      assert.equal(
        secondCampaignCalls.length,
        0,
        "2ª invocação NÃO deveria criar uma nova campanha — deveria reaproveitar a do rascunho (#5677)",
      );
      const sendTestCall = calls.find((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns/999/sendTest");
      assert.ok(sendTestCall, "sendTest deveria ter sido disparado sobre a campanha reaproveitada (id=999)");

      const publishedPath = join(root, "data/editions", EDITION_DATE, "_internal/brevo-diaria-published.json");
      const published = JSON.parse(readFileSync(publishedPath, "utf8")) as BrevoDiariaPublished;
      assert.equal(published.status, "test_sent");
      assert.equal(published.campaign_id, 999, "campaign_id da campanha reaproveitada, não uma nova");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#5677: --force cria uma 2ª campanha de propósito mesmo com rascunho já registrado", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();
      await main(root);
      assert.equal(exitCode, null);

      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = [
        "node",
        "publish-daily-brevo.ts",
        `data/editions/${EDITION_DATE}`,
        "--i-reviewed-the-copy",
        "--force",
      ];
      mockProcessExit();
      await main(root);
      assert.equal(exitCode, null);

      const secondCampaignCalls = calls.filter((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns");
      assert.equal(secondCampaignCalls.length, 1, "--force deveria ter criado uma 2ª campanha de propósito");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#5689: reuse com conteúdo divergente atualiza a campanha via PUT (subject/preview/html novos) ANTES do sendTest reaproveitar o id — regressão do #5687", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      // 1ª invocação: cria o rascunho com o conteúdo V1 ("Título um").
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();
      await main(root);
      assert.equal(exitCode, null);

      const editionDir = join(root, "data/editions", EDITION_DATE);
      const publishedPath = join(editionDir, "_internal/brevo-diaria-published.json");
      const draftPublished = JSON.parse(readFileSync(publishedPath, "utf8")) as BrevoDiariaPublished;
      assert.equal(draftPublished.subject, "Título um", "subject V1 registrado no rascunho");

      // Editor corrige 02-reviewed.md entre as duas invocações (conteúdo V2).
      const editedMd = REVIEWED_MD.replace("Título um", "Título um CORRIGIDO");
      writeFileSync(join(editionDir, "02-reviewed.md"), editedMd, "utf8");

      // 2ª invocação: --send-test. Router reinstalado (calls zerado) pra
      // isolar as chamadas desta invocação.
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = [
        "node",
        "publish-daily-brevo.ts",
        `data/editions/${EDITION_DATE}`,
        "--i-reviewed-the-copy",
        "--send-test",
      ];
      mockProcessExit();
      await main(root);
      assert.equal(exitCode, null);

      // Nenhuma campanha nova — mesmo campaign_id reaproveitado (#5677).
      const createCalls = calls.filter((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns");
      assert.equal(createCalls.length, 0, "reuse não deveria criar uma 2ª campanha");

      // O CORAÇÃO do #5689: PUT /emailCampaigns/999 com o conteúdo V2 recalculado.
      const putCalls = calls.filter((c) => c.method === "PUT" && c.pathname === "/v3/emailCampaigns/999");
      assert.equal(putCalls.length, 1, "reuse deveria disparar exatamente 1 PUT de atualização de conteúdo");
      const putBody = putCalls[0].body as { subject: string; previewText: string; htmlContent: string };
      assert.equal(putBody.subject, "Título um CORRIGIDO", "PUT deveria levar o subject RECALCULADO (V2), não o V1 registrado");
      assert.ok(
        putBody.htmlContent.includes("Título um CORRIGIDO"),
        "PUT deveria levar o html recalculado com o título corrigido",
      );

      // Ordem: PUT de atualização acontece ANTES do sendTest reaproveitar o id
      // (senão o teste sairia com o conteúdo V1 antigo — o próprio bug do #5689).
      const putIdx = calls.findIndex((c) => c.method === "PUT" && c.pathname === "/v3/emailCampaigns/999");
      const sendTestIdx = calls.findIndex((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns/999/sendTest");
      assert.ok(putIdx >= 0 && sendTestIdx >= 0, "ambas as chamadas deveriam ter acontecido");
      assert.ok(putIdx < sendTestIdx, "PUT de atualização deveria acontecer ANTES do sendTest");

      // Estado final reflete o conteúdo V2 (não fica preso ao V1 registrado na 1ª invocação).
      const finalPublished = JSON.parse(readFileSync(publishedPath, "utf8")) as BrevoDiariaPublished;
      assert.equal(finalPublished.subject, "Título um CORRIGIDO");
      assert.equal(finalPublished.campaign_id, 999);
      assert.equal(finalPublished.status, "test_sent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#5689: reuse SEM --send-test também atualiza via PUT e persiste o subject/preview recalculados no state file", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();
      await main(root);
      assert.equal(exitCode, null);

      const editionDir = join(root, "data/editions", EDITION_DATE);
      const editedMd = REVIEWED_MD.replace("Título um", "Título um V2");
      writeFileSync(join(editionDir, "02-reviewed.md"), editedMd, "utf8");

      // 2ª invocação: sem --send-test — só reaproveita o rascunho.
      installRouter({ totalSubscribers: 6, contactsPages: [SIX_CONTACTS] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();
      await main(root);
      assert.equal(exitCode, null);

      const putCalls = calls.filter((c) => c.method === "PUT" && c.pathname === "/v3/emailCampaigns/999");
      assert.equal(putCalls.length, 1, "reuse sem --send-test ainda deveria atualizar o conteúdo via PUT");
      const sendTestCalls = calls.filter((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns/999/sendTest");
      assert.equal(sendTestCalls.length, 0, "sem --send-test, nenhum sendTest deveria disparar");

      const publishedPath = join(editionDir, "_internal/brevo-diaria-published.json");
      const published = JSON.parse(readFileSync(publishedPath, "utf8")) as BrevoDiariaPublished;
      assert.equal(published.subject, "Título um V2", "state file deveria refletir o subject V2, não ficar preso ao V1");
      assert.equal(published.status, "draft", "reuse sem --send-test mantém status draft");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
