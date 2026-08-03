/**
 * test/clarice-sync-brevo-recompute-4205.test.ts (#4205)
 *
 * REGRESSÃO: o sync do Brevo (`clarice-sync-brevo.ts`) precisa deixar o store
 * AUTOCONSISTENTE — `opens_count`/`clicks_count`/etc atualizados SEM que
 * `priority_points` fique pra trás. Medido em produção (260727): um sync
 * incremental que atualiza colunas Brevo sem alcançar `recomputeDerived`
 * (rate-limit/Ctrl+C antes do fim) deixa `isEngajados` (clarice-segment.ts,
 * filtra por `priority_points > 0`) invisível pra quem abriu recentemente —
 * a onda de "engajados" sai centenas de pessoas menor, sem nenhum aviso.
 *
 * `main()` já chama `recomputeDerived(db)` incondicionalmente ao final de
 * QUALQUER run que complete (full ou `--incremental` — ver o bloco
 * "Concluído: recompute global" em clarice-sync-brevo.ts). Este teste TRAVA
 * esse invariante fim-a-fim: roda `main()` com `--incremental` contra um store
 * SQLite de fixture (fetch mockado, sem rede real) e confirma que
 * `priority_points` já reflete o `opens_count` recém-sincronizado — SEM o
 * teste chamar `recomputeDerived` manualmente depois de `main()` retornar.
 * Se um refactor futuro remover essa chamada interna, este teste falha.
 *
 * `checkpointPathsForDb` também é travado aqui — é o que tornou este teste
 * possível: antes, os 2 arquivos de checkpoint (full/incremental) eram consts
 * hardcoded em `data/clarice-subscribers/` do repo real (não injetável, e
 * inexistente num worktree fresco/cloud). Agora derivam do diretório do
 * `--db`, então um `--db <tmpdir>/store.db` de teste isola db+checkpoint
 * juntos, sem tocar o disco real.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { main, checkpointPathsForDb } from "../scripts/clarice-sync-brevo.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";

// ---------------------------------------------------------------------------
// main() --limit — REGRESSÃO #4497 (getIntArg substitui Number(getArg(...))||0)
// ---------------------------------------------------------------------------

test("REGRESSÃO (#4497): main() --limit com valor inválido (typo) LANÇA — não vira '0 = sem limite' silenciosamente", async () => {
  const origApiKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "test-key-4497";
  try {
    // getIntArg lança ANTES de qualquer acesso a disco/rede (a validação do
    // --limit acontece antes de openClariceDb/enumerateContacts) — não
    // precisa de fixture de DB nem mock de fetch pra provar o throw.
    await assert.rejects(
      main(["--db", resolve(tmpdir(), "nao-existe-nao-importa.db"), "--limit", "abc"]),
      /inteiro/,
    );
  } finally {
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
  }
});

// ---------------------------------------------------------------------------
// checkpointPathsForDb — pura
// ---------------------------------------------------------------------------

test("checkpointPathsForDb: co-localiza os 2 checkpoints (full/incremental) no MESMO diretório do --db", () => {
  const dbPath = resolve(tmpdir(), "algum-dir", "store.db");
  const { checkpoint, checkpointInc } = checkpointPathsForDb(dbPath);
  assert.equal(dirname(checkpoint), dirname(dbPath));
  assert.equal(dirname(checkpointInc), dirname(dbPath));
  assert.equal(checkpoint.endsWith(".brevo-sync-checkpoint.json"), true);
  assert.equal(checkpointInc.endsWith(".brevo-sync-checkpoint-inc.json"), true);
  assert.notEqual(checkpoint, checkpointInc); // full e incremental nunca compartilham arquivo
});

// ---------------------------------------------------------------------------
// main() — fim-a-fim, fetch mockado (sem rede real, sem tocar data/ do repo)
// ---------------------------------------------------------------------------

test("REGRESSÃO (#4205): main() --incremental deixa priority_points consistente com o opens_count recém-sincronizado, SEM recomputeDerived manual", async (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), "sync-brevo-4205-"));
  const dbPath = resolve(dir, "store.db");

  // Setup: contato já existia no store (1 send anterior, nunca abriu) — o
  // recompute ANTERIOR (simulando o último clarice-build-db.ts) deixou
  // priority_points negativo (computePriorityPoints: 0 - 10*1 = -10).
  // brevo_modified_at populado pra --incremental conseguir derivar um
  // modifiedSince real (MAX(brevo_modified_at) − 5min) em vez de cair pra full.
  const setupDb = openClariceDb(dbPath);
  setupDb
    .prepare(
      `INSERT INTO clarice_users (email, tier, sends_count, opens_count, brevo_modified_at)
       VALUES ('a@x.com', 2, 1, 0, '2026-07-27T00:00:00.000Z')`,
    )
    .run();
  recomputeDerived(setupDb);
  const before = setupDb
    .prepare("SELECT priority_points, opens_count FROM clarice_users WHERE email = 'a@x.com'")
    .get() as { priority_points: number; opens_count: number };
  assert.equal(before.opens_count, 0);
  assert.equal(before.priority_points, -10); // baseline: decaído (1 send, 0 aberturas)
  setupDb.close();

  // Mock da Brevo: o contato "abriu" desde o último sync (opens_count 0 → 1,
  // sends_count continua 1 — nenhum envio novo, só a abertura tardia do já enviado).
  const origFetch = globalThis.fetch;
  const origApiKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "test-key-4205";
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/contacts?")) {
      // Fase 1 — listing (enumerateContacts): 1 página, 1 contato, completa.
      return new Response(JSON.stringify({ contacts: [{ id: 1, email: "a@x.com" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/contacts/1")) {
      // Fase 2 — GET por contato (parseBrevoContact): 1 abertura nova.
      return new Response(
        JSON.stringify({
          email: "a@x.com",
          emailBlacklisted: false,
          listIds: [],
          modifiedAt: "2026-07-27T12:00:00.000Z",
          statistics: {
            opened: [{ eventTime: "2026-07-27T12:00:00.000Z" }],
            clicked: [],
            messagesSent: [{ eventTime: "2026-07-26T09:00:00.000Z" }],
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

  t.after(() => {
    globalThis.fetch = origFetch;
    if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origApiKey;
  });

  // O ponto central do teste: SÓ main() roda aqui. Nenhuma chamada manual a
  // recomputeDerived depois — se main() parar de chamá-lo internamente, o
  // assert abaixo falha.
  await main(["--db", dbPath, "--incremental"]);

  const { checkpoint, checkpointInc } = checkpointPathsForDb(dbPath);
  assert.equal(existsSync(checkpoint), false, "checkpoint full não deveria existir (run foi incremental)");
  assert.equal(existsSync(checkpointInc), false, "checkpoint incremental é limpo ao concluir com sucesso");

  const finalDb = openClariceDb(dbPath);
  const after = finalDb
    .prepare("SELECT priority_points, opens_count, sends_count FROM clarice_users WHERE email = 'a@x.com'")
    .get() as { priority_points: number; opens_count: number; sends_count: number };
  finalDb.close();

  assert.equal(after.opens_count, 1, "opens_count sincronizado do Brevo");
  assert.equal(after.sends_count, 1, "sends_count inalterado (nenhum envio novo)");
  // computePriorityPoints(opens=1, sends=1): notOpened = max(0, 1-1) = 0 → 20*1 - 10*0 = 20.
  // Só é possível bater 20 (em vez de continuar em -10) se main() chamou
  // recomputeDerived — a prova de que o fix (#4205 item 1) está com fio ligado.
  assert.equal(after.priority_points, 20, "priority_points reflete o opens_count fresco — recomputeDerived rodou dentro de main()");
});
