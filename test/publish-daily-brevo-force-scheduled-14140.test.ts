/**
 * test/publish-daily-brevo-force-scheduled-14140.test.ts (#14140)
 *
 * Regressão: `publish-daily-brevo.ts --force` criava uma 2ª campanha por cima
 * de uma já AGENDADA quando a semanal não dividia (`tercaListId === null`) —
 * o único bloqueio vinha de `checkReuseSplitConsistency`, que só falha com
 * divisão. A lista recebia a edição duas vezes e o estado perdia o id da
 * agendada.
 *
 * Duas camadas: o guard puro `checkForceOverScheduled` com um cliente Brevo
 * fake (sem rede), e o wiring em `main()` com `globalThis.fetch` mockado
 * (mesmo padrão de fixture/router de publish-daily-brevo-send-test-5086.test.ts).
 *
 * GUARD DE PUBLICAÇÃO: nenhuma chamada de rede real — fetch sempre mockado.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, checkForceOverScheduled, type BrevoDiariaPublished } from "../scripts/publish-daily-brevo.ts";

// ── guard puro ───────────────────────────────────────────────────────────

function fakeClient(statuses: Record<number, string | Error>) {
  const asked: number[] = [];
  return {
    asked,
    getCampaignStatus: async (id: number): Promise<string> => {
      asked.push(id);
      const s = statuses[id];
      if (s instanceof Error) throw s;
      if (s === undefined) throw new Error(`campanha ${id} desconhecida no fake`);
      return s;
    },
  };
}

describe("checkForceOverScheduled (#14140)", () => {
  it("estado local scheduled + --force ⇒ recusa sem nem consultar a Brevo", async () => {
    const c = fakeClient({});
    const r = await checkForceOverScheduled({
      existing: { campaign_id: 555, status: "scheduled" },
      force: true,
      getCampaignStatus: c.getCampaignStatus,
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /AGENDADA/);
    assert.deepEqual(c.asked, []);
  });

  it("estado local draft mas releitura queued + --force ⇒ recusa", async () => {
    const c = fakeClient({ 555: "queued" });
    const r = await checkForceOverScheduled({
      existing: { campaign_id: 555, status: "draft" },
      force: true,
      getCampaignStatus: c.getCampaignStatus,
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /"queued"/);
  });

  it("campanha de terça queued (principal draft) + --force ⇒ recusa", async () => {
    const c = fakeClient({ 555: "draft", 556: "queued" });
    const r = await checkForceOverScheduled({
      existing: { campaign_id: 555, status: "test_sent", terca_campaign_id: 556 },
      force: true,
      getCampaignStatus: c.getCampaignStatus,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(c.asked, [555, 556]);
  });

  it("existente draft (releitura draft) + --force ⇒ ok (recriar rascunho segue permitido)", async () => {
    const c = fakeClient({ 555: "draft" });
    const r = await checkForceOverScheduled({
      existing: { campaign_id: 555, status: "draft" },
      force: true,
      getCampaignStatus: c.getCampaignStatus,
    });
    assert.deepEqual(r, { ok: true });
  });

  it("suspended (suspensa pela UI) + --force ⇒ ok", async () => {
    const c = fakeClient({ 555: "suspended" });
    const r = await checkForceOverScheduled({
      existing: { campaign_id: 555, status: "test_sent" },
      force: true,
      getCampaignStatus: c.getCampaignStatus,
    });
    assert.deepEqual(r, { ok: true });
  });

  it("status desconhecido/sent/in_process ⇒ recusa", async () => {
    for (const s of ["sent", "in_process", "archive", "algo-novo"]) {
      const c = fakeClient({ 555: s });
      const r = await checkForceOverScheduled({
        existing: { campaign_id: 555, status: "draft" },
        force: true,
        getCampaignStatus: c.getCampaignStatus,
      });
      assert.equal(r.ok, false, `status ${s} deveria barrar`);
    }
  });

  it("consulta à Brevo falha ⇒ fail-closed", async () => {
    const c = fakeClient({ 555: new Error("Brevo GET 500") });
    const r = await checkForceOverScheduled({
      existing: { campaign_id: 555, status: "draft" },
      force: true,
      getCampaignStatus: c.getCampaignStatus,
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /fail-closed/);
    assert.match((r as { reason: string }).reason, /Brevo GET 500/);
  });

  it("nenhuma campanha registrada ⇒ ok sem consultar", async () => {
    const c = fakeClient({});
    assert.deepEqual(
      await checkForceOverScheduled({ existing: null, force: true, getCampaignStatus: c.getCampaignStatus }),
      { ok: true },
    );
    assert.deepEqual(c.asked, []);
  });

  it("sem --force ⇒ ok sem consultar (o caminho de reaproveitamento não cria nada)", async () => {
    const c = fakeClient({});
    assert.deepEqual(
      await checkForceOverScheduled({
        existing: { campaign_id: 555, status: "scheduled" },
        force: false,
        getCampaignStatus: c.getCampaignStatus,
      }),
      { ok: true },
    );
    assert.deepEqual(c.asked, []);
  });
});

// ── wiring em main() ─────────────────────────────────────────────────────

const LIST_ID = 42;
const API_KEY_ENV = "TEST_BREVO_DIARIA_API_KEY_14140";
const EDITION_DATE = "260812";
const EXISTING_ID = 555;
const NEW_ID = 999;

const originalArgv = process.argv;
const ENV_KEYS = [API_KEY_ENV, "POLL_SECRET", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_WORKERS_TOKEN", "REATIVAR_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

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

const PENDING_INTRO_FIXTURE = [
  "<!-- fixture de teste, não é a cópia real revisada pelo editor -->",
  "",
  "Você está recebendo este e-mail porque se inscreveu na diar.ia.br.",
  "",
  "[Confirmar meu cadastro](https://reativar.diaria.workers.dev/?email={{ contact.EMAIL }})",
  "",
  "Se preferir, você pode se [descadastrar]({{ unsubscribe }}) a qualquer momento.",
  "",
].join("\n");

function setupRoot(existing: BrevoDiariaPublished): string {
  const root = mkdtempSync(join(tmpdir(), "publish-daily-brevo-14140-"));
  writeFileSync(
    join(root, "platform.config.json"),
    JSON.stringify({
      brevo_diaria: {
        api_key_env: API_KEY_ENV,
        list_id: LIST_ID,
        sender_email: "editor@diar.ia.br",
        sender_name: "diar.ia.br",
        daily_send_cap: 300,
      },
    }),
    "utf8",
  );
  const dir = join(root, "data/editions", EDITION_DATE);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD, "utf8");
  writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
  writeFileSync(join(dir, "_internal/brevo-diaria-published.json"), JSON.stringify(existing), "utf8");
  mkdirSync(join(root, "data/snippets"), { recursive: true });
  writeFileSync(join(root, "data/snippets/brevo-diaria-pending-intro.md"), PENDING_INTRO_FIXTURE, "utf8");
  return root;
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

function noContentRes(): Response {
  return {
    ok: true,
    status: 204,
    headers: { get: () => null },
    text: async () => "",
    body: { cancel: async () => {} },
  } as unknown as Response;
}

let calls: Array<{ method: string; pathname: string }> = [];
let originalFetch: typeof fetch;

const CONTACTS = [1, 2, 3].map((i) => ({ email: `ok${i}@x.com`, attributes: {} }));

function installRouter(liveStatus: string | { httpError: number }): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, pathname: url.pathname });
    if (url.hostname === "api.brevo.com") {
      if (method === "GET" && url.pathname === `/v3/emailCampaigns/${EXISTING_ID}`) {
        if (typeof liveStatus === "object") return jsonRes(liveStatus.httpError, { message: "boom" });
        return jsonRes(200, { id: EXISTING_ID, name: "diária", status: liveStatus });
      }
      if (method === "GET" && url.pathname === `/v3/contacts/lists/${LIST_ID}`) {
        return jsonRes(200, { id: LIST_ID, name: "diária", totalSubscribers: CONTACTS.length });
      }
      if (method === "GET" && url.pathname === "/v3/contacts/attributes") {
        return jsonRes(200, { attributes: [{ name: "POLL_TOKEN", category: "normal", type: "text" }] });
      }
      if (method === "GET" && url.pathname === `/v3/contacts/lists/${LIST_ID}/contacts`) {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return jsonRes(200, { contacts: offset === 0 ? CONTACTS : [], count: CONTACTS.length });
      }
      if (method === "PUT" && url.pathname.startsWith("/v3/contacts/") && !url.pathname.startsWith("/v3/contacts/lists")) {
        return noContentRes();
      }
      if (method === "POST" && url.pathname === "/v3/emailCampaigns") return jsonRes(201, { id: NEW_ID });
      if (method === "PUT" && url.pathname.startsWith("/v3/emailCampaigns/")) return noContentRes();
      if (method === "GET" && url.pathname === "/v3/smtp/statistics/aggregatedReport") return jsonRes(200, { requests: 0 });
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

function setCredentials(): void {
  process.env[API_KEY_ENV] = "fake_brevo_key";
  process.env.POLL_SECRET = "test_poll_secret";
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  process.env.CLOUDFLARE_WORKERS_TOKEN = "kvtoken";
  delete process.env.REATIVAR_SECRET;
}

function existingState(status: BrevoDiariaPublished["status"]): BrevoDiariaPublished {
  return {
    campaign_id: EXISTING_ID,
    subject: "assunto antigo",
    preview_text: "preview antigo",
    status,
    list_id: LIST_ID,
    created_at: "2026-08-11T10:00:00.000Z",
    ...(status === "scheduled" ? { scheduled_at: "2026-08-12T09:00:00.000Z" } : {}),
  };
}

function readState(root: string): BrevoDiariaPublished {
  return JSON.parse(
    readFileSync(join(root, "data/editions", EDITION_DATE, "_internal/brevo-diaria-published.json"), "utf8"),
  ) as BrevoDiariaPublished;
}

const created = () => calls.filter((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns");

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exitCode = undefined;
});

describe("publish-daily-brevo.ts main() — --force com campanha agendada (#14140)", () => {
  const argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy", "--force"];

  it("estado scheduled, semanal sem divisão, --force ⇒ exit 9, nada criado, estado intacto", async () => {
    const root = setupRoot(existingState("scheduled"));
    try {
      setCredentials();
      installRouter("queued");
      process.argv = argv;
      await main(root);
      assert.equal(process.exitCode, 9);
      assert.equal(created().length, 0, "nenhuma campanha nova pode nascer por cima da agendada");
      assert.equal(readState(root).campaign_id, EXISTING_ID, "o id da agendada não pode ser perdido");
      assert.equal(readState(root).status, "scheduled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("estado local test_sent mas Brevo diz queued (agendada fora do script), --force ⇒ exit 9, nada criado", async () => {
    const root = setupRoot(existingState("test_sent"));
    try {
      setCredentials();
      installRouter("queued");
      process.argv = argv;
      await main(root);
      assert.equal(process.exitCode, 9);
      assert.equal(created().length, 0);
      assert.equal(readState(root).campaign_id, EXISTING_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releitura da campanha falha (HTTP 500), --force ⇒ fail-closed, exit 9, nada criado", async () => {
    const root = setupRoot(existingState("draft"));
    try {
      setCredentials();
      installRouter({ httpError: 500 });
      process.argv = argv;
      await main(root);
      assert.equal(process.exitCode, 9);
      assert.equal(created().length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("existente draft (Brevo confirma draft), --force ⇒ cria a nova de propósito (escape hatch do #5677 preservado)", async () => {
    const root = setupRoot(existingState("draft"));
    try {
      setCredentials();
      installRouter("draft");
      process.argv = argv;
      await main(root);
      assert.ok(process.exitCode === undefined || process.exitCode === 0, `exitCode=${process.exitCode}`);
      assert.equal(created().length, 1);
      assert.equal(readState(root).campaign_id, NEW_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("existente scheduled SEM --force ⇒ reaproveita (não cria, não consulta status)", async () => {
    const root = setupRoot(existingState("scheduled"));
    try {
      setCredentials();
      installRouter("queued");
      process.argv = argv.filter((a) => a !== "--force");
      await main(root);
      assert.equal(created().length, 0);
      assert.equal(
        calls.filter((c) => c.method === "GET" && c.pathname === `/v3/emailCampaigns/${EXISTING_ID}`).length,
        0,
      );
      assert.equal(readState(root).campaign_id, EXISTING_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
