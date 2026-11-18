/**
 * #13463: `blocks --from-plan` monta o `blocks.json` do molde da decupagem e da
 * proposta do roteiro de gravação, no lugar do script ad-hoc em `node -e` que
 * a skill escrevia a cada edição (261117, 261118). O vínculo é o `falaId` da
 * linha "usar" do `decupagem-plan.json`, que a decupagem leva para o molde.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blocksFromPlan } from "../scripts/lib/diaria/video-blocks-from-plan.ts";
import { blocksFromDecupagem, buildDecupagemDoc, parseDecupagemPlan } from "../scripts/lib/diaria/video-montage-docs.ts";
import { parseBlocksFile, type BlocksFile, type Segment } from "../scripts/lib/diaria/video-montage.ts";
import { parseRoteiroFalas, propostaBlocosDoRoteiro, type PropostaBlocos } from "../scripts/lib/diaria/roteiro-videos.ts";
import { EXIT_BLOCKS_SEM_ROTEIRO, SUBCOMMANDS, main } from "../scripts/video-montagem.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");

const seg = (start: number, end: number, text: string): Segment => ({ start, end, text, words: [] });

describe("#13463: falaId na linha da decupagem vai para o molde", () => {
  const segments = [seg(10, 14, "Primeira fala."), seg(20, 25, "Fala improvisada."), seg(30, 33, "Terceira fala.")];
  const plan = {
    edition: "261118",
    blocks: [
      { key: "resumo", rows: [{ segments: [1], suggestion: "usar", falaId: "H3" }, { segments: [2], suggestion: "usar" }] },
      { key: "comentario", rows: [{ segments: [3], suggestion: "usar", falaId: " H7 " }] },
    ],
  };

  it("parseDecupagemPlan aceita falaId e recusa vazio ou não-texto", () => {
    assert.equal(parseDecupagemPlan(plan, segments.length).ok, true);
    const ruim = structuredClone(plan) as { blocks: Array<{ rows: Array<Record<string, unknown>> }> };
    ruim.blocks[0].rows[0].falaId = "  ";
    ruim.blocks[1].rows[0].falaId = 7;
    const r = parseDecupagemPlan(ruim, segments.length);
    assert.equal(r.ok, false);
    assert.equal((r as { errors: string[] }).errors.filter((e) => /falaId/.test(e)).length, 2);
  });

  it("o molde leva o falaId (aparado) só nas linhas que têm", () => {
    const parsed = parseDecupagemPlan(plan, segments.length);
    assert.ok(parsed.ok);
    const blocks = blocksFromDecupagem(buildDecupagemDoc(parsed.plan, segments));
    assert.deepEqual(blocks.resumo, [{ start: 10, end: 14, text: "Primeira fala.", falaId: "H3" }, { start: 20, end: 25, text: "Fala improvisada." }]);
    assert.deepEqual(blocks.comentario, [{ start: 30, end: 33, text: "Terceira fala.", falaId: "H7" }]);
  });
});

/** Proposta mínima, como `propostaBlocosDoRoteiro` devolve. */
function proposta(over: Partial<PropostaBlocos> = {}): PropostaBlocos {
  return {
    sequencias: [],
    blocks: {
      gancho: [{ text: "Gancho do roteiro.", falaId: "H1" }],
      resumo: [{ text: "Resumo planejado.", falaId: "H3" }],
      resumo_curto: [{ text: "Resumo planejado.", falaId: "H3" }],
      comentario: [
        { text: "Comentário B.", falaId: "H8", targets: ["youtube"] },
        { text: "Comentário A.", falaId: "H7" },
      ],
    },
    sequences: [
      { target: "youtube", name: "Diaria comentada horizontal_V1", width: 1920, height: 1080, order: ["gancho", "resumo", "comentario", "fecho"], scales: [60, 85] },
      { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["gancho", "resumo_curto", "comentario", "fecho"], scales: [115, 130] },
    ],
    screenTitle: "Título da vertical",
    cortesReserva: [],
    fontes: [],
    avisos: [],
    ...over,
  };
}

const template = (): BlocksFile => ({
  edition: "261118",
  mirrored: false,
  vocabulary: [{ pattern: "diária", replacement: "diar.ia.br" }],
  blocks: {
    gancho: [{ start: 5, end: 9, text: "Gancho como gravado.", falaId: "H1" }],
    resumo: [{ start: 40, end: 52, text: "Resumo como gravado.", falaId: "H3" }],
    comentario: [
      { start: 60, end: 64, text: "Comentário A gravado.", falaId: "H7" },
      { start: 64.5, end: 66, text: "Improviso no meio." },
      { start: 70, end: 75, text: "Comentário B gravado.", falaId: "H8" },
    ],
  },
});

describe("#13463: blocksFromPlan", () => {
  it("ordem e targets da proposta; intervalo, texto gravado e campos do molde", () => {
    const { file, avisos } = blocksFromPlan(template(), proposta());
    assert.equal(file.edition, "261118");
    assert.equal(file.mirrored, false);
    assert.deepEqual(file.vocabulary, template().vocabulary);
    assert.equal(file.screenTitle, "Título da vertical");
    assert.deepEqual(file.blocks.gancho, [{ start: 5, end: 9, text: "Gancho como gravado.", falaId: "H1" }]);
    // H8 antes de H7, como no roteiro; o improviso fica logo depois do item do molde que o precedia (H7).
    assert.deepEqual(file.blocks.comentario, [
      { start: 70, end: 75, text: "Comentário B gravado.", falaId: "H8", targets: ["youtube"] },
      { start: 60, end: 64, text: "Comentário A gravado.", falaId: "H7" },
      { start: 64.5, end: 66, text: "Improviso no meio." },
    ]);
    assert.ok(avisos.some((a) => /Improviso no meio.*sem falaId/.test(a)));
    assert.equal(parseBlocksFile(JSON.parse(JSON.stringify(file))).ok, true);
  });

  it("resumo_curto sem linha própria na decupagem reaproveita o item do resumo", () => {
    const { file } = blocksFromPlan(template(), proposta());
    assert.deepEqual(file.blocks.resumo_curto, [{ start: 40, end: 52, text: "Resumo como gravado.", falaId: "H3" }]);
    assert.deepEqual(file.blocks.resumo, file.blocks.resumo_curto);
  });

  it("bloco vazio sai da ordem da sequência (fecho), com aviso", () => {
    const { file, avisos } = blocksFromPlan(template(), proposta());
    assert.deepEqual(file.sequences!.map((s) => s.order), [["gancho", "resumo", "comentario"], ["gancho", "resumo_curto", "comentario"]]);
    assert.ok(avisos.some((a) => /horizontal_V1: fecho sem item/.test(a)));
  });

  it("bloco cujos itens não chegam à sequência também sai da ordem dela", () => {
    const p = proposta({ blocks: { ...proposta().blocks, comentario: [{ text: "Comentário B.", falaId: "H8", targets: ["youtube"] }] } });
    const t = template();
    t.blocks.comentario = [{ start: 70, end: 75, text: "Comentário B gravado.", falaId: "H8" }];
    const { file } = blocksFromPlan(t, p);
    assert.deepEqual(file.sequences![1].order, ["gancho", "resumo_curto"]);
    assert.deepEqual(file.sequences![0].order, ["gancho", "resumo", "comentario"]);
  });

  it("fala sem item no molde sai só com o texto do roteiro, com aviso", () => {
    const t = template();
    delete t.blocks.gancho;
    const { file, avisos } = blocksFromPlan(t, proposta());
    assert.deepEqual(file.blocks.gancho, [{ falaId: "H1", text: "Gancho do roteiro." }]);
    assert.ok(avisos.some((a) => /gancho: fala H1 .*sem linha "usar" com falaId H1/.test(a)));
    assert.equal(parseBlocksFile(JSON.parse(JSON.stringify(file))).ok, true);
  });

  it("trecho de corte numa vertical (#13129) sai só com o texto, com aviso", () => {
    const p = proposta({
      sequencias: [{ video: "vertical1", chave: "outras-redes", falas: [{ id: "H3", bloco: "resumo_curto", texto: "Resumo.", segmentos: ["Resumo."], cortado: "planejado" }] }],
      blocks: { ...proposta().blocks, resumo_curto: [{ text: "Resumo.", falaId: "H3", targets: ["outras-redes"] }] },
    });
    const { file, avisos } = blocksFromPlan(template(), p);
    assert.deepEqual(file.blocks.resumo_curto, [{ falaId: "H3", text: "Resumo.", targets: ["outras-redes"] }]);
    assert.ok(avisos.some((a) => /trecho de corte/.test(a)));
  });

  it("a mesma fala duas vezes no bloco (ordem própria da vertical, #13128) repete a tomada do molde", () => {
    const p = proposta({
      blocks: {
        ...proposta().blocks,
        comentario: [
          { text: "Comentário A.", falaId: "H7", targets: ["outras-redes"] },
          { text: "Comentário B.", falaId: "H8" },
          { text: "Comentário A.", falaId: "H7", targets: ["youtube"] },
        ],
      },
    });
    const { file, avisos } = blocksFromPlan(template(), p);
    const h7 = file.blocks.comentario!.filter((it) => it.falaId === "H7");
    assert.deepEqual(h7.map((it) => [it.start, it.targets]), [[60, ["outras-redes"]], [60, ["youtube"]]]);
    assert.ok(!avisos.some((a) => /H7.*sem linha/.test(a)));
  });

  it("falaId que a proposta não tem fica no bloco, sem targets, com aviso", () => {
    const t = template();
    t.blocks.comentario!.push({ start: 80, end: 82, text: "Fala de outro roteiro.", falaId: "H99", targets: ["youtube"] });
    const { file, avisos } = blocksFromPlan(t, proposta());
    assert.deepEqual(file.blocks.comentario!.at(-1), { start: 80, end: 82, text: "Fala de outro roteiro.", falaId: "H99" });
    assert.ok(avisos.some((a) => /H99, que a proposta do roteiro não tem/.test(a)));
  });

  it("sem sequences na proposta ficam as do molde", () => {
    const t = template();
    t.sequences = proposta().sequences!.map((s) => ({ ...s, name: `${s.name}-molde` }));
    const { file } = blocksFromPlan(t, proposta({ sequences: undefined, screenTitle: undefined }));
    assert.deepEqual(file.sequences!.map((s) => s.name), ["Diaria comentada horizontal_V1-molde", "Diaria comentada_Vertical_V1-molde"]);
    assert.equal(file.screenTitle, undefined);
  });

  it("roteiro real (261116): toda fala com linha no molde ganha intervalo e o resultado valida", () => {
    const lido = parseRoteiroFalas(JSON.parse(readFileSync(FIXTURE, "utf8")));
    assert.ok(lido.ok);
    const p = propostaBlocosDoRoteiro(lido.roteiro);
    // Molde: uma linha "usar" por fala da proposta, no bloco em que a proposta a põe pela 1ª vez.
    const t: BlocksFile = { edition: "261116", blocks: {} };
    const vistos = new Set<string>();
    let at = 10;
    for (const [k, itens] of Object.entries(p.blocks)) {
      for (const it of itens ?? []) {
        if (vistos.has(it.falaId)) continue;
        vistos.add(it.falaId);
        (t.blocks[k as keyof BlocksFile["blocks"]] ??= []).push({ start: at, end: at + 3, text: it.text, falaId: it.falaId });
        at += 5;
      }
    }
    const { file } = blocksFromPlan(t, p);
    assert.equal(parseBlocksFile(JSON.parse(JSON.stringify(file))).ok, true);
    const itens = Object.values(file.blocks).flat();
    assert.ok(itens.length >= vistos.size);
    assert.ok(itens.every((it) => typeof it!.start === "number"), "toda fala com linha no molde sai com intervalo");
    // Os targets são os da proposta, item a item, na mesma ordem.
    for (const [k, itens2] of Object.entries(p.blocks)) {
      assert.deepEqual(
        (file.blocks[k as keyof BlocksFile["blocks"]] ?? []).map((it) => [it.falaId, it.targets]),
        (itens2 ?? []).map((it) => [it.falaId, it.targets]),
        k,
      );
    }
  });
});

describe("#13463: blocks --from-plan no CLI", () => {
  let dir: string;
  const origErr = console.error;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vm-13463-"));
    console.error = () => {};
  });
  afterEach(() => {
    console.error = origErr;
    rmSync(dir, { recursive: true, force: true });
  });
  const roteiroPath = () => join(dir, "roteiro-falas.json");
  const args = (...extra: string[]) => ["blocks", "261118", "--from-plan", "--state-dir", dir, "--work-dir", dir, "--no-drive-api", "--drive-root", dir, "--falas", roteiroPath(), ...extra];
  const escreverMolde = () => writeFileSync(join(dir, "blocks.template.json"), JSON.stringify(template()));
  const escreverRoteiro = () => {
    const r = JSON.parse(readFileSync(FIXTURE, "utf8"));
    r.edicao = "261118";
    writeFileSync(roteiroPath(), JSON.stringify(r));
  };

  it("é subcomando e exige --from-plan", async () => {
    assert.ok((SUBCOMMANDS as readonly string[]).includes("blocks"));
    escreverMolde();
    await assert.rejects(main(["blocks", "261118", "--state-dir", dir, "--work-dir", dir, "--no-drive-api", "--drive-root", dir]), /exige --from-plan/);
  });

  it("sem molde, recusa apontando a decupagem", async () => {
    escreverRoteiro();
    await assert.rejects(main(args()), /blocks\.template\.json/);
  });

  it("sem roteiro de gravação, exit 3 e nada gravado", async () => {
    escreverMolde();
    assert.equal(await main(args()), EXIT_BLOCKS_SEM_ROTEIRO);
    assert.equal(existsSync(join(dir, "blocks.json")), false);
  });

  it("grava o blocks.json válido; não sobrescreve sem --force; --force guarda o anterior", async () => {
    escreverMolde();
    escreverRoteiro();
    assert.equal(await main(args()), 0);
    const path = join(dir, "blocks.json");
    const gravado = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parseBlocksFile(gravado).ok, true);
    assert.equal(gravado.edition, "261118");
    assert.ok(Array.isArray(gravado.sequences) && gravado.sequences.length === 3, "as 3 sequências da proposta (horizontal, vertical, corte guia)");

    writeFileSync(path, '{"editado": "pelo editor"}');
    await assert.rejects(main(args()), /já existe/);
    assert.equal(readFileSync(path, "utf8"), '{"editado": "pelo editor"}');

    assert.equal(await main(args("--force")), 0);
    assert.equal(readFileSync(join(dir, "blocks.antes-from-plan.json"), "utf8"), '{"editado": "pelo editor"}');
    assert.equal(parseBlocksFile(JSON.parse(readFileSync(path, "utf8"))).ok, true);
  });
});
