/**
 * test/build-apoiador-allowlist-3940.test.ts (#3940, #3965)
 *
 * Teste de regressão do gate de VALOR (thisMonthPaidValue >= R$10) usado
 * pra construir a allowlist do artigo mensal. `computeApoiadorAllowlist` é
 * pura — recebe `ContactWithStatus[]` já resolvido (o mesmo shape que
 * `buildApoiosData` produz) e não faz I/O nenhum, então o teste não precisa
 * mockar `contacts.jsonl` real nem `checkBacker`/rede.
 *
 * Casos centrais exigidos pelo dispatch (#3940):
 *   - apoiador R$10+ → entra na allowlist (com TODOS os e-mails do contato).
 *   - R$5 ("amigo", abaixo do gate) → NÃO entra.
 *   - não-apoiador / "apoiou e parou" / "sem_dados" → NÃO entram.
 *   - dedup entre contatos com e-mail repetido.
 *
 * #3965 (follow-up): `findTransientFailureContacts` detecta contatos com
 * falha TRANSIENTE de `checkBacker` (status "sem_dados") — o guard que
 * `main()` usa pra recusar `--push` por padrão (ou prosseguir explicitamente
 * via `--allow-partial`) quando 1+ contato ficou sem resposta definitiva
 * nesta rodada, sem que isso vire o `data.error` de nível superior. Cenário
 * exato da issue: 1 contato com falha pontual, resto normal (inclusive
 * "não apoia" genuíno) — "sem_dados" nunca pode ser confundido com
 * "nao_apoia".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeApoiadorAllowlist, findTransientFailureContacts } from "../scripts/build-apoiador-allowlist.ts";
import type { ContactWithStatus } from "../scripts/studio-ui/studio-apoios.ts";

function contact(
  emails: string[],
  status: ContactWithStatus["status"],
): ContactWithStatus {
  return {
    id: emails[0],
    name: emails[0],
    emails,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status,
    openRate: null,
  };
}

describe("computeApoiadorAllowlist (#3940)", () => {
  it("apoiador R$10 exato → entra (gate é >=, não >)", () => {
    const contacts = [contact(["dez@x.com"], { label: "apoiando", monthlyValue: 10, matchedEmail: "dez@x.com" })];
    assert.deepEqual(computeApoiadorAllowlist(contacts), ["dez@x.com"]);
  });

  it("apoiador R$25+ (mantenedor/patrono) também entra", () => {
    const contacts = [
      contact(["mantenedor@x.com"], { label: "apoiando", monthlyValue: 25, matchedEmail: "mantenedor@x.com" }),
      contact(["patrono@x.com"], { label: "apoiando", monthlyValue: 100, matchedEmail: "patrono@x.com" }),
    ];
    assert.deepEqual(computeApoiadorAllowlist(contacts), ["mantenedor@x.com", "patrono@x.com"]);
  });

  it("R$5 (\"amigo\", abaixo do gate R$10) → NÃO entra", () => {
    const contacts = [contact(["amigo5@x.com"], { label: "apoiando", monthlyValue: 5, matchedEmail: "amigo5@x.com" })];
    assert.deepEqual(computeApoiadorAllowlist(contacts), []);
  });

  it("R$9,99 (abaixo de R$10) → NÃO entra", () => {
    const contacts = [contact(["quase@x.com"], { label: "apoiando", monthlyValue: 9.99, matchedEmail: "quase@x.com" })];
    assert.deepEqual(computeApoiadorAllowlist(contacts), []);
  });

  it("não-apoiador (nao_apoia) → NÃO entra", () => {
    const contacts = [contact(["naoapoia@x.com"], { label: "nao_apoia" })];
    assert.deepEqual(computeApoiadorAllowlist(contacts), []);
  });

  it("\"apoiou e parou\" (sem monthlyValue do mês corrente) → NÃO entra", () => {
    const contacts = [
      contact(["parou@x.com"], { label: "apoiou_e_parou", lastPaidMonth: "2026-05", matchedEmail: "parou@x.com" }),
    ];
    assert.deepEqual(computeApoiadorAllowlist(contacts), []);
  });

  it("\"sem_dados\" (falha de consulta) → NÃO entra — nunca assume apoio por omissão", () => {
    const contacts = [contact(["semdados@x.com"], { label: "sem_dados" })];
    assert.deepEqual(computeApoiadorAllowlist(contacts), []);
  });

  it("contato com múltiplos e-mails qualificado → TODOS os e-mails entram", () => {
    const contacts = [
      contact(["principal@x.com", "secundario@x.com"], {
        label: "apoiando",
        monthlyValue: 15,
        matchedEmail: "principal@x.com",
      }),
    ];
    assert.deepEqual(computeApoiadorAllowlist(contacts).sort(), ["principal@x.com", "secundario@x.com"]);
  });

  it("mistura de qualificados e não-qualificados → só os qualificados, ordenados", () => {
    const contacts = [
      contact(["zebra@x.com"], { label: "apoiando", monthlyValue: 50, matchedEmail: "zebra@x.com" }),
      contact(["amigo@x.com"], { label: "apoiando", monthlyValue: 5, matchedEmail: "amigo@x.com" }),
      contact(["abelha@x.com"], { label: "apoiando", monthlyValue: 10, matchedEmail: "abelha@x.com" }),
      contact(["naoapoia@x.com"], { label: "nao_apoia" }),
    ];
    assert.deepEqual(computeApoiadorAllowlist(contacts), ["abelha@x.com", "zebra@x.com"]);
  });

  it("lista vazia → []", () => {
    assert.deepEqual(computeApoiadorAllowlist([]), []);
  });

  it("monthlyValue undefined em status \"apoiando\" (defensivo, não deveria ocorrer) → NÃO entra", () => {
    const contacts = [contact(["semvalor@x.com"], { label: "apoiando", matchedEmail: "semvalor@x.com" })];
    assert.deepEqual(computeApoiadorAllowlist(contacts), []);
  });
});

describe("findTransientFailureContacts (#3965)", () => {
  it("cenário exato da issue: 1 contato com falha transiente entre vários normais → detecta só esse 1", () => {
    const contacts = [
      contact(["apoiador@x.com"], { label: "apoiando", monthlyValue: 25, matchedEmail: "apoiador@x.com" }),
      contact(["semdados@x.com"], { label: "sem_dados" }),
      contact(["naoapoia@x.com"], { label: "nao_apoia" }),
      contact(["parou@x.com"], { label: "apoiou_e_parou", lastPaidMonth: "2026-05", matchedEmail: "parou@x.com" }),
    ];
    const result = findTransientFailureContacts(contacts);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].emails, ["semdados@x.com"]);
  });

  it("nenhuma falha transiente → []", () => {
    const contacts = [
      contact(["apoiador@x.com"], { label: "apoiando", monthlyValue: 25, matchedEmail: "apoiador@x.com" }),
      contact(["naoapoia@x.com"], { label: "nao_apoia" }),
      contact(["parou@x.com"], { label: "apoiou_e_parou", lastPaidMonth: "2026-05", matchedEmail: "parou@x.com" }),
    ];
    assert.deepEqual(findTransientFailureContacts(contacts), []);
  });

  it("\"nao_apoia\" (resultado válido) NUNCA é tratado como falha transiente — não confundir os dois", () => {
    const contacts = [contact(["naoapoia@x.com"], { label: "nao_apoia" })];
    assert.deepEqual(findTransientFailureContacts(contacts), []);
  });

  it("\"apoiou_e_parou\" (resultado válido) NUNCA é tratado como falha transiente", () => {
    const contacts = [
      contact(["parou@x.com"], { label: "apoiou_e_parou", lastPaidMonth: "2026-05", matchedEmail: "parou@x.com" }),
    ];
    assert.deepEqual(findTransientFailureContacts(contacts), []);
  });

  it("múltiplos contatos com falha transiente → retorna todos", () => {
    const contacts = [
      contact(["a@x.com"], { label: "sem_dados" }),
      contact(["b@x.com"], { label: "sem_dados" }),
      contact(["c@x.com"], { label: "apoiando", monthlyValue: 10, matchedEmail: "c@x.com" }),
    ];
    const result = findTransientFailureContacts(contacts);
    assert.deepEqual(
      result.map((c) => c.emails[0]).sort(),
      ["a@x.com", "b@x.com"],
    );
  });

  it("lista vazia → []", () => {
    assert.deepEqual(findTransientFailureContacts([]), []);
  });
});
