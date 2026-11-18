/**
 * test/video-xml-vs-final-retry-empty-13538.test.ts
 *
 * #13538: registro gravado sem sequências por falta temporária do áudio do
 * bruto (261111/261112 no 300) não pode virar definitivo — a rodada diária
 * seguinte tem de tentar de novo, e só sai da fila quando mede de verdade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_METHOD,
  XML_FINAL_SCHEMA,
  currentDoneSequences,
  editionsToCompare,
  markEditionDone,
  mergeEditionRecord,
  type EditionRecord,
  type RecurringState,
} from "../scripts/lib/diaria/video-xml-vs-final.ts";
import { methodLookup } from "../scripts/video-xml-vs-final.ts";

const AUDIO_MISSING = "áudio do bruto ausente (/hd/261111/work/audio.wav) e bruto.mp4 não achado";
const emptyRecord = (edition: string, keys: string[], generatedAt = "t0"): EditionRecord => ({
  schema: XML_FINAL_SCHEMA,
  edition,
  method: CURRENT_METHOD,
  generatedAt,
  sequences: [],
  skipped: keys.map((key) => ({ key, reason: AUDIO_MISSING })),
});
const seq = (key: string) => ({ key, method: CURRENT_METHOD, target: null, finalFile: null, xmlVersion: null, xmlDurationS: null, finalDurationS: null, coverage: null, summary: {}, loudness: null, framing: null, captions: null });
const noDone: RecurringState = { lastRunAt: null, patterns: {}, done: {} };

describe("#13538: registro vazio por áudio ausente é refeito na rodada seguinte", () => {
  const withPlan = [{ edition: "261111", sequences: ["outras-redes"] }, { edition: "261112", sequences: ["youtube"] }];

  it("registro sem sequências (nada em state.done) continua na fila enquanto está na janela", () => {
    const records = [emptyRecord("261111", ["outras-redes"]), emptyRecord("261112", ["youtube"])];
    const todo = editionsToCompare({ withPlan, state: noDone, today: "261118", days: 14, methodOf: methodLookup(records) });
    assert.deepEqual(todo, ["261111", "261112"]);
    assert.equal(currentDoneSequences(noDone, "261111", methodLookup(records)).size, 0);
  });

  it("falhar de novo pelo mesmo motivo não tira da fila nem conta como desistência", () => {
    const merged = mergeEditionRecord(emptyRecord("261111", ["outras-redes"]), emptyRecord("261111", ["outras-redes"], "t1"));
    assert.equal(merged.sequences.length, 0);
    assert.equal(merged.skipped.length, 1);
    const todo = editionsToCompare({ withPlan, state: noDone, today: "261118", days: 14, methodOf: methodLookup([merged]) });
    assert.ok(todo.includes("261111"));
  });

  it("medida a sequência (áudio voltou), a edição sai da fila e o pulo antigo some do registro", () => {
    const measured: EditionRecord = { ...emptyRecord("261111", [], "t2"), sequences: [seq("outras-redes")] };
    const merged = mergeEditionRecord(emptyRecord("261111", ["outras-redes"]), measured);
    assert.deepEqual(merged.sequences.map((s) => s.key), ["outras-redes"]);
    assert.deepEqual(merged.skipped, []);
    const state: RecurringState = { ...noDone, done: { "261111": { at: "t2", sequences: ["outras-redes"] } } };
    const todo = editionsToCompare({ withPlan, state, today: "261118", days: 14, methodOf: methodLookup([merged]) });
    assert.deepEqual(todo, ["261112"]);
  });

  it("fora da janela de 14 dias o registro vazio deixa de ser tentado", () => {
    const todo = editionsToCompare({ withPlan, state: noDone, today: "261201", days: 14 });
    assert.deepEqual(todo, []);
  });

  it("markEditionDone: registro vazio não marca done; medido marca só as sequências medidas", () => {
    const state: RecurringState = { lastRunAt: null, patterns: {}, done: {} };
    markEditionDone(state, emptyRecord("261111", ["outras-redes"]));
    assert.deepEqual(state.done, {});
    const mixed: EditionRecord = { ...emptyRecord("261112", ["outras-redes"]), sequences: [seq("youtube")] };
    markEditionDone(state, mixed, "t3");
    assert.deepEqual(state.done, { "261112": { at: "t3", sequences: ["youtube"] } });
    const todo = editionsToCompare({ withPlan: [{ edition: "261112", sequences: ["outras-redes", "youtube"] }], state, today: "261118", days: 14, methodOf: methodLookup([mixed]) });
    assert.deepEqual(todo, ["261112"], "edição mista segue na fila pela sequência pulada");
  });
});
