/**
 * test/tsc-baseline.test.ts (#6217)
 *
 * Cobre a parte PURA da catraca (`scripts/lib/tsc-baseline.ts`) — parsing
 * da saída bruta do `tsc` (texto injetado, NUNCA o `tsc` real) e a
 * comparação atual × baseline. Zero rede, zero invocação real do `tsc`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseTscErrors,
  errorKeyString,
  computeErrorCounts,
  evaluateRatchet,
  serializeBaseline,
} from "../scripts/lib/tsc-baseline.ts";

describe("parseTscErrors (#6217)", () => {
  it("extrai file + code de cada linha de erro, ignora linha/coluna/mensagem", () => {
    const output = [
      "test/foo.test.ts(12,34): error TS2304: Cannot find name 'Foo'.",
      "test/bar.test.ts(1,1): error TS2339: Property 'x' does not exist on type 'Y'.",
    ].join("\n");
    const errors = parseTscErrors(output);
    assert.deepEqual(errors, [
      { file: "test/foo.test.ts", code: "TS2304" },
      { file: "test/bar.test.ts", code: "TS2339" },
    ]);
  });

  it("saída sem erros -> lista vazia", () => {
    assert.deepEqual(parseTscErrors(""), []);
    assert.deepEqual(parseTscErrors("Found 0 errors.\n"), []);
  });

  it("linhas que não são erro (headers, resumo) são ignoradas, nunca lança", () => {
    const output = [
      "",
      "Found 3 errors in 2 files.",
      "",
      "Errors  Files",
      "     2  test/foo.test.ts:12",
      "test/foo.test.ts(12,34): error TS2304: Cannot find name 'Foo'.",
    ].join("\n");
    const errors = parseTscErrors(output);
    assert.deepEqual(errors, [{ file: "test/foo.test.ts", code: "TS2304" }]);
  });

  it("mesma chave repetida (2 ocorrências do mesmo erro no mesmo arquivo) preserva as 2 entradas", () => {
    const output = [
      "workers/poll/src/vote.ts(268,104): error TS2304: Cannot find name 'ExecutionContext'.",
      "workers/poll/src/vote.ts(1102,8): error TS2304: Cannot find name 'ExecutionContext'.",
    ].join("\n");
    const errors = parseTscErrors(output);
    assert.equal(errors.length, 2);
  });

  it("chamadas repetidas nunca compartilham estado da regex global (lastIndex) — 2ª chamada não perde a 1ª linha", () => {
    const output = "a.ts(1,1): error TS2304: X.\nb.ts(2,2): error TS2339: Y.\n";
    const first = parseTscErrors(output);
    const second = parseTscErrors(output);
    assert.deepEqual(first, second);
    assert.equal(second.length, 2);
  });
});

describe("errorKeyString (#6217)", () => {
  it("formato {file}::{code}", () => {
    assert.equal(errorKeyString({ file: "test/foo.test.ts", code: "TS2304" }), "test/foo.test.ts::TS2304");
  });
});

describe("computeErrorCounts (#6217)", () => {
  it("conta ocorrências por chave", () => {
    const counts = computeErrorCounts([
      { file: "a.ts", code: "TS1" },
      { file: "a.ts", code: "TS1" },
      { file: "a.ts", code: "TS2" },
      { file: "b.ts", code: "TS1" },
    ]);
    assert.deepEqual(counts, { "a.ts::TS1": 2, "a.ts::TS2": 1, "b.ts::TS1": 1 });
  });

  it("lista vazia -> mapa vazio", () => {
    assert.deepEqual(computeErrorCounts([]), {});
  });
});

// ─── evaluateRatchet — os 3 requisitos centrais da issue (#6217) ──────────
// "erro presente no baseline → não falha; erro novo → falha; erro do
// baseline que sumiu → não falha (e idealmente sinaliza que o baseline
// pode ser baixado)".

describe("evaluateRatchet (#6217)", () => {
  it("erro presente no baseline (mesma contagem) -> ok, sem newKeys/increasedKeys", () => {
    const baseline = { "a.ts::TS1": 1 };
    const current = { "a.ts::TS1": 1 };
    const result = evaluateRatchet(current, baseline);
    assert.equal(result.ok, true);
    assert.deepEqual(result.newKeys, []);
    assert.deepEqual(result.increasedKeys, []);
  });

  it("erro NOVO (chave ausente da baseline) -> falha, aparece em newKeys", () => {
    const baseline = { "a.ts::TS1": 1 };
    const current = { "a.ts::TS1": 1, "b.ts::TS2": 1 };
    const result = evaluateRatchet(current, baseline);
    assert.equal(result.ok, false);
    assert.deepEqual(result.newKeys, ["b.ts::TS2"]);
  });

  it("chave conhecida com MAIS ocorrências que a baseline -> falha (increasedKeys), mesmo sem chave nova (furo da contagem pura)", () => {
    const baseline = { "a.ts::TS1": 1 };
    const current = { "a.ts::TS1": 2 };
    const result = evaluateRatchet(current, baseline);
    assert.equal(result.ok, false);
    assert.deepEqual(result.newKeys, []);
    assert.deepEqual(result.increasedKeys, [{ key: "a.ts::TS1", baselineCount: 1, currentCount: 2 }]);
  });

  it("erro do baseline que SUMIU (contagem atual 0/ausente) -> não falha, sinaliza em resolvedKeys", () => {
    const baseline = { "a.ts::TS1": 1, "b.ts::TS2": 1 };
    const current = { "a.ts::TS1": 1 };
    const result = evaluateRatchet(current, baseline);
    assert.equal(result.ok, true);
    assert.deepEqual(result.resolvedKeys, [{ key: "b.ts::TS2", baselineCount: 1 }]);
  });

  it("chave conhecida com MENOS ocorrências (mas > 0) -> não falha, sinaliza em decreasedKeys", () => {
    const baseline = { "a.ts::TS1": 3 };
    const current = { "a.ts::TS1": 1 };
    const result = evaluateRatchet(current, baseline);
    assert.equal(result.ok, true);
    assert.deepEqual(result.decreasedKeys, [{ key: "a.ts::TS1", baselineCount: 3, currentCount: 1 }]);
  });

  it("baseline vazia + erros atuais -> tudo newKeys, falha", () => {
    const result = evaluateRatchet({ "a.ts::TS1": 1 }, {});
    assert.equal(result.ok, false);
    assert.deepEqual(result.newKeys, ["a.ts::TS1"]);
  });

  it("ambos vazios -> ok, nenhuma lista populada", () => {
    const result = evaluateRatchet({}, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result, { ok: true, newKeys: [], increasedKeys: [], decreasedKeys: [], resolvedKeys: [] });
  });

  it("resultado é determinístico: chaves sempre ordenadas alfabeticamente", () => {
    const baseline = {};
    const current = { "z.ts::TS1": 1, "a.ts::TS1": 1, "m.ts::TS1": 1 };
    const result = evaluateRatchet(current, baseline);
    assert.deepEqual(result.newKeys, ["a.ts::TS1", "m.ts::TS1", "z.ts::TS1"]);
  });
});

describe("serializeBaseline (#6217)", () => {
  it("chaves ordenadas, 2-space indent, newline final", () => {
    const json = serializeBaseline({ "b.ts::TS1": 1, "a.ts::TS2": 2 });
    assert.equal(json, '{\n  "a.ts::TS2": 2,\n  "b.ts::TS1": 1\n}\n');
  });

  it("mapa vazio -> {} + newline", () => {
    assert.equal(serializeBaseline({}), "{}\n");
  });
});
