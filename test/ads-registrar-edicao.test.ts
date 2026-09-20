/**
 * test/ads-registrar-edicao.test.ts (#8241 item 4, #8531)
 *
 * `validateRegistrarEdicaoInput` — a CLI que grava linhas novas em
 * `edicoes.jsonl` no schema unificado nunca deixa passar uma linha sem
 * `ts`/`braco`/`tipo`/`efeito`/`origem` (critério de aceite #8241), nem uma
 * linha com `tipo` de texto livre fora do conjunto fechado de
 * `TIPO_TO_EFEITO` — nem com `--efeito` explícito (#8531: era esse
 * escape-hatch que produzia tipo de texto livre no arquivo).
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
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("conjunto fechado")));
  });

  it("#8531: recusa tipo não catalogado MESMO COM --efeito explícito — nenhum escape-hatch de texto livre", () => {
    const r = validateRegistrarEdicaoInput({ braco: "todos", tipo: "nunca-visto", origem: "editor", efeito: "mudanca", extra: {} }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("conjunto fechado") && e.includes("#8531")));
  });

  it("#8531: recusa --efeito que não bate com o efeito catalogado do tipo", () => {
    const r = validateRegistrarEdicaoInput(
      { braco: "todos", tipo: "pausa-total-anuncios", origem: "editor", efeito: "mudanca", extra: {} },
      NOW,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("não bate com o efeito catalogado")));
  });

  it("#8531: os 5 tipos de texto livre da issue estão catalogados com o efeito correto", () => {
    const casos: Array<[string, string]> = [
      ["teto-gasto-conta-meta", "registro"],
      ["tasks-locais-neo-realinhadas", "registro"],
      ["decisao-teto-orcamento", "registro"],
      ["decisao-teto-orcamento-executada", "mudanca"],
      ["achado-poluicao-ambiente-google-client-id", "registro"],
    ];
    for (const [tipo, efeitoEsperado] of casos) {
      const r = validateRegistrarEdicaoInput({ braco: "todos", tipo, origem: "editor", extra: {} }, NOW);
      assert.equal(r.ok, true, `tipo "${tipo}" deveria ser aceito`);
      if (r.ok) assert.equal(r.line.efeito, efeitoEsperado, `tipo "${tipo}" deveria derivar efeito "${efeitoEsperado}"`);
    }
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
