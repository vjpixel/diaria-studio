/**
 * test/publish-daily-brevo-kit-guard-failure-6501.test.ts (#6501)
 *
 * Fecha a lacuna apontada no review consolidado da rodada
 * `/diaria-overnight 260828b` (PR #6487, issue #6485): a docstring de
 * `applyKitActiveExclusionGuard` (`scripts/lib/brevo-kit-active-exclusion.ts`)
 * dizia que uma falha do guard "deve abortar o dispatch da campanha", mas o
 * caller real (`publish-daily-brevo.ts`) sempre fez fail-soft — try/catch
 * que só loga um AVISO e segue criando a campanha. A divergência
 * docstring↔comportamento era o bug; o fail-soft em si foi mantido (ver
 * docstring atualizada do módulo) e reforçado com um evento estruturado via
 * `log-event.ts`/`run-log.ts` (`kit_exclusion_guard_failed`), visível em
 * `/diaria-log` — antes disto só existia um `console.warn` sem qualquer
 * observabilidade estruturada.
 *
 * Este teste roda `main()` de ponta a ponta (mesmo padrão de
 * `publish-daily-brevo-integration-4532.test.ts`) forçando o guard a
 * lançar (a 1ª chamada à Brevo pra enumerar a lista, que o guard faz via
 * `fetchBrevoListEmails`, responde HTTP 400) e confirma as DUAS pontas do
 * comportamento esperado:
 *   1. Fail-soft preservado — a campanha ainda é criada (`POST
 *      /v3/emailCampaigns` acontece).
 *   2. Visibilidade nova — o evento `kit_exclusion_guard_failed` é gravado
 *      em `data/run-log.jsonl` com o motivo real do erro (não apenas
 *      "falhou").
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/publish-daily-brevo.ts";

const LIST_ID = 42;
const API_KEY_ENV = "TEST_BREVO_DIARIA_API_KEY_6501";
const API_KEY = "fake_brevo_key";
const EDITION_DATE = "260803";

const originalExit = process.exit;
const ENV_KEYS = [API_KEY_ENV, "POLL_SECRET", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_WORKERS_TOKEN", "KIT_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

function mockProcessExit(): void {
  process.exit = (code?: number) => {
    throw new Error(`__mocked_exit__(${code ?? 0})`);
  };
}

function restoreProcessExit(): void {
  process.exit = originalExit;
}

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "publish-daily-brevo-kit-guard-test-"));
}

function writePlatformConfig(root: string): void {
  const cfg = {
    brevo_diaria: {
      api_key_env: API_KEY_ENV,
      list_id: LIST_ID,
      sender_email: "editor@diar.ia.br",
      sender_name: "diar.ia.br",
      daily_send_cap: 300,
    },
    logging: { path: "data/run-log.jsonl" },
  };
  writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg), "utf8");
}

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
}

let calls: Call[] = [];
let originalFetch: typeof fetch;

/** Gera `n` contatos fake paginados em blocos de 50 — mesmo helper do
 * teste #4532. */
function generateContactsPages(n: number): Array<Array<{ email: string; attributes: Record<string, unknown> }>> {
  const PAGE_SIZE = 50;
  const contacts = Array.from({ length: n }, (_, i) => ({ email: `contato${i}@x.com`, attributes: {} }));
  const pages: Array<Array<{ email: string; attributes: Record<string, unknown> }>> = [];
  for (let offset = 0; offset < contacts.length; offset += PAGE_SIZE) {
    pages.push(contacts.slice(offset, offset + PAGE_SIZE));
  }
  return pages;
}

/**
 * Router de fetch mockado. `failFirstListContactsCall`: a 1ª chamada a
 * `GET /v3/contacts/lists/{id}/contacts?offset=0` (a que o guard #6485 faz
 * via `fetchBrevoListEmails`, ANTES de qualquer outra enumeração no
 * pipeline) responde HTTP 400 — não-retriável em `brevoGet` (não é
 * 404/429/5xx), lança imediato, sem sleep de retry. A 2ª chamada em diante
 * ao MESMO endpoint (a enumeração real de `injectPollTokenBrevo`, mais
 * adiante no pipeline) responde normalmente — precisa suceder pra
 * confirmar que o resto do dispatch não foi afetado pela falha do guard.
 */
function installRouter(opts: { failFirstListContactsCall: boolean }): void {
  calls = [];
  const contactsPages = generateContactsPages(10);
  let listContactsCallCount = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, hostname: url.hostname, pathname: url.pathname });

    if (url.hostname === "api.kit.com") {
      // Guard #6485 lê ativos do Kit via `listAllKitSubscribers` — devolve
      // lista vazia (sem paginação), o Kit em si não é o alvo deste teste.
      if (method === "GET" && url.pathname === "/v4/subscribers") {
        return jsonRes(200, { subscribers: [], pagination: { has_next_page: false, end_cursor: null } });
      }
    }

    if (url.hostname === "api.brevo.com") {
      if (method === "GET" && url.pathname === `/v3/contacts/lists/${LIST_ID}`) {
        return jsonRes(200, { id: LIST_ID, name: "diária", totalSubscribers: 10 });
      }
      if (method === "GET" && url.pathname === "/v3/contacts/attributes") {
        return jsonRes(200, { attributes: [{ name: "POLL_TOKEN", category: "normal", type: "text" }] });
      }
      if (method === "POST" && url.pathname === "/v3/contacts/attributes/normal/POLL_TOKEN") {
        return jsonRes(201, { name: "POLL_TOKEN" });
      }
      if (method === "GET" && url.pathname === `/v3/contacts/lists/${LIST_ID}/contacts`) {
        listContactsCallCount++;
        if (opts.failFirstListContactsCall && listContactsCallCount === 1) {
          return jsonRes(400, { message: "erro simulado — guard #6485 deve falhar aqui" });
        }
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
  process.env.KIT_API_KEY = "test_kit_api_key";
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreProcessExit();
  process.exitCode = undefined;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("publish-daily-brevo.ts — guard de exclusão Kit-ativo (#6485) falhando (#6501)", () => {
  it("guard lança → campanha ainda é criada (fail-soft preservado) E o evento kit_exclusion_guard_failed é gravado no run-log", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();
      installRouter({ failFirstListContactsCall: true });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();
      process.exitCode = undefined;

      await main(root);

      // 1. Fail-soft preservado — a divergência corrigida foi a docstring,
      // não o comportamento: o dispatch NUNCA deveria abortar por causa do
      // guard secundário.
      assert.equal(process.exitCode, undefined, "guard falhando não pode abortar a Etapa 5");
      assert.ok(
        calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"),
        "a campanha deveria ter sido criada mesmo com o guard falhando",
      );

      // 2. Visibilidade nova — evento estruturado em data/run-log.jsonl.
      const runLogPath = join(root, "data/run-log.jsonl");
      const lines = readFileSync(runLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const guardFailureEvent = lines.find((l) => l.message === "kit_exclusion_guard_failed");
      assert.ok(guardFailureEvent, `esperava 1 evento kit_exclusion_guard_failed em ${runLogPath}: ${JSON.stringify(lines)}`);
      assert.equal(guardFailureEvent.level, "warn");
      assert.equal(guardFailureEvent.agent, "publish-daily-brevo");
      assert.equal(guardFailureEvent.edition, EDITION_DATE);
      // O motivo real do erro precisa estar presente — não só "falhou".
      assert.ok(
        typeof guardFailureEvent.details?.reason === "string" && guardFailureEvent.details.reason.length > 0,
        `details.reason deveria conter o motivo real do erro: ${JSON.stringify(guardFailureEvent.details)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("guard sucede (nenhuma exclusão necessária) → nenhum evento kit_exclusion_guard_failed é gravado", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();
      installRouter({ failFirstListContactsCall: false });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();
      process.exitCode = undefined;

      await main(root);

      assert.equal(process.exitCode, undefined);
      assert.ok(calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"));

      const runLogPath = join(root, "data/run-log.jsonl");
      let hasGuardFailureEvent = false;
      try {
        const lines = readFileSync(runLogPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        hasGuardFailureEvent = lines.some((l) => l.message === "kit_exclusion_guard_failed");
      } catch {
        // run-log.jsonl nem existir é um resultado válido pra este caso —
        // nenhum evento foi emitido.
      }
      assert.equal(hasGuardFailureEvent, false, "guard bem-sucedido não deveria emitir o evento de falha");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
