/**
 * test/publish-daily-brevo-integration-4532.test.ts (#4532)
 *
 * Teste de integração de ponta a ponta pra `main()` de `publish-daily-brevo.ts`
 * (achado CRITICAL do pr-test-analyzer, fleet review pré-merge do #4532):
 * antes desta unidade, `main()` não era exportado e o wiring fail-closed
 * completo — `checkPollTokenGuards` → `injectPollTokenBrevo` →
 * `if (injectionResult.failed > 0) exit(5)` → só então `POST /emailCampaigns`
 * — nunca era exercitado junto por nenhum teste, só as peças isoladas
 * (`checkPollTokenGuards` sozinha em publish-daily-brevo-4266.test.ts, `run()`
 * de inject-poll-token-brevo.ts sozinho em inject-poll-token-brevo-4517.test.ts).
 * Roda `main(rootDirOverride)` de verdade (mesmo padrão de
 * `select-linkedin-weekly-integration.test.ts`, que já mocka `process.exit`)
 * sobre fixtures em disco + `fetch` mockado, sem tocar `data/`/rede reais.
 *
 * Cobre também o achado HIGH (silent-failure-hunter): reconciliação entre
 * `injectionResult.total_contacts` e `listInfo.totalSubscribers` — uma
 * enumeração que silenciosamente retorna 0 contatos (ex: página 200 com
 * corpo vazio) apesar da lista Brevo não estar vazia precisa abortar, não
 * passar como "0 falhas" e criar a campanha sem ninguém protegido.
 *
 * #4631 (fleet review da PR #4646, achado pr-test-analyzer): os 4 casos
 * acima usam `totalSubscribers: 1` ou `3` contra `daily_send_cap: 300` —
 * longe da fronteira real do incidente 260804 (lista com 179 assinantes
 * brutos, cap 175). O caso adicional abaixo reproduz essa fronteira via
 * `main()` de verdade — o guard antigo (`checkDailySendCap` sem subtrair
 * `EDITOR_SEED_EMAILS`) abortava aqui com exit(3); o novo deve prosseguir.
 *
 * #4651 (fleet review da PR #4652, achado pr-test-analyzer): dos 4
 * `process.exit()` convertidos pra `process.exitCode` neste script, só o
 * guard de `checkDailySendCap` (exit 3) ainda não tinha um teste dinâmico
 * exercitando `main()` de ponta a ponta — o caso abaixo fecha essa lacuna,
 * espelhando a estrutura dos casos de exit 4/5/6.
 *
 * #6793 "Faixa B" item 5 (30/08/2026, decisão do editor): `checkDailySendCap`
 * deixou de bloquear por volume — o teste original de exit(3) acima (#4651)
 * foi reescrito pra afirmar o comportamento NOVO (prossegue mesmo bem acima
 * do cap histórico); o piso de estado impossível (`totalSubscribers <
 * seedCount`) segue intacto e sem teste de integração dedicado aqui (coberto
 * a nível de unidade em publish-daily-brevo-4266.test.ts).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/publish-daily-brevo.ts";

const LIST_ID = 42;
const API_KEY_ENV = "TEST_BREVO_DIARIA_API_KEY_4532";
const API_KEY = "fake_brevo_key";
const EDITION_DATE = "260803";

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
  return mkdtempSync(join(tmpdir(), "publish-daily-brevo-test-"));
}

function writePlatformConfig(root: string, overrides: Record<string, unknown> = {}): void {
  const cfg = {
    brevo_diaria: {
      api_key_env: API_KEY_ENV,
      list_id: LIST_ID,
      sender_email: "editor@diar.ia.br",
      sender_name: "diar.ia.br",
      daily_send_cap: 300,
      ...overrides,
    },
  };
  writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg), "utf8");
}

/** Mesmo fixture mínimo de `render-newsletter-html-cli-esp-4266.test.ts` —
 * já comprovado suficiente pra `extractContent`/`renderHTML` completo sem
 * precisar de jpgs reais no disco. */
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

interface RouterOpts {
  totalSubscribers: number;
  attributesExist?: boolean;
  contactsPages: Array<Array<{ email?: string; attributes?: Record<string, unknown> }>>;
  putStatus?: number;
  /** #4532 (achado HIGH): força a página offset=0 do endpoint de listagem em
   * massa a responder com este status em vez de 200 (simula 404/5xx). */
  listContactsStatus?: number;
  /** #6146 — consumo transacional do dia devolvido por
   * `/v3/smtp/statistics/aggregatedReport`. Default 0 ("conta zerada"), que
   * é o dia normal e mantém estes casos testando o que sempre testaram. */
  transactionalRequestsToday?: number;
}

function installRouter(opts: RouterOpts): void {
  calls = [];
  const {
    totalSubscribers,
    attributesExist = true,
    contactsPages,
    putStatus = 204,
    listContactsStatus,
    transactionalRequestsToday = 0,
  } = opts;
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
      if (method === "PUT" && url.pathname.startsWith("/v3/contacts/") && !url.pathname.startsWith("/v3/contacts/lists")) {
        return putStatus >= 200 && putStatus < 300 ? noContentRes(putStatus) : jsonRes(putStatus, { message: "erro" });
      }
      if (method === "POST" && url.pathname === "/v3/emailCampaigns") {
        return jsonRes(201, { id: 999 });
      }
      // #6146 — guard de cota da CONTA (balde único transacional+marketing).
      if (method === "GET" && url.pathname === "/v3/smtp/statistics/aggregatedReport") {
        return jsonRes(200, { requests: transactionalRequestsToday });
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

/** Gera `n` contatos fake paginados em blocos de 50 (mesmo `limit` fixo de
 * `iterateListContacts`, `inject-poll-token-brevo.ts`) — usado pra reproduzir
 * uma lista Brevo de tamanho real sem depender de fixtures manuais. */
function generateContactsPages(n: number): Array<Array<{ email: string; attributes: Record<string, unknown> }>> {
  const PAGE_SIZE = 50;
  const contacts = Array.from({ length: n }, (_, i) => ({ email: `contato${i}@x.com`, attributes: {} }));
  const pages: Array<Array<{ email: string; attributes: Record<string, unknown> }>> = [];
  for (let offset = 0; offset < contacts.length; offset += PAGE_SIZE) {
    pages.push(contacts.slice(offset, offset + PAGE_SIZE));
  }
  return pages;
}

function setAllCredentials(): void {
  process.env[API_KEY_ENV] = API_KEY;
  process.env.POLL_SECRET = "test_poll_secret";
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  process.env.CLOUDFLARE_WORKERS_TOKEN = "kvtoken";
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreProcessExit();
  // #4651: defesa contra teste que falhar ANTES do reset explícito no corpo
  // — nunca deixar process.exitCode vazar pro exit code real do test runner.
  process.exitCode = undefined;
});

describe("publish-daily-brevo.ts main() — wiring fail-closed de ponta a ponta (#4532)", () => {
  it("#6146: cota da conta estourada NÃO bloqueia a Etapa 5 — rascunho é criado, com AVISO (o gate duro é a Etapa 6)", async () => {
    const root = mkTmpRoot();
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      writePlatformConfig(root, { daily_send_cap: 300 });
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      // Cenário 260825: os 300/dia já consumidos por transacional. Criar o
      // rascunho não gasta cota nenhuma e o dia do envio ainda nem existe
      // aqui — barrar seria punir o caso comum em que a Etapa 5 roda antes
      // da virada UTC e o envio cai num balde novo.
      installRouter({
        totalSubscribers: 10,
        contactsPages: generateContactsPages(10),
        transactionalRequestsToday: 300,
      });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();
      process.exitCode = undefined;

      await main(root);

      assert.equal(process.exitCode, undefined, "cota da conta não pode abortar a Etapa 5");
      assert.ok(
        calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"),
        "o rascunho deveria ter sido criado assim mesmo",
      );
      const out = stderr.join("");
      assert.match(out, /AVISO: se esta campanha fosse enviada HOJE, não caberia/);
      assert.match(out, /Etapa 6/, "o aviso precisa apontar onde está o gate real");
    } finally {
      (process.stderr as NodeJS.WriteStream).write = originalWrite;
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#6793 (Faixa B, item 5, 30/08/2026): checkDailySendCap NÃO bloqueia mais mesmo bem acima do cap — main() prossegue e cria a campanha (era exit(3) até o #4651/#6793)", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root, { daily_send_cap: 2 });
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      // totalSubscribers=10 (>= 5 EDITOR_SEED_EMAILS, não dispara o piso de
      // estado impossível) com daily_send_cap=2 → líquido de 5, MUITO acima
      // do cap histórico. Antes do #6793 isto abortava com exit(3) antes de
      // qualquer enumeração; desde #6793 o guard de volume foi removido
      // (decisão do editor) — só o piso de estado impossível continua
      // podendo abortar, e não é o caso aqui.
      installRouter({ totalSubscribers: 10, contactsPages: generateContactsPages(10) });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();

      await main(root);

      assert.equal(exitCode, null, "não deveria ter abortado em NENHUM guard — em particular não exit(3), o cap (removido, #6793)");
      assert.ok(
        calls.some((c) => c.method === "GET" && c.pathname === `/v3/contacts/lists/${LIST_ID}/contacts`),
        `deveria ter enumerado a lista normalmente (guard de cap não bloqueia mais): ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"),
        `campanha deveria ter sido criada normalmente: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("credenciais do token de voto ausentes: aborta com exit(4), NUNCA enumera a lista (injectPollTokenBrevo nunca é chamada) nem cria a campanha", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      process.env[API_KEY_ENV] = API_KEY;
      delete process.env.POLL_SECRET;
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      delete process.env.CLOUDFLARE_WORKERS_TOKEN;

      // totalSubscribers >= 5 (EDITOR_SEED_EMAILS.length) de propósito — #4631
      // acrescentou um piso que aborta com exit(3) ANTES desta guard quando o
      // bruto fica abaixo do seedCount; abaixo disso o teste pegaria o guard
      // errado.
      installRouter({ totalSubscribers: 6, contactsPages: [[{ email: "a@x.com", attributes: {} }]] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit(); // belt-and-suspenders: se main() voltar a chamar process.exit(), este teste falha alto.
      process.exitCode = undefined;

      // #4651 (Windows fix, mesma classe do #4638): este branch já não chama
      // process.exit(4) — seta process.exitCode + return, então main()
      // RESOLVE normalmente em vez de rejeitar.
      await main(root);
      assert.equal(process.exitCode, 4, "guard de credenciais do token de voto deveria abortar com exitCode 4");
      process.exitCode = undefined;
      assert.ok(
        !calls.some((c) => c.method === "GET" && c.pathname === `/v3/contacts/lists/${LIST_ID}/contacts`),
        `injectPollTokenBrevo nunca deveria ter enumerado a lista: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"),
        "campanha nunca deveria ter sido criada",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("injeção com falha (contato retornando 500 no PUT) aborta com exit(5), sem que POST /emailCampaigns seja chamado", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      // totalSubscribers >= 5 pelo mesmo motivo do teste anterior (#4631).
      installRouter({
        totalSubscribers: 6,
        contactsPages: [[{ email: "falha@x.com", attributes: {} }]],
        putStatus: 500,
      });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit(); // belt-and-suspenders: se main() voltar a chamar process.exit(), este teste falha alto.
      process.exitCode = undefined;

      // #4651: este branch já não chama process.exit(5) — resolve normalmente.
      await main(root);
      assert.equal(process.exitCode, 5, "falha de injeção em ≥1 contato deveria abortar com exitCode 5");
      process.exitCode = undefined;
      assert.ok(
        calls.some((c) => c.method === "PUT" && c.pathname === `/v3/contacts/${encodeURIComponent("falha@x.com")}`),
        "a injeção deveria de fato ter tentado o PUT antes de falhar",
      );
      assert.ok(
        !calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"),
        "campanha nunca deveria ter sido criada após falha de injeção",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#4532 achado HIGH: enumeração retorna 0 contatos apesar da lista Brevo reportar assinantes → aborta (exit 6), sem POST /emailCampaigns", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      // listInfo.totalSubscribers=6 (brevoGetList, endpoint separado — >= 5
      // EDITOR_SEED_EMAILS de propósito, #4631, pra não disparar o piso de
      // anomalia ANTES de chegar na reconciliação sob teste), mas a
      // enumeração paginada devolve uma página VAZIA (200, contacts: []) —
      // simula qualquer forma de enumeração incompleta que não seja um
      // 404/5xx explícito (esse caso já é coberto no nível de unidade por
      // inject-poll-token-brevo-4517.test.ts). Sem a reconciliação (#4532),
      // isso resultaria em total_contacts:0, failed:0 — passando o gate
      // antigo e criando a campanha sem ninguém protegido.
      installRouter({ totalSubscribers: 6, contactsPages: [[]] });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit(); // belt-and-suspenders: se main() voltar a chamar process.exit(), este teste falha alto.
      process.exitCode = undefined;

      // #4651: este branch já não chama process.exit(6) — resolve normalmente.
      await main(root);
      assert.equal(process.exitCode, 6, "divergência enumeração×lista deveria abortar com exitCode 6");
      process.exitCode = undefined;
      assert.ok(
        !calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"),
        "campanha nunca deveria ter sido criada com enumeração divergente da lista",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("injeção 100% ok: POST /emailCampaigns é de fato disparado, sem nenhum process.exit de erro", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root);
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      // totalSubscribers >= 5 (#4631) e enumeração com o MESMO total (senão a
      // reconciliação do #4532, que roda antes da criação da campanha, aborta
      // com exit(6) por divergência).
      installRouter({
        totalSubscribers: 6,
        contactsPages: [
          [
            { email: "ok@x.com", attributes: {} },
            { email: "ok2@x.com", attributes: {} },
            { email: "ok3@x.com", attributes: {} },
            { email: "ok4@x.com", attributes: {} },
            { email: "ok5@x.com", attributes: {} },
            { email: "ok6@x.com", attributes: {} },
          ],
        ],
      });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();

      await main(root);

      assert.equal(exitCode, null, "não deveria ter chamado process.exit em nenhum momento");
      const campaignCall = calls.find((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns");
      assert.ok(campaignCall, `POST /emailCampaigns deveria ter sido disparado: ${JSON.stringify(calls)}`);
      const campaignBody = campaignCall!.body as {
        subject: string;
        recipients: { listIds: number[] };
        sender: { email: string; name: string };
      };
      assert.deepEqual(campaignBody.recipients, { listIds: [LIST_ID] });
      assert.equal(campaignBody.subject, "Título um");
      assert.equal(campaignBody.sender.email, "editor@diar.ia.br");
      assert.ok(
        calls.some((c) => c.method === "PUT" && c.pathname === `/v3/contacts/${encodeURIComponent("ok@x.com")}`),
        "o contato deveria ter recebido o PUT do token opaco de voto ANTES da campanha",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#4631: reproduz o incidente 260804 via main() real — lista Brevo com 179 assinantes brutos, daily_send_cap 175 → prossegue sem abortar no cap (guard antigo abortava com exit(3))", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root, { daily_send_cap: 175 });
      writeEdition(root, EDITION_DATE);
      setAllCredentials();

      installRouter({ totalSubscribers: 179, contactsPages: generateContactsPages(179) });
      process.argv = ["node", "publish-daily-brevo.ts", `data/editions/${EDITION_DATE}`, "--i-reviewed-the-copy"];
      mockProcessExit();

      await main(root);

      assert.equal(exitCode, null, "não deveria ter abortado em NENHUM guard — em particular não exit(3), o cap");
      assert.ok(
        calls.some((c) => c.method === "POST" && c.pathname === "/v3/emailCampaigns"),
        `POST /emailCampaigns deveria ter sido disparado (fronteira 179 bruto / 175 cap): ${JSON.stringify(
          calls.map((c) => `${c.method} ${c.pathname}`),
        )}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
