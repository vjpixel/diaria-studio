import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { resolveOptinEmail, main } from "../scripts/clarice-optin.ts";

// ---------------------------------------------------------------------------
// resolveOptinEmail (#2861) — resolução Gmail-normalizada no ponto de entrada
// do optin. Réplica do incidente real 260702: 4 de 13 opt-ins responderam da
// variante sem-pontos do Gmail, o store tinha a forma com pontos (Stripe), o
// join exato deixou o boost +40 órfão.
// ---------------------------------------------------------------------------

test("#2861 resolveOptinEmail: variante sem-pontos com match único → resolve pro canônico do store, com notice", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, ?)").run(
    "filosofo.daniel@gmail.com",
    1,
  );
  const r = resolveOptinEmail(db, "filosofodaniel@gmail.com");
  assert.equal(r.email, "filosofo.daniel@gmail.com", "grava o email CANÔNICO do store, não o literal informado");
  assert.ok(r.notice, "emite notice mostrando a resolução");
  assert.equal(r.warning, undefined);
  db.close();
});

test("#2861 resolveOptinEmail: match exato não precisa de resolução (sem notice/warning)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run(
    "assinante@empresa.com.br",
  );
  const r = resolveOptinEmail(db, "assinante@empresa.com.br");
  assert.equal(r.email, "assinante@empresa.com.br");
  assert.equal(r.notice, undefined);
  assert.equal(r.warning, undefined);
  db.close();
});

test("#2861 resolveOptinEmail: sem match nenhum → grava o literal informado, com warning", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run(
    "outrapessoa@gmail.com",
  );
  const r = resolveOptinEmail(db, "ninguem.aqui@gmail.com");
  assert.equal(r.email, "ninguem.aqui@gmail.com", "sem match → literal informado (nunca inventa resolução)");
  assert.ok(r.warning, "emite warning de miss");
  assert.equal(r.notice, undefined);
  db.close();
});

test("#2861 resolveOptinEmail: match AMBÍGUO (2+ candidatos) → grava literal com warning listando os candidatos", () => {
  const db = openClariceDb(":memory:");
  // duas linhas distintas do store colidem na forma canônica "abc@gmail.com"
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run("a.bc@gmail.com");
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run("ab.c@gmail.com");
  const r = resolveOptinEmail(db, "a.b.c@gmail.com");
  assert.equal(r.email, "a.b.c@gmail.com", "ambíguo → grava o literal informado, nunca escolhe um candidato arbitrariamente");
  assert.ok(r.warning, "emite warning de ambiguidade");
  assert.match(r.warning as string, /a\.bc@gmail\.com/);
  assert.match(r.warning as string, /ab\.c@gmail\.com/);
  db.close();
});

test("#2861 resolveOptinEmail: domínio não-Gmail com pontos não normaliza → miss real, warning", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run(
    "filosofo.daniel@empresa.com.br",
  );
  const r = resolveOptinEmail(db, "filosofodaniel@empresa.com.br");
  assert.equal(r.email, "filosofodaniel@empresa.com.br");
  assert.ok(r.warning);
  db.close();
});

// ---------------------------------------------------------------------------
// Regressão #2920 (Bug 2) — conta de teste do editor NUNCA resolve o optin
// pra conta REAL via normalização Gmail. Cenário citado na issue: `clarice-
// optin add vjpixel+test2@gmail.com` gravaria o optin na conta REAL do
// editor — inconsistente com a premissa do #2895 de que vjpixel+test* é uma
// identidade distinta.
// ---------------------------------------------------------------------------

test("#2920 resolveOptinEmail: vjpixel+test2@gmail.com NÃO resolve pra vjpixel@gmail.com (conta real) — grava o literal, com warning", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email) VALUES (?)").run("vjpixel@gmail.com");
  const r = resolveOptinEmail(db, "vjpixel+test2@gmail.com");
  assert.equal(
    r.email,
    "vjpixel+test2@gmail.com",
    "NUNCA deve gravar vjpixel@gmail.com (a conta REAL) — test account é identidade distinta (#2895)",
  );
  assert.ok(r.warning, "emite warning de miss (não notice de resolução)");
  db.close();
});

test("#2920 main add: 'clarice-optin add vjpixel+test2@gmail.com' grava o priority_optin na conta de TESTE, nunca na conta real do editor", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "clarice-optin-test-2920-"));
  const dbPath = resolve(dir, "store.db");

  const seed = openClariceDb(dbPath);
  seed.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, ?)").run("vjpixel@gmail.com", 1);
  seed.close();

  main(["add", "vjpixel+test2@gmail.com", "--db", dbPath]);

  const check = openClariceDb(dbPath);
  const rows = check.prepare("SELECT email FROM priority_optin").all() as Array<{ email: string }>;
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].email,
    "vjpixel+test2@gmail.com",
    "priority_optin guarda a conta de TESTE literal, não a conta real (vjpixel@gmail.com) por normalização Gmail",
  );

  // A conta REAL do editor não deve ter recebido o boost +40 por acidente.
  const realContact = check
    .prepare("SELECT priority_points FROM clarice_users WHERE email = ?")
    .get("vjpixel@gmail.com") as { priority_points: number } | undefined;
  assert.equal(
    realContact?.priority_points ?? 0,
    0,
    "conta real não deve ganhar +40 de um optin destinado à conta de teste",
  );
  check.close();
});

// ---------------------------------------------------------------------------
// main("add", ...) end-to-end — confirma que a resolução realmente afeta o
// que é gravado em priority_optin (não só a função pura isolada).
// ---------------------------------------------------------------------------

test("#2861 main add: grava o email CANÔNICO em priority_optin quando há match único gmail-normalized", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "clarice-optin-test-"));
  const dbPath = resolve(dir, "store.db");

  const seed = openClariceDb(dbPath);
  seed.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, ?)").run(
    "filosofo.daniel@gmail.com",
    1,
  );
  seed.close();

  main(["add", "filosofodaniel@gmail.com", "--db", dbPath]);

  const check = openClariceDb(dbPath);
  const rows = check.prepare("SELECT email FROM priority_optin").all() as Array<{ email: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "filosofo.daniel@gmail.com", "priority_optin guarda o canônico, não a variante sem-pontos");

  const contact = check
    .prepare("SELECT priority_points FROM clarice_users WHERE email = ?")
    .get("filosofo.daniel@gmail.com") as { priority_points: number };
  assert.equal(contact.priority_points, 40, "recomputeDerived aplicou o boost +40 na linha certa (não órfão)");
  check.close();
});

test("#2861 main add: sem match nenhum → grava o literal informado em priority_optin", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "clarice-optin-test-"));
  const dbPath = resolve(dir, "store.db");

  const seed = openClariceDb(dbPath);
  seed.close();

  main(["add", "alguem@gmail.com", "--db", dbPath]);

  const check = openClariceDb(dbPath);
  const rows = check.prepare("SELECT email FROM priority_optin").all() as Array<{ email: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "alguem@gmail.com");
  check.close();
});

test("#2861 main add: match AMBÍGUO → grava o literal informado (não escolhe um candidato)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "clarice-optin-test-"));
  const dbPath = resolve(dir, "store.db");

  const seed = openClariceDb(dbPath);
  seed.prepare("INSERT INTO clarice_users (email) VALUES (?)").run("a.bc@gmail.com");
  seed.prepare("INSERT INTO clarice_users (email) VALUES (?)").run("ab.c@gmail.com");
  seed.close();

  main(["add", "a.b.c@gmail.com", "--db", dbPath]);

  const check = openClariceDb(dbPath);
  const rows = check.prepare("SELECT email FROM priority_optin").all() as Array<{ email: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "a.b.c@gmail.com", "ambíguo → grava o literal, deixa as 2 linhas do store intocadas");
  check.close();
});

// ---------------------------------------------------------------------------
// Regressão #2921 — `resolveOptinEmail` era aplicado só no `add`, não no
// `remove`. Réplica do incidente descrito na issue: `add` de uma variante
// Gmail resolve pro canônico do store e grava o canônico em `priority_optin`;
// um `remove` da MESMA variante (digitada do mesmo jeito) precisa resolver
// igual e deletar a linha canônica — não pode casar 0 linhas e deixar o
// boost +40 ativo silenciosamente.
// ---------------------------------------------------------------------------

test("#2921 main remove: remove de variante Gmail resolve pro canônico e efetivamente apaga o priority_optin", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "clarice-optin-test-2921-"));
  const dbPath = resolve(dir, "store.db");

  const seed = openClariceDb(dbPath);
  seed.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, ?)").run(
    "filosofo.daniel@gmail.com",
    1,
  );
  seed.close();

  // add da variante SEM pontos → resolve e grava o canônico COM pontos.
  main(["add", "filosofodaniel@gmail.com", "--db", dbPath]);

  let check = openClariceDb(dbPath);
  let rows = check.prepare("SELECT email FROM priority_optin").all() as Array<{ email: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "filosofo.daniel@gmail.com");
  let contact = check
    .prepare("SELECT priority_points FROM clarice_users WHERE email = ?")
    .get("filosofo.daniel@gmail.com") as { priority_points: number };
  assert.equal(contact.priority_points, 40, "boost aplicado após o add");
  check.close();

  // remove da MESMA variante SEM pontos (o editor digita do mesmo jeito) —
  // antes do fix, isto rodava DELETE ... WHERE email = 'filosofodaniel@gmail.com'
  // e casava 0 linhas (a linha real é 'filosofo.daniel@gmail.com'), deixando o
  // boost +40 órfão e ativo.
  main(["remove", "filosofodaniel@gmail.com", "--db", dbPath]);

  check = openClariceDb(dbPath);
  rows = check.prepare("SELECT email FROM priority_optin").all() as Array<{ email: string }>;
  assert.equal(rows.length, 0, "remove da variante deve apagar a linha canônica (não casar 0 linhas)");
  contact = check
    .prepare("SELECT priority_points FROM clarice_users WHERE email = ?")
    .get("filosofo.daniel@gmail.com") as { priority_points: number };
  assert.equal(contact.priority_points, 0, "boost +40 removido — recomputeDerived rodou após o delete real");
  check.close();
});

test("#2921 main remove: email já-canônico (sem variante) continua removendo normalmente", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "clarice-optin-test-2921b-"));
  const dbPath = resolve(dir, "store.db");

  const seed = openClariceDb(dbPath);
  seed.prepare("INSERT INTO clarice_users (email, tier) VALUES (?, ?)").run(
    "assinante@empresa.com.br",
    1,
  );
  seed.close();

  main(["add", "assinante@empresa.com.br", "--db", dbPath]);
  main(["remove", "assinante@empresa.com.br", "--db", dbPath]);

  const check = openClariceDb(dbPath);
  const rows = check.prepare("SELECT email FROM priority_optin").all() as Array<{ email: string }>;
  assert.equal(rows.length, 0, "match exato (sem normalização Gmail) continua removendo como antes");
  check.close();
});

test("#2921 main remove: email sem match no store (nunca foi adicionado) remove literal sem erro", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "clarice-optin-test-2921c-"));
  const dbPath = resolve(dir, "store.db");

  const seed = openClariceDb(dbPath);
  seed.close();

  // Nunca houve add — remove deve resolver (miss → literal) e reportar
  // "não estava" sem lançar exceção.
  main(["remove", "ninguem@gmail.com", "--db", dbPath]);

  const check = openClariceDb(dbPath);
  const rows = check.prepare("SELECT email FROM priority_optin").all() as Array<{ email: string }>;
  assert.equal(rows.length, 0);
  check.close();
});
