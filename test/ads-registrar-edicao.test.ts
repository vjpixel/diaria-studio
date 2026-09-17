/**
 * test/ads-registrar-edicao.test.ts (#8241 item 4)
 *
 * `validateRegistrarEdicaoInput` — a CLI que grava linhas novas em
 * `edicoes.jsonl` no schema unificado nunca deixa passar uma linha sem
 * `ts`/`braco`/`tipo`/`efeito`/`origem` (critério de aceite #8241).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRegistrarEdicaoInput } from "../scripts/ads-registrar-edicao.ts";

const NOW = "2026-09-18T00:00:00.000Z";

describe("#8241 item 4 — validateRegistrarEdicaoInput", () => {
  it("recusa sem braco", () => {
    const r = validateRegistrarEdicaoInput({ tipo: "edicao-em-voo", origem: "editor", extra: {} }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("braco")));
  });

  it("recusa sem tipo", () => {
    const r = validateRegistrarEdicaoInput({ braco: "todos", origem: "editor", extra: {} }, NOW);
    assert.equal(r.ok, false);
  });

  it("recusa sem origem", () => {
    const r = validateRegistrarEdicaoInput({ braco: "todos", tipo: "edicao-em-voo", extra: {} }, NOW);
    assert.equal(r.ok, false);
  });

  it("recusa origem inválida", () => {
    const r = validateRegistrarEdicaoInput({ braco: "todos", tipo: "edicao-em-voo", origem: "ninguem", extra: {} }, NOW);
    assert.equal(r.ok, false);
  });

  it("recusa tipo não catalogado sem --efeito explícito", () => {
    const r = validateRegistrarEdicaoInput({ braco: "todos", tipo: "nunca-visto", origem: "editor", extra: {} }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("efeito")));
  });

  it("aceita tipo não catalogado COM --efeito explícito", () => {
    const r = validateRegistrarEdicaoInput({ braco: "todos", tipo: "nunca-visto", origem: "editor", efeito: "mudanca", extra: {} }, NOW);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.line.efeito, "mudanca");
  });

  it("auto-deriva efeito de um tipo catalogado (pausa-total-anuncios -> pausa)", () => {
    const r = validateRegistrarEdicaoInput({ braco: "todos", tipo: "pausa-total-anuncios", origem: "editor", extra: {} }, NOW);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.line.efeito, "pausa");
  });

  it("sem --ts, usa o `nowIso` injetado", () => {
    const r = validateRegistrarEdicaoInput({ braco: "todos", tipo: "edicao-em-voo", origem: "editor", extra: {} }, NOW);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.line.ts, NOW);
  });

  it("campos extras livres entram na linha tal como vieram", () => {
    const r = validateRegistrarEdicaoInput(
      { braco: "todos", tipo: "edicao-em-voo", origem: "editor", extra: { motivo: "x", issue: "8241" } },
      NOW,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.line.motivo, "x");
      assert.equal(r.line.issue, "8241");
    }
  });

  it("linha completa e válida", () => {
    const r = validateRegistrarEdicaoInput(
      { ts: "2026-09-17T13:50:00-03:00", braco: "Meta Ads (teste 2608)", tipo: "edicao-em-voo", origem: "editor", extra: { motivo: "teste" } },
      NOW,
    );
    assert.deepEqual(r, {
      ok: true,
      line: {
        ts: "2026-09-17T13:50:00-03:00",
        braco: "Meta Ads (teste 2608)",
        tipo: "edicao-em-voo",
        efeito: "mudanca",
        origem: "editor",
        motivo: "teste",
      },
    });
  });
});
