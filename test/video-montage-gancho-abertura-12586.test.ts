/**
 * test/video-montage-gancho-abertura-12586.test.ts — a frase falada que abre o
 * vídeo é o Gancho, não o Título (#12586, pedido do editor na 261109).
 *
 * Com a frase em `gancho` e sem `titulo`:
 *   - as duas versões abrem no gancho (o vertical também), sem "falta titulo";
 *   - o PNG do título das verticais, o respiro do horizontal e a vinheta se
 *     ancoram no gancho, como se ancoravam no `titulo` quando a frase ia lá;
 *   - o roteiro rotula a linha "Gancho".
 * Com `titulo` (o modelo de antes), nada muda.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VINHETA_AFTER_SPEECH_S,
  VINHETA_BREATH_S,
  blockRunEndFrame,
  buildSequencePlan,
  defaultSequences,
  ganchoWarning,
  openingBlockOf,
  openingBlockOfClips,
  openingBlockOfOrder,
  screenTitleSpan,
  titleBreathS,
  vinhetaBreathBlock,
  vinhetaBreathFor,
  vinhetaSpan,
  type BlockKey,
  type ResolvedItem,
  type SequenceSpec,
  type VinhetaAsset,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { BLOCK_LABELS, decupagemPlanTemplate } from "../scripts/lib/diaria/video-montage-docs.ts";

const VIN: VinhetaAsset = { path: "vinheta.mov", durationS: 1.2, width: 1920, height: 1080, hasAudio: false };
const src = { fps: 30, durationS: 600 };
const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (start: number, end: number, text: string, words: Word[], holdLimit: number): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit,
  how: "explicit",
});

// O caso da 261109: o gancho falado 1,0–2,9 s, pausa no bruto até 5,0 s, e o resto.
const gancho = (holdLimit: number) => [item(1, 3, "teve um caso com uma espiã chinesa.", [w("teve", 1, 1.5), w("chinesa.", 1.6, 2.9)], holdLimit)];
const rest = {
  abertura: [item(5, 7, "olá eu sou o Pixel", [w("olá", 5, 5.5), w("Pixel", 5.6, 7)], 7)],
  resumo: [item(8, 10, "o resumo", [w("o", 8, 8.5), w("resumo", 8.6, 10)], 10)],
  resumo_curto: [item(11, 13, "o resumo curto", [w("o", 11, 11.5), w("curto", 11.6, 13)], 13)],
  comentario: [item(14, 16, "o comentário", [w("o", 14, 14.5), w("comentário", 14.6, 16)], 16)],
  fecho: [item(17, 19, "tchau", [w("tchau", 17, 18)], 19)],
};
const silences = [{ start: 2.95, end: 5 }, { start: 7.05, end: 8 }, { start: 10.05, end: 11 }, { start: 13.05, end: 14 }, { start: 16.05, end: 17 }];

const byTarget = (specs: SequenceSpec[], t: SequenceSpec["target"]) => specs.find((s) => s.target === t)!;

describe("#12586: qual é o bloco de abertura", () => {
  it("titulo com item vence (modelo de antes); sem ele, o gancho; sem nenhum, titulo", () => {
    assert.equal(openingBlockOf({ titulo: [{}], gancho: [{}] }), "titulo");
    assert.equal(openingBlockOf({ titulo: [{}] }), "titulo");
    assert.equal(openingBlockOf({ gancho: [{}] }), "gancho");
    assert.equal(openingBlockOf({ titulo: [], gancho: [{}] }), "gancho");
    assert.equal(openingBlockOf({}), "titulo");
  });

  it("pela ordem: titulo se está nela, senão gancho, senão nenhum (entrevista)", () => {
    assert.equal(openingBlockOfOrder(["gancho", "titulo", "abertura"]), "titulo");
    assert.equal(openingBlockOfOrder(["gancho", "abertura"]), "gancho");
    assert.equal(openingBlockOfOrder(["abertura", "comentario"]), null);
  });
});

describe("#12586: as sequências padrão com o gancho falado de abertura", () => {
  it("o gancho abre as duas versões, sem titulo na ordem", () => {
    const specs = defaultSequences("V1", "monologo", "gancho");
    assert.deepEqual(byTarget(specs, "youtube").order, ["gancho", "abertura", "resumo", "comentario", "cta_yt", "fecho"]);
    assert.deepEqual(byTarget(specs, "outras-redes").order, ["gancho", "resumo_curto", "comentario", "cta_vertical", "fecho"]);
  });

  it("modelo de antes (default e titulo explícito) fica idêntico", () => {
    const before = [
      ["gancho", "titulo", "abertura", "resumo", "comentario", "cta_yt", "fecho"],
      ["titulo", "resumo_curto", "comentario", "cta_vertical", "fecho"],
    ];
    assert.deepEqual(defaultSequences("V1", "monologo").map((s) => s.order), before);
    assert.deepEqual(defaultSequences("V1", "monologo", "titulo").map((s) => s.order), before);
    // Entrevista não tem gancho nem título: o parâmetro não muda nada.
    assert.deepEqual(defaultSequences("V1", "entrevista", "gancho"), defaultSequences("V1", "entrevista"));
  });

  it("o blocks.json com o gancho e sem titulo monta as duas versões sem bloco faltando nem aviso de gancho", () => {
    const resolved = { gancho: gancho(4.9), ...rest };
    for (const spec of defaultSequences("V1", "monologo", openingBlockOf(resolved))) {
      const p = buildSequencePlan(spec, resolved, silences, src, { breathAfter: vinhetaBreathFor(spec) });
      assert.deepEqual(p.missingBlocks.filter((k) => !k.startsWith("cta")), [], `${spec.name}: ${p.missingBlocks}`);
      assert.equal(p.clips[0].block, "gancho", `${spec.name} abre no gancho`);
      assert.equal(ganchoWarning(p), null);
      assert.ok(p.script.startsWith("teve um caso"), p.script);
    }
  });

  it("regressão: antes do #12586 o mesmo blocks.json deixava a vertical sem a frase de abertura e acusava falta de titulo", () => {
    const resolved = { gancho: gancho(4.9), ...rest };
    const vOld = byTarget(defaultSequences("V1", "monologo"), "outras-redes");
    const p = buildSequencePlan(vOld, resolved, silences, src, {});
    assert.ok(p.missingBlocks.includes("titulo"));
    assert.ok(!p.clips.some((c) => c.block === "gancho"));
  });
});

describe("#12586: PNG do título, respiro e vinheta seguem na mesma frase", () => {
  const resolved = { gancho: gancho(4.9), ...rest };
  const specs = defaultSequences("V1", "monologo", "gancho");
  const H = byTarget(specs, "youtube");
  const V = byTarget(specs, "outras-redes");

  it("o respiro de 0,7 s do horizontal vai depois do gancho (nunca na vertical)", () => {
    assert.equal(vinhetaBreathBlock(H), "gancho");
    assert.deepEqual(vinhetaBreathFor(H), { gancho: VINHETA_BREATH_S });
    assert.equal(vinhetaBreathFor(V), undefined);
    const p = buildSequencePlan(H, resolved, silences, src, { breathAfter: vinhetaBreathFor(H) });
    const g = p.clips.filter((c) => c.block === "gancho");
    assert.equal(g[g.length - 1].srcOut, 3.6, "0,7 s depois da última palavra (2,9 s)");
    assert.equal(p.titleSpeechEndS, 2.9);
    assert.equal(titleBreathS(p, 30), 0.7);
  });

  it("a vinheta entra 0,3 s depois da última palavra do gancho no horizontal, e no fim do gancho na vertical", () => {
    const ph = buildSequencePlan(H, resolved, silences, src, { breathAfter: vinhetaBreathFor(H) });
    const last = ph.clips.filter((c) => c.block === "gancho").at(-1)!;
    const vs = vinhetaSpan(ph, 30, VIN);
    assert.ok(vs?.afterTitle);
    assert.equal(vs.start, last.seqStart + (Math.round(2.9 * 30) - last.frameIn) + Math.round(VINHETA_AFTER_SPEECH_S * 30));
    const pv = buildSequencePlan(V, resolved, silences, src, { breathAfter: vinhetaBreathFor(V) });
    const vv = vinhetaSpan(pv, 30, VIN);
    assert.ok(vv?.afterTitle, "não cai no fallback de 2 s");
    assert.equal(vv.start, blockRunEndFrame(pv.clips, "gancho", 30));
  });

  it("o PNG do título da vertical fica na duração do gancho", () => {
    const pv = buildSequencePlan(V, resolved, silences, src, {});
    const span = screenTitleSpan(pv, 30);
    assert.equal(span?.block, "gancho");
    assert.equal(span?.start, 0);
    assert.equal(span?.end, blockRunEndFrame(pv.clips, "gancho", 30));
  });

  it("modelo de antes: com titulo e gancho, tudo segue ancorado no titulo", () => {
    const titulo = [item(3.2, 4.8, "o título", [w("o", 3.2, 3.5), w("título", 3.6, 4.7)], 4.9)];
    const old = { gancho: gancho(3.1), titulo, ...rest };
    const [h, v] = defaultSequences("V1", "monologo", openingBlockOf(old));
    assert.deepEqual(vinhetaBreathFor(h), { titulo: VINHETA_BREATH_S });
    const ph = buildSequencePlan(h, old, [], src, { breathAfter: vinhetaBreathFor(h) });
    assert.equal(ph.titleSpeechEndS, 4.7);
    assert.equal(openingBlockOfClips(ph.clips), "titulo");
    const pv = buildSequencePlan(v, old, [], src, {});
    assert.equal(screenTitleSpan(pv, 30)?.block, "titulo");
    assert.ok(!pv.clips.some((c) => c.block === "gancho"), "o gancho do #12093 segue só no horizontal");
  });
});

describe("#12586: nomenclatura do roteiro e do molde", () => {
  it("o roteiro rotula a frase de abertura como Gancho", () => {
    const key: BlockKey = openingBlockOf({ gancho: [{}] });
    assert.equal(BLOCK_LABELS[key], "Gancho");
  });

  it("o molde da decupagem diz onde vai a frase falada de abertura", () => {
    const tpl = decupagemPlanTemplate("261109", []) as { _como: string };
    assert.match(tpl._como, /abre o vídeo vai em gancho/);
  });
});
