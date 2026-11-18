/**
 * #13573 — lista de esquecimento (LGPD) do store da Clarice: o pedido de
 * exclusão de dados sobrevive ao rebuild do Stripe, ao store recriado do zero
 * e ao sync da Brevo. #13574 — progresso visível e recompute que não regrava
 * a base inteira.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main as buildDb } from "../scripts/clarice-build-db.ts";
import {
  listForgetRequests,
  makeBrevoUpsert,
  makeForgetMatcher,
  markSuppressedNow,
  minimizeForgottenRows,
  openClariceDb,
  recomputeDerived,
  recordForgetRequest,
} from "../scripts/lib/clarice-db.ts";
import {
  appendForgetLedger,
  brevoMinimizerFromIo,
  buildBrevoMinimizeBody,
  forgetInStore,
  importForgetLedger,
  readForgetLedger,
} from "../scripts/lib/clarice-forget.ts";
import { main as forgetCli } from "../scripts/clarice-forget.ts";
import { applyTriagePlan } from "../scripts/clarice-replies-triage.ts";
import { buildTriagePlan, type ReplyMessage } from "../scripts/lib/clarice-replies-classify.ts";
import type { BrevoColumns } from "../scripts/lib/brevo-stats.ts";

const EMAIL = "maria.souza@uol.com.br";

function tmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

function quiet<T>(fn: () => T): T {
  const err = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.error = err;
    console.log = log;
  }
}

async function quietAsync<T>(fn: () => Promise<T>): Promise<T> {
  const err = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
    console.log = log;
  }
}

type Row = Record<string, unknown>;
function row(dbPath: string, email: string): Row | undefined {
  const db = openClariceDb(dbPath);
  const r = db.prepare("SELECT * FROM clarice_users WHERE email = ?").get(email) as Row | undefined;
  db.close();
  return r;
}

/** data-dir com um export Stripe que tem a leitora + um MV dela num ciclo válido. */
function fixtureDataDir(): string {
  const dataDir = tmp("forget-13573-data-");
  writeFileSync(
    resolve(dataDir, "stripe-customers.csv"),
    "id,Email,Name,Created (UTC),Status\n" +
      `cus_maria,${EMAIL},Maria Souza,2026-03-10 10:00,active\n` +
      "cus_joao,joao.lima@uol.com.br,João Lima,2026-03-11 10:00,active\n",
  );
  const cycleDir = resolve(dataDir, "2605-06");
  mkdirSync(cycleDir);
  writeFileSync(
    resolve(cycleDir, "mv-export-x-verified.csv"),
    `email,MV_RESULT,MV_QUALITY,MV_CODE\n${EMAIL},ok,good,1\njoao.lima@uol.com.br,ok,good,1\n`,
  );
  return dataDir;
}

function assertMinimal(r: Row | undefined, label: string) {
  assert.ok(r, `${label}: a linha continua no store (só com a supressão)`);
  for (const c of ["name", "stripe_ids", "status", "created", "cohort", "mv_bucket", "mv_result", "brevo_list_ids", "last_open_at"]) {
    assert.equal(r![c], null, `${label}: ${c} deveria estar vazio`);
  }
  for (const c of ["opens_count", "clicks_count", "sends_count", "priority_points", "send_eligible"]) {
    assert.equal(r![c], 0, `${label}: ${c} deveria ser 0`);
  }
  assert.equal(r!.unsubscribed, 1, `${label}: unsubscribed`);
  assert.equal(r!.email_blacklisted, 1, `${label}: email_blacklisted`);
  assert.equal(r!.ineligible_reason, "unsubscribed", `${label}: ineligible_reason`);
}

// ---------------------------------------------------------------------------
// Regressão central do #13573
// ---------------------------------------------------------------------------

test("#13573 regressão: rebuild com a leitora ainda no export do Stripe não repõe nome, ids, cohort nem MV", () => {
  const dataDir = fixtureDataDir();
  const dbPath = resolve(tmp("forget-13573-db-"), "clarice-users.db");

  quiet(() => buildDb(["--db", dbPath, "--data-dir", dataDir]));
  const before = row(dbPath, EMAIL);
  assert.equal(before?.name, "Maria Souza", "pré-condição: o rebuild grava o nome");
  assert.notEqual(before?.stripe_ids, null);

  // pedido de exclusão (ledger no data-dir, como em produção)
  const db = openClariceDb(dbPath);
  forgetInStore(db, { email: EMAIL, requestedAt: "2026-11-18T12:00:00.000Z", source: "teste" }, resolve(dataDir, "forget-requests.jsonl"));
  recomputeDerived(db);
  db.close();
  assertMinimal(row(dbPath, EMAIL), "logo após o pedido");

  // o rebuild que antes desfazia a exclusão
  quiet(() => buildDb(["--db", dbPath, "--data-dir", dataDir]));
  assertMinimal(row(dbPath, EMAIL), "depois do rebuild");
  // o resto da base segue normal
  const joao = row(dbPath, "joao.lima@uol.com.br");
  assert.equal(joao?.name, "João Lima");
  assert.equal(joao?.mv_bucket, "verified");
});

test("#13573 store recriado do zero: o ledger em data/ traz o pedido de volta antes de ingerir o Stripe", () => {
  const dataDir = fixtureDataDir();
  appendForgetLedger(resolve(dataDir, "forget-requests.jsonl"), {
    email: EMAIL,
    requested_at: "2026-11-18T12:00:00.000Z",
    source: "teste",
    note: null,
  });
  const dbPath = resolve(tmp("forget-13573-fresh-"), "clarice-users.db");
  quiet(() => buildDb(["--db", dbPath, "--data-dir", dataDir]));
  assertMinimal(row(dbPath, EMAIL), "store novo");
  const db = openClariceDb(dbPath);
  assert.deepEqual(listForgetRequests(db).map((r) => r.email), [EMAIL]);
  db.close();
});

test("#13573 ledger ilegível aborta o rebuild (seguir sem ele regravaria dado pessoal)", () => {
  const dataDir = fixtureDataDir();
  mkdirSync(resolve(dataDir, "forget-requests.jsonl")); // diretório no lugar do arquivo → leitura falha
  const dbPath = resolve(tmp("forget-13573-broken-"), "clarice-users.db");
  const exit = process.exit;
  let code: number | undefined;
  (process as { exit: (c?: number) => never }).exit = ((c?: number) => {
    code = c;
    throw new Error("exit");
  }) as never;
  try {
    assert.throws(() => quiet(() => buildDb(["--db", dbPath, "--data-dir", dataDir])), /exit/);
  } finally {
    process.exit = exit;
  }
  assert.equal(code, 1);
  assert.equal(row(dbPath, EMAIL), undefined, "nada do Stripe foi ingerido");
});

// ---------------------------------------------------------------------------
// Sync da Brevo, variante Gmail, opt-in
// ---------------------------------------------------------------------------

function brevoCols(email: string, over: Partial<BrevoColumns> = {}): BrevoColumns {
  return {
    email,
    email_blacklisted: 0,
    unsubscribed: 0,
    hard_bounced: 0,
    complained: 0,
    opens_count: 7,
    clicks_count: 3,
    sends_count: 10,
    soft_bounce_count: 0,
    last_open_at: "2026-11-01T00:00:00.000Z",
    last_click_at: "2026-11-01T00:00:00.000Z",
    last_sent_at: "2026-11-01T00:00:00.000Z",
    recency_quartil: "Q1",
    brevo_list_ids: "[1,2]",
    brevo_created_at: "2026-01-01T00:00:00.000Z",
    brevo_modified_at: "2026-11-02T00:00:00.000Z",
    ...over,
  } as BrevoColumns;
}

test("#13573 sync da Brevo: e-mail esquecido recebe só a supressão, nunca engajamento/listas", () => {
  const db = openClariceDb(":memory:");
  recordForgetRequest(db, { email: EMAIL, requestedAt: "2026-11-18T12:00:00.000Z" });
  const upsert = makeBrevoUpsert(db);
  upsert(brevoCols(EMAIL, { hard_bounced: 1 }));
  upsert(brevoCols("outra@uol.com.br"));
  const r = db.prepare("SELECT * FROM clarice_users WHERE email = ?").get(EMAIL) as Row;
  assert.equal(r.opens_count, 0);
  assert.equal(r.brevo_list_ids, null);
  assert.equal(r.last_open_at, null);
  assert.equal(r.unsubscribed, 1);
  assert.equal(r.email_blacklisted, 1, "liga a blacklist mesmo se a Brevo ainda não refletir");
  assert.equal(r.hard_bounced, 1, "supressão da Brevo continua sendo mesclada");
  assert.equal(r.send_eligible, 0);
  const o = db.prepare("SELECT opens_count FROM clarice_users WHERE email = 'outra@uol.com.br'").get() as Row;
  assert.equal(o.opens_count, 7, "os demais contatos seguem o upsert normal");
  db.close();
});

test("#13573 variante do mesmo Gmail e opt-in também saem; pedido sem linha cria linha mínima suprimida", () => {
  const db = openClariceDb(":memory:");
  db.prepare(
    "INSERT INTO clarice_users (email, name, stripe_ids, cohort, opens_count) VALUES ('maria.souza@gmail.com', 'Maria', '[\"cus_1\"]', 'assinantes-ativos', 4)",
  ).run();
  db.prepare("INSERT INTO priority_optin (email, added_at) VALUES ('maria.souza@gmail.com', '2026-11-01')").run();
  recordForgetRequest(db, { email: "MariaSouza+news@Gmail.com", requestedAt: "2026-11-18T12:00:00.000Z" });
  recordForgetRequest(db, { email: "sem.linha@uol.com.br", requestedAt: "2026-11-18T12:00:00.000Z" });
  assert.equal(makeForgetMatcher(db)("maria.souza@gmail.com"), true);
  const m = minimizeForgottenRows(db);
  assert.equal(m.optin_removed, 1);
  assert.equal(m.inserted, 1);
  recomputeDerived(db);
  const r = db.prepare("SELECT * FROM clarice_users WHERE email = 'maria.souza@gmail.com'").get() as Row;
  assertMinimal(r, "variante Gmail");
  const novo = db.prepare("SELECT * FROM clarice_users WHERE email = 'sem.linha@uol.com.br'").get() as Row;
  assertMinimal(novo, "pedido sem linha");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM priority_optin").get() as { n: number }).n, 0);
  // idempotente: rodar de novo não grava nada
  assert.deepEqual(minimizeForgottenRows(db), { minimized: 0, inserted: 0, optin_removed: 0 });
  db.close();
});

test("#13573 pedido repetido mantém a data original; e-mail inválido é recusado", () => {
  const db = openClariceDb(":memory:");
  assert.equal(recordForgetRequest(db, { email: EMAIL, requestedAt: "2026-11-18T12:00:00.000Z" }), true);
  assert.equal(recordForgetRequest(db, { email: EMAIL.toUpperCase(), requestedAt: "2026-12-01T00:00:00.000Z" }), false);
  assert.equal(listForgetRequests(db)[0].requested_at, "2026-11-18T12:00:00.000Z");
  assert.throws(() => recordForgetRequest(db, { email: "  ", requestedAt: "x" }));
  db.close();
});

test("#13573 ledger: append idempotente, import idempotente, linha inválida reportada", () => {
  const dir = tmp("forget-13573-ledger-");
  const path = resolve(dir, "sub", "forget-requests.jsonl");
  const req = { email: EMAIL, requested_at: "2026-11-18T12:00:00.000Z", source: "t", note: null };
  assert.equal(appendForgetLedger(path, req), true);
  assert.equal(appendForgetLedger(path, { ...req, email: EMAIL.toUpperCase() }), false);
  writeFileSync(path, readFileSync(path, "utf8") + "não é json\n");
  const read = readForgetLedger(path);
  assert.deepEqual(read.entries.map((e) => e.email), [EMAIL]);
  assert.deepEqual(read.invalid, [2]);
  const db = openClariceDb(":memory:");
  assert.equal(importForgetLedger(db, path).imported, 1);
  assert.equal(importForgetLedger(db, path).imported, 0);
  db.close();
  assert.deepEqual(readForgetLedger(resolve(dir, "nao-existe.jsonl")).entries, []);
});

// ---------------------------------------------------------------------------
// Brevo (IO fake — nada ao vivo)
// ---------------------------------------------------------------------------

test("#13573 Brevo: minimiza sem apagar — blacklist, sai das listas, zera texto, mantém não-texto", async () => {
  const { body, cleared, kept } = buildBrevoMinimizeBody({
    listIds: [3, 7],
    attributes: { NOME: "Maria", SOBRENOME: "Souza", VAZIO: "", TIER: 2, ATIVO: true },
  });
  assert.deepEqual(body, { emailBlacklisted: true, unlinkListIds: [3, 7], attributes: { NOME: "", SOBRENOME: "" } });
  assert.deepEqual(cleared, ["NOME", "SOBRENOME"]);
  assert.deepEqual(kept, ["ATIVO", "TIER"]);

  const puts: Array<[string, unknown]> = [];
  const min = brevoMinimizerFromIo({
    get: async () => ({ status: 200, body: { listIds: [3], attributes: { NOME: "Maria" } } }),
    put: async (p, b) => void puts.push([p, b]),
  });
  const r = await min("a+b@x.com");
  assert.equal(r.status, "ok");
  assert.equal(puts[0][0], "/contacts/a%2Bb%40x.com");
  assert.deepEqual((puts[0][1] as { unlinkListIds: number[] }).unlinkListIds, [3]);

  const missing = brevoMinimizerFromIo({ get: async () => ({ status: 404, body: {} }), put: async () => assert.fail("não deveria chamar PUT") });
  assert.deepEqual(await missing("x@x.com"), { status: "not_found" });
  const broken = brevoMinimizerFromIo({ get: async () => ({ status: 401, body: {} }), put: async () => ({}) });
  await assert.rejects(broken("x@x.com"), /401/);
});

// ---------------------------------------------------------------------------
// Triagem --apply com data_deletion (item 3)
// ---------------------------------------------------------------------------

function reply(body: string, from: string, i = 1): ReplyMessage {
  return {
    message_id: `m${i}-${from}`,
    thread_id: `t${i}`,
    from,
    subject: "Re: Notícias do mês sobre IA",
    date: `2026-11-18T10:0${i}:00.000Z`,
    body,
  };
}

test("#13573 triagem --apply: data_deletion entra na lista de esquecimento, minimiza store e Brevo; reaplicar retenta só a Brevo", async () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, name, stripe_ids, cohort, mv_bucket) VALUES (?, 'Maria', '[\"cus_1\"]', 'assinantes-ativos', 'verified')").run(EMAIL);
  recomputeDerived(db);
  const ledger = resolve(tmp("forget-13573-triage-"), "forget-requests.jsonl");
  const plan = buildTriagePlan([reply("Pela LGPD peço que excluam todos os meus dados.", EMAIL)]);
  assert.deepEqual(plan.actions.data_deletion, [EMAIL]);

  const logs: string[] = [];
  await applyTriagePlan(plan, {
    db,
    blacklist: async () => {},
    minimizeBrevo: async () => {
      throw new Error("Brevo 500");
    },
    forgetLedgerPath: ledger,
    log: (m) => logs.push(m),
  });
  assertMinimal(db.prepare("SELECT * FROM clarice_users WHERE email = ?").get(EMAIL) as Row, "após o apply");
  assert.deepEqual(plan.applied.forget_store_done, [EMAIL]);
  assert.deepEqual(plan.applied.failures.map((f) => [f.email, f.step]), [[EMAIL, "forget_brevo"]]);
  const req = listForgetRequests(db)[0];
  assert.equal(req.requested_at, "2026-11-18T10:01:00.000Z", "data do pedido = data da resposta");
  assert.match(req.source ?? "", /clarice-replies-triage:/);
  assert.deepEqual(readForgetLedger(ledger).entries.map((e) => e.email), [EMAIL]);
  assert.ok(logs.some((l) => l.includes("recomputando")), "#13574: fase cara anunciada");

  const calls: string[] = [];
  logs.length = 0;
  await applyTriagePlan(plan, {
    db,
    blacklist: async () => assert.fail("blacklist já feita"),
    minimizeBrevo: async (e) => {
      calls.push(e);
      return { status: "ok", lists_unlinked: [1], attributes_cleared: ["NOME"], attributes_kept: [] };
    },
    forgetLedgerPath: ledger,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(calls, [EMAIL]);
  assert.deepEqual(plan.applied.failures, []);
  assert.deepEqual(plan.applied.forget_brevo_done, [EMAIL]);
  assert.ok(!logs.some((l) => l.includes("recomputando")), "#13574: re-run sem escrita no store não recomputa a base");
  db.close();
});

test("#13573 triagem: sem cliente de minimização, o pedido vira falha visível (nunca some em silêncio)", async () => {
  const db = openClariceDb(":memory:");
  const plan = buildTriagePlan([reply("Peço que apaguem minhas informações.", EMAIL)]);
  await applyTriagePlan(plan, { db, blacklist: async () => {} });
  assert.deepEqual(plan.applied.failures.map((f) => f.step), ["forget_brevo"]);
  assert.equal(makeForgetMatcher(db)(EMAIL), true, "o store já registrou o pedido");
  db.close();
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("#13573 CLI add --no-brevo: registra, minimiza e grava o ledger ao lado do store; list mostra o pedido", async () => {
  const dir = tmp("forget-13573-cli-");
  const dbPath = resolve(dir, "clarice-users.db");
  const seed = openClariceDb(dbPath);
  seed.prepare("INSERT INTO clarice_users (email, name) VALUES (?, 'Maria')").run(EMAIL);
  seed.close();
  assert.equal(await quietAsync(() => forgetCli(["add", "--email", EMAIL, "--no-brevo", "--db", dbPath])), 0);
  assertMinimal(row(dbPath, EMAIL), "CLI");
  assert.ok(existsSync(resolve(dir, "forget-requests.jsonl")), "ledger ao lado do store");
  assert.equal(await quietAsync(() => forgetCli(["add", "--email", "sem-arroba", "--no-brevo", "--db", dbPath])), 1);
  let out = "";
  const log = console.log;
  console.log = (s: string) => void (out += s);
  try {
    assert.equal(await forgetCli(["list", "--db", dbPath]), 0);
  } finally {
    console.log = log;
  }
  assert.deepEqual((JSON.parse(out) as Array<{ email: string }>).map((r) => r.email), [EMAIL]);
  rmSync(dir, { recursive: true, force: true });
});

test("#13573 CLI add com Brevo: minimiza o endereço canônico do store", async () => {
  const dir = tmp("forget-13573-cli-brevo-");
  const dbPath = resolve(dir, "clarice-users.db");
  const seed = openClariceDb(dbPath);
  seed.prepare("INSERT INTO clarice_users (email, name) VALUES ('maria.souza@gmail.com', 'Maria')").run();
  seed.close();
  const calls: string[] = [];
  const code = await quietAsync(() =>
    forgetCli(["add", "--email", "mariasouza@gmail.com", "--db", dbPath], {
      brevoMinimize: async (e) => {
        calls.push(e);
        return { status: "ok", lists_unlinked: [], attributes_cleared: [], attributes_kept: [] };
      },
    }),
  );
  assert.equal(code, 0);
  assert.deepEqual(calls, ["maria.souza@gmail.com"]);
  assertMinimal(row(dbPath, "maria.souza@gmail.com"), "canônico");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #13574 — supressão imediata e recompute sem regravar a base inteira
// ---------------------------------------------------------------------------

test("#13574 markSuppressedNow já deixa a linha inelegível (apply interrompido antes do recompute não a deixa elegível)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, mv_bucket) VALUES ('c@uol.com.br', 'verified')").run();
  recomputeDerived(db);
  assert.equal((db.prepare("SELECT send_eligible FROM clarice_users").get() as Row).send_eligible, 1);
  markSuppressedNow(db, "c@uol.com.br");
  const r = db.prepare("SELECT send_eligible, ineligible_reason FROM clarice_users").get() as Row;
  assert.deepEqual([r.send_eligible, r.ineligible_reason], [0, "unsubscribed"]);
  db.close();
});

test("#13574 recomputeDerived sem mudança não regrava as linhas (só o carimbo do recompute)", () => {
  const db = openClariceDb(":memory:");
  const ins = db.prepare("INSERT INTO clarice_users (email, mv_bucket, opens_count, sends_count) VALUES (?, 'verified', 1, 2)");
  for (let i = 0; i < 50; i++) ins.run(`p${i}@uol.com.br`);
  assert.equal(recomputeDerived(db), 50);
  const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = changes();
  assert.equal(recomputeDerived(db), 50, "n segue contando as linhas recomputadas");
  assert.equal(changes() - before, 1, "só o upsert de derived_meta");
  // mudança real ainda é gravada
  db.prepare("UPDATE clarice_users SET unsubscribed = 1 WHERE email = 'p3@uol.com.br'").run();
  recomputeDerived(db);
  assert.equal((db.prepare("SELECT send_eligible FROM clarice_users WHERE email = 'p3@uol.com.br'").get() as Row).send_eligible, 0);
  db.close();
});
