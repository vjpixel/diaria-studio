/**
 * #13743: na 261119 as três sequências terminavam secas (a última fala do
 * comentário seguida direto do card). O conserto à mão foi o bloco `fecho`
 * com H14 (horizontal e vertical 2) e V1-CTA (vertical 1).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { propostaBlocosDoRoteiro } from "../scripts/lib/diaria/roteiro-videos.ts";
import { falaDeFecho, sequenceEndingWarning } from "../scripts/lib/diaria/video-sequence-fecho.ts";
import { blocksFromPlan } from "../scripts/lib/diaria/video-blocks-from-plan.ts";
import { assembleClips } from "../scripts/lib/diaria/video-montage.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261118-v9.json");

/** O fim do roteiro da 261119: H14 (comentário de encerramento) e V1-CTA. */
function roteiro261119(): RoteiroFalas {
  const r: RoteiroFalas = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const h14 = r.falas.find((f) => f.id === "H14")!;
  h14.texto = "E aí, você já faz slide com IA ou ainda monta na mão? Me conta nos comentários.";
  h14.videos = ["horizontal", "vertical2"];
  const ord = r.porVideo?.vertical2?.ordem;
  if (ord) r.porVideo!.vertical2!.ordem = [...ord.filter((x) => x !== "H14"), "H14"];
  return r;
}

describe("#13743 falaDeFecho", () => {
  it("CTA e comentário que chama o público fecham; dica comum no fim não", () => {
    assert.equal(falaDeFecho("cta_vertical", "O passo a passo tá no vídeo completo, no YouTube da diar.ia.br."), true);
    assert.equal(falaDeFecho("comentario", "E aí, você já faz slide com IA ou ainda monta na mão? Me conta nos comentários."), true);
    assert.equal(falaDeFecho("comentario", "Quarto: pergunta se faltou alguma coisa."), false);
    assert.equal(falaDeFecho("resumo", "Me conta nos comentários."), false);
  });
});

describe("#13743 proposta de blocos: a fala de encerramento vai para o fecho", () => {
  it("H14 no fecho do horizontal e do vertical 2, V1-CTA no fecho do vertical 1 (o conserto manual da 261119)", () => {
    const p = propostaBlocosDoRoteiro(roteiro261119());
    const ultimo = (v: string) => p.sequencias.find((s) => s.video === v)!.falas.at(-1)!;
    assert.deepEqual([ultimo("horizontal").id, ultimo("horizontal").bloco], ["H14", "fecho"]);
    assert.deepEqual([ultimo("vertical1").id, ultimo("vertical1").bloco], ["V1-CTA", "fecho"]);
    assert.deepEqual([ultimo("vertical2").id, ultimo("vertical2").bloco], ["H14", "fecho"]);
    const fecho = p.blocks.fecho ?? [];
    assert.deepEqual(fecho.map((x) => x.falaId).sort(), ["H14", "V1-CTA"]);
    assert.equal(p.blocks.cta_vertical, undefined);
    assert.ok(!(p.blocks.comentario ?? []).some((x) => x.falaId === "H14"));
    // O corte do vertical 2 termina no fecho.
    assert.equal(p.sequences?.find((s) => s.corte)?.order.at(-1), "fecho");
    assert.ok(p.avisos.some((a) => /H14 \(comentario\), é de encerramento e vai para o bloco fecho/.test(a)));
  });

  it("blocks --from-plan: as três sequências terminam no fecho, com o fecho que chega a cada uma", () => {
    const p = propostaBlocosDoRoteiro(roteiro261119());
    const ids = (k: string) => (p.blocks[k as keyof typeof p.blocks] ?? []).map((x) => ({ falaId: x.falaId, text: x.text, start: 1, end: 2 }));
    const template = { edition: "261119", blocks: Object.fromEntries(Object.keys(p.blocks).map((k) => [k, ids(k)])) } as never;
    const { file } = blocksFromPlan(template, p);
    for (const s of file.sequences ?? []) assert.equal(s.order.at(-1), "fecho", s.name);
  });

  it("vídeo que já tem fecho não muda", () => {
    const r = roteiro261119();
    r.falas.find((f) => f.id === "H14")!.bloco = "fecho";
    const p = propostaBlocosDoRoteiro(r);
    assert.ok(!p.avisos.some((a) => /#13743/.test(a) && /horizontal/i.test(a)));
  });
});

describe("#13743 build: aviso quando a sequência termina sem fecho", () => {
  it("termina no comentário: aviso; no fecho (ou num holdBlocks): nada; o filler da vinheta não conta", () => {
    assert.match(sequenceEndingWarning("Diaria comentada horizontal_V1", [{ block: "abertura" }, { block: "comentario" }]) ?? "", /termina na última fala do comentário, sem fecho.*#13743/);
    assert.match(sequenceEndingWarning("V", [{ block: "cta_vertical" }]) ?? "", /termina no bloco cta_vertical/);
    assert.equal(sequenceEndingWarning("V", [{ block: "comentario" }, { block: "fecho" }]), null);
    assert.equal(sequenceEndingWarning("V", [{ block: "fecho" }, { block: "comentario", filler: true }]), null);
    assert.equal(sequenceEndingWarning("V", [{ block: "cta_yt" }], ["fecho", "cta_yt"]), null);
    assert.equal(sequenceEndingWarning("V", []), null);
  });

  it("#13805: comentário e fecho contíguos no bruto viram um clipe só (block comentario, fecho em parts): sem aviso", () => {
    const { clips } = assembleClips(
      { scales: [100, 115] },
      [
        { block: "abertura", srcIn: 1, srcOut: 4, script: "Bom dia." },
        { block: "comentario", srcIn: 10, srcOut: 14, script: "O que importa é isso." },
        { block: "fecho", srcIn: 14, srcOut: 16, script: "Me conta nos comentários." },
      ],
      30,
    );
    const last = clips[clips.length - 1];
    assert.equal(last.block, "comentario");
    assert.deepEqual(last.parts?.map((p) => p.block), ["comentario", "fecho"]);
    assert.equal(sequenceEndingWarning("Diaria comentada horizontal_V1", clips), null);
    // O fundido que TERMINA no comentário (fecho antes, comentário depois) segue avisando.
    assert.match(
      sequenceEndingWarning("V", [{ block: "fecho", parts: [{ block: "fecho" }, { block: "comentario" }] }]) ?? "",
      /termina na última fala do comentário, sem fecho/,
    );
  });

  it("o build chama o aviso (guard de fiação)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    assert.match(src, /sequenceEndingWarning\(p\.spec\.name, p\.clips, file\.holdBlocks \?\? \["fecho"\]\)/);
  });
});
