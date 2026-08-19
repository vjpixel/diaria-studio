/**
 * test/clarice-build-segment-write-path-ignores-quota-reserve-5697.test.ts (#5697)
 *
 * Não-regressão (#633) pro item 1 da issue #5697: "clarice-build-segment.ts/
 * clarice-plan-wave.ts continuam abortando (nunca escrevendo) quando a
 * checagem de comprometidos falha — comportamento atual preservado, com
 * teste". Já coberto ao vivo por
 * "main: falha na consulta de campanhas comprometidas ABORTA a escrita real"
 * em `test/clarice-build-segment.test.ts` (não tocado por esta unidade).
 *
 * Este arquivo cobre a metade que É nova nesta unidade: o caminho de
 * ESCRITA nunca chama `assertCampaignQuotaHeadroom` — ele é o BENEFICIÁRIO
 * da reserva, não quem a respeita (ver docstring de
 * `scripts/lib/brevo-rate-state.ts`). Prova disso, sem acoplar a um mock de
 * import interno: com a cota gravada BEM abaixo da reserva (remaining=0),
 * uma checagem de comprometidos que SUCEDE ainda assim deixa `main()`
 * prosseguir e escrever o CSV normalmente — se o caminho de escrita
 * chamasse o assert, esta chamada teria lançado `BrevoCampaignQuotaLowError`
 * e o CSV nunca teria sido criado.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/clarice-build-segment.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";
import { DEFAULT_RATE_STATE_PATH, recordCampaignQuotaRemaining } from "../scripts/lib/brevo-rate-state.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const stateDir = dirname(DEFAULT_RATE_STATE_PATH);
let dirPreexisted: boolean;

beforeEach(() => {
  dirPreexisted = existsSync(stateDir);
});

afterEach(() => {
  if (existsSync(DEFAULT_RATE_STATE_PATH)) rmSync(DEFAULT_RATE_STATE_PATH);
  if (!dirPreexisted && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
});

test("main (--group engajados, escrita real): cota BEM abaixo da reserva não bloqueia — write path não chama assertCampaignQuotaHeadroom", async () => {
  // Cota no chão — se o caminho de escrita chamasse o guard de reserva
  // (reserva default 30), esta chamada explodiria e o teste falharia.
  recordCampaignQuotaRemaining(0, 100);

  const dir = mkdtempSync(resolve(tmpdir(), "bseg-write-ignores-quota-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('a@x.com','A',2,3,3,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();
  const segDir = clariceSegmentsDir("2606-07", dir);

  const prevKey = process.env.BREVO_CLARICE_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.BREVO_CLARICE_API_KEY = "test-fake-key";
  // Checagem de comprometidos SUCEDE (nenhuma campanha queued/sent) — o
  // cenário em que o write path deveria seguir em frente e escrever.
  globalThis.fetch = (async () => jsonResponse({ campaigns: [] })) as typeof fetch;
  try {
    await main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--data-root", dir]); // SEM --dry-run
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey !== undefined) process.env.BREVO_CLARICE_API_KEY = prevKey;
    else delete process.env.BREVO_CLARICE_API_KEY;
  }

  assert.ok(
    existsSync(resolve(segDir, "engajados.csv")),
    "CSV deveria ter sido escrito — cota baixa não é motivo pro caminho de ESCRITA abortar (#5697)",
  );
});
