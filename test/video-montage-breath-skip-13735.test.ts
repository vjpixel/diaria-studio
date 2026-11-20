/**
 * test/video-montage-breath-skip-13735.test.ts — trecho tirado de dentro do
 * respiro da vinheta (#13735). Na 261116 o respiro de 1,7 s depois do gancho
 * saiu do próprio take, e dentro dele o editor abaixa a cabeça e fecha os
 * olhos. O `build` só montava o respiro como trecho contínuo depois da última
 * palavra; o item de abertura do `blocks.json` ganha `breathSkip`, que tira o
 * intervalo do respiro com corte e troca de zoom, como numa pausa removida.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  breathSkipCut,
  buildSequencePlan,
  parseBlocksFile,
  resolveBlocks,
  titleBreathS,
  vinhetaBreathFor,
  vinhetaSpan,
  type BlocksFile,
  type ResolvedItem,
  type SequenceSpec,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";

const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "abertura"], scales: [60, 85] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] };
const src = { fps: 30, durationS: 600 };
const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (start: number, end: number, text: string, words: Word[], holdLimit: number, extra: Partial<ResolvedItem> = {}): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit,
  how: "explicit",
  ...extra,
} as ResolvedItem);

// Título falado 1,0–2,9 s; pausa no bruto 2,95–6,0 s (o aceno em 3,1–3,5); abertura a partir de 6,0 s.
const ACENO = { start: 3.1, end: 3.5 };
const resolved = (breathSkip?: ResolvedItem["breathSkip"], holdLimit = 5.9) => ({
  titulo: [item(1, 3, "a vinheta", [w("a", 1, 1.5), w("vinheta", 1.6, 2.9)], holdLimit, breathSkip ? { breathSkip } : {})],
  abertura: [item(6, 8, "olá eu sou", [w("olá", 6, 6.5), w("eu", 6.6, 7), w("sou", 7.1, 8)], 8)],
});
const silences = [{ start: 2.95, end: 6 }, { start: 10, end: 12 }];

describe("#13735: breathSkipCut", () => {
  it("tira o trecho e estende o respiro no bruto pelo mesmo tanto", () => {
    const c = breathSkipCut(2.9, 5.9, 1.7, [ACENO], 0.6);
    assert.equal(c.firstEnd, 3.1);
    assert.deepEqual(c.pieces, [{ start: 3.5, end: 5 }]);
    assert.equal(c.end, 5);
    assert.equal(c.removed, 0.4);
    assert.deepEqual(c.outside, []);
  });

  it("a extensão para na palavra seguinte do bruto (limit)", () => {
    const c = breathSkipCut(2.9, 4.6, 1.7, [ACENO], 0.6);
    assert.equal(c.end, 4.6);
    assert.deepEqual(c.pieces, [{ start: 3.5, end: 4.6 }]);
  });

  it("pedaço abaixo de um clipe sai e conta no que foi tirado; trecho fora do respiro é ignorado", () => {
    const c = breathSkipCut(2.9, 5.9, 1.7, [{ start: 3.05, end: 3.5 }, { start: 3.7, end: 5.5 }, { start: 1, end: 2 }], 0.6);
    // 3,05–3,5 e 3,7–5,5 tirados: estende até 2,9 + 1,7 + 2,25 = 6,85, preso em 5,9. Sobram 3,5–3,7 (curto) e 5,5–5,9 (curto).
    assert.equal(c.end, 5.9);
    assert.deepEqual(c.pieces, []);
    assert.deepEqual(c.short, [{ start: 3.5, end: 3.7 }, { start: 5.5, end: 5.9 }]);
    assert.deepEqual(c.outside, [{ start: 1, end: 2 }]);
  });
});

describe("#13735: buildSequencePlan com breathSkip", () => {
  it("o respiro vira dois clipes, com corte e troca de zoom, e conta inteiro no respiro da vinheta", () => {
    for (const spec of [SPEC_H, SPEC_V]) {
      const p = buildSequencePlan(spec, resolved([ACENO]), silences, src, { breathAfter: vinhetaBreathFor(spec) });
      const titulo = p.clips.filter((c) => c.block === "titulo");
      assert.equal(titulo.length, 2, spec.name);
      assert.equal(titulo[0].srcOut, 3.1, spec.name);
      assert.equal(titulo[1].srcIn, 3.5, spec.name);
      assert.equal(titulo[1].srcOut, 5, spec.name);
      assert.equal(titulo[1].filler, true, spec.name);
      assert.notEqual(titulo[0].scale, titulo[1].scale, `${spec.name}: troca de zoom no corte do aceno`);
      // Nenhum quadro do aceno no vídeo.
      assert.ok(!p.clips.some((c) => c.srcIn < ACENO.end - 1e-6 && c.srcOut > ACENO.start + 1e-6), spec.name);
      assert.equal(titleBreathS(p, 30), 1.7, spec.name);
      assert.equal(p.warnings, undefined, spec.name);
      assert.match((p.premises ?? []).join("\n"), /breathSkip, #13735/, spec.name);
      // A vinheta termina dentro do respiro, antes da abertura.
      const vs = vinhetaSpan(p, 30, { durationS: 1.3 });
      assert.ok(vs);
      assert.ok(vs.end <= titulo[1].seqEnd, `${spec.name}: vinheta até ${vs.end}, respiro até ${titulo[1].seqEnd}`);
    }
  });

  it("sem breathSkip, o respiro segue um trecho contínuo (inclui o aceno)", () => {
    const p = buildSequencePlan(SPEC_H, resolved(), silences, src, { breathAfter: vinhetaBreathFor(SPEC_H) });
    const titulo = p.clips.filter((c) => c.block === "titulo");
    assert.equal(titulo.length, 1);
    assert.equal(titulo[0].srcOut, 4.6);
  });

  it("breathSkip fora do respiro vira aviso e não muda o plano", () => {
    const p = buildSequencePlan(SPEC_H, resolved([{ start: 20, end: 21 }]), silences, src, { breathAfter: vinhetaBreathFor(SPEC_H) });
    assert.equal(p.clips.filter((c) => c.block === "titulo").at(-1)!.srcOut, 4.6);
    assert.match((p.warnings ?? []).join("\n"), /fora do respiro.*#13735/);
  });

  it("breathSkip num item que não recebe o respiro vira aviso", () => {
    const r = resolved();
    r.abertura[0] = { ...r.abertura[0], breathSkip: [{ start: 6.1, end: 6.2 }] };
    const p = buildSequencePlan(SPEC_H, r, silences, src, { breathAfter: vinhetaBreathFor(SPEC_H) });
    assert.match((p.warnings ?? []).join("\n"), /abertura\[0\] tem breathSkip.*ignorado \(#13735\)/);
  });
});

describe("#13735: blocks.json", () => {
  const base = (it: Record<string, unknown>) => ({ edition: "261116", blocks: { titulo: [{ text: "a vinheta", ...it }] } });

  it("aceita breathSkip e o leva até o item resolvido", () => {
    const r = parseBlocksFile(base({ breathSkip: [{ start: 3.05, end: 3.5 }] }));
    assert.equal(r.ok, true);
    const file = (r as { ok: true; file: BlocksFile }).file;
    const { blocks } = resolveBlocks(file, [w("a", 1, 1.5), w("vinheta", 1.6, 2.9)], { durationS: 600 });
    assert.deepEqual(blocks.titulo?.[0].breathSkip, [{ start: 3.05, end: 3.5 }]);
  });

  it("recusa lista vazia, não-lista e intervalo inválido", () => {
    const errs = (v: unknown) => {
      const r = parseBlocksFile(base({ breathSkip: v }));
      assert.equal(r.ok, false);
      return r.ok ? "" : r.errors.join("\n");
    };
    assert.match(errs([]), /breathSkip precisa ser uma lista/);
    assert.match(errs({ start: 1, end: 2 }), /breathSkip precisa ser uma lista/);
    assert.match(errs([{ start: 2, end: 1 }]), /breathSkip\[0\] precisa ser \{ start, end \}/);
    assert.match(errs([{ start: 1, end: 2, x: 1 }]), /breathSkip\[0\]/);
  });
});
