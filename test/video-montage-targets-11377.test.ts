/**
 * #11377 — item de bloco com `targets`/`skip` (entra só em algumas versões) e
 * `[aviso]` quando a vertical montada passa de 180 s (teto do Shorts), no build
 * e no roteiro do Gate 2.
 *
 * Caso real: na 261028 as verticais saíram com 3:31 e o corte de parte do
 * comentário só nelas virou instrução manual no Doc, porque o `blocks.json`
 * não deixava um item entrar só no horizontal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSequencePlan,
  defaultSequences,
  itemInTarget,
  parseBlocksFile,
  resolveBlocks,
  type BlocksFile,
  type SequenceSpec,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { roteiroMarkdown, SHORTS_MAX_S, shortsOverS, shortsWarning } from "../scripts/lib/diaria/video-montage-docs.ts";

const FPS = 30;
const SOURCE = { fps: FPS, durationS: 400 };

/** Uma palavra por segundo em [a, b), para os intervalos explícitos terem fala dentro. */
function wordsIn(a: number, b: number, prefix: string): Word[] {
  const out: Word[] = [];
  for (let t = a; t < b; t++) out.push({ start: t + 0.1, end: t + 0.9, text: ` ${prefix}${t}` });
  return out;
}

const [YT, OUT] = defaultSequences();
const IG: SequenceSpec = { ...OUT, target: "instagram", name: "Diaria comentada_Instagram_V1" };

describe("itemInTarget (#11377)", () => {
  it("sem targets nem skip, entra em todas", () => {
    for (const t of ["youtube", "instagram", "outras-redes"] as const) assert.equal(itemInTarget({}, t), true);
  });
  it("targets: só nas listadas; skip: todas menos as listadas", () => {
    assert.equal(itemInTarget({ targets: ["youtube"] }, "youtube"), true);
    assert.equal(itemInTarget({ targets: ["youtube"] }, "instagram"), false);
    assert.equal(itemInTarget({ skip: ["instagram", "outras-redes"] }, "youtube"), true);
    assert.equal(itemInTarget({ skip: ["instagram", "outras-redes"] }, "outras-redes"), false);
  });
});

describe("blocks.json: validação de targets/skip (#11377)", () => {
  const base = (item: Record<string, unknown>) => ({ edition: "261028", blocks: { comentario: [item] } });

  it("aceita targets ou skip com versões conhecidas", () => {
    assert.equal(parseBlocksFile(base({ start: 1, end: 2, targets: ["youtube"] })).ok, true);
    assert.equal(parseBlocksFile(base({ text: "Frase.", skip: ["instagram", "outras-redes"] })).ok, true);
  });

  it("recusa versão desconhecida, lista vazia, não-lista e os dois juntos", () => {
    const errs = (item: Record<string, unknown>) => {
      const r = parseBlocksFile(base(item));
      assert.equal(r.ok, false);
      return r.ok ? [] : r.errors;
    };
    assert.match(errs({ start: 1, end: 2, targets: ["tiktok"] }).join("\n"), /comentario\[0\]: targets precisa ser uma lista não vazia/);
    assert.match(errs({ start: 1, end: 2, skip: [] }).join("\n"), /comentario\[0\]: skip precisa ser uma lista não vazia/);
    assert.match(errs({ start: 1, end: 2, skip: "instagram" }).join("\n"), /skip precisa ser uma lista/);
    assert.match(errs({ start: 1, end: 2, targets: ["youtube"], skip: ["instagram"] }).join("\n"), /targets e skip juntos/);
  });
});

describe("item com targets entra só na sequência indicada (#11377)", () => {
  // Comentário em 3 trechos; o do meio (o corte da Hotmart, na 261028) só no horizontal.
  const words = [...wordsIn(0, 10, "c"), ...wordsIn(10, 20, "h"), ...wordsIn(20, 30, "f"), ...wordsIn(30, 33, "t")];
  const file: BlocksFile = {
    edition: "261028",
    blocks: {
      comentario: [{ start: 0, end: 10 }, { start: 10, end: 20, targets: ["youtube"] }, { start: 20, end: 30 }],
      fecho: [{ start: 30, end: 31 }, { start: 31, end: 33, skip: ["instagram", "outras-redes"] }],
    },
  };
  const { blocks, errors } = resolveBlocks(file, words, { durationS: SOURCE.durationS });
  const only = (spec: SequenceSpec) => ({ ...spec, order: ["comentario", "fecho"] as SequenceSpec["order"] });
  const yt = buildSequencePlan(only(YT), blocks, [], SOURCE);
  const ig = buildSequencePlan(only(IG), blocks, [], SOURCE);
  const out = buildSequencePlan(only(OUT), blocks, [], SOURCE);
  const inRange = (p: typeof yt, a: number, b: number) => p.clips.some((c) => c.srcIn < b && c.srcOut > a);

  it("resolve sem erro e o escopo segue no item resolvido", () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(blocks.comentario?.[1].targets, ["youtube"]);
    assert.equal("targets" in (blocks.comentario?.[0] ?? {}), false);
  });

  it("o trecho com targets youtube está no horizontal e fora das verticais", () => {
    assert.equal(inRange(yt, 10, 20), true);
    assert.equal(inRange(ig, 10, 20), false);
    assert.equal(inRange(out, 10, 20), false);
    // O resto do comentário segue nas três.
    for (const p of [yt, ig, out]) {
      assert.equal(inRange(p, 0, 10), true);
      assert.equal(inRange(p, 20, 30), true);
    }
    assert.ok(yt.durationFrames > ig.durationFrames);
    assert.deepEqual(ig.dropped, []);
    assert.deepEqual(ig.missingBlocks, []);
  });

  it("o respiro do fecho vai no último item que ENTRA na versão", () => {
    const lastIg = ig.clips[ig.clips.length - 1];
    // Comentário e fecho são contíguos no bruto: um clipe só desde o #11503, com o fecho no último pedaço.
    assert.equal(lastIg.parts?.at(-1)?.block ?? lastIg.block, "fecho");
    // Sem o item 31–33 na vertical, o respiro sai do fim da palavra 30,9 s, preso antes da palavra seguinte do bruto.
    assert.ok(lastIg.srcOut > 30.9 && lastIg.srcOut <= 31.1, `srcOut ${lastIg.srcOut}`);
    assert.equal(inRange(yt, 31.2, 33), true);
  });

  it("bloco com todos os itens fora da versão não é 'falta no blocks.json'", () => {
    const f2: BlocksFile = { edition: "261028", blocks: { comentario: [{ start: 0, end: 10, targets: ["youtube"] }] } };
    const r = resolveBlocks(f2, words, { durationS: SOURCE.durationS });
    const p = buildSequencePlan({ ...IG, order: ["comentario"] }, r.blocks, [], SOURCE);
    assert.deepEqual(p.missingBlocks, []);
    assert.equal(p.clips.length, 0);
    const md = roteiroMarkdown("261028", [p], r.blocks, FPS);
    assert.match(md, /\| Comentário \| \(nenhum item nesta versão: targets\/skip\) \|/);
  });

  it("o roteiro mostra o item só na versão dele, com o escopo na coluna Bruto", () => {
    const md = roteiroMarkdown("261028", [yt, ig], blocks, FPS);
    const [ytSec, igSec] = md.split(/^## Vertical Instagram/m);
    assert.match(ytSec, /\(só youtube\)/);
    assert.match(ytSec, /\(fora de instagram, outras-redes\)/);
    assert.doesNotMatch(igSec, /só youtube|fora de instagram/);
    const rows = (s: string) => s.match(/^\|.*\| \d\d:\d\d\.\d–/gm)?.length ?? 0;
    assert.equal(rows(ytSec), 3 + 2, "3 itens do comentário + 2 do fecho no horizontal");
    assert.equal(rows(igSec), 2 + 1, "2 itens do comentário + 1 do fecho na vertical");
  });
});

describe("aviso de vertical acima de 180 s (#11377)", () => {
  const plan = (spec: SequenceSpec, seconds: number) => ({ spec, durationFrames: Math.round(seconds * FPS) });

  it("vertical de 181 s gera o aviso dizendo quanto passou", () => {
    const w = shortsWarning(plan(IG, 181), FPS);
    assert.ok(w);
    assert.match(w, /Diaria comentada_Instagram_V1: 03:01\.0 \(181\.0 s\), 1\.0 s acima do teto do Shorts \(180 s\)/);
    assert.match(w, /"skip"\/"targets"/);
  });

  it("180 s exatos, vertical curta e o horizontal longo não avisam", () => {
    assert.equal(shortsWarning(plan(OUT, SHORTS_MAX_S), FPS), null);
    assert.equal(shortsWarning(plan(OUT, 90), FPS), null);
    assert.equal(shortsWarning(plan(YT, 400), FPS), null);
    assert.equal(shortsOverS(YT, 400), 0);
    assert.equal(shortsOverS(IG, 211), 31);
  });

  it("o roteiro (Gate 2) mostra o aviso na seção da vertical que passa, e só nela", () => {
    const words = wordsIn(0, 181, "w");
    const file: BlocksFile = { edition: "261028", blocks: { comentario: [{ start: 0, end: 181 }] } };
    const { blocks } = resolveBlocks(file, words, { durationS: SOURCE.durationS });
    const ps = [YT, IG].map((s) => buildSequencePlan({ ...s, order: ["comentario"] }, blocks, [], SOURCE));
    assert.equal(ps[1].durationFrames, 181 * FPS);
    const md = roteiroMarkdown("261028", ps, blocks, FPS);
    const [ytSec, igSec] = md.split(/^## Vertical Instagram/m);
    assert.doesNotMatch(ytSec, /\[aviso\]/);
    assert.match(igSec, /\*\*\[aviso\] Diaria comentada_Instagram_V1: 03:01\.0 \(181\.0 s\), 1\.0 s acima do teto do Shorts/);
  });
});
