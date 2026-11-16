/**
 * test/video-xml-vs-final-13196-13197.test.ts
 *
 * Comparação recorrente XML gerado × vídeo publicado (#13196) e backfill com
 * os resultados da #11670 (#13197). Miolo puro em
 * scripts/lib/diaria/video-xml-vs-final.ts; o CLI faz só I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  aggregateRecords,
  alignWithReorder,
  compareSequence,
  detectPatterns,
  driveUnreachable,
  isDriveUnavailable,
  editionsToCompare,
  EMPTY_STATE,
  finalSpansFromRuns,
  jaccard,
  mergeEditionRecord,
  PATTERN_MARKER,
  patternIssueBody,
  pickFinalsPerSequence,
  renderReport,
  stableHash,
  XML_FINAL_SCHEMA,
  type EditionRecord,
  type FinalSpan,
  type SequenceRecord,
} from "../scripts/lib/diaria/video-xml-vs-final.ts";
import { BASELINE_11670 } from "../scripts/lib/diaria/video-xml-vs-final-baseline.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import { isReportKind } from "../scripts/studio-ui/studio-reports.ts";
import { alignEnvelopes } from "../scripts/lib/diaria/video-audio-align.ts";
import { compareEdition, reportPatterns, type Finder, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";

/** Final montado como a sequência de trechos do bruto, colados em ordem. */
function spansOf(pieces: Array<[number, number]>): FinalSpan[] {
  let t = 0;
  return pieces.map(([a, b]) => {
    const s = { finalStart: t, finalEnd: t + (b - a), brutoStart: a, brutoEnd: b };
    t += b - a;
    return s;
  });
}

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("#13196 finalSpansFromRuns: offset do alinhamento = bruto − final", () => {
  it("converte o run em tempo do bruto", () => {
    assert.deepEqual(finalSpansFromRuns([{ audioStart: 0, audioEnd: 4, offset: 10 }]), [{ finalStart: 0, finalEnd: 4, brutoStart: 10, brutoEnd: 14 }]);
  });
});

describe("#13196 compareSequence: classifica cada diferença", () => {
  const clips = [
    { index: 0, srcIn: 10, srcOut: 14 },
    { index: 1, srcIn: 20, srcOut: 25 },
    { index: 2, srcIn: 30, srcOut: 33 },
  ];

  it("final idêntico ao XML: nada mexido", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14], [20, 25], [30, 33]]), finalDurationS: 12 });
    assert.equal(r.summary.clipsRemoved, 0);
    assert.equal(r.summary.clipsTouched, 0);
    assert.equal(r.summary.headMeanMs, 0);
    assert.equal(r.summary.tailMeanMs, 0);
    assert.equal(r.finalUnpairedS, 0);
  });

  it("ponta da saída estendida e cabeça aparada, em ms e por lado", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14.3], [20.5, 25], [30, 33]]), finalDurationS: 11.8 });
    assert.equal(r.clips[0].tailMs, 300);
    assert.equal(r.clips[1].headMs, -500);
    assert.equal(r.summary.tailExtended, 1);
    assert.equal(r.summary.headTrimmed, 1);
    assert.equal(r.summary.clipsTouched, 2);
  });

  it("diferença abaixo da tolerância é ruído do alinhamento, não mudança", () => {
    const r = compareSequence({ clips, spans: spansOf([[10.05, 14], [20, 25.04], [30, 33]]), finalDurationS: 12 });
    assert.equal(r.summary.clipsTouched, 0);
  });

  it("clipe removido e pausa interna removida", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14], [20, 22], [22.6, 25]]), finalDurationS: 8.4 });
    assert.equal(r.clips[2].status, "removed");
    assert.equal(r.summary.clipsRemoved, 1);
    assert.deepEqual(r.clips[1].internalPauses, [{ start: 22, end: 22.6, ms: 600 }]);
    assert.equal(r.summary.internalPausesRemoved, 1);
  });

  it("palavra que o editor recolocou fora do corte do XML conta como recuperada (#13194)", () => {
    // O XML cortou "anticonvulsionante." (14,0–14,6 s); o final estende a saída até 14,7.
    const words = [w("o", 13.5, 13.8), w("anticonvulsionante.", 14.0, 14.6), w("depois", 20.1, 20.5)];
    const r = compareSequence({ clips, spans: spansOf([[10, 14.7], [20, 25], [30, 33]]), words, finalDurationS: 12.7 });
    assert.deepEqual(r.wordsRecovered.map((x) => x.text), ["anticonvulsionante."]);
    assert.equal(r.summary.wordsRecovered, 1);
    assert.equal(r.clips[0].tailMs, 700);
  });

  it("trecho acrescentado com a mesma fala de um clipe removido é tomada trocada", () => {
    const words = [
      w("ele", 30, 30.5), w("chega", 30.5, 31), w("a", 31, 31.2), w("igualar", 31.2, 32), w("o", 32, 32.2), w("gpt", 32.2, 33),
      w("ele", 40, 40.5), w("chega", 40.5, 41), w("a", 41, 41.2), w("igualar", 41.2, 42), w("o", 42, 42.2), w("gpt", 42.2, 43),
    ];
    const r = compareSequence({ clips, spans: spansOf([[10, 14], [20, 25], [40, 43]]), words, finalDurationS: 12 });
    assert.equal(r.clips[2].status, "removed");
    assert.equal(r.summary.takeSwaps, 1);
    assert.equal(r.takeSwaps[0].clip, 2);
    assert.equal(r.summary.added, 0, "a outra tomada não conta também como trecho acrescentado");
  });

  it("trecho acrescentado sem relação com clipe removido", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14], [50, 52], [20, 25], [30, 33]]), finalDurationS: 14 });
    assert.equal(r.summary.added, 1);
    assert.equal(r.added[0].brutoStart, 50);
  });

  it("ordem trocada no final conta inversões", () => {
    const r = compareSequence({ clips, spans: spansOf([[20, 25], [10, 14], [30, 33]]), finalDurationS: 12 });
    assert.equal(r.summary.orderInversions, 1);
  });

  it("final com vinheta/card sem par no bruto: segundos sem par", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14], [20, 25], [30, 33]]), finalDurationS: 14.5 });
    assert.equal(r.finalUnpairedS, 2.5);
  });

  it("dois clipes juntados pelo editor marcam a emenda e não inflam a ponta além do vizinho", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 25], [30, 33]]), finalDurationS: 18 });
    assert.equal(r.clips[0].joinedTail, true);
    assert.equal(r.clips[0].tailMs, 6000, "a ponta para no clipe seguinte do XML (20 s)");
    assert.equal(r.clips[1].joinedHead, true);
  });

  it("ponta emendada fica fora da média de ponta e conta à parte (self-review PR #13205)", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 25], [30, 33]]), finalDurationS: 18 });
    assert.equal(r.summary.joins, 1);
    assert.equal(r.summary.tailMeanMs, 0, "o vão de 6000 ms até o vizinho não é padding");
    assert.equal(r.summary.headMeanMs, 0);
    assert.equal(r.summary.tailExtended, 0);
  });

  it("fala da outra tomada não conta como palavra recuperada (self-review PR #13205)", () => {
    const words = [
      w("ele", 30, 30.5), w("chega", 30.5, 31), w("a", 31, 31.2), w("igualar", 31.2, 32), w("o", 32, 32.2), w("gpt", 32.2, 33),
      w("ele", 40, 40.5), w("chega", 40.5, 41), w("a", 41, 41.2), w("igualar", 41.2, 42), w("o", 42, 42.2), w("gpt", 42.2, 43),
      w("anticonvulsionante.", 14.0, 14.6),
    ];
    const r = compareSequence({ clips, spans: spansOf([[10, 14.7], [20, 25], [40, 43]]), words, finalDurationS: 12.7 });
    assert.equal(r.summary.takeSwaps, 1);
    assert.deepEqual(r.wordsRecovered.map((x) => x.text), ["anticonvulsionante."], "só a palavra da ponta estendida");
  });

  it("fala de trecho acrescentado não conta como palavra recuperada", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14], [50, 52], [20, 25], [30, 33]]), words: [w("extra", 50.5, 51)], finalDurationS: 14 });
    assert.equal(r.summary.added, 1);
    assert.equal(r.summary.wordsRecovered, 0);
  });
});

describe("#13196 jaccard e stableHash", () => {
  it("jaccard ignora acento e caixa", () => {
    assert.equal(jaccard("Inteligência Artificial", "inteligencia artificial"), 1);
    assert.equal(jaccard("", "x"), 0);
  });
  it("hash determinístico", () => {
    assert.equal(stableHash("abc"), stableHash("abc"));
    assert.notEqual(stableHash("abc"), stableHash("abd"));
  });
});

function auto(edition: string, sequences: Array<Partial<SequenceRecord> & { key: string }>): EditionRecord {
  return {
    schema: XML_FINAL_SCHEMA,
    edition,
    method: "audio-envelope-align-v1",
    generatedAt: "2026-11-16T00:00:00.000Z",
    sequences: sequences.map((s) => ({ target: null, finalFile: null, xmlVersion: null, xmlDurationS: null, finalDurationS: null, coverage: null, summary: {}, loudness: null, framing: null, captions: null, ...s })),
    skipped: [],
  };
}

describe("#13196 mergeEditionRecord", () => {
  it("sequência medida de novo substitui; as outras ficam; skipped resolvido sai", () => {
    const prev = { ...auto("261110", [{ key: "youtube", summary: { clips: 10 } }]), skipped: [{ key: "instagram", reason: "sem final" }] };
    const next = auto("261110", [{ key: "instagram", summary: { clips: 5 } }]);
    const m = mergeEditionRecord(prev, next);
    assert.deepEqual(m.sequences.map((s) => s.key), ["instagram", "youtube"]);
    assert.equal(m.skipped.length, 0);
  });

  it("o importado da #11670 nunca substitui uma medição automática", () => {
    const prev = auto("261103", [{ key: "youtube", summary: { clips: 30 } }]);
    const baseline = BASELINE_11670.find((b) => b.edition === "261103") as EditionRecord;
    const m = mergeEditionRecord(prev, baseline);
    const yt = m.sequences.find((s) => s.key === "youtube") as SequenceRecord;
    assert.equal(yt.summary.clips, 30);
    assert.equal(yt.method, "audio-envelope-align-v1");
    assert.equal(m.sequences.find((s) => s.key === "soberana")?.method, "11670-manual", "sequência só da #11670 entra");
  });
});

describe("#13197 baseline da #11670", () => {
  it("cobre 261028–261103 e mantém a 261029 YouTube como sem par", () => {
    assert.deepEqual(BASELINE_11670.map((b) => b.edition), ["261028", "261029", "261030", "261103"]);
    assert.ok(BASELINE_11670.every((b) => b.method === "11670-manual" && b.schema === XML_FINAL_SCHEMA));
    const s29 = BASELINE_11670.find((b) => b.edition === "261029") as EditionRecord;
    assert.equal(s29.skipped[0].key, "youtube");
  });

  it("os números batem com a tabela de durações da #11670", () => {
    const yt28 = BASELINE_11670[0].sequences.find((s) => s.key === "youtube") as SequenceRecord;
    assert.equal(yt28.xmlDurationS, 269.1);
    assert.equal(yt28.finalDurationS, 198.9);
    assert.equal(yt28.summary.clipsRemoved, 15);
  });

  it("agregado do baseline: campo não medido fica n/d, nunca zero", () => {
    const agg = aggregateRecords(BASELINE_11670);
    const row = agg.rows.find((r) => r.edition === "261029" && r.key === "instagram");
    assert.equal(row?.clips, null);
    assert.equal(row?.internalPausesRemoved, 13);
    assert.equal(agg.editions, 4);
  });

  it("os padrões do baseline batem com o que a #11670 achou (pausas internas em 3 edições, palavras recuperadas em 2)", () => {
    const ids = detectPatterns(aggregateRecords(BASELINE_11670), undefined, { requireAuto: false }).map((p) => p.id);
    assert.ok(ids.includes("pausa-interna-removida"));
    assert.ok(ids.includes("palavras-recuperadas"));
    // Só a 261028 tem a contagem de clipes na #11670 (a 261030 cita "2 clipes" sem o total): 1 edição medida, sem padrão.
    assert.equal(ids.includes("clipes-removidos"), false);
    assert.ok(ids.includes("tomada-trocada"));
  });
});

describe("#13196 detectPatterns e corpo de issue", () => {
  it("só o baseline da #11670 não abre issue: precisa de uma edição medida pela tarefa", () => {
    assert.deepEqual(detectPatterns(aggregateRecords(BASELINE_11670)), []);
    const withAuto = aggregateRecords([...BASELINE_11670, auto("261110", [{ key: "youtube", summary: { internalPausesRemoved: 5 } }])]);
    const p = detectPatterns(withAuto).find((x) => x.id === "pausa-interna-removida");
    assert.ok(p);
    assert.ok(p.editions.includes("261029") && p.editions.includes("261110"), "a evidência da #11670 entra junto");
  });

  it("padrão só sai com o mínimo de edições", () => {
    const one = aggregateRecords([auto("261110", [{ key: "youtube", summary: { clips: 10, tailMeanMs: 200 } }])]);
    assert.equal(detectPatterns(one).some((p) => p.id === "ponta-saida-estendida"), false);
    const three = aggregateRecords(["261110", "261111", "261112"].map((e) => auto(e, [{ key: "youtube", summary: { clips: 10, tailMeanMs: 200 } }])));
    const p = detectPatterns(three).find((x) => x.id === "ponta-saida-estendida");
    assert.ok(p);
    assert.deepEqual(p.editions, ["261110", "261111", "261112"]);
  });

  it("palavras recuperadas vai para a #13194, que já acompanha o padrão", () => {
    const agg = aggregateRecords(["261110", "261111"].map((e) => auto(e, [{ key: "youtube", summary: { wordsRecovered: 2 } }])));
    const p = detectPatterns(agg).find((x) => x.id === "palavras-recuperadas");
    assert.equal(p?.trackingIssue, 13194);
    assert.equal(p?.priority, "P1");
  });

  it("o corpo leva o marcador de dedup e a evidência", () => {
    const agg = aggregateRecords(["261110", "261111"].map((e) => auto(e, [{ key: "youtube", summary: { takeSwaps: 1 } }])));
    const p = detectPatterns(agg).find((x) => x.id === "tomada-trocada");
    assert.ok(p);
    const body = patternIssueBody(p);
    assert.ok(body.startsWith(PATTERN_MARKER("tomada-trocada")));
    assert.match(body, /\| 261111 \| youtube \| 1 troca\(s\) \|/);
  });

  it("hash da evidência muda quando a evidência muda (comentar de novo)", () => {
    const a = detectPatterns(aggregateRecords(["261110", "261111"].map((e) => auto(e, [{ key: "youtube", summary: { takeSwaps: 1 } }])))).find((x) => x.id === "tomada-trocada");
    const b = detectPatterns(aggregateRecords(["261110", "261111", "261112"].map((e) => auto(e, [{ key: "youtube", summary: { takeSwaps: 1 } }])))).find((x) => x.id === "tomada-trocada");
    assert.notEqual(a?.evidenceHash, b?.evidenceHash);
  });

  it("relatório cita palavras recuperadas e as puladas", () => {
    const agg = aggregateRecords(BASELINE_11670);
    const md = renderReport({ agg, patterns: detectPatterns(agg), skipped: [{ edition: "261029", key: "youtube", reason: "sem par" }], generatedAt: "x" });
    assert.match(md, /Palavras recuperadas pelo editor: 8 no total/);
    assert.match(md, /\| 261029 \| youtube \| sem par \|/);
  });
});

describe("#13196 escolha do final e das edições", () => {
  it("maior _V{n} por sequência; nome irreconhecível fica de fora", () => {
    const files = [
      { name: "Diaria comentada_Youtube_V1.mp4" },
      { name: "Diaria comentada_Youtube_V2.mp4" },
      { name: "Diaria comentada_Vertical_V1.mp4" },
      { name: "notas.txt" },
      { name: "outra coisa.mp4" },
    ];
    const key = (n: string) => (n.includes("Youtube") ? "youtube" : n.includes("Vertical") ? "outras-redes" : null);
    const ver = (n: string) => {
      const m = /_V(\d+)/.exec(n);
      return m ? Number(m[1]) : null;
    };
    const m = pickFinalsPerSequence(files, key, ver);
    assert.equal(m.get("youtube")?.name, "Diaria comentada_Youtube_V2.mp4");
    assert.equal(m.get("outras-redes")?.name, "Diaria comentada_Vertical_V1.mp4");
    assert.equal(m.size, 2);
  });

  it("janela: só edições com sequência ainda sem comparação, dentro dos dias", () => {
    const todo = editionsToCompare({
      withPlan: [
        { edition: "261020", sequences: ["youtube"] },
        { edition: "261110", sequences: ["youtube", "outras-redes"] },
        { edition: "261112", sequences: ["youtube"] },
        { edition: "261114", sequences: ["youtube"] },
      ],
      state: { ...EMPTY_STATE, done: { "261110": { at: "x", sequences: ["youtube"] }, "261112": { at: "x", sequences: ["youtube"] } } },
      today: "261116",
      days: 14,
    });
    assert.deepEqual(todo, ["261110", "261114"]);
  });
});

describe("#13196 método: o alinhamento por envelope acha os cortes do final no bruto", () => {
  it("bruto sintético com fala/pausa; final = 2 trechos com uma pausa tirada", () => {
    // Envelope a 100 Hz: "fala" com padrão pseudoaleatório, "pausa" em -80 dB.
    const hop = 0.01;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const bruto = new Float64Array(6000); // 60 s
    for (let i = 0; i < bruto.length; i++) bruto[i] = i % 400 < 300 ? -30 + 20 * rnd() : -80;
    const seg = (a: number, b: number) => bruto.slice(Math.round(a / hop), Math.round(b / hop));
    const parts = [seg(8, 20), seg(24, 40)];
    const final = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      final.set(p, o);
      o += p.length;
    }
    const al = alignEnvelopes(final, bruto, hop, { windowS: 10, windowHopS: 5, stepS: 0.05, subWinS: 1 });
    const spans = finalSpansFromRuns(al.runs);
    const r = compareSequence({ clips: [{ index: 0, srcIn: 8, srcOut: 40 }], spans, finalDurationS: final.length * hop });
    assert.ok(al.coverage > 0.9, `cobertura ${al.coverage}`);
    assert.equal(r.clips[0].status, "kept");
    // A emenda cai em silêncio dos dois lados (19–20 s e 23–24 s são pausa): qualquer posição entre elas explica o
    // final igual. O que conta é a pausa de ~4 s tirada perto dos 20 s.
    const gap = r.clips[0].internalPauses.find((p) => p.start >= 18.9 && p.start <= 20.3);
    assert.ok(gap && Math.abs(gap.ms - 4000) <= 300, JSON.stringify(r.clips[0].internalPauses));
  });

  it("trecho reordenado pelo editor: a 2ª passada global acha o par e a ordem trocada (self-review PR #13205)", () => {
    const hop = 0.01;
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const bruto = new Float64Array(6000);
    for (let i = 0; i < bruto.length; i++) bruto[i] = i % 400 < 300 ? -30 + 20 * rnd() : -80;
    const seg = (a: number, b: number) => bruto.slice(Math.round(a / hop), Math.round(b / hop));
    // XML: A = 8–20 s, B = 24–40 s. O editor pôs B antes de A.
    const parts = [seg(24, 40), seg(8, 20)];
    const final = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      final.set(p, o);
      o += p.length;
    }
    const opts = { windowS: 10, windowHopS: 5, stepS: 0.05, subWinS: 1 };
    const clipsAB = [{ index: 0, srcIn: 8, srcOut: 20 }, { index: 1, srcIn: 24, srcOut: 40 }];
    const mono = alignEnvelopes(final, bruto, hop, opts);
    const before = compareSequence({ clips: clipsAB, spans: finalSpansFromRuns(mono.runs), finalDurationS: final.length * hop });
    assert.equal(before.clips[0].status, "removed", "premissa: o alinhamento monótono perde o trecho que foi para trás");
    const al = alignWithReorder(final, bruto, hop, opts);
    assert.ok(al.coverage > 0.9, `cobertura ${al.coverage}`);
    assert.ok(al.reordered >= 1);
    const r = compareSequence({ clips: clipsAB, spans: finalSpansFromRuns(al.runs), finalDurationS: final.length * hop });
    assert.equal(r.summary.clipsRemoved, 0);
    assert.equal(r.summary.orderInversions, 1);
  });
});

describe("self-review PR #13205: Drive inacessível não é 'sem final exportado'", () => {
  const plan: PlanFileLite = {
    plans: [{ spec: { target: "youtube" }, clips: [], durationFrames: 0 } as unknown as PlanFileLite["plans"][number]],
    source: { fps: 30 },
  };
  const finderOf = (list: Finder["list"]): Finder => ({ mode: "api", list, workDir: () => "/nao-existe", brutoFile: async () => null });

  it("falha de consulta vira drive-indisponivel e alarma", async () => {
    const rec = await compareEdition("261110", finderOf(async () => {
      throw new Error("401 invalid_grant");
    }), { plan });
    assert.ok(rec);
    assert.equal(rec.skipped.length, 1);
    assert.match(rec.skipped[0].reason, /^drive-indisponivel: 401 invalid_grant/);
    assert.equal(isDriveUnavailable(rec), true);
    assert.equal(driveUnreachable([rec]), true);
  });

  it("pasta sem final segue 'sem final exportado' e não alarma", async () => {
    const rec = await compareEdition("261110", finderOf(async () => []), { plan });
    assert.ok(rec);
    assert.match(rec.skipped[0].reason, /^sem final exportado/);
    assert.equal(driveUnreachable([rec]), false);
  });

  it("uma edição alcançada basta para não alarmar a rodada", () => {
    const bad: EditionRecord = { schema: XML_FINAL_SCHEMA, edition: "261110", method: "audio-envelope-align-v1", generatedAt: "", sequences: [], skipped: [{ key: "k", reason: "drive-indisponivel: x" }] };
    const ok: EditionRecord = { ...bad, edition: "261111", skipped: [{ key: "k", reason: "sem final exportado em Final/" }] };
    assert.equal(driveUnreachable([bad, ok]), false);
    assert.equal(driveUnreachable([]), false);
  });
});

describe("self-review PR #13205: state.json gravado a cada padrão", () => {
  it("gh que falha no 2º padrão não perde o registro da issue do 1º", async () => {
    const mk = (id: string) => ({ id, title: `t ${id}`, priority: "P3" as const, editions: ["261110", "261111"], evidence: [], suggestion: "s", evidenceHash: `h-${id}` });
    const state = { lastRunAt: null, done: {}, patterns: {} } as { lastRunAt: null; done: Record<string, never>; patterns: Record<string, { issue: number; evidenceHash: string }> };
    const persisted: string[] = [];
    let creates = 0;
    const gh = (args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") return "[]";
      if (args[0] === "issue" && args[1] === "create") {
        creates++;
        if (creates === 2) throw new Error("gh saiu 1: rede");
        return "https://github.com/vjpixel/diaria-studio/issues/99001";
      }
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    await assert.rejects(reportPatterns([mk("a"), mk("b")], state, [], true, { gh, persist: (s) => persisted.push(JSON.stringify(s.patterns)) }), /rede/);
    assert.deepEqual(persisted, [JSON.stringify({ a: { issue: 99001, evidenceHash: "h-a" } })]);
  });
});

describe("#13196 registro da task e do relatório", () => {
  it("task diária habilitada após autorização do editor, rodando o run com --open-issues", () => {
    const t = getScheduledTaskByName("Diaria-Video-Xml-Vs-Final-Daily");
    assert.ok(t);
    assert.notEqual(t.enabled, false);
    assert.deepEqual(t.schedule, { kind: "daily", hour: 22, minute: 15 });
    assert.equal(t.steps[0].script, "scripts/video-xml-vs-final.ts");
    assert.deepEqual(t.steps[0].args, ["run", "--open-issues"]);
  });

  it("kind do relatório aceito pela superfície de Relatórios", () => {
    assert.equal(isReportKind("video-xml-final"), true);
  });

  it("o CLI nunca chama publicador nem escreve no Drive", () => {
    const src = readFileSync(new URL("../scripts/video-xml-vs-final.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /uploadToFolder|publish-|uploadAll/);
  });
});
