/**
 * #13792: a proposta de blocos (#13743) passa a última fala `cta_*` para o
 * bloco `fecho`; o aviso "sai sem CTA nenhum" do build (#12571) só olhava
 * clipes de `cta_*` e disparava com o CTA falado no fecho.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { propostaBlocosDoRoteiro } from "../scripts/lib/diaria/roteiro-videos.ts";
import { clipsHaveSpokenCta, textoDeCta } from "../scripts/lib/diaria/video-sequence-fecho.ts";
import { buildSequencePlan, CTA_BLOCKS, type ResolvedItem, type SequenceSpec, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { sequenceHasSpokenCta } from "../scripts/video-montagem.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261118-v9.json");
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario", "cta_vertical", "fecho"], scales: [115, 130] };

const item = (start: number, end: number, text: string): ResolvedItem => {
  const words: Word[] = text.split(" ").map((t, i) => ({ text: t, start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
  return { interval: { start, end }, text, words, lastWordEnd: words[words.length - 1].end, holdLimit: end + 2, how: "explicit" };
};

describe("#13792 CTA falado no fecho conta como CTA", () => {
  it("o cenário da issue: V1-CTA vai para o fecho na proposta, e o build não avisa 'sem CTA nenhum'", () => {
    const r: RoteiroFalas = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const p = propostaBlocosDoRoteiro(r);
    const v1 = p.sequencias.find((s) => s.video === "vertical1")!;
    const ultima = v1.falas.at(-1)!;
    assert.deepEqual([ultima.id, ultima.bloco], ["V1-CTA", "fecho"]);
    // Sem cta_* no vertical 1: o único CTA falado é o do fecho.
    assert.ok(!v1.falas.some((f) => f.bloco.startsWith("cta_")));

    const ctaText = ultima.texto;
    const blocks = { titulo: [item(1, 3, "Título aqui")], comentario: [item(5, 8, "Um comentário curto")], fecho: [item(10, 14, ctaText)] };
    const plan = buildSequencePlan(SPEC_V, blocks, [], { fps: 30, durationS: 40 });
    assert.ok(plan.clips.some((c) => c.block === "fecho"));
    assert.equal(sequenceHasSpokenCta(plan), true);
  });

  it("fecho de despedida ou que só chama para os comentários não vira CTA (o aviso do #12571 continua)", () => {
    for (const t of ["Até amanhã", "E aí, você já faz slide com IA? Me conta nos comentários."]) {
      const blocks = { titulo: [item(1, 3, "Título aqui")], comentario: [item(5, 8, "Um comentário curto")], fecho: [item(10, 14, t)] };
      assert.equal(sequenceHasSpokenCta(buildSequencePlan(SPEC_V, blocks, [], { fps: 30, durationS: 40 })), false, t);
    }
  });

  it("clipsHaveSpokenCta: cta_*, pedaço cta_* de clipe fundido, fecho com texto de CTA; filler e comentário não", () => {
    assert.equal(clipsHaveSpokenCta([{ block: "cta_vertical" }], CTA_BLOCKS), true);
    assert.equal(clipsHaveSpokenCta([{ block: "comentario", parts: [{ block: "comentario" }, { block: "cta_ig" }] }], CTA_BLOCKS), true);
    assert.equal(clipsHaveSpokenCta([{ block: "fecho", script: "O vídeo completo tá no YouTube da diar.ia.br." }], CTA_BLOCKS), true);
    assert.equal(clipsHaveSpokenCta([{ block: "fecho" }], CTA_BLOCKS), false);
    assert.equal(clipsHaveSpokenCta([{ block: "comentario", script: "Tem no YouTube" }], CTA_BLOCKS), false);
    assert.equal(clipsHaveSpokenCta([{ block: "fecho", script: "Link na descrição", filler: true }], CTA_BLOCKS), false);
  });

  it("textoDeCta reconhece os CTAs das fixtures do roteiro", () => {
    for (const t of [
      "As três dicas pra tirar mais dele estão no vídeo completo, no YouTube da diar.ia.br.",
      "Agora vem a parte pra mandar pros seus pais. Na descrição tem um link que já abre o vídeo neste ponto.",
      "Se inscreve no canal pra não perder.",
      "Segue a diar.ia.br.",
    ]) assert.equal(textoDeCta(t), true, t);
    for (const t of ["Até amanhã", "Me conta nos comentários.", undefined]) assert.equal(textoDeCta(t), false, String(t));
  });

  it("o build usa o helper do fecho (guard de fiação)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    assert.match(src, /return clipsHaveSpokenCta\(plan\.clips, CTA_BLOCKS\)/);
  });
});
