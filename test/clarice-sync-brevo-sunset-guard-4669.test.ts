/**
 * test/clarice-sync-brevo-sunset-guard-4669.test.ts (#4669)
 *
 * REGRESSÃO: `clarice-sync-brevo.ts` (`main()`) precisa reportar o guard de
 * blast radius do sunset de não-abridores ANTES de rodar `recomputeDerived`
 * — decisão do editor (comentário 260805b): "guard de blast radius
 * obrigatório — reportar quantos contatos saem da base elegível antes de
 * aplicar". Este teste força um cenário onde o guard tem algo REAL pra
 * reportar (um contato já `send_eligible=1` com 3 envios e 0 aberturas,
 * inserido diretamente no store — simulando o estoque retroativo que
 * existia ANTES do #4669 entrar em produção) e confirma que o JSON de saída
 * de `main()` carrega `sunset_blast_radius.cutCount` correto, calculado
 * sobre o estado PRÉ-recompute (não `0` por o corte já ter sido aplicado
 * antes da leitura).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/clarice-sync-brevo.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";

test("REGRESSÃO (#4669): main() reporta sunset_blast_radius.cutCount sobre o estado PRÉ-recompute, não zero", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4669-"));
  const dbPath = resolve(dir, "store.db");

  // Setup: contato JÁ elegível (send_eligible=1, gravado direto — sem passar
  // por recomputeDerived) com 3 envios e 0 aberturas. Simula o estoque
  // retroativo que o sunset precisa cortar na primeira passagem.
  const setupDb = openClariceDb(dbPath);
  setupDb
    .prepare(
      `INSERT INTO clarice_users (email, tier, sends_count, opens_count, send_eligible, mv_bucket, brevo_modified_at)
       VALUES ('nunca-abriu@x.com', 4, 3, 0, 1, 'verified', '2026-07-27T00:00:00.000Z')`,
    )
    .run();
  setupDb.close();

  const origFetch = globalThis.fetch;
  const origApiKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "test-key-4669";
  globalThis.fetch = (async (url: string | URL) => {
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

  const origLog = console.log;
  let captured = "";
  console.log = (msg: string) => {
    captured = msg;
  };

  try {
    await main(["--db", dbPath, "--incremental"]);
  } finally {
    console.log = origLog;
    globalThis.fetch = origFetch;
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
  }

  const summary = JSON.parse(captured);
  assert.equal(summary.sunset_blast_radius.cutCount, 1, "o único contato do store seria cortado pelo sunset (3 envios, 0 aberturas)");
  assert.equal(summary.sunset_blast_radius.eligibleBefore, 1);
  assert.equal(summary.sunset_blast_radius.ratio, 1);
  assert.equal(summary.sunset_blast_radius.minSends, 3);

  // E o recompute que roda LOGO DEPOIS de fato aplica o corte — confirma que
  // o número reportado pelo guard bate com o efeito real.
  const finalDb = openClariceDb(dbPath);
  const after = finalDb
    .prepare("SELECT send_eligible, ineligible_reason FROM clarice_users WHERE email = 'nunca-abriu@x.com'")
    .get() as { send_eligible: number; ineligible_reason: string | null };
  finalDb.close();
  assert.equal(after.send_eligible, 0);
  assert.equal(after.ineligible_reason, "non_opener_sunset");
});
