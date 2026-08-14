import { test } from "node:test";
import assert from "node:assert/strict";
import { auditCorruptedNames, type CorruptedNameAuditRow } from "../scripts/check-corrupted-names.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";

// auditCorruptedNames — pura, mesma detecção (hasCorruptedName) usada pelo
// warning por onda em clarice-build-segment.ts (#5214 item 1). Sem fixture
// SQLite: a função recebe as rows já lidas, a integração com o store real é
// coberta pelo teste end-to-end abaixo.

test("auditCorruptedNames: store sem nome corrompido → count 0, emails omitido por padrão", () => {
  const rows: CorruptedNameAuditRow[] = [
    { email: "a@x.com", name: "Ana Costa" },
    { email: "b@x.com", name: null },
  ];
  const result = auditCorruptedNames(rows, false);
  assert.deepEqual(result, { total: 2, count: 0 });
});

test("auditCorruptedNames: conta os corrompidos; --emails ausente → emails NUNCA aparece no resultado (PII)", () => {
  const rows: CorruptedNameAuditRow[] = [
    { email: "ok@x.com", name: "Ana Costa" },
    { email: "gonçalo@x.com", name: "Gon�alo Soares" },
    { email: "nicolas@x.com", name: "N�colas Canuto" },
  ];
  const result = auditCorruptedNames(rows, false);
  assert.equal(result.total, 3);
  assert.equal(result.count, 2);
  assert.equal("emails" in result, false, "sem --emails, o campo não deve existir no objeto (não só undefined)");
});

test("auditCorruptedNames: --emails=true inclui a lista completa dos afetados", () => {
  const rows: CorruptedNameAuditRow[] = [
    { email: "ok@x.com", name: "Ana Costa" },
    { email: "gonçalo@x.com", name: "Gon�alo Soares" },
  ];
  const result = auditCorruptedNames(rows, true);
  assert.equal(result.count, 1);
  assert.deepEqual(result.emails, ["gonçalo@x.com"]);
});

// Integração leve — confirma que a QUERY do script (`SELECT email, name FROM
// clarice_users`) bate com o schema real e que `auditCorruptedNames` sobre o
// resultado dá o mesmo veredito da query ad-hoc citada na issue #5214
// (`WHERE name LIKE '%�%'`).
test("REGRESSÃO (#5214): rows lidas do store real (:memory:) são auditadas corretamente", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, name) VALUES ('limpo@x.com', 'Ana Costa')").run();
  db.prepare("INSERT INTO clarice_users (email, name) VALUES ('corrompido@x.com', 'Gon�alo Soares')").run();
  db.prepare("INSERT INTO clarice_users (email, name) VALUES ('sem-nome@x.com', NULL)").run();
  recomputeDerived(db);

  const rows = db.prepare("SELECT email, name FROM clarice_users").all() as unknown as CorruptedNameAuditRow[];
  db.close();

  const result = auditCorruptedNames(rows, true);
  assert.equal(result.total, 3);
  assert.equal(result.count, 1);
  assert.deepEqual(result.emails, ["corrompido@x.com"]);
});
