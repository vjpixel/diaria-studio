/**
 * test/clarice-sync-brevo-sunset-guard-4669.test.ts (#4669, bloqueio #4688)
 *
 * REGRESSÃO: `clarice-sync-brevo.ts` (`main()`) precisa reportar o guard de
 * blast radius do sunset de não-abridores ANTES de rodar `recomputeDerived`
 * — decisão do editor (comentário 260805b): "guard de blast radius
 * obrigatório — reportar quantos contatos saem da base elegível antes de
 * aplicar". Este teste força um cenário onde o guard tem algo REAL pra
 * reportar (um contato já `send_eligible=1` com 3 envios e 0 aberturas,
 * inserido diretamente no store — simulando o estoque retroativo que
 * existia ANTES do #4669 entrar em produção).
 *
 * #4688: o guard passou de informativo (só log, `exceedsThreshold` nunca
 * lido) pra BLOQUEANTE — acima do limiar de 30%, `recomputeDerived` NÃO
 * roda (o corte fica represado), salvo `--force-blast-radius`. Este cenário
 * é 100% de corte (1/1), bem acima do limiar — por isso o teste abaixo
 * espera BLOQUEIO por padrão (inverte a expectativa original desta unidade,
 * que testava "aplica sempre").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/clarice-sync-brevo.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";

/** Monta 1 contato já elegível (send_eligible=1), 3 envios, 0 aberturas —
 *  o caso que o sunset cortaria (100% de corte, 1/1 elegível). */
function setupSingleNonOpenerStore(dbPath: string): void {
  const setupDb = openClariceDb(dbPath);
  setupDb
    .prepare(
      `INSERT INTO clarice_users (email, tier, sends_count, opens_count, send_eligible, mv_bucket, brevo_modified_at)
       VALUES ('nunca-abriu@x.com', 4, 3, 0, 1, 'verified', '2026-07-27T00:00:00.000Z')`,
    )
    .run();
  setupDb.close();
}

function mockFetchSingleNonOpener(): typeof globalThis.fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/contacts?")) {
      return new Response(JSON.stringify({ contacts: [{ id: 1, email: "nunca-abriu@x.com" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/contacts/1")) {
      // Nenhuma abertura nova — o contato continua exatamente como estava.
      return new Response(
        JSON.stringify({
          email: "nunca-abriu@x.com",
          emailBlacklisted: false,
          listIds: [],
          modifiedAt: "2026-07-27T12:00:00.000Z",
          statistics: {
            opened: [],
            clicked: [],
            messagesSent: [
              { eventTime: "2026-07-20T09:00:00.000Z" },
              { eventTime: "2026-07-22T09:00:00.000Z" },
              { eventTime: "2026-07-24T09:00:00.000Z" },
            ],
            hardBounces: [],
            softBounces: [],
            complaints: [],
            unsubscriptions: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`fetch inesperado no mock: ${u}`);
  }) as unknown as typeof globalThis.fetch;
}

async function withMockedEnv<T>(fetchImpl: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const origFetch = globalThis.fetch;
  const origApiKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "test-key-4669";
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = origFetch;
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
  }
}

test("#4688: acima do limiar (100% de corte) → main() RECUSA recomputeDerived, contato continua elegível", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4669-blocked-"));
  const dbPath = resolve(dir, "store.db");
  setupSingleNonOpenerStore(dbPath);

  const origLog = console.log;
  let captured = "";
  console.log = (msg: string) => {
    captured = msg;
  };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await withMockedEnv(mockFetchSingleNonOpener(), () => main(["--db", dbPath, "--incremental"]));
    assert.equal(process.exitCode, 1, "guard bloqueado deve sinalizar falha via exitCode (nunca process.exit pós-await, #4651)");
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode;
  }

  // Sem summary JSON — main() retorna antes do console.log final quando bloqueado.
  assert.equal(captured, "");

  const finalDb = openClariceDb(dbPath);
  const after = finalDb
    .prepare("SELECT send_eligible, ineligible_reason FROM clarice_users WHERE email = 'nunca-abriu@x.com'")
    .get() as { send_eligible: number; ineligible_reason: string | null };
  finalDb.close();
  assert.equal(after.send_eligible, 1, "recomputeDerived NÃO rodou — o corte não foi aplicado");
  assert.equal(after.ineligible_reason, null);
});

test("#4688: --force-blast-radius aplica o corte mesmo acima do limiar, e loga o uso da flag", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4669-forced-"));
  const dbPath = resolve(dir, "store.db");
  setupSingleNonOpenerStore(dbPath);

  const origLog = console.log;
  const origError = console.error;
  let captured = "";
  let stderr = "";
  console.log = (msg: string) => {
    captured = msg;
  };
  console.error = (msg: string) => {
    stderr += `${msg}\n`;
  };

  try {
    await withMockedEnv(mockFetchSingleNonOpener(), () =>
      main(["--db", dbPath, "--incremental", "--force-blast-radius"]),
    );
  } finally {
    console.log = origLog;
    console.error = origError;
  }

  assert.match(stderr, /--force-blast-radius usado/, "uso da flag precisa ficar logado, sempre");

  const summary = JSON.parse(captured);
  assert.equal(summary.sunset_blast_radius.cutCount, 1);
  assert.equal(summary.sunset_blast_radius.eligibleBefore, 1);
  assert.equal(summary.sunset_blast_radius.ratio, 1);

  const finalDb = openClariceDb(dbPath);
  const after = finalDb
    .prepare("SELECT send_eligible, ineligible_reason FROM clarice_users WHERE email = 'nunca-abriu@x.com'")
    .get() as { send_eligible: number; ineligible_reason: string | null };
  finalDb.close();
  assert.equal(after.send_eligible, 0, "com --force-blast-radius o corte é aplicado normalmente");
  assert.equal(after.ineligible_reason, "non_opener_sunset");
});

test("#4669: abaixo do limiar → main() aplica recomputeDerived normalmente, sem precisar de --force", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4669-below-"));
  const dbPath = resolve(dir, "store.db");

  // 4 contatos elegíveis, só 1 seria cortado pelo sunset (25% < 30%) — 3 deles
  // com sends_count < 3 (não batem o corte), 1 com 3 envios e 0 aberturas.
  const setupDb = openClariceDb(dbPath);
  const ins = setupDb.prepare(
    `INSERT INTO clarice_users (email, tier, sends_count, opens_count, send_eligible, mv_bucket, brevo_modified_at)
     VALUES (?, 4, ?, ?, 1, 'verified', '2026-07-27T00:00:00.000Z')`,
  );
  ins.run("nunca-abriu@x.com", 3, 0);
  ins.run("abriu1@x.com", 3, 1);
  ins.run("poucos-envios-a@x.com", 1, 0);
  ins.run("poucos-envios-b@x.com", 1, 0);
  setupDb.close();

  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/contacts?")) {
      return new Response(JSON.stringify({ contacts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`fetch inesperado no mock: ${u}`);
  }) as unknown as typeof globalThis.fetch;

  const origLog = console.log;
  let captured = "";
  console.log = (msg: string) => {
    captured = msg;
  };

  try {
    await withMockedEnv(fetchImpl, () => main(["--db", dbPath, "--incremental"]));
  } finally {
    console.log = origLog;
  }

  const summary = JSON.parse(captured);
  assert.equal(summary.sunset_blast_radius.cutCount, 1);
  assert.equal(summary.sunset_blast_radius.eligibleBefore, 4);
  assert.equal(summary.sunset_blast_radius.ratio, 0.25);
  assert.equal(summary.sunset_blast_radius.exceedsThreshold, false);

  const finalDb = openClariceDb(dbPath);
  const after = finalDb
    .prepare("SELECT send_eligible, ineligible_reason FROM clarice_users WHERE email = 'nunca-abriu@x.com'")
    .get() as { send_eligible: number; ineligible_reason: string | null };
  finalDb.close();
  assert.equal(after.send_eligible, 0, "abaixo do limiar, o corte se aplica normalmente sem --force");
  assert.equal(after.ineligible_reason, "non_opener_sunset");
});
