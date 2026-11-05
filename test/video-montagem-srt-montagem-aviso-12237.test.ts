/**
 * #12237: o `srt` da montagem (sem `--from-final`) usa o mesmo alinhamento
 * (`forceAlignToScript`) que o #12198 passou a recusar no export, e seguia
 * calado com legenda espremida/roteiro divergente. `montageSrtWarnings` aplica
 * os mesmos limites (`exportSrtProblems`) como `[aviso]` nomeando o trecho —
 * o caso da 261030 (roteiro com trecho que não foi falado) avisa; roteiro que
 * casa com a fala não avisa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Word } from "../scripts/lib/diaria/video-montage.ts";
import { cueTimings, forceAlignToScript, segmentCues } from "../scripts/lib/diaria/video-montage.ts";
import { montageSrtWarnings } from "../scripts/video-montagem.ts";

const say = (text: string, t0: number, dur = 0.3): Word[] =>
  text.split(" ").map((w, i) => ({ start: +(t0 + i * dur).toFixed(3), end: +(t0 + (i + 1) * dur).toFixed(3), text: w }));

const script =
  "A paciente procurou o pronto-socorro com dor de cabeça forte. " +
  "O remédio que ela tomava era lamotrigina. A dosagem tinha mudado na semana anterior por causa do remédio. " +
  "Os médicos chegaram ao diagnóstico em dois dias.";

function warningsFor(heard: Word[]): string[] {
  const aligned = forceAlignToScript(heard, script, { aliases: [], cuts: [], endS: 70 });
  return montageSrtWarnings("Diaria comentada_Youtube_V1", script, aligned, cueTimings(segmentCues(aligned.words)));
}

describe("#12237: srt da montagem avisa legenda imprópria", () => {
  it("regressão (caso 261030): trecho do roteiro sem fala vira [aviso] nomeando o trecho", () => {
    const heard = [
      ...say("A paciente procurou o pronto-socorro com dor de cabeça forte.", 49.76),
      ...say("Os médicos chegaram ao diagnóstico em dois dias.", 53.12),
      ...say("A dosagem que ela tomava era 400mg por dia, o dobro.", 57.18),
    ];
    const warnings = warningsFor(heard);
    assert.ok(warnings.length > 0, "esperava aviso");
    const all = warnings.join("\n");
    assert.ok(warnings.every((w) => w.startsWith("[aviso] Diaria comentada_Youtube_V1:")), all);
    assert.match(all, /#12237/);
    assert.match(all, /lamotrigina/);
  });

  it("roteiro que casa com a fala não avisa", () => {
    assert.deepEqual(warningsFor(say(script, 10)), []);
  });
});
