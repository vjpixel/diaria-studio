/**
 * test/apoio-overrides.test.ts (#8820)
 *
 * Testa `scripts/lib/apoio-overrides.ts` — override manual de nível de apoio
 * (`context/apoio-overrides.json`) consumido por `sync-apoio-nivel-beehiiv.ts`
 * e `sync-apoio-nivel-kit.ts`. Casos obrigatórios da issue:
 *
 *   (a) override adiciona nível pra quem NÃO está no apoia.se.
 *   (b) override sobrevive a um sync em que a pessoa some da base do
 *       apoia.se (relido do arquivo em toda execução, nunca depende de
 *       estado anterior).
 *
 * Mais: `loadApoioOverrides` fail-soft na ausência do arquivo, fail-loud em
 * conteúdo malformado; `applyApoioOverrides` nunca produz `level: null`
 * (garantia que sustenta "override não conta como remoção" nos guards de
 * `sync-apoio-nivel-beehiiv.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadApoioOverrides,
  applyApoioOverrides,
  type ApoioOverrideEntry,
  type DesiredLevelLike,
} from "../scripts/lib/apoio-overrides.ts";

function desiredEntry(overrides: Partial<DesiredLevelLike> = {}): DesiredLevelLike {
  return {
    contactId: "c1",
    contactName: "Fulano",
    emails: ["fulano@example.com"],
    level: "apoiador",
    unresolved: false,
    ...overrides,
  };
}

describe("loadApoioOverrides", () => {
  it("devolve [] quando o arquivo não existe (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "apoio-overrides-"));
    try {
      assert.deepEqual(loadApoioOverrides(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lê e normaliza (lowercase/trim) o email das entradas válidas", () => {
    const dir = mkdtempSync(join(tmpdir(), "apoio-overrides-"));
    try {
      mkdirSync(join(dir, "context"), { recursive: true });
      writeFileSync(
        join(dir, "context/apoio-overrides.json"),
        JSON.stringify([
          { email: "  Bruna@Example.com ", nivel: "patrono", motivo: "fixado manualmente", desde: "2026-09-25" },
        ]),
      );
      const result = loadApoioOverrides(dir);
      assert.equal(result.length, 1);
      assert.equal(result[0].email, "bruna@example.com");
      assert.equal(result[0].nivel, "patrono");
      assert.equal(result[0].motivo, "fixado manualmente");
      assert.equal(result[0].desde, "2026-09-25");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lança (fail-loud) em JSON malformado", () => {
    const dir = mkdtempSync(join(tmpdir(), "apoio-overrides-"));
    try {
      mkdirSync(join(dir, "context"), { recursive: true });
      writeFileSync(join(dir, "context/apoio-overrides.json"), "{ not valid json");
      assert.throws(() => loadApoioOverrides(dir), /malformado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lança se o conteúdo não é um array", () => {
    const dir = mkdtempSync(join(tmpdir(), "apoio-overrides-"));
    try {
      mkdirSync(join(dir, "context"), { recursive: true });
      writeFileSync(join(dir, "context/apoio-overrides.json"), JSON.stringify({ email: "x@y.com" }));
      assert.throws(() => loadApoioOverrides(dir), /deve ser um array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lança se uma entrada tem nivel inválido ou email vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "apoio-overrides-"));
    try {
      mkdirSync(join(dir, "context"), { recursive: true });
      writeFileSync(
        join(dir, "context/apoio-overrides.json"),
        JSON.stringify([{ email: "x@y.com", nivel: "vip", motivo: "", desde: "" }]),
      );
      assert.throws(() => loadApoioOverrides(dir), /nivel válido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyApoioOverrides", () => {
  it("sem overrides, devolve uma cópia do array desejado inalterada", () => {
    const desired = [desiredEntry()];
    const result = applyApoioOverrides(desired, []);
    assert.deepEqual(result, desired);
    assert.notEqual(result, desired); // cópia, não a mesma referência
  });

  it("(a) adiciona nível pra quem NÃO está no apoia.se (sem entrada correspondente em desired)", () => {
    const desired: DesiredLevelLike[] = []; // Bruna não existe no apoia.se
    const overrides: ApoioOverrideEntry[] = [
      { email: "bruna@example.com", nivel: "patrono", motivo: "Bruna Quevedo — fixado manualmente (#8820)", desde: "2026-09-25" },
    ];
    const result = applyApoioOverrides(desired, overrides);
    assert.equal(result.length, 1);
    assert.equal(result[0].contactId, "override:bruna@example.com");
    assert.equal(result[0].level, "patrono");
    assert.equal(result[0].unresolved, false);
    assert.deepEqual(result[0].emails, ["bruna@example.com"]);
    assert.equal(result[0].contactName, "Bruna Quevedo — fixado manualmente (#8820)");
  });

  it("(b) override sobrevive quando a pessoa some da base do apoia.se (mesma simulação: desired vazio a cada rodada)", () => {
    // Rodada 1: pessoa ainda aparece na base do apoia.se com nível "amigo".
    const desiredRound1 = [desiredEntry({ contactId: "c-apoiase", level: "amigo", emails: ["bruna@example.com"] })];
    const overrides: ApoioOverrideEntry[] = [
      { email: "bruna@example.com", nivel: "patrono", motivo: "fixado", desde: "2026-09-01" },
    ];
    const resultRound1 = applyApoioOverrides(desiredRound1, overrides);
    assert.equal(resultRound1.length, 1);
    assert.equal(resultRound1[0].level, "patrono"); // override venceu o apoia.se

    // Rodada 2: a pessoa SOME da base do apoia.se (desired não a contém mais) —
    // override é relido do arquivo (mesmo array `overrides`, sem estado
    // persistido de rodada anterior) e continua se aplicando.
    const desiredRound2: DesiredLevelLike[] = [];
    const resultRound2 = applyApoioOverrides(desiredRound2, overrides);
    assert.equal(resultRound2.length, 1);
    assert.equal(resultRound2[0].level, "patrono");
    assert.equal(resultRound2[0].contactId, "override:bruna@example.com");
  });

  it("override substitui o nível calculado quando casa por email com um contato existente", () => {
    const desired = [desiredEntry({ level: "amigo", unresolved: false })];
    const overrides: ApoioOverrideEntry[] = [
      { email: "fulano@example.com", nivel: "patrono", motivo: "fixado", desde: "2026-09-25" },
    ];
    const result = applyApoioOverrides(desired, overrides);
    assert.equal(result.length, 1);
    assert.equal(result[0].contactId, "c1"); // contato original preservado, não sintético
    assert.equal(result[0].level, "patrono");
  });

  it("override resolve um contato 'sem_dados' (unresolved: true vira false)", () => {
    const desired = [desiredEntry({ level: null, unresolved: true })];
    const overrides: ApoioOverrideEntry[] = [
      { email: "fulano@example.com", nivel: "mantenedor", motivo: "fixado", desde: "2026-09-25" },
    ];
    const result = applyApoioOverrides(desired, overrides);
    assert.equal(result[0].level, "mantenedor");
    assert.equal(result[0].unresolved, false);
  });

  it("nunca produz level: null — nenhuma entrada de override é candidata a remoção (guard de blast radius)", () => {
    const desired = [desiredEntry({ level: "patrono" })]; // apoia.se calcula um nível alto
    const overrides: ApoioOverrideEntry[] = [
      { email: "fulano@example.com", nivel: "amigo", motivo: "rebaixado manualmente", desde: "2026-09-25" },
    ];
    const result = applyApoioOverrides(desired, overrides);
    // Rebaixa (patrono → amigo), mas segue com um nível concreto — nunca null.
    assert.equal(result[0].level, "amigo");
    assert.notEqual(result[0].level, null);
  });

  it("contato que já bate com o override (mesmo nível, resolved) é preservado por referência (idempotência)", () => {
    const entry = desiredEntry({ level: "patrono", unresolved: false });
    const desired = [entry];
    const overrides: ApoioOverrideEntry[] = [{ email: "fulano@example.com", nivel: "patrono", motivo: "", desde: "" }];
    const result = applyApoioOverrides(desired, overrides);
    assert.equal(result[0], entry); // mesma referência — nenhuma mutação desnecessária
  });

  it("múltiplos overrides não-casados geram uma entrada sintética cada, sem colidir", () => {
    const overrides: ApoioOverrideEntry[] = [
      { email: "a@example.com", nivel: "amigo", motivo: "", desde: "" },
      { email: "b@example.com", nivel: "patrono", motivo: "", desde: "" },
    ];
    const result = applyApoioOverrides([] as DesiredLevelLike[], overrides);
    assert.equal(result.length, 2);
    const byEmail = new Map(result.map((r) => [r.emails[0], r.level]));
    assert.equal(byEmail.get("a@example.com"), "amigo");
    assert.equal(byEmail.get("b@example.com"), "patrono");
  });
});
