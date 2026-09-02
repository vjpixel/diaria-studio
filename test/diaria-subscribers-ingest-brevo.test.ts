/**
 * diaria-subscribers-ingest-brevo.test.ts (#6464 fatia 4 — #6587)
 *
 * Cobre a camada de I/O do builder Brevo: enumeração de contatos (mock de
 * `fetch` global — mesmo padrão de `test/brevo-committed-campaigns-3682.test.ts`),
 * checkpoint resumível por CONTA, e `main()` orquestrando as DUAS contas com
 * fixtures — sem rede real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  ingestAccount,
  checkpointPathForAccount,
  main,
  BREVO_ACCOUNTS,
} from "../scripts/diaria-subscribers-ingest-brevo.ts";
import { openDiariaSubscribersDb, getStoreCounts, findSubscriberIdsByEmail } from "../scripts/lib/diaria-subscribers-db.ts";

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

/** Troca `globalThis.fetch` só pra responder o LISTING (`/contacts?...`) —
 *  mesmo padrão de `brevo-committed-campaigns-3682.test.ts`. */
async function withMockedListing<T>(contacts: Array<{ id: number; email: string }>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/contacts?")) return jsonResponse({ contacts });
    throw new Error(`fetch inesperado no teste: ${url}`);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("checkpointPathForAccount", () => {
  it("1 arquivo de checkpoint por conta, ao lado do .db", () => {
    const p1 = checkpointPathForAccount("/x/data/diaria-subscribers/diaria-subscribers.db", "brevo_diaria");
    const p2 = checkpointPathForAccount("/x/data/diaria-subscribers/diaria-subscribers.db", "brevo_clarice");
    assert.notEqual(p1, p2);
    assert.match(p1, /brevo-ingest-checkpoint-brevo_diaria\.json$/);
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
        ingestAccount(db, "fake-key", "brevo_diaria", dbPath, {
          deps: { fetchContact: async (_key, id) => bodies[id] },
        }),
    );

    assert.equal(result.contactsListed, 2);
    assert.equal(result.contactsProcessed, 2);
    assert.equal(result.contactsFailed, 0);
    assert.equal(result.eventsNew, 3); // 1 sent + (1 sent + 1 open)
    assert.equal(getStoreCounts(db).subscribers, 2);

    // checkpoint limpo ao terminar (enumeração + processamento completos)
    assert.equal(existsSync(checkpointPathForAccount(dbPath, "brevo_diaria")), false);
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
      ingestAccount(db, "fake-key", "brevo_diaria", dbPath, {
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
    const cpPath = checkpointPathForAccount(dbPath, "brevo_diaria");
    assert.ok(existsSync(cpPath), "checkpoint sobrevive quando algo falhou (retomável)");
    const cp = JSON.parse(readFileSync(cpPath, "utf8"));
    assert.deepEqual(cp.doneIds, []);
    db.close();
  });
});

describe("main() — as DUAS contas, fail-soft por key ausente", () => {
  it("conta sem API key no env é pulada com entry 'error' no manifest — a outra segue normal", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-main-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/brevo-ingest-manifest.json");

    const origDiaria = process.env.BREVO_DIARIA_API_KEY;
    const origClarice = process.env.BREVO_CLARICE_API_KEY;
    delete process.env.BREVO_DIARIA_API_KEY;
    delete process.env.BREVO_CLARICE_API_KEY;

    try {
      await main(["--db", dbPath, "--manifest", manifestPath, "--account", "brevo_diaria"]);
    } finally {
      if (origDiaria !== undefined) process.env.BREVO_DIARIA_API_KEY = origDiaria;
      if (origClarice !== undefined) process.env.BREVO_CLARICE_API_KEY = origClarice;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.entries.find((e: { id: string }) => e.id === "brevo_diaria");
    assert.equal(entry.status, "error");
    assert.match(entry.error, /BREVO_DIARIA_API_KEY/);
  });

  it("--account inválido recusa cedo (exitCode 1)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-badacct-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const originalExit = process.exitCode;
    await main(["--db", dbPath, "--account", "mailchimp"]);
    assert.equal(process.exitCode, 1);
    process.exitCode = originalExit;
  });

  it("BREVO_ACCOUNTS expõe as 2 contas reais do projeto", () => {
    assert.deepEqual(
      BREVO_ACCOUNTS.map((a) => a.platform).sort(),
      ["brevo_clarice", "brevo_diaria"],
    );
  });
});

describe("main() — ponta a ponta com fixtures das DUAS contas (#6587 critério de pronto)", () => {
  it("ingere brevo_diaria E brevo_clarice na mesma rodada, sem cruzar identidade entre contas", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-brevo-ingest-2contas-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/brevo-ingest-manifest.json");

    // 2 contas, 2 keys, 2 listagens de contato DIFERENTES — o mesmo e-mail
    // (compartilhado@x.com) aparece nas duas, propositalmente, pra provar
    // que vira 2 subscriber distintos (1 por conta), nunca fundido.
    const listingByKey: Record<string, Array<{ id: number; email: string }>> = {
      "key-diaria": [{ id: 1, email: "compartilhado@x.com" }],
      "key-clarice": [{ id: 101, email: "compartilhado@x.com" }],
    };
    const contactByKeyAndId: Record<string, Record<number, Record<string, any>>> = {
      "key-diaria": {
        1: { id: 1, email: "compartilhado@x.com", statistics: { messagesSent: [{ campaignId: 5, eventTime: "2026-08-01T00:00:00Z" }] } },
      },
      "key-clarice": {
        101: { id: 101, email: "compartilhado@x.com", statistics: { opened: [{ campaignId: 7, eventTime: "2026-08-02T00:00:00Z" }] } },
      },
    };

    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const apiKey = headers?.["api-key"] ?? "";
      if (String(url).includes("/contacts?")) return jsonResponse({ contacts: listingByKey[apiKey] ?? [] });
      const match = String(url).match(/\/contacts\/(\d+)$/);
      if (match) return jsonResponse(contactByKeyAndId[apiKey]?.[Number(match[1])] ?? {});
      throw new Error(`fetch inesperado no teste: ${url}`);
    }) as typeof fetch;

    const origDiaria = process.env.BREVO_DIARIA_API_KEY;
    const origClarice = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_DIARIA_API_KEY = "key-diaria";
    process.env.BREVO_CLARICE_API_KEY = "key-clarice";

    try {
      await main(["--db", dbPath, "--manifest", manifestPath]);
    } finally {
      globalThis.fetch = orig;
      if (origDiaria !== undefined) process.env.BREVO_DIARIA_API_KEY = origDiaria;
      else delete process.env.BREVO_DIARIA_API_KEY;
      if (origClarice !== undefined) process.env.BREVO_CLARICE_API_KEY = origClarice;
      else delete process.env.BREVO_CLARICE_API_KEY;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const ids = manifest.entries.map((e: { id: string }) => e.id).sort();
    assert.deepEqual(ids, ["brevo_clarice", "brevo_diaria"]);
    assert.ok(manifest.entries.every((e: { status: string }) => e.status === "ok"));

    const db = openDiariaSubscribersDb(dbPath);
    const subs = findSubscriberIdsByEmail(db, "compartilhado@x.com");
    assert.equal(subs.length, 2, "mesmo e-mail nas 2 contas → 2 subscriber distintos, nunca fundidos");
    const platforms = db
      .prepare("SELECT DISTINCT platform FROM subscription WHERE subscriber_id IN (?, ?)")
      .all(subs[0], subs[1])
      .map((r: any) => r.platform)
      .sort();
    assert.deepEqual(platforms, ["brevo_clarice", "brevo_diaria"]);
    assert.equal(getStoreCounts(db).events, 2); // 1 sent (diária) + 1 open (clarice)
    db.close();
  });
});
