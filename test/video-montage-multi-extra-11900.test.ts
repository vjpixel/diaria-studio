/**
 * #11900 item (a): mais de uma vertical extra na montagem. Antes a sequência
 * era identificada pelo `target` (único por plano), e o corte ocupava uma das
 * chaves `instagram`/`outras-redes`: cabia 1 extra só, e os arquivos de
 * trabalho (`seq-{target}.wav`, `previa-{target}`, `review-{target}.json`), o
 * `--seq` do CLI e os `targets`/`skip` dos itens não sabiam distinguir duas.
 * Agora a identidade é o slug do corte (`sequenceKey`); sem corte segue o
 * destino, então o `blocks.json` antigo (1 extra, `targets: ["instagram"]`)
 * monta igual.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyVocabularyToWords,
  buildSequencePlan,
  buildXmeml,
  defaultSequences,
  itemInTarget,
  parseBlocksFile,
  resolveBlocks,
  sequenceInList,
  sequenceKey,
  type BlocksFile,
  type SequenceSpec,
  type SourceInfo,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { roteiroMarkdown } from "../scripts/lib/diaria/video-montage-docs.ts";
import { pickPlans, previewFileName, reviewFinalSequence, reviewFinalTarget } from "../scripts/video-montagem.ts";
import { extraVerticalHook, extraVerticalSpecs } from "../scripts/lib/diaria/extra-verticals.ts";

const FPS = 30;
const [YT, OUT] = defaultSequences();
const corte = (slug: string, target: SequenceSpec["target"] = "instagram"): SequenceSpec => ({
  ...OUT,
  target,
  name: `Diaria comentada_Vertical_V1-${slug}`,
  corte: slug,
  screenTitle: `Título ${slug}`,
});
const SOBERANA = corte("soberana");
const CHIPS = corte("chips");

function wordsIn(a: number, b: number, prefix: string): Word[] {
  const out: Word[] = [];
  for (let t = a; t < b; t++) out.push({ start: t + 0.1, end: t + 0.9, text: ` ${prefix}${t}` });
  return out;
}

describe("sequenceKey / sequenceInList", () => {
  it("a chave é o slug do corte, ou o destino sem corte", () => {
    assert.equal(sequenceKey(YT), "youtube");
    assert.equal(sequenceKey(OUT), "outras-redes");
    assert.equal(sequenceKey(SOBERANA), "soberana");
  });
  it("corte casa pelo slug e pelo destino; sequência sem corte só pelo destino", () => {
    assert.equal(sequenceInList(["soberana"], SOBERANA), true);
    assert.equal(sequenceInList(["instagram"], SOBERANA), true, "compatível com o blocks.json de 1 extra");
    assert.equal(sequenceInList(["soberana"], CHIPS), false);
    assert.equal(sequenceInList(["soberana"], OUT), false);
    assert.equal(sequenceInList(["outras-redes"], "outras-redes"), true);
  });
});

describe("blocks.json com 2 verticais extras", () => {
  const file = (sequences: unknown[], comentario: unknown[] = [{ start: 1, end: 2 }], extra: Record<string, unknown> = {}) => ({
    edition: "261103",
    sequences,
    blocks: { comentario },
    ...extra,
  });
  const errs = (...a: Parameters<typeof file>) => {
    const r = parseBlocksFile(file(...a));
    return r.ok ? [] : r.errors;
  };

  it("aceita 2 cortes de mesmo destino, com itens mirando cada um pelo slug", () => {
    assert.deepEqual(errs([YT, OUT, SOBERANA, CHIPS], [{ start: 1, end: 2, targets: ["soberana"] }, { start: 3, end: 4, skip: ["chips", "youtube"] }]), []);
  });

  it("vocabulário do blocks.json pode mirar um corte pelo slug", () => {
    assert.deepEqual(errs([YT, OUT, SOBERANA, CHIPS], undefined, { vocabulary: [{ pattern: "chip", replacement: "chip", targets: ["chips"] }] }), []);
  });

  it("recusa slug repetido, slug com nome de destino e item citando corte inexistente", () => {
    assert.match(errs([YT, OUT, SOBERANA, { ...SOBERANA, target: "outras-redes" }]).join("\n"), /sequences\[3\]: corte soberana repetido/);
    assert.match(errs([YT, OUT, { ...corte("instagram"), name: "Diaria comentada_Vertical_V1-instagram" }]).join("\n"), /corte "instagram" é nome de destino/);
    assert.match(errs([YT, OUT, SOBERANA], [{ start: 1, end: 2, targets: ["chips"] }]).join("\n"), /comentario\[0\]: targets precisa ser uma lista não vazia de youtube\/instagram\/outras-redes\/soberana/);
  });

  it("sem sequences, slug de corte em targets segue recusado (não há corte no plano)", () => {
    const r = parseBlocksFile({ edition: "261103", blocks: { comentario: [{ start: 1, end: 2, targets: ["soberana"] }] } });
    assert.equal(r.ok, false);
  });

  it("o blocks.json antigo de 1 extra (target instagram, itens com targets instagram) segue válido", () => {
    assert.deepEqual(errs([YT, OUT, SOBERANA], [{ start: 1, end: 2, targets: ["instagram"] }, { start: 3, end: 4, targets: ["outras-redes"] }]), []);
  });
});

describe("cada vertical extra monta só os itens dela", () => {
  const SOURCE = { fps: FPS, durationS: 400 };
  const words = [...wordsIn(0, 10, "a"), ...wordsIn(10, 20, "s"), ...wordsIn(20, 30, "c"), ...wordsIn(30, 40, "f")];
  const file: BlocksFile = {
    edition: "261103",
    sequences: [YT, OUT, SOBERANA, CHIPS],
    blocks: {
      comentario: [
        { start: 0, end: 10, targets: ["youtube", "outras-redes"] },
        { start: 10, end: 20, targets: ["soberana"] },
        { start: 20, end: 30, targets: ["chips"] },
        { start: 30, end: 40 },
      ],
    },
  };
  const { blocks, errors } = resolveBlocks(file, words, { durationS: SOURCE.durationS });
  const only = (spec: SequenceSpec) => ({ ...spec, order: ["comentario"] as SequenceSpec["order"] });
  const [yt, out, sob, chips] = [YT, OUT, SOBERANA, CHIPS].map((s) => buildSequencePlan(only(s), blocks, [], SOURCE));
  const inRange = (p: typeof yt, a: number, b: number) => p.clips.some((c) => c.srcIn < b && c.srcOut > a);

  it("resolve sem erro", () => assert.deepEqual(errors, []));

  it("os dois cortes de mesmo destino não se misturam", () => {
    assert.equal(inRange(sob, 10, 20), true);
    assert.equal(inRange(sob, 20, 30), false);
    assert.equal(inRange(chips, 20, 30), true);
    assert.equal(inRange(chips, 10, 20), false);
    for (const p of [sob, chips]) {
      assert.equal(inRange(p, 0, 10), false);
      assert.equal(inRange(p, 30, 40), true);
    }
    assert.equal(inRange(out, 10, 30), false);
    assert.equal(inRange(yt, 0, 10), true);
  });

  it("o roteiro do Gate 2 nomeia cada corte e mostra só os itens dele", () => {
    const md = roteiroMarkdown("261103", [sob, chips], blocks, FPS);
    const [, sobSec, chipsSec] = md.split(/^## Vertical (?:soberana|chips)/m);
    assert.ok(sobSec && chipsSec, md);
    assert.match(sobSec, /\(só soberana\)/);
    assert.doesNotMatch(sobSec, /só chips/);
    assert.match(chipsSec, /\(só chips\)/);
  });

  it("o XML leva uma sequência por corte, com id distinto", () => {
    const src: SourceInfo = { path: "G:/x/bruto.mp4", fps: FPS, durationS: 400, width: 3840, height: 2160, mirrored: false };
    const xml = buildXmeml([yt, out, sob, chips], src, { faceX: 0.5, eyeY: 0.5 });
    const ids = [...xml.matchAll(/<sequence id="([^"]+)">/g)].map((m) => m[1]);
    assert.deepEqual(ids, ["seq-1-youtube", "seq-2-outras-redes", "seq-3-soberana", "seq-4-chips"]);
  });

  it("vocabulário com targets de um corte só vale nele", () => {
    const rules = [{ pattern: "a1", replacement: "Z", targets: ["chips"] }];
    const ws = wordsIn(1, 2, "a");
    assert.equal(applyVocabularyToWords(ws, rules, CHIPS)[0].text, "Z");
    assert.equal(applyVocabularyToWords(ws, rules, SOBERANA)[0].text, "a1");
  });

  it("o gancho de cada extra vem do resumo_curto dela", () => {
    const f: BlocksFile = {
      edition: "261103",
      sequences: [YT, OUT, { ...SOBERANA, screenTitle: undefined }, CHIPS],
      blocks: { resumo_curto: [{ text: "Sobre soberania.", targets: ["soberana"] }, { text: "Sobre chips.", targets: ["chips"] }] },
    };
    assert.deepEqual(extraVerticalSpecs(f).map((s) => s.corte), ["soberana", "chips"]);
    assert.equal(extraVerticalHook(f, SOBERANA)?.text, "Sobre soberania.");
    assert.equal(extraVerticalHook(f, CHIPS)?.text, "Sobre chips.");
  });
});

describe("CLI: --seq e arquivos por sequência", () => {
  const plans = [YT, OUT, SOBERANA, CHIPS].map((spec) => ({ spec }));

  it("--seq pelo slug escolhe aquele corte; o destino escolhe a sequência sem corte", () => {
    assert.deepEqual(pickPlans(plans, "chips", true, true).map((p) => sequenceKey(p.spec)), ["chips"]);
    assert.deepEqual(pickPlans(plans, "outras-redes", true, true).map((p) => sequenceKey(p.spec)), ["outras-redes"]);
    assert.deepEqual(pickPlans(plans, undefined, true).map((p) => sequenceKey(p.spec)), ["outras-redes", "soberana", "chips"]);
  });

  it("destino que casa 2 cortes é ambíguo na prévia, mas o srt pega os dois", () => {
    assert.throws(() => pickPlans(plans, "instagram", true, true), /2 sequências verticais com esse destino; escolha pelo corte \(soberana, chips\)/);
    assert.equal(pickPlans(plans, "instagram", true).length, 2);
  });

  it("compatível: blocks.json de 1 extra, --seq instagram acha o corte", () => {
    const legacy = [YT, OUT, SOBERANA].map((spec) => ({ spec }));
    assert.deepEqual(pickPlans(legacy, "instagram", true, true).map((p) => sequenceKey(p.spec)), ["soberana"]);
    assert.throws(() => pickPlans(legacy, "tiktok", true, true), /há: outras-redes, soberana/);
  });

  it("a prévia de cada corte tem nome próprio", () => {
    assert.notEqual(previewFileName("261103", sequenceKey(SOBERANA)), previewFileName("261103", sequenceKey(CHIPS)));
    assert.equal(previewFileName("261103", sequenceKey(OUT)), "261103 - previa outras-redes.mp4");
  });

  it("review-final: cada export de corte vai para a sequência dele, e --seq aceita o slug", () => {
    const specs = [YT, OUT, SOBERANA, CHIPS];
    assert.deepEqual(reviewFinalSequence("x/Diaria comentada_Vertical_V1-chips.mp4", undefined, specs), { target: "instagram", key: "chips" });
    assert.deepEqual(reviewFinalSequence("x/Diaria comentada_Vertical_V1-soberana.mp4", undefined, specs), { target: "instagram", key: "soberana" });
    assert.deepEqual(reviewFinalSequence("x/qualquer.mp4", "chips", specs), { target: "instagram", key: "chips" });
    assert.deepEqual(reviewFinalSequence("x/Diaria comentada_Vertical_V1.mp4", undefined, specs), { target: "outras-redes", key: "outras-redes" });
    assert.throws(() => reviewFinalSequence("x/qualquer.mp4", "tiktok", specs), /--seq deve ser youtube, instagram, outras-redes, soberana, chips/);
    assert.equal(reviewFinalTarget("x/Diaria comentada_Vertical_V1-chips.mp4", undefined, specs), "instagram");
  });
});

describe("itemInTarget aceita a sequência inteira", () => {
  it("item mirando um corte entra só nele", () => {
    assert.equal(itemInTarget({ targets: ["chips"] }, CHIPS), true);
    assert.equal(itemInTarget({ targets: ["chips"] }, SOBERANA), false);
    assert.equal(itemInTarget({ skip: ["chips"] }, SOBERANA), true);
    assert.equal(itemInTarget({ skip: ["instagram"] }, CHIPS), false);
  });
});
