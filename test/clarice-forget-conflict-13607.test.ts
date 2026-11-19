/**
 * #13607 — o ledger da lista de esquecimento (LGPD) vive em `data/` e é
 * escrito por duas máquinas. Quando as duas acrescentam linhas antes do sync,
 * o rclone bisync deixa `forget-requests.jsonl.conflictN` (às vezes
 * renomeando também o original). Antes do fix, `readForgetLedger` só lia o
 * caminho principal: o rebuild abortava em loop (pedido na tabela, fora do
 * principal) ou, com o principal sumido e o store recriado do zero, seguia
 * "sem pedidos" e regravava nome e ids do Stripe de quem pediu exclusão.
 *
 * Só fixtures em diretório temporário: nada de `data/` real, nada de Brevo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main as buildDb } from "../scripts/clarice-build-db.ts";
import { listForgetRequests, openClariceDb } from "../scripts/lib/clarice-db.ts";
import {
  appendForgetLedger,
  forgetInStore,
  importForgetLedger,
  readForgetLedger,
  syncLedgerFromStore,
} from "../scripts/lib/clarice-forget.ts";
import { main as forgetCli } from "../scripts/clarice-forget.ts";

const EMAIL = "maria.souza@uol.com.br";
const OUTRA = "ana.reis@uol.com.br";

function tmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

function line(email: string, at = "2026-11-18T12:00:00.000Z"): string {
  return JSON.stringify({ email, requested_at: at, source: "teste", note: null }) + "\n";
}

/** data-dir com um export Stripe que tem a leitora (e outra pessoa que não pediu nada). */
function fixtureDataDir(): string {
  const dataDir = tmp("forget-13607-data-");
  writeFileSync(
    resolve(dataDir, "stripe-customers.csv"),
    "id,Email,Name,Created (UTC),Status\n" +
      `cus_maria,${EMAIL},Maria Souza,2026-03-10 10:00,active\n` +
      `cus_ana,${OUTRA},Ana Reis,2026-03-10 10:00,active\n` +
      "cus_joao,joao.lima@uol.com.br,João Lima,2026-03-11 10:00,active\n",
  );
  return dataDir;
}

function row(dbPath: string, email: string): Record<string, unknown> | undefined {
  const db = openClariceDb(dbPath);
  const r = db.prepare("SELECT * FROM clarice_users WHERE email = ?").get(email) as Record<string, unknown> | undefined;
  db.close();
  return r;
}

/** Roda o rebuild e devolve o código de saída (undefined = terminou sem process.exit). */
function buildExitCode(dbPath: string, dataDir: string, ledger: string): number | undefined {
  const exit = process.exit;
  const err = console.error;
  const log = console.log;
  let code: number | undefined;
  (process as { exit: (c?: number) => never }).exit = ((c?: number) => {
    code = c;
    throw new Error("exit");
  }) as never;
  console.error = () => {};
  console.log = () => {};
  try {
    buildDb(["--db", dbPath, "--data-dir", dataDir, "--forget-ledger", ledger]);
  } catch (e) {
    if ((e as Error).message !== "exit") throw e;
  } finally {
    process.exit = exit;
    console.error = err;
    console.log = log;
  }
  return code;
}

function assertForgotten(dbPath: string, email: string, label: string) {
  const r = row(dbPath, email);
  assert.ok(r, `${label}: a linha continua no store (só com a supressão)`);
  assert.equal(r!.name, null, `${label}: nome não pode voltar`);
  assert.equal(r!.stripe_ids, null, `${label}: ids do Stripe não podem voltar`);
  assert.equal(r!.send_eligible, 0, `${label}: inelegível`);
}

test("#13607 regressão: pedido que só está na .conflict1 do ledger não trava o rebuild em loop", () => {
  const dataDir = fixtureDataDir();
  const ledger = resolve(dataDir, "forget-requests.jsonl");
  const dbPath = resolve(tmp("forget-13607-loop-"), "clarice-users.db");
  // A tabela do 300 já tem o pedido da Maria (veio com o .db sincronizado)...
  const db = openClariceDb(dbPath);
  forgetInStore(db, { email: EMAIL, requestedAt: "2026-11-18T12:00:00.000Z" }, null);
  db.close();
  // ...e o bisync deixou a linha dela só na cópia de conflito; o principal tem outro pedido.
  writeFileSync(ledger, line(OUTRA));
  writeFileSync(`${ledger}.conflict1`, line(OUTRA) + line(EMAIL));

  assert.equal(buildExitCode(dbPath, dataDir, ledger), undefined, "o rebuild segue (antes: exit 1 em loop)");
  assertForgotten(dbPath, EMAIL, "pedido da cópia");
  assertForgotten(dbPath, OUTRA, "pedido do principal");
  assert.equal(row(dbPath, "joao.lima@uol.com.br")?.name, "João Lima", "o resto da base segue normal");
});

test("#13607 comentário 3: principal sumido (as duas versões viraram .conflictN) + store recriado do zero não regrava o dado pessoal", () => {
  const dataDir = fixtureDataDir();
  const ledger = resolve(dataDir, "forget-requests.jsonl"); // não existe
  writeFileSync(`${ledger}.conflict1`, line(EMAIL));
  writeFileSync(`${ledger}.conflict2`, line(OUTRA));
  const dbPath = resolve(tmp("forget-13607-fresh-"), "clarice-users.db"); // store novo, tabela vazia

  assert.equal(buildExitCode(dbPath, dataDir, ledger), undefined);
  assertForgotten(dbPath, EMAIL, "pedido da .conflict1");
  assertForgotten(dbPath, OUTRA, "pedido da .conflict2");
  const db = openClariceDb(dbPath);
  assert.deepEqual(listForgetRequests(db).map((r) => r.email).sort(), [OUTRA, EMAIL].sort());
  db.close();
});

test("#13607 cópia de conflito com linha inválida aborta o rebuild (mesma regra do principal)", () => {
  const dataDir = fixtureDataDir();
  const ledger = resolve(dataDir, "forget-requests.jsonl");
  writeFileSync(ledger, line(OUTRA));
  writeFileSync(`${ledger}.conflict1`, line(EMAIL) + `{"email":"maria.so\n`);
  const dbPath = resolve(tmp("forget-13607-invalid-"), "clarice-users.db");
  assert.equal(buildExitCode(dbPath, dataDir, ledger), 1);
  assert.equal(row(dbPath, EMAIL), undefined, "nada do Stripe foi ingerido");
});

test("#13607 leitura: união sem duplicar, fica o pedido mais antigo, cópia do OneDrive também conta", () => {
  const dir = tmp("forget-13607-read-");
  const ledger = resolve(dir, "forget-requests.jsonl");
  writeFileSync(ledger, line(EMAIL, "2026-11-18T15:00:00.000Z"));
  writeFileSync(`${ledger}.conflict1`, line(EMAIL, "2026-11-18T12:00:00.000Z") + line(OUTRA));
  writeFileSync(resolve(dir, "forget-requests-neo-safeBackup-0001.jsonl"), line("bia@uol.com.br"));
  writeFileSync(resolve(dir, "outro-arquivo.jsonl.conflict1"), line("nao-e-do-ledger@uol.com.br"));

  const r = readForgetLedger(ledger);
  assert.equal(r.exists, true);
  assert.deepEqual(r.entries.map((e) => e.email).sort(), ["bia@uol.com.br", EMAIL, OUTRA].sort());
  assert.equal(r.entries.find((e) => e.email === EMAIL)?.requested_at, "2026-11-18T12:00:00.000Z");
  assert.equal(r.conflict_copies.length, 2);
  // só o principal
  assert.deepEqual(readForgetLedger(ledger, { includeConflictCopies: false }).entries.map((e) => e.email), [EMAIL]);
  assert.deepEqual(readForgetLedger(ledger, { includeConflictCopies: false }).conflict_copies, []);
  // nenhum arquivo
  assert.deepEqual(readForgetLedger(resolve(dir, "nada.jsonl")), { exists: false, entries: [], conflict_copies: [] });
  rmSync(dir, { recursive: true, force: true });
});

test("#13607 sync-ledger consolida no principal o que só estava nas cópias, sem apagá-las", async () => {
  const dir = tmp("forget-13607-sync-");
  const ledger = resolve(dir, "forget-requests.jsonl");
  const dbPath = resolve(dir, "clarice-users.db");
  writeFileSync(ledger, line(OUTRA));
  writeFileSync(`${ledger}.conflict1`, line(EMAIL));
  const db = openClariceDb(dbPath);
  forgetInStore(db, { email: "bia@uol.com.br", requestedAt: "2026-11-18T12:00:00.000Z" }, null); // só a tabela
  db.close();

  const err = console.error;
  const log = console.log;
  let out = "";
  console.error = () => {};
  console.log = (s: string) => void (out += s);
  try {
    assert.equal(await forgetCli(["sync-ledger", "--db", dbPath, "--ledger", ledger]), 0);
  } finally {
    console.error = err;
    console.log = log;
  }
  const res = JSON.parse(out) as { added: string[]; conflict_copies: string[] };
  assert.deepEqual(res.added.sort(), ["bia@uol.com.br", EMAIL].sort());
  assert.equal(res.conflict_copies.length, 1, "a cópia é informada");
  assert.deepEqual(
    readForgetLedger(ledger, { includeConflictCopies: false }).entries.map((e) => e.email).sort(),
    ["bia@uol.com.br", EMAIL, OUTRA].sort(),
    "o principal agora cobre tudo",
  );
  assert.ok(readdirSync(dir).includes("forget-requests.jsonl.conflict1"), "a cópia não é apagada");

  // idempotente: rodar de novo não acrescenta nada; append de quem só estava na cópia agora é no-op
  const db2 = openClariceDb(dbPath);
  assert.deepEqual(syncLedgerFromStore(db2, ledger), []);
  assert.equal(importForgetLedger(db2, ledger).total, 3);
  db2.close();
  assert.equal(appendForgetLedger(ledger, { email: EMAIL, requested_at: "x", source: null, note: null }), false);
  rmSync(dir, { recursive: true, force: true });
});

test("#13607 append: pedido que só está numa cópia é escrito no principal (consolida em vez de pular)", () => {
  const dir = tmp("forget-13607-append-");
  mkdirSync(dir, { recursive: true });
  const ledger = resolve(dir, "forget-requests.jsonl");
  writeFileSync(`${ledger}.conflict1`, line(EMAIL));
  assert.equal(appendForgetLedger(ledger, { email: EMAIL, requested_at: "2026-11-18T12:00:00.000Z", source: null, note: null }), true);
  assert.deepEqual(readForgetLedger(ledger, { includeConflictCopies: false }).entries.map((e) => e.email), [EMAIL]);
  rmSync(dir, { recursive: true, force: true });
});
