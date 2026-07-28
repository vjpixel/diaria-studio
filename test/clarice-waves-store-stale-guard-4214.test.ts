/**
 * test/clarice-waves-store-stale-guard-4214.test.ts (#4214)
 *
 * Follow-up do #4205/PR #4213: `isDerivedStale` (clarice-db.ts) já guarda
 * `clarice-build-segment.ts --group engajados` (aborta) contra a mesma
 * classe de defasagem (sync incremental que atualiza opens_count/etc no
 * Brevo mas é interrompido ANTES do `recomputeDerived` final alcançar o
 * fim). `clarice-build-waves-store.ts` (`priorityQueue`, clarice-segment.ts)
 * também particiona/ordena por `priority_points` — mas o efeito é mais
 * brando (ordem de fila errada, não invisibilidade — o contato ainda entra
 * na wave). Por isso o guard aqui é WARNING (main() não aborta), não abort
 * como no #4205.
 *
 * Este arquivo cobre: (a) o warning aparece quando isDerivedStale=true; (b)
 * main() NÃO aborta (process.exit não é chamado) mesmo defasado — a wave
 * ainda é montada; (c) sem defasagem, nenhum warning #4214 aparece.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/clarice-build-waves-store.ts";
import { openClariceDb, recomputeDerived, isDerivedStale } from "../scripts/lib/clarice-db.ts";

function makeStaleDb(dir: string): string {
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  // Contato "engajado" (re-envio, priority_points>0) — cuja posição na fila
  // (topo, priorityQueue) depende de priority_points estar fresco.
  db.prepare(
    `INSERT INTO clarice_users (email, name, tier, sends_count, opens_count)
     VALUES ('eng@x.com', 'Eng', 2, 3, 3)`,
  ).run();
  // Contato de 1º envio (não exposto ao guard, mas garante fila não-vazia).
  db.prepare(
    `INSERT INTO clarice_users (email, name, tier, sends_count, mv_bucket)
     VALUES ('fresh@x.com', 'Fresh', 1, 0, 'verified')`,
  ).run();
  recomputeDerived(db); // carimba last_recomputed_at
  // Defasa o store: 'eng@x.com' foi tocado pelo Brevo DEPOIS do recompute
  // (ex: run interrompido antes do recomputeDerived final).
  const future = new Date(Date.now() + 60_000).toISOString();
  db.prepare("UPDATE clarice_users SET brevo_modified_at = ? WHERE email = 'eng@x.com'").run(future);
  db.close();
  return dbPath;
}

test("REGRESSÃO (#4214): clarice-build-waves-store emite WARNING (não aborta) quando isDerivedStale — a wave ainda é montada", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bws-stale-"));
  const dbPath = makeStaleDb(dir);

  // Confirma o setup: o store está de fato defasado (mesma primitiva do #4205).
  {
    const db = openClariceDb(dbPath);
    assert.equal(isDerivedStale(db), true, "setup: store deve estar defasado");
    db.close();
  }

  const errors: string[] = [];
  const origErr = console.error;
  const logs: string[] = [];
  const origLog = console.log;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };

  let exited = false;
  const origExit = process.exit;
  // @ts-expect-error — stub pra provar que main() NÃO chama process.exit
  process.exit = (_code?: number) => { exited = true; throw new Error("__unexpected_exit__"); };

  try {
    main(["--cycle", "2606-07", "--db", dbPath, "--budget", "10", "--dry-run"]);
  } finally {
    console.error = origErr;
    console.log = origLog;
    process.exit = origExit;
  }

  assert.equal(exited, false, "guard deve ser WARNING, não abort — main() não deve chamar process.exit");
  assert.ok(
    errors.some((e) => /#4214/.test(e) && /defasad/i.test(e)),
    `esperava warning mencionando #4214/defasado, recebeu: ${JSON.stringify(errors)}`,
  );
  // A wave ainda foi montada normalmente apesar do warning (dry-run, então só
  // o summary via console.log — não escreve arquivo).
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 2, "os 2 contatos elegíveis ainda devem ser selecionados apesar do warning");
});

test("clarice-build-waves-store NÃO emite warning #4214 quando o store está fresco (recompute cobre o brevo_modified_at mais recente)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bws-fresh-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    `INSERT INTO clarice_users (email, name, tier, sends_count, opens_count, brevo_modified_at)
     VALUES ('eng@x.com', 'Eng', 2, 3, 3, '2026-07-01T00:00:00Z')`,
  ).run();
  recomputeDerived(db); // recompute roda DEPOIS do brevo_modified_at -> fresco
  db.close();

  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  const origLog = console.log;
  console.log = () => {};

  try {
    main(["--cycle", "2606-07", "--db", dbPath, "--budget", "10", "--dry-run"]);
  } finally {
    console.error = origErr;
    console.log = origLog;
  }

  assert.ok(!errors.some((e) => /#4214/.test(e)), `não deveria emitir warning #4214 com store fresco: ${JSON.stringify(errors)}`);
});

test("clarice-build-waves-store NÃO emite warning #4214 quando o store nunca foi recomputado (fail-open, mesma semântica do #4205)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bws-never-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    `INSERT INTO clarice_users (email, name, tier, sends_count, priority_points, send_eligible)
     VALUES ('a@x.com', 'A', 1, 0, 0, 1)`,
  ).run();
  db.close();

  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  const origLog = console.log;
  console.log = () => {};

  try {
    main(["--cycle", "2606-07", "--db", dbPath, "--budget", "10", "--dry-run"]);
  } finally {
    console.error = origErr;
    console.log = origLog;
  }

  assert.ok(!errors.some((e) => /#4214/.test(e)), `store nunca recomputado deve ser fail-open (sem warning): ${JSON.stringify(errors)}`);
});
