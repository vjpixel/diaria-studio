/**
 * test/clarice-derived-stale-guard-4205.test.ts (#4205)
 *
 * Guard (2) da issue: `clarice-build-segment.ts --group engajados` precisa
 * ABORTAR (não montar uma onda menor em silêncio) quando o store tem
 * engajamento Brevo mais recente que o último `recomputeDerived` — defesa em
 * profundidade sobre o fix primário (clarice-sync-brevo.ts sempre chamar
 * recomputeDerived ao final, ver test/clarice-sync-brevo-recompute-4205.test.ts).
 *
 * `isDerivedStale`/`getLastRecomputedAt` (clarice-db.ts) são as primitivas;
 * este arquivo testa as duas EM CONJUNTO com a integração em `main()` de
 * clarice-build-segment.ts.
 *
 * Cobre explicitamente o caso que a issue #4205 sugeriu como heurística
 * (`opens_count>0 AND priority_points<=0`) e que foi REJEITADO na
 * implementação: medido em produção, ~165/14.290 contatos batem essa
 * condição mesmo em store recém-recomputado (decaído, não defasado) — um
 * guard que usasse essa heurística dispararia sempre, inutilizando o grupo
 * 'engajados'. `isDerivedStale` usa MAX(brevo_modified_at) vs
 * last_recomputed_at, que NÃO confunde os dois casos.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  openClariceDb,
  recomputeDerived,
  getLastRecomputedAt,
  isDerivedStale,
} from "../scripts/lib/clarice-db.ts";
import { main } from "../scripts/clarice-build-segment.ts";

// ---------------------------------------------------------------------------
// getLastRecomputedAt / isDerivedStale — primitivas (clarice-db.ts)
// ---------------------------------------------------------------------------

test("getLastRecomputedAt: store novo (nunca recomputado) -> null", () => {
  const db = openClariceDb(":memory:");
  assert.equal(getLastRecomputedAt(db), null);
  db.close();
});

test("getLastRecomputedAt: carimba um ISO timestamp após recomputeDerived", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES ('a@x.com', 1)").run();
  recomputeDerived(db);
  const stamped = getLastRecomputedAt(db);
  db.close();
  assert.ok(stamped);
  assert.ok(!Number.isNaN(new Date(stamped as string).getTime()));
});

test("isDerivedStale: store nunca recomputado -> false (fail-open, próximo build resolve)", () => {
  const db = openClariceDb(":memory:");
  db.prepare(
    "INSERT INTO clarice_users (email, tier, brevo_modified_at) VALUES ('a@x.com', 1, '2026-07-27T12:00:00Z')",
  ).run();
  assert.equal(isDerivedStale(db), false);
  db.close();
});

test("isDerivedStale: sem nenhuma linha com brevo_modified_at -> false (nada Brevo pra estar defasado)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES ('a@x.com', 1)").run();
  recomputeDerived(db);
  assert.equal(isDerivedStale(db), false);
  db.close();
});

test("isDerivedStale: recompute FRESCO (brevo_modified_at <= last_recomputed_at) -> false", () => {
  const db = openClariceDb(":memory:");
  db.prepare(
    "INSERT INTO clarice_users (email, tier, brevo_modified_at) VALUES ('a@x.com', 1, '2026-07-27T10:00:00Z')",
  ).run();
  recomputeDerived(db); // carimba last_recomputed_at = agora (bem depois de 10:00)
  assert.equal(isDerivedStale(db), false);
  db.close();
});

test("REGRESSÃO (#4205): brevo_modified_at MAIS RECENTE que last_recomputed_at -> true (defasado)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES ('a@x.com', 1)").run();
  recomputeDerived(db); // carimba last_recomputed_at = agora
  // Simula: um sync incremental tocou este contato DEPOIS do recompute (ex: run
  // interrompido antes do recomputeDerived final) — brevo_modified_at no futuro.
  const future = new Date(Date.now() + 60_000).toISOString();
  db.prepare("UPDATE clarice_users SET brevo_modified_at = ? WHERE email = 'a@x.com'").run(future);
  assert.equal(isDerivedStale(db), true);
  db.close();
});

test("REGRESSÃO (#4205): NÃO usa opens_count>0 AND priority_points<=0 como sinal — contato DECAÍDO (não defasado) não dispara falso-positivo", () => {
  const db = openClariceDb(":memory:");
  // 1 abertura antiga + 4 sends não-abertos: computePriorityPoints = 20 - 40 = -20
  // (<=0) com opens_count=1 (>0) — bate a heurística REJEITADA da issue, mas é um
  // estado legítimo e permanente (leitor que decaiu), não staleness.
  db.prepare(
    `INSERT INTO clarice_users (email, tier, sends_count, opens_count, brevo_modified_at)
     VALUES ('decaido@x.com', 2, 5, 1, '2026-07-20T00:00:00Z')`,
  ).run();
  recomputeDerived(db);
  const row = db
    .prepare("SELECT priority_points, opens_count FROM clarice_users WHERE email = 'decaido@x.com'")
    .get() as { priority_points: number; opens_count: number };
  assert.ok(row.opens_count > 0 && row.priority_points <= 0, "setup: bate a heurística rejeitada");
  assert.equal(isDerivedStale(db), false, "mas isDerivedStale não confunde decaído com defasado");
  db.close();
});

// ---------------------------------------------------------------------------
// clarice-build-segment.ts main() — guard aplicado SÓ a --group engajados
// ---------------------------------------------------------------------------

// #4347: main() (clarice-build-segment.ts) é async desde o wire do guard
// queued/sent — `fn` precisa suportar Promise, e o mock de process.exit
// (que lança) precisa ser capturado via await, não try/catch síncrono.
async function withMockedExit<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T | undefined; exitCode: number | undefined; errors: string[] }> {
  const origExit = process.exit;
  const origErr = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  let exitCode: number | undefined;
  // @ts-expect-error — stub de process.exit pra capturar sem matar o test runner
  process.exit = (code?: number) => {
    exitCode = code;
    throw Object.assign(new Error(`__mock_exit__:${code}`), { __mockExit: true });
  };
  let result: T | undefined;
  try {
    result = await fn();
  } catch (e) {
    if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
  return { result, exitCode, errors };
}

// #4347: isola de um BREVO_CLARICE_API_KEY real que `loadProjectEnv()` possa
// ter carregado de `.env` na máquina do editor — sem isso, o guard
// queued/sent novo bateria na rede de verdade num teste. Mesmo helper de
// test/clarice-build-segment.test.ts.
async function withoutBrevoKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.BREVO_CLARICE_API_KEY = prev;
  }
}

function makeStaleDb(dir: string): string {
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  // Candidato válido de 'engajados' (pra provar que, sem o guard, o build teria
  // sucesso — não é um "0 contatos" mascarando o teste).
  db.prepare(
    `INSERT INTO clarice_users (email, name, tier, sends_count, opens_count)
     VALUES ('eng@x.com', 'Eng', 2, 3, 3)`,
  ).run();
  // Candidato válido de 'ramp-warm' (1º envio, verificado) — usado pro teste de
  // que o guard NÃO bloqueia outros grupos.
  db.prepare(
    `INSERT INTO clarice_users (email, name, tier, sends_count, mv_bucket)
     VALUES ('warm@x.com', 'Warm', 1, 0, 'verified')`,
  ).run();
  recomputeDerived(db); // carimba last_recomputed_at
  // Defasa o store: um contato foi tocado pelo Brevo DEPOIS do recompute.
  const future = new Date(Date.now() + 60_000).toISOString();
  db.prepare("UPDATE clarice_users SET brevo_modified_at = ? WHERE email = 'eng@x.com'").run(future);
  db.close();
  return dbPath;
}

test("REGRESSÃO (#4205): clarice-build-segment --group engajados ABORTA (exit 1) quando isDerivedStale, com mensagem clara — não monta onda menor em silêncio", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-stale-"));
  const dbPath = makeStaleDb(dir);

  const { exitCode, errors } = await withoutBrevoKey(() =>
    withMockedExit(() =>
      main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run"]),
    ),
  );

  assert.equal(exitCode, 1);
  assert.ok(
    errors.some((e) => /#4205/.test(e) && /defasad/i.test(e)),
    `esperava erro mencionando #4205/defasado, recebeu: ${JSON.stringify(errors)}`,
  );
});

test("clarice-build-segment --group ramp-warm NÃO é bloqueado pelo guard (#4205 é escopado a 'engajados' — ramp-warm não usa priority_points)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-stale-rampwarm-"));
  const dbPath = makeStaleDb(dir);

  const { exitCode, errors } = await withoutBrevoKey(() =>
    withMockedExit(() =>
      main(["--cycle", "2606-07", "--db", dbPath, "--group", "ramp-warm", "--dry-run"]),
    ),
  );

  assert.equal(exitCode, undefined, `não deveria ter chamado process.exit — errors: ${JSON.stringify(errors)}`);
  assert.ok(!errors.some((e) => /#4205/.test(e)), "guard de #4205 não deveria disparar pra ramp-warm");
});

test("clarice-build-segment --group engajados NÃO aborta quando o store está fresco (recompute cobre o brevo_modified_at mais recente)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-fresh-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    `INSERT INTO clarice_users (email, name, tier, sends_count, opens_count, brevo_modified_at)
     VALUES ('eng@x.com', 'Eng', 2, 3, 3, '2026-07-01T00:00:00Z')`,
  ).run();
  recomputeDerived(db); // recompute roda DEPOIS do brevo_modified_at -> fresco
  db.close();

  const { exitCode, errors } = withMockedExit(() =>
    main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run"]),
  );

  assert.equal(exitCode, undefined, `não deveria abortar — errors: ${JSON.stringify(errors)}`);
});
