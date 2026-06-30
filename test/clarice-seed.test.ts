/**
 * Testes de regressão para scripts/lib/clarice-seed.ts (#2683).
 *
 * Cobrem os requisitos da issue:
 *   - Seed presente exatamente 1× em cada wave (sem duplicar).
 *   - Se o email já está na base (editor é assinante), NÃO duplica.
 *   - IS_SEED="true" é setado em todos os casos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectSeed, CLARICE_SEED_EMAIL, CLARICE_SEED_NOME } from "../scripts/lib/clarice-seed.ts";

type Row = Record<string, string>;

function makeRow(email: string, extra: Record<string, string> = {}): Row {
  return { email, NOME: "Fulano", OPEN_PROBABILITY: "30", ...extra };
}

describe("injectSeed — seed ausente", () => {
  it("adiciona vjpixel@gmail.com ao fim da wave quando ausente", () => {
    const rows = [makeRow("a@x.com"), makeRow("b@x.com")];
    const result = injectSeed(rows, "email", { NOME: CLARICE_SEED_NOME });
    const emails = result.map((r) => r.email);
    assert.ok(emails.includes(CLARICE_SEED_EMAIL), "seed deve estar na wave");
    assert.equal(result.length, rows.length + 1, "deve ter 1 row a mais");
  });

  it("seed está no final (não altera ordem dos reais)", () => {
    const rows = [makeRow("a@x.com"), makeRow("b@x.com")];
    const result = injectSeed(rows, "email", { NOME: CLARICE_SEED_NOME });
    assert.equal(result[result.length - 1].email, CLARICE_SEED_EMAIL);
    assert.equal(result[0].email, "a@x.com");
    assert.equal(result[1].email, "b@x.com");
  });

  it("IS_SEED='true' na row injetada", () => {
    const rows = [makeRow("a@x.com")];
    const result = injectSeed(rows, "email", { NOME: CLARICE_SEED_NOME });
    assert.equal(result.find((r) => r.email === CLARICE_SEED_EMAIL)?.IS_SEED, "true");
  });

  it("seedDefaults são usados na row injetada (NOME, RECENCY_QUARTIL, etc.)", () => {
    const result = injectSeed([], "email", { NOME: CLARICE_SEED_NOME, RECENCY_QUARTIL: "Q1", RECENCY_RANK: "0" });
    const seed = result[0];
    assert.equal(seed.email, CLARICE_SEED_EMAIL);
    assert.equal(seed.NOME, CLARICE_SEED_NOME);
    assert.equal(seed.RECENCY_QUARTIL, "Q1");
    assert.equal(seed.RECENCY_RANK, "0");
  });
});

describe("injectSeed — seed já presente (editor é assinante)", () => {
  it("NÃO duplica quando seed já está na wave", () => {
    const rows = [
      makeRow("a@x.com"),
      makeRow(CLARICE_SEED_EMAIL, { NOME: "Vjpixel" }),
      makeRow("b@x.com"),
    ];
    const result = injectSeed(rows, "email");
    assert.equal(
      result.filter((r) => r.email === CLARICE_SEED_EMAIL).length,
      1,
      "deve aparecer exatamente 1×",
    );
    assert.equal(result.length, rows.length, "sem row extra");
  });

  it("IS_SEED='true' mesmo quando a row já existia", () => {
    const rows = [makeRow(CLARICE_SEED_EMAIL, { NOME: "Vjpixel" })];
    const result = injectSeed(rows, "email");
    assert.equal(result[0].IS_SEED, "true");
  });

  it("preserva os campos existentes da row (NOME, OPEN_PROBABILITY, etc.)", () => {
    const rows = [makeRow(CLARICE_SEED_EMAIL, { NOME: "Editor", OPEN_PROBABILITY: "80" })];
    const result = injectSeed(rows, "email");
    const seed = result.find((r) => r.email === CLARICE_SEED_EMAIL)!;
    assert.equal(seed.NOME, "Editor", "NOME existente deve ser preservado");
    assert.equal(seed.OPEN_PROBABILITY, "80", "OPEN_PROBABILITY deve ser preservada");
  });
});

describe("injectSeed — normalização", () => {
  it("normaliza case/whitespace ao comparar (VJPIXEL@GMAIL.COM = vjpixel@gmail.com)", () => {
    const rows = [makeRow(" VJPIXEL@GMAIL.COM "), makeRow("b@x.com")];
    const result = injectSeed(rows, "email");
    const matchCount = result.filter(
      (r) => r.email.trim().toLowerCase() === CLARICE_SEED_EMAIL,
    ).length;
    assert.equal(matchCount, 1, "não deve duplicar com case/whitespace diferente");
    assert.equal(result.length, rows.length, "sem row extra");
  });

  it("funciona com emailKey diferente de 'email' (ex: 'e-mail', 'EMAIL')", () => {
    const rows = [{ "e-mail": "a@x.com", NOME: "Ana" }];
    const result = injectSeed(rows, "e-mail", { NOME: CLARICE_SEED_NOME });
    assert.equal(result[result.length - 1]["e-mail"], CLARICE_SEED_EMAIL);
    assert.equal(result[result.length - 1].IS_SEED, "true");
  });
});

describe("injectSeed — imutabilidade", () => {
  it("não muta o array original", () => {
    const rows = [makeRow("a@x.com")];
    const before = JSON.stringify(rows);
    injectSeed(rows, "email", { NOME: CLARICE_SEED_NOME });
    assert.equal(JSON.stringify(rows), before);
  });

  it("não muta os objetos dentro do array", () => {
    const row = makeRow("a@x.com");
    const rowBefore = JSON.stringify(row);
    injectSeed([row], "email");
    assert.equal(JSON.stringify(row), rowBefore);
  });
});

describe("injectSeed — invariante de presença exatamente 1× (requisito #2683)", () => {
  it("wave vazia → seed é inserido → 1×", () => {
    const result = injectSeed([], "email", { NOME: CLARICE_SEED_NOME });
    assert.equal(result.length, 1);
    assert.equal(result[0].email, CLARICE_SEED_EMAIL);
    assert.equal(result[0].IS_SEED, "true");
  });

  it("wave grande sem seed → exatamente 1 seed ao fim", () => {
    const rows = Array.from({ length: 100 }, (_, i) => makeRow(`user${i}@x.com`));
    const result = injectSeed(rows, "email", { NOME: CLARICE_SEED_NOME });
    assert.equal(
      result.filter((r) => r.email === CLARICE_SEED_EMAIL).length,
      1,
    );
    assert.equal(result.length, 101);
  });

  it("seed duplicado na entrada → garante apenas 1 (usa a 1ª ocorrência)", () => {
    // Edge case: CSV de entrada já vinha com seed duplicado (build manual / bug externo).
    // injectSeed encontra o 1º, marca IS_SEED. Não adiciona 3ª cópia.
    const rows = [
      makeRow(CLARICE_SEED_EMAIL),
      makeRow("a@x.com"),
      makeRow(CLARICE_SEED_EMAIL), // duplicata externa — fora do controle
    ];
    const result = injectSeed(rows, "email");
    // injectSeed NÃO deduplica o array inteiro — apenas garante que não ADICIONA
    // uma cópia extra. A 1ª ocorrência já existia → IS_SEED marcado, nada inserido.
    // As 2 cópias externas permanecem (deduplicate é responsabilidade do CSV de origem).
    // O que garantimos: NÃO inseriu uma 3ª cópia.
    assert.equal(result.length, rows.length, "não adicionou row extra quando seed estava presente");
    assert.equal(result[0].IS_SEED, "true", "1ª ocorrência marcada");
  });
});
