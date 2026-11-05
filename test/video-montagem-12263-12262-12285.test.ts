/**
 * Lote video-montagem (#12263, #12262, #12285):
 *  - #12263: o XML voltava a cortar o começo de palavras. (1) A passada B do
 *    refino (#11500) tirava como "som fora do roteiro" a sílaba da própria
 *    palavra na entrada ("O" de "O juiz", "vi-" de "violação", "E" de "e que
 *    quem", 261105); (2) o detector de fala (#12089) começava a ilha depois do
 *    ataque suave, abaixo dos limiares fixos; (3) faltava a checagem que achou
 *    os casos à mão (energia nos 40 ms antes da entrada).
 *  - #12262: a faixa tratada zerava as pausas (gate de -40 dB, 10/150 ms) e
 *    reduzia pouco o ruído.
 *  - #12285: rebuild sem mudança no XML trocava a legenda do export
 *    (`--from-final`) pela da montagem, porque o `builtAt` avança em todo build.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPEECH_DETECT,
  edgeExtras,
  entryCutSoundWarnings,
  extendIslandAttacks,
  speechIslands,
  speechNoiseFloors,
  type Envelope,
  type FrameEnergy,
} from "../scripts/lib/diaria/video-cut-refine.ts";
import { AUDIO_CLEAN, AUDIO_CLEAN_MAX_PAUSE_DROP_DB, audioCleanFilter, audioCleanParams, makeMatcher, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { applyYoutubeSrtCopy, mergeBuildPlan, sequenceXmlVersion, xmlVersionAt, youtubeSrtCopyDecision } from "../scripts/video-montagem.ts";

const w = (start: number, end: number, text: string): Word => ({ start, end, text });

/** Envelope sintético (hop 10 ms): `loud` dB nos trechos dados, `quiet` no resto. */
function env(durationS: number, speech: Array<[number, number]>, loud = -14, quiet = -66): Envelope {
  const hopS = 0.01;
  const n = Math.round(durationS / hopS);
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * hopS;
    db[i] = speech.some(([a, b]) => t >= a && t < b) ? loud : quiet;
  }
  return { hopS, db };
}

describe("#12263 (1): a passada B não tira, na entrada, sílaba colada na 1ª palavra", () => {
  const match = makeMatcher();
  const TH = -34;

  it('"O juiz" (261105, 608,84 → 609,04 s): sem silêncio entre o "O" e "juiz", a entrada fica', () => {
    const e = env(620, [[608.8, 615]]);
    const reference = [w(608.86, 609.4, "juiz"), w(609.4, 609.9, "decidiu"), w(609.9, 610.3, "que")];
    const heard = [w(608.84, 609.0, "O"), w(609.04, 609.4, "juiz"), w(609.4, 609.9, "decidiu"), w(609.9, 610.3, "que")];
    const d = edgeExtras({ edge: "in", clip: { srcIn: 608.84, srcOut: 615, script: "juiz decidiu que" }, heard, reference, env: e, thresholdDb: TH, match });
    assert.equal(d.to, undefined, `a entrada não pode avançar para dentro da fala (to ${d.to})`);
    assert.match(d.note ?? "", /colado na 1ª palavra.*#12263/);
  });

  it('"violação" (610,66 → 611,06 s): o "vi-" ouvido solto é o começo da palavra e fica', () => {
    const e = env(620, [[610.6, 615]]);
    const reference = [w(610.7, 611.3, "violação"), w(611.3, 611.5, "de"), w(611.5, 612, "direitos")];
    const heard = [w(610.66, 610.84, "vi"), w(611.06, 611.4, "violação"), w(611.4, 611.5, "de"), w(611.5, 612, "direitos")];
    const d = edgeExtras({ edge: "in", clip: { srcIn: 610.66, srcOut: 615, script: "violação de direitos" }, heard, reference, env: e, thresholdDb: TH, match });
    assert.equal(d.to, undefined);
  });

  it('"e que quem" (398,13 → 398,31 s): o "E" colado em "que" fica', () => {
    const e = env(410, [[398.1, 405]]);
    const reference = [w(398.2, 398.4, "que"), w(398.4, 398.7, "quem"), w(398.7, 399.1, "decide")];
    const heard = [w(398.13, 398.28, "E"), w(398.31, 398.45, "que"), w(398.45, 398.7, "quem"), w(398.7, 399.1, "decide")];
    const d = edgeExtras({ edge: "in", clip: { srcIn: 398.13, srcOut: 405, script: "que quem decide" }, heard, reference, env: e, thresholdDb: TH, match });
    assert.equal(d.to, undefined);
  });

  it("som separado por silêncio (hesitação, cauda da frase anterior) continua saindo", () => {
    const e = env(620, [[608.84, 608.98], [609.1, 615]]);
    const reference = [w(608.9, 609.4, "juiz"), w(609.4, 609.9, "decidiu"), w(609.9, 610.3, "que")];
    const heard = [w(608.84, 608.98, "é"), w(609.1, 609.4, "juiz"), w(609.4, 609.9, "decidiu"), w(609.9, 610.3, "que")];
    const d = edgeExtras({ edge: "in", clip: { srcIn: 608.84, srcOut: 615, script: "juiz decidiu que" }, heard, reference, env: e, thresholdDb: TH, match });
    assert.equal(d.extra, "é");
    assert.ok(d.to !== undefined && d.to >= 608.98 && d.to <= 609.1, `to ${d.to}`);
  });
});

/** Quadros do detector (5 ms) com o sinal cheio por trecho; a 1ª diferença fica `diffGap` dB abaixo. */
function frames(durationS: number, parts: Array<[number, number, number]>, floorDb: number, diffGap = 10): FrameEnergy {
  const hopS = SPEECH_DETECT.hopS;
  const n = Math.round(durationS / hopS);
  const fullDb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * hopS;
    const p = parts.find(([a, b]) => t >= a && t < b);
    fullDb[i] = p ? p[2] : floorDb;
  }
  return { hopS, fullDb, diffDb: Float64Array.from(fullDb, (d) => d - diffGap) };
}

describe("#12263 (2): o detector de fala recua até o ataque medido contra o piso do bruto", () => {
  it('consoante suave (-45 dB) antes da vogal: a ilha do limiar fixo começa depois do ataque; o recuo a pega', () => {
    // Piso -60; "s" de 1,00 a 1,08 s a -45 dB (abaixo de -33 e, na diferença, de -46); vogal a -20 dB.
    const e = frames(4, [[1.0, 1.08, -45], [1.08, 2, -20]], -60);
    const fixed = speechIslands(e);
    assert.equal(fixed.length, 1);
    assert.ok(fixed[0].start >= 1.075, `pré-condição: o limiar fixo começa na vogal (${fixed[0].start})`);
    const [ext] = extendIslandAttacks(e, fixed);
    assert.ok(ext.start <= 1.005 && ext.start >= 1.0 - 1e-9, `ataque em ${ext.start}`);
    assert.equal(ext.end, fixed[0].end);
  });

  it("o recuo para em attackMaxS e na ilha anterior", () => {
    const long = frames(4, [[0.5, 1.0, -45], [1.0, 2, -20]], -60);
    const [ext] = extendIslandAttacks(long, speechIslands(long));
    assert.ok(Math.abs(ext.start - (1.0 - SPEECH_DETECT.attackMaxS)) < 0.006, `teto: ${ext.start}`);
    const prev = [{ start: 0.2, end: 0.95 }, { start: 1.0, end: 2 }];
    assert.equal(extendIslandAttacks(long, prev)[1].start, 0.95);
  });

  it("piso alto (gravação externa, -40 dB): o critério relativo não passa do fixo, nada muda", () => {
    const e = frames(4, [[1.0, 1.08, -36], [1.08, 2, -20]], -40);
    const fixed = speechIslands(e);
    assert.deepEqual(extendIslandAttacks(e, fixed), fixed);
    assert.equal(Math.round(speechNoiseFloors(e)!.fullDb), -40);
  });
});

describe("#12263 (3): checagem do build, entrada que corta som", () => {
  const FPS = 30;
  // Metade do bruto em fala (-20 dB), piso -60: limite = -60 + 0,45·40 = -42.
  const e = frames(4, [[1.0, 3.0, -20]], -60);

  it("entrada 30 ms depois do começo da fala avisa, com o tempo no bruto e na sequência", () => {
    const warns = entryCutSoundWarnings([{ block: "comentario", frameIn: 31, frameOut: 80, seqStart: 12 }], e, FPS);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /comentario: entrada em 1\.03 s do bruto \(0\.40 s da sequência\) corta som: -20 dB nos 40 ms antes do corte.*#12263/);
  });

  it("entrada no silêncio antes da fala não avisa; clipe contíguo ao anterior no bruto também não", () => {
    assert.deepEqual(entryCutSoundWarnings([{ block: "comentario", frameIn: 29, frameOut: 80, seqStart: 0 }], e, FPS), []);
    const contig = [
      { block: "titulo", frameIn: 25, frameOut: 45, seqStart: 0 },
      { block: "comentario", frameIn: 45, frameOut: 80, seqStart: 20 },
    ];
    assert.deepEqual(entryCutSoundWarnings(contig, e, FPS), []);
  });
});

describe("#12262: faixa tratada com redução constante e gate suave", () => {
  it("o gate nunca baixa a pausa mais que 10 dB, com attack/release longos, e a redução é mais forte que a do #12102", () => {
    assert.ok(-AUDIO_CLEAN.rangeDb <= AUDIO_CLEAN_MAX_PAUSE_DROP_DB, `range ${AUDIO_CLEAN.rangeDb} dB zera a pausa`);
    assert.ok(AUDIO_CLEAN.attackMs >= 50 && AUDIO_CLEAN.releaseMs >= 400, "attack/release curtos cortam o fundo de forma abrupta");
    assert.ok(AUDIO_CLEAN.nrDb > 12, "nr 12 deixava o ruído sob a fala");
    const f = audioCleanFilter(audioCleanParams(-35));
    const range = Number(/range=([0-9.]+)/.exec(f)?.[1]);
    assert.ok(range >= 10 ** (-AUDIO_CLEAN_MAX_PAUSE_DROP_DB / 20) - 1e-6, `range linear ${range}`);
    assert.match(f, /^afftdn=nr=24:nf=-41:tn=1,/);
  });
});

describe("#12285: a legenda do export só sai quando o XML do horizontal muda", () => {
  type P = Parameters<typeof mergeBuildPlan>[0]["next"]["plans"][number];
  const plan = (target: string, tag: string, height = 1080, width = 1920): P =>
    ({ spec: { name: `${target}-${tag}`, target, width, height }, clips: [], durationFrames: 0, missingBlocks: [], dropped: [], script: tag } as unknown as P);
  const base = { edition: "261105", source: {} as never, framing: {} as never, framingAssumed: false };
  const ID_V2 = "seq-youtube-v2-aaaaaaaa";
  const ID_V3 = "seq-youtube-v3-bbbbbbbb";

  it("mergeBuildPlan: rebuild com o mesmo id mantém o since; id novo abre outro", () => {
    const first = mergeBuildPlan({ next: { ...base, hash: "H", plans: [plan("youtube", "V2")] }, pickedKeys: new Set(["youtube"]), prev: null, now: 100, xmlIds: { youtube: ID_V2 } });
    assert.deepEqual(first.plan.xmlVersions, { youtube: { id: ID_V2, since: 100 } });
    // build sem --seq (ajuste na vertical): o horizontal sai igual, builtAt avança, a versão não
    const same = mergeBuildPlan({
      next: { ...base, hash: "H", plans: [plan("youtube", "V2"), plan("outras-redes", "V8", 1920, 1080)] },
      pickedKeys: new Set(["youtube", "outras-redes"]),
      prev: first.plan,
      now: 500,
      xmlIds: { youtube: ID_V2, "outras-redes": "seq-outras-redes-v8-cccccccc" },
    });
    assert.equal(same.plan.builtAt?.youtube, 500);
    assert.deepEqual(same.plan.xmlVersions?.youtube, { id: ID_V2, since: 100 });
    assert.deepEqual(xmlVersionAt(same.plan, "youtube", 0), { builtAtMs: 100, sequenceId: ID_V2 });
    const changed = mergeBuildPlan({ next: { ...base, hash: "H2", plans: [plan("youtube", "V3")] }, pickedKeys: new Set(["youtube"]), prev: same.plan, now: 900, xmlIds: { youtube: ID_V3 } });
    assert.deepEqual(changed.plan.xmlVersions?.youtube, { id: ID_V3, since: 900 });
  });

  it("--seq de outra sequência: o horizontal mantido leva a versão dele", () => {
    const prev = mergeBuildPlan({ next: { ...base, hash: "H", plans: [plan("youtube", "V2"), plan("outras-redes", "V8", 1920, 1080)] }, pickedKeys: new Set(["youtube", "outras-redes"]), prev: null, now: 100, xmlIds: { youtube: ID_V2, "outras-redes": "x" } }).plan;
    const r = mergeBuildPlan({ next: { ...base, hash: "H", plans: [plan("youtube", "V2"), plan("outras-redes", "V9", 1920, 1080)] }, pickedKeys: new Set(["outras-redes"]), prev, now: 500, xmlIds: { "outras-redes": "y" } });
    assert.deepEqual(r.plan.xmlVersions?.youtube, { id: ID_V2, since: 100 });
  });

  it("plano anterior ao #12285 (sem xmlVersions): cai no builtAt do #12209", () => {
    assert.equal(sequenceXmlVersion({}, "youtube"), null);
    assert.deepEqual(xmlVersionAt({ builtAt: { youtube: 300 } }, "youtube", 0), { builtAtMs: 300, sequenceId: null });
  });

  it("regressão do cenário da issue: export do V2 → build sem mudança no horizontal → srt mantém a legenda do export", () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-12285-"));
    try {
      const p = { path: join(dir, "edicao", "diaria-comentada-261105.srt"), recordPath: join(dir, "state", "youtube-srt.json") };
      const T_EXPORT = Date.parse("2026-11-05T10:00:00Z");
      const T_REBUILD = Date.parse("2026-11-05T11:00:00Z");
      assert.equal(applyYoutubeSrtCopy({ ...p, srt: "EXPORT V2", force: false, origin: { name: "V2.mp4", size: 10, mtimeMs: T_EXPORT }, sequenceId: ID_V2 }), "write");
      assert.equal(JSON.parse(readFileSync(p.recordPath, "utf8")).fromExportSequenceId, ID_V2);
      // builtAt avançou (rebuild da vertical), mas o id é o mesmo: a legenda do export fica
      assert.equal(applyYoutubeSrtCopy({ ...p, srt: "MONTAGEM V2", force: false, sequenceBuiltAtMs: T_REBUILD, sequenceId: ID_V2 }), "keep-from-export");
      assert.equal(readFileSync(p.path, "utf8"), "EXPORT V2");
      // XML novo do horizontal: a legenda do export antigo sai (o #12209 continua valendo)
      assert.equal(applyYoutubeSrtCopy({ ...p, srt: "MONTAGEM V3", force: false, sequenceBuiltAtMs: T_REBUILD, sequenceId: ID_V3 }), "replace-stale-export");
      assert.equal(readFileSync(p.path, "utf8"), "MONTAGEM V3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decisão: o id vence o instante; sem id de um dos lados, o instante", () => {
    const existing = "x";
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const common = { existing, recordedSha256: sha(existing), force: false, recordedFromExport: true, recordedExportAtMs: 100, sequenceBuiltAtMs: 500 };
    assert.equal(youtubeSrtCopyDecision({ ...common, recordedSequenceId: ID_V2, sequenceId: ID_V2 }), "keep-from-export");
    assert.equal(youtubeSrtCopyDecision({ ...common, recordedSequenceId: ID_V2, sequenceId: ID_V3 }), "replace-stale-export");
    assert.equal(youtubeSrtCopyDecision({ ...common, recordedSequenceId: null, sequenceId: ID_V2 }), "replace-stale-export");
    assert.equal(youtubeSrtCopyDecision({ ...common, sequenceBuiltAtMs: 50, recordedSequenceId: null, sequenceId: ID_V2 }), "keep-from-export");
  });
});
