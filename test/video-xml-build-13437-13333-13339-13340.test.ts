/**
 * test/video-xml-build-13437-13333-13339-13340.test.ts — lote do XML da montagem:
 *
 * - #13333: fala que cita a tela leva o box também no vertical, abaixo da
 *   legenda (exceção à regra dos verticais sem tela, #13186).
 * - #13339/#13340: só instrumentação na comparação XML × final; os clipes
 *   removidos e as trocas de tomada ganham detalhe no registro e no agregado,
 *   sem mudar a classificação.
 * - #13437 (1ª fatia): `trechoInserido` vira marcador do XML no fim da fala.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CITA_TELA_RE, falaCitaTela, telaBoxLayout, telaBoxSvg } from "../scripts/lib/diaria/video-tela.ts";
import { parseAssStyle, subtitleBottomY, subtitleLayout } from "../scripts/lib/diaria/video-legenda-xml.ts";
import { buildXmeml, PREVIEW_SUBTITLE_STYLE, telaMarkersFor, type PlannedClip, type ResolvedItem, type SequencePlan, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";
import {
  aggregateRecords,
  compareSequence,
  detectPatterns,
  patternExamples,
  removalStats,
  renderReport,
  swapStats,
  takeSwapDirection,
  type EditionRecord,
  type FinalSpan,
} from "../scripts/lib/diaria/video-xml-vs-final.ts";
import { parseTempo, parseTrechoOrigem, readTrechosInseridos, ROTEIRO_FALAS_PATH, trechoInseridoLine, trechoInseridoMarkersXml } from "../scripts/lib/diaria/video-trecho-inserido.ts";
import { ROTEIRO_FALAS_FILE } from "../scripts/lib/diaria/roteiro-videos.ts";

const item = (start: number, end: number, text: string, fala?: string): ResolvedItem =>
  ({ interval: { start, end }, text, words: [], lastWordEnd: end, holdLimit: end, how: "explicit", ...(fala ? { fala } : {}) }) as ResolvedItem;
const clip = (srcIn: number, srcOut: number, seqStart: number): PlannedClip => ({
  block: "comentario",
  srcIn,
  srcOut,
  frameIn: Math.round(srcIn * 30),
  frameOut: Math.round(srcOut * 30),
  seqStart,
  seqEnd: seqStart + Math.round((srcOut - srcIn) * 30),
  scale: 115,
});

describe("#13333: fala que cita a tela leva o box também no vertical", () => {
  const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada horizontal_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] };
  const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["comentario"], scales: [115, 130] };
  const SPEC_GUIA: SequenceSpec = { ...SPEC_V, target: "instagram", name: "Diaria comentada_Vertical_V1-guia", corte: "guia" };
  const clips = [clip(10, 20, 0), clip(30, 38, 300)];
  // A fala da 261117: o endereço do Fato ou Fake, "aqui na tela".
  const telas = [
    { id: "G3", texto: "Para conferir, o endereço está aqui na tela.", tela: "diabetes.org.br/fake" },
    { id: "G4", texto: "O Hydrogen ficou com nota 51 no índice.", tela: "Hydrogen: 51" },
  ];
  const resolved = { comentario: [item(10, 20, "Pra conferir, o endereço tá aqui na tela.", "G3"), item(30, 38, "O Hydrogen ficou com nota 51.", "G4")] };

  it("falaCitaTela: 'aqui na tela', 'nesta tela'; 'telas' e 'a tela do celular' não", () => {
    assert.ok(falaCitaTela("O endereço está aqui na tela."));
    assert.ok(falaCitaTela("Nesta tela você vê o índice."));
    assert.ok(falaCitaTela("Está NA TELA agora"));
    assert.ok(!falaCitaTela("Duas telas lado a lado."));
    assert.ok(!falaCitaTela("A tela do celular quebrou."));
    assert.ok(CITA_TELA_RE.flags.includes("i"));
  });

  it("vertical (a da edição e o corte guia): só a fala que cita a tela vira marcador; horizontal: as duas", () => {
    assert.deepEqual(telaMarkersFor({ spec: SPEC_H, clips }, resolved, 30, telas).map((m) => m.id), ["G3", "G4"]);
    assert.deepEqual(telaMarkersFor({ spec: SPEC_V, clips }, resolved, 30, telas).map((m) => [m.id, m.in, m.out]), [["G3", 0, 300]]);
    assert.deepEqual(telaMarkersFor({ spec: SPEC_GUIA, clips }, resolved, 30, telas).map((m) => m.id), ["G3"]);
  });

  it("vertical: a citação gravada no item também vale, com o roteiro sem ela", () => {
    const semCitar = [{ id: "G3", texto: "Para conferir, veja o endereço.", tela: "diabetes.org.br/fake" }];
    assert.equal(telaMarkersFor({ spec: SPEC_V, clips }, resolved, 30, semCitar).length, 1);
    const nemGravado = { comentario: [item(10, 20, "Pra conferir, veja o endereço.", "G3")] };
    assert.equal(telaMarkersFor({ spec: SPEC_V, clips }, nemGravado, 30, semCitar).length, 0, "sem citar a tela, o vertical segue sem box (#13186)");
  });

  it("box no vertical: centrado na largura, abaixo da legenda, dentro do quadro", () => {
    const style = parseAssStyle(PREVIEW_SUBTITLE_STYLE);
    const bottom = subtitleBottomY(1080, 1920, style);
    const leg = subtitleLayout("uma legenda\nde duas linhas", 1080, 1920, style);
    assert.equal(bottom, Math.max(...leg.lines.map((l) => l.box.y + l.box.h)), "a base não depende do número de linhas");
    const { box } = telaBoxLayout("diabetes.org.br/fake", 1080, 1920, { topY: bottom });
    assert.ok(box.y >= bottom, `o box (${box.y}) começa abaixo da legenda (${bottom})`);
    assert.ok(box.y + box.h <= 1920);
    assert.ok(Math.abs(box.x + box.w / 2 - 540) <= 1, "centrado na largura");
    // Legenda muito embaixo: o box sobe para caber, nunca sai do quadro.
    const fundo = telaBoxLayout("a\nb\nc", 1080, 1920, { topY: 1900 }).box;
    assert.ok(fundo.y + fundo.h <= 1920);
    assert.match(telaBoxSvg("diabetes.org.br/fake", 1080, 1920, { topY: bottom }), /fill="#00A0A0"/);
  });

  it("box no horizontal: o mesmo de antes (terço da direita, centrado na altura)", () => {
    const { box } = telaBoxLayout("Hydrogen: 51", 1920, 1080);
    assert.ok(box.x > 1920 / 2);
    assert.ok(Math.abs(box.y + box.h / 2 - 540) <= 1);
  });
});

function spansOf(pieces: Array<[number, number]>): FinalSpan[] {
  let t = 0;
  return pieces.map(([a, b]) => {
    const s = { finalStart: t, finalEnd: t + (b - a), brutoStart: a, brutoEnd: b };
    t += b - a;
    return s;
  });
}
const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("#13339: clipe removido com mais detalhe (só instrumentação)", () => {
  const clips = [
    { index: 0, srcIn: 10, srcOut: 14, block: "resumo" },
    { index: 1, srcIn: 20, srcOut: 25, block: "comentario" },
    { index: 2, srcIn: 30, srcOut: 33, block: "comentario" },
    { index: 3, srcIn: 34, srcOut: 34.5, block: "titulo", filler: true as const },
  ];
  const words = [w("isso", 20, 20.5), w("muda", 20.5, 21), w("tudo", 21, 22), w("fim", 30, 31)];

  it("o removido grava duração, bloco, fala e a pausa da vinheta; a contagem não muda", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14]]), words, finalDurationS: 4 });
    assert.equal(r.summary.clipsRemoved, 3, "mesma contagem de antes");
    const c1 = r.clips[1];
    assert.equal(c1.status, "removed");
    assert.equal(c1.durationS, 5);
    assert.equal(c1.block, "comentario");
    assert.equal(c1.text, "isso muda tudo");
    assert.equal(r.clips[3].filler, true);
    assert.equal(r.clips[0].durationS, undefined, "o mantido não ganha os campos");
  });

  it("removalStats: segundos, % do XML, terços, trechos vizinhos e bloco; a pausa da vinheta fica à parte", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14]]), words, finalDurationS: 4 });
    const s = removalStats(r, 16);
    assert.ok(s);
    assert.equal(s.removedS, 8);
    assert.equal(s.removedPctOfXml, 50);
    assert.deepEqual(s.byThird, [1, 1, 0], "4 clipes: índices 1 e 2 caem no 1º e no 2º terço");
    assert.equal(s.runs, 1);
    assert.equal(s.longestRun, 2);
    assert.deepEqual(s.byBlock, { comentario: 2 });
    assert.equal(s.fillers, 1);
    assert.equal(removalStats(undefined, 10), null);
  });

  it("registro antigo (sem durationS/bloco) ainda dá segundos e posição", () => {
    const antigo = { clips: [{ index: 0, srcIn: 0, srcOut: 2, status: "removed" as const, headMs: null, tailMs: null, internalPauses: [], finalStart: null, touched: true }, { index: 1, srcIn: 3, srcOut: 4, status: "kept" as const, headMs: 0, tailMs: 0, internalPauses: [], finalStart: 0, touched: false }] };
    const s = removalStats(antigo, null);
    assert.equal(s?.removedS, 2);
    assert.equal(s?.removedPctOfXml, null);
    assert.deepEqual(s?.byBlock, {});
  });
});

describe("#13340: troca de tomada com o lado do bruto (só instrumentação)", () => {
  const clips = [
    { index: 0, srcIn: 10, srcOut: 14, block: "resumo" },
    { index: 1, srcIn: 20, srcOut: 25, block: "comentario" },
  ];
  const words = [
    w("ele", 20, 20.5), w("chega", 20.5, 21), w("a", 21, 21.2), w("igualar", 21.2, 22), w("o", 22, 22.2), w("gpt", 22.2, 23),
    w("ele", 40, 40.5), w("chega", 40.5, 41), w("a", 41, 41.2), w("igualar", 41.2, 42), w("o", 42, 42.2), w("gpt", 42.2, 43.5),
  ];

  it("a troca grava direção, distância, durações, falas e bloco; a contagem não muda", () => {
    const r = compareSequence({ clips, spans: spansOf([[10, 14], [40, 43.5]]), words, finalDurationS: 7.5 });
    assert.equal(r.summary.takeSwaps, 1);
    const t = r.takeSwaps[0];
    assert.equal(t.direction, "posterior");
    assert.equal(t.gapS, 15);
    assert.equal(t.xmlDurationS, 5);
    assert.equal(t.finalDurationS, 3.5);
    assert.equal(t.block, "comentario");
    assert.match(t.xmlText ?? "", /igualar o gpt/);
    assert.match(t.finalText ?? "", /igualar o gpt/);
  });

  it("takeSwapDirection: anterior quando o final usa a 1ª tomada; distância nunca negativa", () => {
    assert.deepEqual(takeSwapDirection({ start: 50, end: 52 }, { start: 30, end: 33 }), { direction: "anterior", gapS: 17 });
    assert.deepEqual(takeSwapDirection({ start: 50, end: 52 }, { start: 51, end: 53 }), { direction: "posterior", gapS: 0 });
  });

  it("swapStats deriva o lado também de registro antigo (só xml/final)", () => {
    const s = swapStats({ takeSwaps: [{ clip: 1, xml: { start: 703.08, end: 704.14 }, final: { start: 748.025, end: 748.28 }, similarity: 0.6 }, { clip: 29, xml: { start: 821.075, end: 822.76 }, final: { start: 572.49, end: 574.38 }, similarity: 0.7 }] });
    assert.equal(s?.later, 1);
    assert.equal(s?.earlier, 1);
    assert.equal(s?.meanGapS, 145.29, "(43,885 + 246,695) / 2");
  });
});

describe("#13339/#13340: agregado, relatório e exemplos; padrões intactos", () => {
  const rec = (edition: string): EditionRecord => {
    const clips = [
      { index: 0, srcIn: 10, srcOut: 14, block: "resumo" },
      { index: 1, srcIn: 20, srcOut: 25, block: "comentario" },
      { index: 2, srcIn: 30, srcOut: 33, block: "comentario" },
    ];
    const words = [w("ele", 30, 30.5), w("chega", 30.5, 31), w("lá", 31, 33), w("ele", 40, 40.5), w("chega", 40.5, 41), w("lá", 41, 43)];
    const { summary, ...detail } = compareSequence({ clips, spans: spansOf([[10, 14], [40, 43]]), words, finalDurationS: 7 });
    return { schema: 1, edition, method: "audio-envelope-align-v2", generatedAt: "t", sequences: [{ key: "youtube", target: "youtube", finalFile: "f", xmlVersion: null, xmlDurationS: 12, finalDurationS: 7, coverage: 1, summary, loudness: null, framing: null, captions: null, detail }], skipped: [] };
  };
  const records = [rec("261110"), rec("261111")];

  it("o agregado soma removidos e trocas; as regras de padrão continuam as mesmas", () => {
    const agg = aggregateRecords(records);
    assert.equal(agg.rows[0].removal?.removedS, 8);
    assert.equal(agg.rows[0].swaps?.later, 1);
    assert.equal(agg.totals.removal?.removedS, 16);
    assert.deepEqual(agg.totals.removal?.byBlock, { comentario: 4 });
    assert.equal(agg.totals.swaps?.later, 2);
    const ids = detectPatterns(agg).map((p) => p.id).sort();
    assert.deepEqual(ids, ["clipes-removidos", "tomada-trocada"]);
    const report = renderReport({ agg, patterns: [], skipped: [], generatedAt: "t" });
    assert.match(report, /Clipes removidos \(#13339\): 16\.0 s de fala/);
    assert.match(report, /Tomadas trocadas \(#13340\): 2 posterior\(es\), 0 anterior\(es\)/);
  });

  it("a evidência (e o hash que decide comentar de novo) não muda com o detalhe novo", () => {
    const agg = aggregateRecords(records);
    const semDetalhe = aggregateRecords(records.map((r) => ({ ...r, sequences: r.sequences.map(({ detail: _d, ...s }) => s) })));
    assert.deepEqual(detectPatterns(agg).map((p) => p.evidenceHash), detectPatterns(semDetalhe).map((p) => p.evidenceHash));
  });

  it("exemplos da issue trazem duração, bloco, fala e o lado da tomada", () => {
    const ex = patternExamples(records);
    assert.match(ex.get("clipes-removidos")?.[0] ?? "", /clipe 1 \(20–25 s\) fora do final \(5\.00 s, bloco comentario\)/);
    assert.match(ex.get("tomada-trocada")?.[0] ?? "", /\(tomada posterior, 7 s de distância, bloco comentario; XML "ele chega lá", final "ele chega lá"\)/);
  });
});

describe("#13437: trechoInserido vira marcador do XML (1ª fatia)", () => {
  it("parseTrechoOrigem lê o link do YouTube e o intervalo da convenção da doc", () => {
    assert.deepEqual(parseTrechoOrigem("Vídeo de 10/11, youtu.be/lyh6IZux4FE, 3:42 a 4:00"), { youtubeId: "lyh6IZux4FE", inicioS: 222, fimS: 240 });
    assert.deepEqual(parseTrechoOrigem("https://www.youtube.com/watch?v=lyh6IZux4FE 1:02:03-1:02:10"), { youtubeId: "lyh6IZux4FE", inicioS: 3723, fimS: 3730 });
    assert.deepEqual(parseTrechoOrigem("Vídeo de 10/11, 3:42 a 4:00"), { youtubeId: null, inicioS: 222, fimS: 240 });
    assert.deepEqual(parseTrechoOrigem("Vídeo de 10/11"), { youtubeId: null, inicioS: null, fimS: null });
    assert.deepEqual(parseTrechoOrigem("youtu.be/lyh6IZux4FE, 4:00 a 3:42"), { youtubeId: "lyh6IZux4FE", inicioS: null, fimS: null }, "intervalo invertido não vira tempo");
    assert.equal(parseTempo("3:75"), null);
  });

  it("o caminho do roteiro é o mesmo de roteiro-videos.ts (cópia para não fechar ciclo de import)", () => {
    assert.equal(ROTEIRO_FALAS_PATH, ROTEIRO_FALAS_FILE);
  });

  it("readTrechosInseridos lê o roteiro; fala só de vertical fica fora; campo vazio avisa", () => {
    const dir = mkdtempSync(join(tmpdir(), "trecho-13437-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "_internal", "roteiro-falas.json"),
      JSON.stringify({
        falas: [
          { id: "H5", texto: "Olha o que eu disse no dia 10.", videos: ["horizontal"], trechoInserido: { origem: "youtu.be/lyh6IZux4FE, 3:42 a 4:00", texto: "E ele pode chegar a perder o cargo." } },
          { id: "V2", texto: "Só no vertical.", videos: ["vertical1"], trechoInserido: { origem: "x", texto: "y" } },
          { id: "H6", texto: "Vazio.", videos: ["horizontal"], trechoInserido: { origem: "", texto: "y" } },
          { id: "H7", texto: "Sem trecho.", videos: ["horizontal"] },
        ],
      }),
    );
    const avisos: string[] = [];
    const ts = readTrechosInseridos(dir, (m) => void avisos.push(m));
    assert.deepEqual(ts.map((t) => t.id), ["H5"]);
    assert.equal(ts[0].trecho, "E ele pode chegar a perder o cargo.");
    assert.ok(avisos.some((a) => /fala H6: trechoInserido sem origem ou texto/.test(a)));
    assert.deepEqual(readTrechosInseridos(join(dir, "nada"), () => assert.fail("sem aviso")), []);
  });

  it("o marcador vai no fim da fala, no <sequence> do horizontal, com origem e texto escapados", () => {
    const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada horizontal_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] };
    const plan = { spec, clips: [clip(10, 20, 0)], durationFrames: 300, script: "", missingBlocks: [], dropped: [] } as unknown as SequencePlan;
    const fim = telaMarkersFor(plan, { comentario: [item(10, 20, "x", "H5")] }, 30, [{ id: "H5", texto: "Olha o que eu disse", tela: "origem" }]);
    const m = { id: "H5", origem: "youtu.be/lyh6IZux4FE, 3:42 a 4:00", trecho: "perder o <cargo>", at: fim[0].out, parsed: parseTrechoOrigem("youtu.be/lyh6IZux4FE, 3:42 a 4:00") };
    assert.equal(m.at, 300);
    assert.equal(trechoInseridoMarkersXml([m]), `<marker><name>trecho H5</name><comment>youtu.be/lyh6IZux4FE, 3:42 a 4:00: &quot;perder o &lt;cargo&gt;&quot;</comment><in>300</in><out>301</out></marker>\n`);
    const source = { path: "/b/bruto.mp4", fps: 30, durationS: 1000, width: 1920, height: 1080 } as Parameters<typeof buildXmeml>[1];
    const sem = buildXmeml([plan], source, { faceX: 0.5, eyeY: 0.5 });
    const com = buildXmeml([plan], source, { faceX: 0.5, eyeY: 0.5 }, { trechoMarkers: { youtube: [m] } });
    assert.match(com, /<marker><name>trecho H5<\/name>/);
    assert.equal(com.replace(/<marker><name>trecho H5<\/name>.*<\/marker>\n/, ""), sem, "sem marcador, o XML de antes");
    const line = trechoInseridoLine(m, 30);
    assert.equal(line.level, "premissa");
    assert.match(line.text, /em 10\.0 s .*youtu\.be\/lyh6IZux4FE, 222–240 s, soma 18\.0 s ao horizontal/);
    assert.equal(trechoInseridoLine({ ...m, parsed: parseTrechoOrigem("Vídeo de 10/11") }, 30).level, "aviso");
  });
});
