/**
 * test/video-trecho-fim-do-clipe-13489.test.ts
 *
 * #13489 — o trecho inserido entrava no fim da palavra do transcript, mas o
 * clipe já abre até o silêncio (borda de energia): 6 quadros da palavra tocavam
 * depois do trecho. Com `toClipEnd`, o ponto é o fim do clipe ajustado, limitado
 * ao começo do próximo item.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { telaMarkersFor, trechoInseridoAtFrames, type ResolvedItem, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";

const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] };
const item = (start: number, end: number, text: string, fala: string): ResolvedItem =>
  ({ interval: { start, end }, text, words: [], lastWordEnd: end, holdLimit: end, how: "explicit", fala }) as ResolvedItem;
const clip = (srcIn: number, srcOut: number, seqStart: number) => ({
  block: "comentario" as const, srcIn, srcOut, frameIn: srcIn * 30, frameOut: srcOut * 30, seqStart, seqEnd: seqStart + Math.round((srcOut - srcIn) * 30), scale: 60,
});
const telas = [{ id: "H3", texto: "primeira", tela: "x" }];

describe("#13489: ponto do trecho no fim do clipe ajustado", () => {
  it("palavra termina em 12,0 s e o clipe vai até 12,2 s (6 quadros): out no fim do clipe", () => {
    const clips = [clip(10, 12.2, 0)];
    const its = { comentario: [item(10, 12, "primeira", "H3")] };
    assert.equal(telaMarkersFor({ spec, clips }, its, 30, telas)[0].out, 60, "padrão: fim da palavra");
    assert.equal(telaMarkersFor({ spec, clips }, its, 30, telas, { toClipEnd: true })[0].out, 66);
  });

  it("clipe fundido com o próximo item: o out para onde o próximo item começa, não no fim do clipe", () => {
    const clips = [clip(10, 15, 0)];
    const its = { comentario: [item(10, 12, "primeira", "H3"), item(12.1, 15, "segunda", "H4")] };
    assert.equal(telaMarkersFor({ spec, clips }, its, 30, telas, { toClipEnd: true })[0].out, 63);
  });

  it("falas sobrepostas pela folga (pausa curta): o próximo item é achado pelo início, o out fica no fim da fala", () => {
    // A 10–12,2 s e B 12,1–15 s (folga de 0,3 s dos dois lados se sobrepõe) no mesmo clipe fundido 10–15 s.
    // Antes: B era descartado por começar antes do fim de A, `next` virava Infinity e o out ia a 150 (fim do clipe, depois de B).
    const clips = [clip(10, 15, 0)];
    const its = { comentario: [item(10, 12.2, "primeira", "H3"), item(12.1, 15, "segunda", "H4")] };
    assert.equal(telaMarkersFor({ spec, clips }, its, 30, telas)[0].out, 66, "padrão: fim da palavra");
    assert.equal(telaMarkersFor({ spec, clips }, its, 30, telas, { toClipEnd: true })[0].out, 66);
  });
});

describe("#13489: trechoInseridoAtFrames (call site do build)", () => {
  it("usa o fim do clipe ajustado (toClipEnd), não o fim da palavra", () => {
    const clips = [clip(10, 12.2, 0)];
    const its = { comentario: [item(10, 12, "primeira", "H3")] };
    const at = trechoInseridoAtFrames({ spec, clips }, its, 30, [{ id: "H3", texto: "primeira" }]);
    assert.equal(at.get("H3"), 66, "sem toClipEnd seria 60");
  });

  it("trecho sem item casado fica fora do mapa", () => {
    const clips = [clip(10, 12.2, 0)];
    const its = { comentario: [item(10, 12, "primeira", "H3")] };
    assert.equal(trechoInseridoAtFrames({ spec, clips }, its, 30, [{ id: "H9", texto: "outra" }]).has("H9"), false);
  });

  it("o build calcula o ponto do trecho pelo helper (guard de fonte)", () => {
    const src = readFileSync(new URL("../scripts/video-montagem.ts", import.meta.url), "utf8");
    assert.match(src, /const pos = trechoInseridoAtFrames\(p, resolved, source\.fps, trechosInseridos\)/);
  });
});
