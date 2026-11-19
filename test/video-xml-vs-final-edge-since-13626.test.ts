/**
 * #13626: a regra `cabeca-aparada` abriu issue somando a 261103 (-500 ms) e a
 * 261105 (-283 ms), XMLs de antes das margens do #13194, à 261118 (-180 ms),
 * a única edição pós-correção acima do limiar. As regras das pontas só contam
 * as edições a partir de `EDGE_MARGIN_SINCE_EDITION`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_MARGIN_SINCE_EDITION,
  PATTERN_RULES,
  XML_FINAL_SCHEMA,
  aggregateRecords,
  countsForRule,
  detectPatterns,
  patternExamples,
  type ClipComparison,
  type EditionRecord,
  type SequenceRecord,
} from "../scripts/lib/diaria/video-xml-vs-final.ts";

function rec(edition: string, key: string, headMeanMs: number, clips: Array<Partial<ClipComparison>> = []): EditionRecord {
  const seq: SequenceRecord = {
    key,
    target: key,
    finalFile: null,
    xmlVersion: null,
    xmlDurationS: null,
    finalDurationS: null,
    coverage: null,
    summary: { clips: 20, headMeanMs },
    loudness: null,
    framing: null,
    captions: null,
    method: "audio-envelope-align-v1",
    detail: {
      clips: clips.map((c, i) => ({ index: i, srcIn: 10 * i, srcOut: 10 * i + 2, status: "kept", headMs: 0, tailMs: 0, internalPauses: [], finalStart: i, touched: true, ...c })),
      wordsRecovered: [],
      takeSwaps: [],
    } as unknown as SequenceRecord["detail"],
  } as SequenceRecord;
  return { schema: XML_FINAL_SCHEMA, edition, method: "audio-envelope-align-v1", generatedAt: "2026-11-19T00:00:00.000Z", sequences: [seq], skipped: [] };
}

const rule = (id: string) => PATTERN_RULES.find((r) => r.id === id)!;

describe("#13626 regras das pontas só contam edições pós-#13194", () => {
  it("as três regras de margem levam o corte; as outras não", () => {
    for (const id of ["cabeca-aparada", "ponta-entrada-estendida", "ponta-saida-estendida"]) assert.equal(rule(id).sinceEdition, EDGE_MARGIN_SINCE_EDITION, id);
    for (const id of ["palavras-recuperadas", "pausa-interna-removida", "clipes-removidos", "tomada-trocada"]) assert.equal(rule(id).sinceEdition, undefined, id);
    assert.equal(EDGE_MARGIN_SINCE_EDITION, "261117");
  });

  it("countsForRule compara AAMMDD", () => {
    assert.equal(countsForRule({ sinceEdition: "261117" }, "261116"), false);
    assert.equal(countsForRule({ sinceEdition: "261117" }, "261117"), true);
    assert.equal(countsForRule({ sinceEdition: "261117" }, "270101"), true);
    assert.equal(countsForRule({}, "261028"), true);
  });

  it("cenário real da #13626: 261103 + 261105 + 261118 não abre mais issue", () => {
    const agg = aggregateRecords([rec("261103", "youtube", -500), rec("261105", "youtube", -283), rec("261118", "outras-redes", -180)]);
    assert.equal(detectPatterns(agg).some((p) => p.id === "cabeca-aparada"), false);
  });

  it("três edições pós-correção com a cabeça aparada abrem, só com elas na evidência", () => {
    const agg = aggregateRecords([rec("261105", "youtube", -283), rec("261118", "outras-redes", -180), rec("261120", "youtube", -200), rec("261121", "youtube", -160)]);
    const p = detectPatterns(agg).find((x) => x.id === "cabeca-aparada");
    assert.ok(p);
    assert.deepEqual(p.editions, ["261118", "261120", "261121"]);
    assert.equal(p.evidence.some((e) => e.edition === "261105"), false);
  });

  it("exemplos da regra com corte não vêm de edição anterior; os das outras regras seguem", () => {
    const ex = patternExamples([
      rec("261104", "youtube", -40, [{ headMs: -115, internalPauses: [{ start: 1, end: 1.5, ms: 500 }] }]),
      rec("261118", "outras-redes", -180, [{ headMs: -250 }]),
    ]);
    const heads = ex.get("cabeca-aparada") ?? [];
    assert.equal(heads.length, 1);
    assert.match(heads[0], /^261118 outras-redes: clipe 0 entrada 0 s, -250 ms$/);
    assert.equal((ex.get("pausa-interna-removida") ?? []).length, 1, "pausa interna não tem corte por edição");
  });
});
