/**
 * test/lint-contest-entries.test.ts (#954)
 *
 * Cobre o validador puro `lintContestEntries`. Lint roda em runtime sobre
 * `data/contest-entries.jsonl` — pega corruption introduzida por edição
 * manual antes de quebrar `sorteio-process.ts draw`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintContestEntries } from "../scripts/lint-contest-entries.ts";

const VALID = JSON.stringify({
  draw_month: "2026-05",
  number: 1,
  reader_email: "leitor@example.com",
  reader_name: "Leitor Teste",
  edition: "260415",
  error_type: "factual",
  detail: "exemplo",
  reply_thread_id: "thread-x",
  confirmed_at: "2026-04-15T10:00:00Z",
});

describe("lintContestEntries (#954)", () => {
  it("aceita arquivo vazio", () => {
    const r = lintContestEntries("");
    assert.equal(r.errors.length, 0);
    assert.equal(r.total_lines, 0);
  });

  it("aceita entry válida", () => {
    const r = lintContestEntries(VALID);
    assert.equal(r.errors.length, 0);
    assert.equal(r.valid_entries, 1);
  });

  it("rejeita JSON inválido", () => {
    const r = lintContestEntries("{not valid json");
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /JSON inválido/);
  });

  it("rejeita campos obrigatórios ausentes", () => {
    const r = lintContestEntries(JSON.stringify({ draw_month: "2026-05", number: 1 }));
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /campos ausentes/);
  });

  it("rejeita number duplicado dentro do mesmo draw_month", () => {
    const dup = [VALID, VALID].join("\n");
    const r = lintContestEntries(dup);
    assert.ok(r.errors.some((e) => /number duplicado/.test(e)));
  });

  it("aceita number igual em draw_months diferentes", () => {
    const e1 = VALID;
    const e2 = JSON.stringify({
      ...JSON.parse(VALID),
      draw_month: "2026-06",
      reply_thread_id: "thread-y",
    });
    const r = lintContestEntries([e1, e2].join("\n"));
    assert.equal(r.errors.length, 0);
    assert.equal(r.valid_entries, 2);
  });

  it("rejeita draw_month formato inválido", () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID), draw_month: "2026-5" });
    const r = lintContestEntries(bad);
    assert.ok(r.errors.some((e) => /draw_month inválido/.test(e)));
  });

  it("rejeita edition formato inválido", () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID), edition: "26-04-15" });
    const r = lintContestEntries(bad);
    assert.ok(r.errors.some((e) => /edition inválida/.test(e)));
  });

  it("rejeita number negativo ou zero", () => {
    const zero = JSON.stringify({ ...JSON.parse(VALID), number: 0 });
    const r1 = lintContestEntries(zero);
    assert.ok(r1.errors.some((e) => /number inválido/.test(e)));
    const neg = JSON.stringify({ ...JSON.parse(VALID), number: -5 });
    const r2 = lintContestEntries(neg);
    assert.ok(r2.errors.some((e) => /number inválido/.test(e)));
  });

  it("rejeita confirmed_at não-parseable", () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID), confirmed_at: "ontem" });
    const r = lintContestEntries(bad);
    assert.ok(r.errors.some((e) => /confirmed_at não-parseable/.test(e)));
  });

  it("rejeita reader_email malformado", () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID), reader_email: "no-at-sign" });
    const r = lintContestEntries(bad);
    assert.ok(r.errors.some((e) => /reader_email inválido/.test(e)));
  });

  it("warn (não erro) pra error_type desconhecido", () => {
    const odd = JSON.stringify({ ...JSON.parse(VALID), error_type: "humor_engagement" });
    const r = lintContestEntries(odd);
    assert.equal(r.errors.length, 0, "error_type unknown não bloqueia");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /error_type desconhecido/);
  });

  it("aceita todos error_types em KNOWN_ERROR_TYPES sem warn", async () => {
    const { KNOWN_ERROR_TYPES } = await import("../scripts/lib/contest-entries.ts");
    const types = [...KNOWN_ERROR_TYPES];
    assert.ok(types.length >= 5, "deve ter ao menos os 5 tipos canônicos");
    for (let i = 0; i < types.length; i++) {
      const e = JSON.stringify({
        ...JSON.parse(VALID),
        number: i + 100,
        error_type: types[i],
      });
      const r = lintContestEntries(e);
      assert.equal(r.warnings.length, 0, `error_type ${types[i]} não deve gerar warn`);
    }
  });

  it("ignora linhas vazias entre entries", () => {
    const e2 = JSON.stringify({ ...JSON.parse(VALID), number: 2, reply_thread_id: "t2" });
    const r = lintContestEntries(`${VALID}\n\n\n${e2}\n`);
    assert.equal(r.errors.length, 0);
    assert.equal(r.valid_entries, 2);
  });

  it("regression: o arquivo de produção atual está válido", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const path = resolve(process.cwd(), "data/contest-entries.jsonl");
    if (!existsSync(path)) {
      // Arquivo opcional — bootstrap acontece em produção, não em CI
      return;
    }
    const content = readFileSync(path, "utf8");
    const r = lintContestEntries(content);
    assert.deepEqual(r.errors, [], `data/contest-entries.jsonl tem erros: ${r.errors.join("; ")}`);
  });
});
