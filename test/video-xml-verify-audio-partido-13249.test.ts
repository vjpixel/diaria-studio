/**
 * test/video-xml-verify-audio-partido-13249.test.ts — #13249: o `verify-xml`
 * lê o áudio partido sob a vinheta (#13240).
 *
 * O `buildXmeml` parte o clipe de áudio sob a vinheta em `a{n}`, `a{n}-2`,
 * `a{n}-3`. O `parseXmlAudio` só reconhecia `a\d+`: perdia os pedaços, o
 * `xmlStructureIssues` acusava "buraco na sequência" e o `verify-xml` saía com
 * exit 1 em todo build com vinheta. De ponta a ponta: build -> parse ->
 * estrutura + plano, sem problema nenhum, e o áudio remontado cobre a
 * sequência inteira sem cortes falsos nas emendas dos pedaços.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assembleClips, buildXmeml, vinhetaDuckSpan, type RawClip, type SequencePlan, type SequenceSpec, type SourceInfo, type VinhetaAsset } from "../scripts/lib/diaria/video-montage.ts";
import { assemblySegments, edgeFindings, parseXmlAudio, sequenceCutsS, toTimeline, xmlPlanIssues, xmlStructureIssues } from "../scripts/lib/diaria/video-xml-verify.ts";

const FPS = 30;
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V12", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada horizontal_V13", width: 1920, height: 1080, order: ["titulo", "abertura", "comentario"], scales: [60, 85] };
const SOURCE: SourceInfo = { path: "/m/bruto.mp4", fps: FPS, durationS: 2000, width: 3840, height: 2160, mirrored: false };
const VIN: VinhetaAsset = { path: "/m/_marca/vinheta-logo-diaria.mov", durationS: 1.3, width: 1920, height: 1080, hasAudio: false, fps: 30 };
const GAIN = { db: 0, linear: 1, limitedBy: "target" as const };

function planOf(spec: SequenceSpec, raws: RawClip[], extra: Partial<SequencePlan> = {}): SequencePlan {
  const a = assembleClips(spec, raws, FPS);
  return { spec, clips: a.clips, durationFrames: a.durationFrames, script: "", missingBlocks: [], dropped: [], ...extra };
}

// Vertical da 261116 (o cenário da issue): título até 34,44 s, pausa filler 42,3–44 s do bruto, depois a abertura.
const VERTICAL = planOf(
  SPEC_V,
  [
    { block: "titulo", srcIn: 27.23, srcOut: 34.6 },
    { block: "titulo", srcIn: 42.3, srcOut: 44, filler: true },
    { block: "abertura", srcIn: 174.1, srcOut: 177.4 },
  ],
  { titleSpeechEndS: 34.44 },
);

function verify(plan: SequencePlan, xml: string) {
  const parsed = parseXmlAudio(xml);
  return {
    parsed,
    issues: [...xmlStructureIssues(parsed.clips), ...xmlPlanIssues(parsed, { clips: plan.clips.length, durationFrames: plan.durationFrames })],
  };
}

describe("#13249: verify-xml com o áudio partido sob a vinheta", () => {
  it("o XML de fato parte o áudio (pré-condição do cenário)", () => {
    const xml = buildXmeml([VERTICAL], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { vinheta: VIN, audioGain: GAIN });
    assert.ok(vinhetaDuckSpan(VERTICAL, FPS, VIN));
    assert.match(xml, /<clipitem id="a\d+-\d+">/);
  });

  it("vertical 261116: build -> parse -> estrutura + plano, zero problemas", () => {
    const xml = buildXmeml([VERTICAL], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { vinheta: VIN, audioGain: GAIN });
    const { parsed, issues } = verify(VERTICAL, xml);
    assert.deepEqual(issues, []);
    // Um clipe remontado por clipe do plano, com os quadros do plano.
    assert.deepEqual(
      parsed.clips.map((c) => [c.start, c.end, c.in, c.out]),
      VERTICAL.clips.map((c) => [c.seqStart, c.seqEnd, c.frameIn, c.frameOut]),
    );
    // O áudio remontado cobre a sequência inteira (o trecho abaixado incluído).
    const { clips, errors } = toTimeline(parsed, [0]);
    assert.deepEqual(errors, []);
    const seconds = assemblySegments(clips, parsed.rate).reduce((n, s) => n + (s.end - s.start), 0);
    assert.ok(Math.abs(seconds * FPS - VERTICAL.durationFrames) < 1e-6);
    // As emendas dos pedaços não viram corte na revisão.
    assert.equal(sequenceCutsS(parsed.clips, parsed.rate).length, VERTICAL.clips.length - 1);
  });

  it("emenda entre pedaços nunca é SOM CORTADO (fala alta em todo o bruto)", () => {
    const xml = buildXmeml([VERTICAL], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { vinheta: VIN, audioGain: GAIN });
    const parsed = parseXmlAudio(xml);
    const { clips } = toTimeline(parsed, [0]);
    const loud = () => -10;
    const f = edgeFindings(clips, parsed.rate, loud, -40);
    // Só as bordas reais dos clipes do plano (entre trechos não contíguos no bruto) podem acusar.
    assert.equal(f.length, VERTICAL.clips.length);
  });

  it("horizontal (com e sem faixa tratada): zero problemas", () => {
    const plan = planOf(
      SPEC_H,
      [
        { block: "titulo", srcIn: 27.23, srcOut: 34.6 },
        { block: "titulo", srcIn: 42.3, srcOut: 44, filler: true },
        { block: "abertura", srcIn: 174.1, srcOut: 177.4 },
        { block: "comentario", srcIn: 300, srcOut: 320 },
      ],
      { titleSpeechEndS: 34.44 },
    );
    for (const audioPath of [undefined, "/m/audio-tratado.wav"]) {
      const xml = buildXmeml([plan], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { vinheta: VIN, audioGain: GAIN, ...(audioPath ? { audioPath } : {}) });
      assert.match(xml, /<clipitem id="a\d+-\d+">/);
      assert.deepEqual(verify(plan, xml).issues, [], `audioPath=${audioPath}`);
    }
  });

  it("pedaço que não emenda no anterior fica separado e é acusado", () => {
    const xml = buildXmeml([VERTICAL], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { vinheta: VIN, audioGain: GAIN });
    // Desloca o 1º pedaço `-2` em 5 quadros na sequência: abre um buraco.
    const broken = xml.replace(/(<clipitem id="a\d+-2">[\s\S]*?<start>)(\d+)(<\/start>)/, (_, a, s, b) => `${a}${Number(s) + 5}${b}`);
    assert.notEqual(broken, xml);
    const { parsed, issues } = verify(VERTICAL, broken);
    assert.ok(parsed.clips.length > VERTICAL.clips.length);
    assert.ok(issues.some((i) => /buraco/.test(i)), issues.join("; "));
    assert.ok(issues.some((i) => /clipes de áudio no XML/.test(i)), issues.join("; "));
  });
});
