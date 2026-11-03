/**
 * #11958: falso começo/repetição que o Whisper engole numa palavra esticada
 * (261103: "duas… dois… duas linhas", "de seus… de suas conversas"), achado
 * nas subjanelas do `retranscribe --sub` e proposto no roteiro como linha
 * "repetição" para o Gate 2.
 * #11959: espelhamento default pelo metadado da câmera (traseira não espelha)
 * ou por `publishing.video.mirrored_default`, com a premissa registrada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSequencePlan,
  cameraFacingFromTags,
  collapsedTakeSuspects,
  findRepetitionCut,
  mergeWindowWords,
  mirroredDefaultFrom,
  mirroredPremise,
  parseProbe,
  resolveBlocks,
  resolveMirrored,
  subRetranscribeWindow,
  subWindows,
  type Segment,
  type SequenceSpec,
  type Transcript,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { roteiroMarkdown } from "../scripts/lib/diaria/video-montage-docs.ts";
import { RETRANSCRIBED_FILE } from "../scripts/video-montagem.ts";

const ROOT = join(import.meta.dirname, "..");
const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const seg = (words: Word[]): Segment => ({ start: words[0].start, end: words[words.length - 1].end, text: words.map((x) => x.text).join(" "), words });
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [50, 62] };
const SOURCE = { fps: 30, durationS: 1000 };

describe("#11958: falso começo dentro da palavra esticada", () => {
  const PHRASE = "O roteiro tem duas linhas principais.";
  // 261103 02:24–02:27: o transcript registrou "duas" esticada por 3 s de fala.
  const main: Word[] = [
    w("O", 142.8, 143.1),
    w("roteiro", 143.15, 143.45),
    w("tem", 143.5, 143.8),
    w("duas", 143.9, 146.9),
    w("linhas", 146.95, 147.25),
    w("principais.", 147.3, 147.6),
  ];
  // A retranscrição da janela inteira também "achou uma tomada só".
  const whole: Transcript = { segments: [seg(main.map((x) => ({ ...x })))] };
  // As subjanelas ouvem o falso começo: "duas dois" e a repetição final "duas linhas".
  const subA: Transcript = { sub: { window: { start: 142, end: 146 } }, segments: [seg([w("O", 142.8, 143.1), w("roteiro", 143.15, 143.45), w("tem", 143.5, 143.8), w("duas", 143.9, 144.2), w("dois", 144.6, 144.9)])] };
  const subB: Transcript = { sub: { window: { start: 144, end: 148 } }, segments: [seg([w("dois", 144.62, 144.92), w("duas", 146.5, 146.85), w("linhas", 146.95, 147.25), w("principais.", 147.3, 147.6)])] };
  const file = { edition: "261103", blocks: { comentario: [{ text: PHRASE }] } };

  it("subjanelas de 4 s com passo de 2 s, a última encostada no fim", () => {
    assert.deepEqual(subWindows({ start: 142, end: 149 }), [
      { start: 142, end: 146 },
      { start: 144, end: 148 },
      { start: 145, end: 149 },
    ]);
    assert.deepEqual(subWindows({ start: 10, end: 13 }), [{ start: 10, end: 13 }]);
  });

  it("a suspeita traz o fim e a palavra, e a janela do --sub fica em volta dela", () => {
    const sus = collapsedTakeSuspects(main);
    assert.equal(sus.length, 1);
    assert.equal(sus[0].kind, "palavra-longa");
    assert.equal(sus[0].word, 3);
    assert.equal(sus[0].end, 146.9);
    const sw = subRetranscribeWindow(sus[0]);
    // 1,5 s de cada lado, sem sair da janela da suspeita (as palavras do trecho com 0,5 s de margem).
    assert.deepEqual(sw, { start: 142.4, end: 148.1 });
  });

  it("a palavra ouvida em duas subjanelas entra uma vez só", () => {
    const merged = mergeWindowWords([
      { start: 142, end: 146, words: subA.segments[0].words! },
      { start: 144, end: 148, words: subB.segments[0].words! },
    ]);
    assert.deepEqual(merged.map((x) => x.text), ["O", "roteiro", "tem", "duas", "dois", "duas", "linhas", "principais."]);
  });

  it("acha o corte: do fim da palavra antes ao começo da repetição final", () => {
    const sus = collapsedTakeSuspects(main)[0];
    const heard = mergeWindowWords([
      { start: 142, end: 146, words: subA.segments[0].words! },
      { start: 144, end: 148, words: subB.segments[0].words! },
    ]);
    const rep = findRepetitionCut(main, sus, heard);
    assert.ok(rep);
    assert.deepEqual(rep.cut, { start: 143.8, end: 146.5 });
    assert.equal(rep.falseStart, "duas dois");
    assert.equal(rep.restart, "duas linhas");
  });

  it("'de seus… de suas conversas': o recomeço pode começar antes da palavra esticada", () => {
    const m = [w("o", 600, 600.2), w("histórico", 600.25, 600.8), w("de", 600.85, 601.0), w("suas", 601.05, 603.6), w("conversas.", 603.65, 604.2)];
    const sus = collapsedTakeSuspects(m)[0];
    assert.equal(sus.word, 3);
    const heard = [w("o", 600, 600.2), w("histórico", 600.25, 600.8), w("de", 600.85, 601.0), w("seus", 601.05, 601.4), w("de", 603.0, 603.15), w("suas", 603.2, 603.6), w("conversas.", 603.65, 604.2)];
    const rep = findRepetitionCut(m, sus, heard);
    assert.ok(rep);
    assert.equal(rep.restart, "suas conversas.");
    assert.equal(rep.cut.end, 603.2);
  });

  it("sem repetição nas subjanelas, ou só pausa (silêncio) no trecho, não propõe corte", () => {
    const sus = collapsedTakeSuspects(main)[0];
    assert.equal(findRepetitionCut(main, sus, [w("duas", 143.9, 144.3), w("linhas", 146.95, 147.25)]), null);
    const heard = [w("tem", 143.5, 143.8), w("duas", 143.9, 144.2), w("dois", 144.6, 144.9), w("duas", 146.5, 146.85), w("linhas", 146.95, 147.25)];
    assert.equal(findRepetitionCut(main, sus, heard, [{ start: 143.8, end: 146.5 }]), null, "trecho todo em silêncio detectado é pausa, não fala");
  });

  it("regressão 261103: sem --sub o roteiro pede as subjanelas; com elas, linha repetição e o item segue inteiro", () => {
    const sem = resolveBlocks(file, main, { durationS: 1000, retranscribed: [whole] });
    const it0 = sem.blocks.comentario![0];
    assert.ok(it0.collapsed?.unresolved, JSON.stringify(sem.warnings));
    assert.equal(it0.collapsed!.repetition, undefined);
    const mdSem = roteiroMarkdown("261103", [buildSequencePlan(SPEC_H, sem.blocks, [], SOURCE)], sem.blocks, 30);
    assert.match(mdSem, /\*\*tomada colapsada\?\*\* Comentário \[0\].*retranscribe 261103 --from \d+\.\d --to \d+\.\d --sub/);
    assert.doesNotMatch(mdSem, /conferir no áudio/);

    const com = resolveBlocks(file, main, { durationS: 1000, retranscribed: [whole, subA, subB] });
    const it1 = com.blocks.comentario![0];
    assert.deepEqual(it1.interval, it0.interval, "corte só proposto: o intervalo do item não muda antes do Gate 2");
    assert.deepEqual(it1.collapsed?.repetition?.cut, { start: 143.8, end: 146.5 });
    assert.match(com.warnings.join("\n"), /falso começo\/repetição "duas dois".*Gate 2 \(#11958\)/);
    const md = roteiroMarkdown("261103", [buildSequencePlan(SPEC_H, com.blocks, [], SOURCE)], com.blocks, 30);
    assert.match(md, /\*\*repetição\*\* Comentário \[0\].*falso começo "duas dois".*recomeço em "duas linhas".*Corte proposto 143\.80–146\.50 s/);
    assert.match(md, new RegExp(`\\{"start": ${Math.round(it1.interval.start * 100) / 100}, "end": 143\\.8\\}, \\{"start": 146\\.5, "end": ${Math.round(it1.interval.end * 100) / 100}\\}`));
  });

  it("subjanelas sem repetição: o roteiro manda conferir no áudio", () => {
    const flat: Transcript = { sub: { window: { start: 142, end: 148 } }, segments: [seg(main.map((x) => ({ ...x })))] };
    const r = resolveBlocks(file, main, { durationS: 1000, retranscribed: [whole, flat] });
    const it0 = r.blocks.comentario![0];
    assert.equal(it0.collapsed?.subChecked, true);
    const md = roteiroMarkdown("261103", [buildSequencePlan(SPEC_H, r.blocks, [], SOURCE)], r.blocks, 30);
    assert.match(md, /as subjanelas também não acharam repetição: conferir no áudio/);
  });

  it("subjanela nunca é lida como a retranscrição da janela inteira (arquivo próprio)", () => {
    assert.ok(RETRANSCRIBED_FILE.test("retranscribe-140.0-150.0.json"));
    assert.ok(RETRANSCRIBED_FILE.test("retranscribe-sub-142.0-146.0.json"));
    assert.ok(!RETRANSCRIBED_FILE.test("retranscribe-sub-windows.json"));
  });
});

describe("#11959: espelhamento default e premissa", () => {
  const probe = (tags?: Record<string, string>, streamTags?: Record<string, string>) =>
    JSON.stringify({
      streams: [{ codec_type: "video", width: 3840, height: 2160, r_frame_rate: "30/1", ...(streamTags ? { tags: streamTags } : {}) }, { codec_type: "audio" }],
      format: { duration: "600.0", ...(tags ? { tags } : {}) },
    });

  it("regressão 261103: câmera traseira no metadado = sem espelho, independente do config", () => {
    const s = parseProbe(probe({ "com.apple.quicktime.camera.lens_model": "iPhone 15 Pro back triple camera 6.765mm f/1.78" }), "G:/x.mov", { mirroredDefault: true });
    assert.equal(s.mirrored, false);
    assert.equal(s.mirroredFrom, "camera-metadata");
    assert.equal(s.camera, "back");
  });

  it("sem metadado: vale o config; sem config, o default do #11208", () => {
    assert.deepEqual(
      [parseProbe(probe(), "x", { mirroredDefault: false }).mirrored, parseProbe(probe(), "x", { mirroredDefault: false }).mirroredFrom],
      [false, "config"],
    );
    const d = parseProbe(probe(), "x");
    assert.equal(d.mirrored, true);
    assert.equal(d.mirroredFrom, "default");
  });

  it("câmera frontal fica com o config (o espelho dela depende do aparelho)", () => {
    const s = parseProbe(probe(undefined, { "com.apple.quicktime.camera.identifier": "Front" }), "x", { mirroredDefault: true });
    assert.equal(s.camera, "front");
    assert.deepEqual([s.mirrored, s.mirroredFrom], [true, "config"]);
    assert.deepEqual(resolveMirrored("front", false), { mirrored: false, mirroredFrom: "config" });
  });

  it("só tags de câmera contam; as duas ao mesmo tempo = sem leitura", () => {
    assert.equal(cameraFacingFromTags({ title: "back to school" }), null);
    assert.equal(cameraFacingFromTags({ "camera.lens": "back" }, { "camera.lens": "front" }), null);
    assert.equal(cameraFacingFromTags({ "com.android.capture.camera": "rear" }), "back");
  });

  it("o config do repo traz publishing.video.mirrored_default booleano", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    assert.equal(typeof mirroredDefaultFrom(cfg), "boolean");
    assert.equal(mirroredDefaultFrom({}), null);
    assert.equal(mirroredDefaultFrom({ publishing: { video: { mirrored_default: "sim" } } }), null);
  });

  it("a premissa diz a origem e, quando ambígua, manda conferir o frame lado a lado", () => {
    assert.match(mirroredPremise({ mirrored: false, mirroredFrom: "camera-metadata", camera: "back" }), /traseira/);
    assert.doesNotMatch(mirroredPremise({ mirrored: false, mirroredFrom: "camera-metadata", camera: "back" }), /lado a lado/);
    assert.match(mirroredPremise({ mirrored: true, mirroredFrom: "config" }), /mirrored_default.*lado a lado/);
    assert.match(mirroredPremise({ mirrored: true }), /anterior ao #11959/);
    assert.match(mirroredPremise({ mirrored: true, mirroredFrom: "default" }, false), /pelo blocks\.json/);
  });
});
