/**
 * diaria-subscribers-ingest-brevo.test.ts (#6464 fatia 4 — #6587)
 *
 * Cobre a camada de I/O do builder Brevo: enumeração de contatos (mock de
 * `fetch` global — mesmo padrão de `test/brevo-committed-campaigns-3682.test.ts`),
 * checkpoint resumível por CONTA, e `main()` orquestrando a única conta
 * (`brevo_diaria` — `brevo_clarice` nunca entra aqui desde #7196) com
 * fixtures — sem rede real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  ingestAccount,
  checkpointPathForAccount,
  contactsByListPath,
  loadBrevoDiariaListId,
  main,
  BREVO_ACCOUNTS,
} from "../scripts/diaria-subscribers-ingest-brevo.ts";
import { openDiariaSubscribersDb, getStoreCounts, findSubscriberIdsByEmail } from "../scripts/lib/diaria-subscribers-db.ts";

/** `list_id` fixo usado nos testes — não precisa bater com o de
 *  `platform.config.json` (que É lido de verdade no import do módulo, via
 *  `loadBrevoDiariaListId()` dentro do literal de `BREVO_ACCOUNTS`, inclusive
 *  em teste). Não precisa bater porque `ingestAccount`/`checkpointPathForAccount`
 *  são chamados aqui com `listId` explícito, sem passar por `BREVO_ACCOUNTS`. */
const TEST_LIST_ID = 7;

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

/** Troca `globalThis.fetch` só pra responder o LISTING escopado à lista
 *  (`/contacts/lists/{listId}/contacts?...`, #7199) — mesmo padrão de
 *  `brevo-committed-campaigns-3682.test.ts`. */
async function withMockedListing<T>(contacts: Array<{ id: number; email: string }>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/contacts/lists/")) return jsonResponse({ contacts });
    throw new Error(`fetch inesperado no teste: ${url}`);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("loadBrevoDiariaListId (#7199/#7451 review — os 2 caminhos de fallback avisam)", () => {
  it("config válido: devolve o list_id do arquivo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-cfg-"));
    const cfgPath = resolve(tmp, "platform.config.json");
    writeFileSync(cfgPath, JSON.stringify({ brevo_diaria: { list_id: 42 } }));
    assert.equal(loadBrevoDiariaListId(cfgPath), 42);
  });

  it("arquivo ausente: cai no fallback (7) e avisa via console.error", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-cfg-"));
    const cfgPath = resolve(tmp, "nao-existe.json");
    const orig = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => messages.push(args.join(" "));
    try {
      assert.equal(loadBrevoDiariaListId(cfgPath), 7);
    } finally {
      console.error = orig;
    }
    assert.ok(messages.some((m) => m.includes("platform.config.json não lido")));
  });

  it("config lido, mas brevo_diaria.list_id ausente: cai no fallback E avisa (achado dos reviewers do #7451 — antes era silencioso)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-cfg-"));
    const cfgPath = resolve(tmp, "platform.config.json");
    writeFileSync(cfgPath, JSON.stringify({ brevo_diaria: {} }));
    const orig = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => messages.push(args.join(" "));
    try {
      assert.equal(loadBrevoDiariaListId(cfgPath), 7);
    } finally {
      console.error = orig;
    }
    assert.ok(messages.some((m) => m.includes("list_id ausente ou inválido")));
  });

  it("config lido, mas list_id é string (tipo errado): cai no fallback E avisa", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-cfg-"));
    const cfgPath = resolve(tmp, "platform.config.json");
    writeFileSync(cfgPath, JSON.stringify({ brevo_diaria: { list_id: "7" } }));
    const orig = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => messages.push(args.join(" "));
    try {
      assert.equal(loadBrevoDiariaListId(cfgPath), 7);
    } finally {
      console.error = orig;
    }
    assert.ok(messages.some((m) => m.includes("list_id ausente ou inválido")));
  });

  it("list_id 0, negativo ou fracionário é rejeitado (Number.isInteger && > 0, não Number.isFinite)", () => {
    for (const bad of [0, -1, 7.5]) {
      const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-cfg-"));
      const cfgPath = resolve(tmp, "platform.config.json");
      writeFileSync(cfgPath, JSON.stringify({ brevo_diaria: { list_id: bad } }));
      assert.equal(loadBrevoDiariaListId(cfgPath), 7, `list_id=${bad} deveria cair no fallback`);
    }
  });
});

describe("contactsByListPath (#7199 — nunca /contacts sem escopo de lista)", () => {
  it("monta o path escopado à lista, paginado", () => {
    assert.equal(contactsByListPath(7, 0), "/contacts/lists/7/contacts?limit=500&offset=0");
    assert.equal(contactsByListPath(7, 500), "/contacts/lists/7/contacts?limit=500&offset=500");
  });
});

describe("checkpointPathForAccount", () => {
  it("checkpoint nomeado pela conta + lista, ao lado do .db (#7199 — nunca reaproveita checkpoint de conta inteira)", () => {
    const p1 = checkpointPathForAccount("/x/data/diaria-subscribers/diaria-subscribers.db", "brevo_diaria", TEST_LIST_ID);
    assert.match(p1, /brevo-ingest-checkpoint-brevo_diaria-list7\.json$/);
  });

  it("listas diferentes da mesma conta nunca colidem no mesmo arquivo de checkpoint", () => {
    const p7 = checkpointPathForAccount("/x/data/diaria-subscribers/diaria-subscribers.db", "brevo_diaria", 7);
    const p8 = checkpointPathForAccount("/x/data/diaria-subscribers/diaria-subscribers.db", "brevo_diaria", 8);
    assert.notEqual(p7, p8);
  });
});

describe("ingestAccount", () => {
  it("enumera contatos (mock de fetch), busca cada um (deps injetadas), grava eventos idempotentes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-"));
    const dbDir = resolve(tmp, "data/diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "diaria-subscribers.db");
    const db = openDiariaSubscribersDb(dbPath);

    const bodies: Record<number, Record<string, any>> = {
      1: {
        id: 1,
        email: "a@x.com",
        createdAt: "2026-01-01T00:00:00Z",
        statistics: { messagesSent: [{ campaignId: 9, eventTime: "2026-01-05T00:00:00Z" }] },
      },
      2: {
        id: 2,
        email: "b@x.com",
        createdAt: "2026-01-01T00:00:00Z",
        statistics: {
          messagesSent: [{ campaignId: 9, eventTime: "2026-01-05T00:00:00Z" }],
          opened: [{ campaignId: 9, eventTime: "2026-01-05T01:00:00Z" }],
        },
      },
    };

    const result = await withMockedListing(
      [{ id: 1, email: "a@x.com" }, { id: 2, email: "b@x.com" }],
      () =>
        ingestAccount(db, "fake-key", "brevo_diaria", TEST_LIST_ID, dbPath, {
          deps: { fetchContact: async (_key, id) => bodies[id] },
        }),
    );

    assert.equal(result.contactsListed, 2);
    assert.equal(result.contactsProcessed, 2);
    assert.equal(result.contactsFailed, 0);
    // #7201: cada contato com createdAt também emite 1 "subscribe" —
    // 1 sent + (1 sent + 1 open) + 2 subscribe (1 por contato).
    assert.equal(result.eventsNew, 5);
    assert.equal(getStoreCounts(db).subscribers, 2);

    // checkpoint limpo ao terminar (enumeração + processamento completos)
    assert.equal(existsSync(checkpointPathForAccount(dbPath, "brevo_diaria", TEST_LIST_ID)), false);
    db.close();
  });

  it("contato que falha no fetch NÃO entra em doneIds — re-rodar tenta de novo, sem duplicar o que já funcionou", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-"));
    const dbDir = resolve(tmp, "data/diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "diaria-subscribers.db");
    const db = openDiariaSubscribersDb(dbPath);

    let attempt = 0;
    const result = await withMockedListing([{ id: 1, email: "a@x.com" }], () =>
      ingestAccount(db, "fake-key", "brevo_diaria", TEST_LIST_ID, dbPath, {
        deps: {
          fetchContact: async () => {
            attempt++;
            if (attempt === 1) throw new Error("500 transitório");
            return { id: 1, email: "a@x.com", statistics: {} };
          },
        },
      }),
    );
    assert.equal(result.contactsFailed, 1);
    assert.equal(result.contactsProcessed, 0);

    // checkpoint preservado — contato 1 não está em doneIds
    const cpPath = checkpointPathForAccount(dbPath, "brevo_diaria", TEST_LIST_ID);
    assert.ok(existsSync(cpPath), "checkpoint sobrevive quando algo falhou (retomável)");
    const cp = JSON.parse(readFileSync(cpPath, "utf8"));
    assert.deepEqual(cp.doneIds, []);
    db.close();
  });

  it("404 no listing (list_id inválido) propaga erro — NUNCA vira '0 contatos, sucesso' (#7451 review, silent-failure-hunter)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-404-"));
    const dbDir = resolve(tmp, "data/diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, "diaria-subscribers.db");
    const db = openDiariaSubscribersDb(dbPath);

    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/contacts/lists/")) {
        return {
          ok: false,
          status: 404,
          text: async () => "{}",
          json: async () => ({}),
          headers: { get: () => "application/json" },
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado no teste: ${url}`);
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => ingestAccount(db, "fake-key", "brevo_diaria", 999999, dbPath, {}),
        /404 numa listagem em massa não significa lista vazia/,
      );
    } finally {
      globalThis.fetch = orig;
      db.close();
    }
  });
});

describe("main() — a única conta (brevo_diaria), fail-soft por key ausente", () => {
  it("conta sem API key no env é pulada com entry 'error' no manifest", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-main-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/brevo-ingest-manifest.json");

    const origDiaria = process.env.BREVO_DIARIA_API_KEY;
    delete process.env.BREVO_DIARIA_API_KEY;

    try {
      await main(["--db", dbPath, "--manifest", manifestPath, "--account", "brevo_diaria"]);
    } finally {
      if (origDiaria !== undefined) process.env.BREVO_DIARIA_API_KEY = origDiaria;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.entries.find((e: { id: string }) => e.id === "brevo_diaria");
    assert.equal(entry.status, "error");
    assert.match(entry.error, /BREVO_DIARIA_API_KEY/);
  });

  it("--account inválido recusa cedo (exitCode 1) — inclusive 'brevo_clarice' (#7196)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-badacct-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const originalExit = process.exitCode;
    await main(["--db", dbPath, "--account", "brevo_clarice"]);
    assert.equal(process.exitCode, 1);
    process.exitCode = originalExit;
  });

  it("BREVO_ACCOUNTS expõe só brevo_diaria (#7196 — brevo_clarice nunca ingere no store da diária)", () => {
    assert.deepEqual(
      BREVO_ACCOUNTS.map((a) => a.platform),
      ["brevo_diaria"],
    );
  });

  it("cada conta carrega um listId numérico (#7199 — enumeração sempre escopada à lista)", () => {
    for (const account of BREVO_ACCOUNTS) {
      assert.equal(typeof account.listId, "number");
      assert.ok(Number.isFinite(account.listId) && account.listId > 0);
    }
  });
});

describe("main() — ponta a ponta com fixture da conta brevo_diaria (#6587 critério de pronto)", () => {
  it("ingere brevo_diaria a partir da listagem + fetch de cada contato (mock de fetch)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-e2e-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/brevo-ingest-manifest.json");

    const listing = [{ id: 1, email: "leitor@x.com" }];
    const contactById: Record<number, Record<string, any>> = {
      1: { id: 1, email: "leitor@x.com", statistics: { messagesSent: [{ campaignId: 5, eventTime: "2026-08-01T00:00:00Z" }] } },
    };

    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/contacts/lists/")) return jsonResponse({ contacts: listing });
      const match = String(url).match(/\/contacts\/(\d+)$/);
      if (match) return jsonResponse(contactById[Number(match[1])] ?? {});
      throw new Error(`fetch inesperado no teste: ${url}`);
    }) as typeof fetch;

    const origDiaria = process.env.BREVO_DIARIA_API_KEY;
    process.env.BREVO_DIARIA_API_KEY = "key-diaria";

    try {
      await main(["--db", dbPath, "--manifest", manifestPath]);
    } finally {
      globalThis.fetch = orig;
      if (origDiaria !== undefined) process.env.BREVO_DIARIA_API_KEY = origDiaria;
      else delete process.env.BREVO_DIARIA_API_KEY;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const ids = manifest.entries.map((e: { id: string }) => e.id);
    assert.deepEqual(ids, ["brevo_diaria"]);
    assert.ok(manifest.entries.every((e: { status: string }) => e.status === "ok"));

    const db = openDiariaSubscribersDb(dbPath);
    const subs = findSubscriberIdsByEmail(db, "leitor@x.com");
    assert.equal(subs.length, 1);
    const platforms = db
      .prepare("SELECT DISTINCT platform FROM subscription WHERE subscriber_id = ?")
      .all(subs[0])
      .map((r: any) => r.platform);
    assert.deepEqual(platforms, ["brevo_diaria"]);
    assert.equal(getStoreCounts(db).events, 1);
    db.close();
  });
});
