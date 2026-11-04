/**
 * Enquadramento por item do blocks.json: o `framing` de um item sobrepõe o do
 * arquivo só nos clipes daquele item (XML e prévia), para alinhar pelos olhos
 * quando o editor muda de posição entre as tomadas (edição 261105).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleClips,
  buildSequencePlan,
  buildXmeml,
  clipFraming,
  faceCenterWarnings,
  framingFor,
  parseBlocksFile,
  previewCropFor,
  resolveBlocks,
  type BlocksFile,
  type SequenceSpec,
  type SourceInfo,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";

function say(text: string, t0: number, dur = 0.3, gap = 0.05): Word[] {
  let t = t0;
  return text.split(" ").map((w) => {
    const word = { start: Math.round(t * 1000) / 1000, end: Math.round((t + dur) * 1000) / 1000, text: w };
    t += dur + gap;
    return word;
  });
}

const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario"], scales: [115, 130] };
const SOURCE: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 20, width: 3840, height: 2160, mirrored: false };
const BASE = { faceX: 0.5, eyeY: 0.42 };
const ITEM = { faceX: 0.53, eyeY: 0.44 };

function fixture(): { file: BlocksFile; words: Word[] } {
  const words = [...say("Google pode ler seu Gmail?", 1), ...say("O comentário de hoje é este.", 5)];
  const file: BlocksFile = {
    edition: "261105",
    framing: BASE,
    blocks: {
      titulo: [{ text: "Google pode ler seu Gmail?" }],
      comentario: [{ text: "O comentário de hoje é este.", framing: ITEM }],
    },
  };
  return { file, words };
}

describe("framing por item do blocks.json", () => {
  it("o clipe do item leva o framing dele; os outros seguem o do arquivo", () => {
    const { file, words } = fixture();
    const { blocks, errors } = resolveBlocks(file, words, { durationS: SOURCE.durationS });
    assert.deepEqual(errors, []);
    const plan = buildSequencePlan(SPEC_V, blocks, [], SOURCE);
    const tit = plan.clips.find((c) => c.block === "titulo")!;
    const com = plan.clips.find((c) => c.block === "comentario")!;
    assert.equal(tit.framing, undefined);
    assert.deepEqual(com.framing, ITEM);
  });

  it("XML e prévia usam o framing do clipe (Center e recorte mudam só no item)", () => {
    const { file, words } = fixture();
    const plan = buildSequencePlan(SPEC_V, resolveBlocks(file, words, { durationS: SOURCE.durationS }).blocks, [], SOURCE);
    const xml = buildXmeml([plan], SOURCE, BASE);
    const com = plan.clips.find((c) => c.block === "comentario")!;
    const tit = plan.clips.find((c) => c.block === "titulo")!;
    const own = framingFor({ srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: com.scale, framing: { ...BASE, ...ITEM } });
    const base = framingFor({ srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: tit.scale, framing: BASE });
    assert.ok(xml.includes(`<horiz>${own.center.horiz}</horiz>`), "Center do item no XML");
    assert.ok(xml.includes(`<horiz>${base.center.horiz}</horiz>`), "Center do arquivo no clipe sem framing próprio");
    assert.notEqual(own.center.horiz, base.center.horiz);
    assert.deepEqual(previewCropFor(SOURCE, SPEC_V, clipFraming(BASE, com), com.scale), own.crop);
  });

  it("clipFraming mantém a caneca do arquivo", () => {
    const mug = { left: 0.6, right: 0.65, top: 0.7, bottom: 0.8 };
    assert.deepEqual(clipFraming({ ...BASE, mug }, { framing: ITEM }), { ...ITEM, mug });
    assert.deepEqual(clipFraming(BASE, {}), BASE);
  });

  it("validação: framing do item fora de 0–1 é erro", () => {
    const { file } = fixture();
    (file.blocks.comentario![0] as { framing: unknown }).framing = { faceX: 1.2, eyeY: 0.4 };
    const r = parseBlocksFile(file);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.errors.join("\n") : "", /comentario\[0\]: framing do item precisa só de faceX e eyeY, entre 0 e 1/);
  });

  it("validação: mug no item é erro; 0 e 1 valem como no framing do arquivo", () => {
    const { file } = fixture();
    (file.blocks.comentario![0] as { framing: unknown }).framing = { faceX: 0.5, eyeY: 0.4, mug: { left: 0.1, right: 0.2, top: 0.1, bottom: 0.2 } };
    assert.equal(parseBlocksFile(file).ok, false);
    (file.blocks.comentario![0] as { framing: unknown }).framing = { faceX: 1, eyeY: 0 };
    assert.equal(parseBlocksFile(file).ok, true);
  });

  it("fusão de trechos contíguos com framing diferente fica registrada (vale o do 1º)", () => {
    const { merges, clips } = assembleClips(SPEC_V, [
      { block: "comentario", srcIn: 5, srcOut: 6, framing: { faceX: 0.5, eyeY: 0.4 } },
      { block: "comentario", srcIn: 6, srcOut: 7, framing: { faceX: 0.53, eyeY: 0.44 } },
    ], 30);
    assert.equal(clips.length, 1);
    assert.deepEqual(clips[0].framing, { faceX: 0.5, eyeY: 0.4 });
    assert.ok(merges.some((m) => /framing do item seguinte descartado/.test(m.reason)));
    const same = assembleClips(SPEC_V, [
      { block: "comentario", srcIn: 5, srcOut: 6 },
      { block: "comentario", srcIn: 6, srcOut: 7 },
    ], 30);
    assert.ok(!same.merges.some((m) => /framing/.test(m.reason)));
  });

  it("aviso de rosto fora do centro considera o framing do clipe", () => {
    const plan = { spec: { name: "V", width: 1080, height: 1920 }, clips: [{ scale: 115 }, { scale: 115, framing: { faceX: 0.95, eyeY: 0.42 } }] };
    const w = faceCenterWarnings([plan], { width: 3840, height: 2160 }, BASE);
    assert.equal(w.length, 1);
    assert.match(w[0], /item com rosto em 0\.95/);
  });
});
