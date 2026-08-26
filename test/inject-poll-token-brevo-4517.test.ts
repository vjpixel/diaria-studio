/**
 * test/inject-poll-token-brevo-4517.test.ts (#4517)
 *
 * Paridade Brevo de `inject-poll-token.ts` (Beehiiv, #4487/#4512) —
 * `run()` popula o atributo de contato `POLL_TOKEN` (mesmo token opaco
 * ESP-agnóstico, `computePollToken`) e grava a entrada reversa
 * `polltoken:{token} -> email` no KV do Worker `poll`. Mocka `fetch` global
 * direto (mesmo padrão de `test/brevo-send-now-4347.test.ts`) — os helpers
 * de transporte (`brevoGet`/`brevoPost`/`brevoPut`) usam `fetch` global sem
 * hook de baseUrl, diferente do `undici.MockAgent` usado em
 * `test/inject-poll-token.test.ts` (Beehiiv).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/inject-poll-token-brevo.ts";
import { computePollToken, pollTokenKvKey } from "../scripts/lib/shared/poll-token.ts";
import type { CloudflareKVConfig } from "../scripts/lib/cloudflare-kv-upload.ts";

const API_KEY = "fake_brevo_key";
const SECRET = "test_secret";
const LIST_ID = 7;
const KV_CFG: CloudflareKVConfig = { accountId: "acct", token: "kvtoken", kvNamespaceId: "ns_test" };

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
  pathname: string;
  search: string;
  body: unknown;
}

/** Fake putKv que grava num Map — evita depender do transporte real do KV
 * (já coberto isoladamente por cloudflare-kv-upload.test.ts). Mesmo padrão
 * de test/inject-poll-token.test.ts. */
function makeFakePutKv() {
  const written = new Map<string, string>();
  const putKv = async (key: string, value: string, _cfg: CloudflareKVConfig) => {
    written.set(key, value);
  };
  return { written, putKv };
}

let calls: Call[] = [];
let originalFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Router mínimo: `attributesExist` controla a resposta de GET
 * /contacts/attributes (se POLL_TOKEN já está na lista); `contactsPages` é
 * um array de páginas (cada uma um array de contatos) consumido por offset
 * (0, 50, 100, ...); `putStatus` (default 204) controla a resposta de todo
 * PUT /contacts/{email}.
 */
function installRouter(opts: {
  attributesExist: boolean;
  contactsPages: Array<Array<{ email?: string; attributes?: Record<string, unknown> }>>;
  putStatus?: number;
  /** #4532: força a página de offset=0 do endpoint de listagem a responder
   * com este status HTTP em vez de 200 (ex: 404, 500) — regressão do achado
   * HIGH abaixo. */
  listContactsStatus?: number;
}) {
  const { attributesExist, contactsPages, putStatus = 204, listContactsStatus } = opts;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, pathname: url.pathname, search: url.search, body });

    if (method === "GET" && url.pathname === "/v3/contacts/attributes") {
      return jsonRes(200, {
        attributes: attributesExist ? [{ name: "POLL_TOKEN", category: "normal", type: "text" }] : [],
      });
    }
    if (method === "POST" && url.pathname === "/v3/contacts/attributes/normal/POLL_TOKEN") {
      return jsonRes(201, { name: "POLL_TOKEN" });
    }
    if (method === "GET" && url.pathname === `/v3/contacts/lists/${LIST_ID}/contacts`) {
      if (listContactsStatus !== undefined && listContactsStatus !== 200) {
        return jsonRes(listContactsStatus, { message: "erro simulado" });
      }
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const pageIdx = offset / limit;
      const page = contactsPages[pageIdx] ?? [];
      return jsonRes(200, { contacts: page, count: contactsPages.flat().length });
    }
    if (method === "PUT" && url.pathname.startsWith("/v3/contacts/")) {
      return putStatus >= 200 && putStatus < 300 ? noContentRes(putStatus) : jsonRes(putStatus, { message: "erro" });
    }
    throw new Error(`unexpected fetch: ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;
}

describe("inject-poll-token-brevo.ts run() — #4517", () => {
  it("contato sem POLL_TOKEN correto: PUT com o token esperado + grava entrada reversa no KV", async () => {
    const email = "novo@x.com";
    const { written, putKv } = makeFakePutKv();
    installRouter({ attributesExist: true, contactsPages: [[{ email, attributes: {} }]] });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    const expectedToken = await computePollToken(SECRET, email);
    assert.equal(result.total_contacts, 1);
    assert.equal(result.patched, 1);
    assert.equal(result.failed, 0);
    assert.equal(written.get(pollTokenKvKey(expectedToken)), email);

    const putCall = calls.find((c) => c.method === "PUT");
    assert.ok(putCall, "PUT deveria ter sido chamado");
    assert.equal(putCall!.pathname, `/v3/contacts/${encodeURIComponent(email)}`);
    assert.deepEqual((putCall!.body as { attributes: Record<string, string> }).attributes, {
      POLL_TOKEN: expectedToken,
    });
  });

  it("sem --force: contato cujo POLL_TOKEN já bate o esperado é skipado (idempotência, sem PUT nem KV write)", async () => {
    const email = "already@x.com";
    const currentToken = await computePollToken(SECRET, email);
    const { written, putKv } = makeFakePutKv();
    installRouter({
      attributesExist: true,
      contactsPages: [[{ email, attributes: { POLL_TOKEN: currentToken } }]],
    });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.patched, 0);
    assert.equal(result.skipped_already_correct, 1);
    assert.equal(written.size, 0);
    assert.ok(!calls.some((c) => c.method === "PUT"), "nenhum PUT deveria ter sido feito");
  });

  it("--force: repatcha mesmo com o valor já correto (rotação de POLL_SECRET)", async () => {
    const email = "already@x.com";
    const currentToken = await computePollToken(SECRET, email);
    const { written, putKv } = makeFakePutKv();
    installRouter({
      attributesExist: true,
      contactsPages: [[{ email, attributes: { POLL_TOKEN: currentToken } }]],
    });

    const result = await run({
      dryRun: false,
      force: true,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.patched, 1, "--force repatcha mesmo com valor já correto");
    assert.equal(written.get(pollTokenKvKey(currentToken)), email);
  });

  it("contato sem e-mail: contabiliza skipped_no_email, nunca chama PUT", async () => {
    const { putKv } = makeFakePutKv();
    installRouter({ attributesExist: true, contactsPages: [[{ email: "", attributes: {} }]] });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.skipped_no_email, 1);
    assert.equal(result.patched, 0);
    assert.ok(!calls.some((c) => c.method === "PUT"));
  });

  it("dry-run: computa mas não cria atributo, não faz PUT, não grava KV", async () => {
    const email = "novo@x.com";
    const { written, putKv } = makeFakePutKv();
    installRouter({ attributesExist: false, contactsPages: [[{ email, attributes: {} }]] });

    const result = await run({
      dryRun: true,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.dry_run, true);
    assert.equal(result.patched, 0);
    assert.equal(written.size, 0);
    assert.ok(!calls.some((c) => c.method === "POST"), "dry-run não deve criar o atributo de contato");
    assert.ok(!calls.some((c) => c.method === "PUT"), "dry-run não deve fazer PUT");
  });

  it("ensureContactAttribute: cria o atributo POLL_TOKEN quando ausente (fora de --dry-run)", async () => {
    const { putKv } = makeFakePutKv();
    installRouter({ attributesExist: false, contactsPages: [[]] });

    await run({
      dryRun: false,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    const createCall = calls.find(
      (c) => c.method === "POST" && c.pathname === "/v3/contacts/attributes/normal/POLL_TOKEN",
    );
    assert.ok(createCall, "deveria ter criado o atributo POLL_TOKEN");
  });

  it("ensureContactAttribute: NÃO recria quando o atributo já existe", async () => {
    const { putKv } = makeFakePutKv();
    installRouter({ attributesExist: true, contactsPages: [[]] });

    await run({
      dryRun: false,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.ok(
      !calls.some((c) => c.method === "POST"),
      "não deveria tentar criar um atributo que já existe",
    );
  });

  it("paginação: 2ª página (offset=50) é consumida e contatos de lá também são patcheados", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      email: `bulk${i}@x.com`,
      attributes: {},
    }));
    const secondPage = [{ email: "last@x.com", attributes: {} }];
    const { written, putKv } = makeFakePutKv();
    installRouter({ attributesExist: true, contactsPages: [fullPage, secondPage] });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    assert.equal(result.total_contacts, 51);
    assert.equal(result.patched, 51);
    const lastToken = await computePollToken(SECRET, "last@x.com");
    assert.equal(written.get(pollTokenKvKey(lastToken)), "last@x.com", "contato da 2ª página também foi patcheado");
  });

  it("#4532 (achado HIGH, silent-failure-hunter): GET /contacts/lists/{id}/contacts retornando 404 LANÇA em vez de tratar como lista vazia (regressão do falso-sucesso silencioso)", async () => {
    const { putKv } = makeFakePutKv();
    // brevoGet trata 404 como {status:404, body:{}} não-fatal — desenhado pra
    // lookup de contato ÚNICO (contato sumiu entre listar e buscar). Antes do
    // fix #4532, iterateListContacts reusava isso pro endpoint de listagem em
    // MASSA da lista de produção, e um 404 aqui virava silenciosamente
    // `total_contacts: 0, failed: 0` — um falso-sucesso que passaria o gate
    // `injectionResult.failed > 0` em publish-daily-brevo.ts e criaria uma
    // campanha real sem NENHUM POLL_TOKEN populado.
    installRouter({ attributesExist: true, contactsPages: [[{ email: "x@x.com", attributes: {} }]], listContactsStatus: 404 });

    await assert.rejects(
      () =>
        run({
          dryRun: false,
          force: false,
          apiOpts: { apiKey: API_KEY, listId: LIST_ID },
          secret: SECRET,
          kvConfig: KV_CFG,
          putKv,
        }),
      /retornou status 404/,
      "run() deveria lançar em vez de devolver total_contacts:0 silenciosamente",
    );
  });

  it("falha do PUT (500): KV já escrito, result.failed incrementa (mesma ordem de garantia do Beehiiv, #4512)", async () => {
    const email = "falha-put@x.com";
    const { written, putKv } = makeFakePutKv();
    installRouter({ attributesExist: true, contactsPages: [[{ email, attributes: {} }]], putStatus: 500 });

    const result = await run({
      dryRun: false,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv,
    });

    const expectedToken = await computePollToken(SECRET, email);
    assert.equal(written.get(pollTokenKvKey(expectedToken)), email, "KV escrito ANTES do PUT, mesmo com falha depois");
    assert.equal(result.failed, 1);
    assert.equal(result.patched, 0);
    // #4532 (achado type-design): failedContacts expõe QUAL contato falhou e
    // por quê, não só a contagem — publish-daily-brevo.ts usa isso na
    // mensagem de abort.
    assert.equal(result.failedContacts.length, 1);
    assert.equal(result.failedContacts[0].email, email);
    assert.match(result.failedContacts[0].error, /500/);
  });
});

describe("inject-poll-token-brevo.ts exit semantics (#4653, mesma classe do #4638/#4651/#1401)", () => {
  // Regressão: process.exit(N) chamado no catch handler do isMainModule()
  // roda DEPOIS de `await run(...)` (fetch pra Brevo + KV Cloudflare) — o
  // cenário exato da assertion UV_HANDLE_CLOSING no Windows (libuv força
  // shutdown antes dos sockets keep-alive do fetch fecharem). Fix:
  // process.exitCode no catch. Os 2 guards PRÉ-await (list-id ausente, envs
  // ausentes) ficam com process.exit() de propósito — nenhum fetch rodou
  // ainda nesses pontos, mesmo padrão de publish-daily-brevo.ts (#4651).
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "inject-poll-token-brevo.ts");

  function readMainAndCatchBodies(): { mainBody: string; catchBody: string } {
    const source = readFileSync(SCRIPT, "utf8");
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    // Âncora de fim de `main()`: o guard de módulo principal, que desde #6191
    // é `isMainModule(...)` (antes era um `const _argv1` + template `file://`
    // montado à mão, que nunca casava no Windows — ver
    // `test/main-module-guard.test.ts`).
    const mainMatch = sourceNoComments.match(
      /async function main\([^)]*\)[^{]*\{[\s\S]*?\n\}\n\nif \(isMainModule/,
    );
    assert.ok(mainMatch, "main() não encontrada em inject-poll-token-brevo.ts");
    const catchMatch = sourceNoComments.match(/if \(\s*isMainModule\([\s\S]*?\n\}\n?$/);
    assert.ok(catchMatch, "bloco isMainModule() (import.meta.url guard) não encontrado em inject-poll-token-brevo.ts");
    return { mainBody: mainMatch[0], catchBody: catchMatch[0] };
  }

  it("catch handler do CLI usa process.exitCode, não process.exit (#4653)", () => {
    const { catchBody } = readMainAndCatchBodies();
    assert.equal(
      /process\.exit\s*\(/.test(catchBody),
      false,
      "catch de main() não pode chamar process.exit() — usar process.exitCode (#4653 Windows crash, mesma classe #4638/#4651)",
    );
    assert.match(catchBody, /process\.exitCode/, "catch de main() deve setar process.exitCode");
  });

  it("guards pré-await (list-id, envs ausentes) continuam com process.exit — sem risco libuv (#4653)", () => {
    // Positive control: nenhum await fetch rodou ainda nestes pontos, então
    // manter process.exit() ali é seguro e intencional (mesmo padrão do
    // #4651 em publish-daily-brevo.ts/sync-apoio-nivel-brevo.ts).
    const { mainBody } = readMainAndCatchBodies();
    const occurrences = mainBody.match(/process\.exit\(1\)/g) ?? [];
    assert.equal(
      occurrences.length,
      2,
      "esperava exatamente 2 process.exit(1) em main() (guard de --list-id + guard de envs ausentes)",
    );
  });
});
