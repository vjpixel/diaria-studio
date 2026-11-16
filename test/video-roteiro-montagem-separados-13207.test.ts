/**
 * #13207: roteiro de gravação congelado × roteiro de montagem com o id da fala
 * de origem e o planejado × gravado lado a lado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSequencePlan, parseBlocksFile, resolveBlocks, type Segment, type SequenceSpec, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { roteiroMarkdown } from "../scripts/lib/diaria/video-montage-docs.ts";
import { readRoteiroFalas } from "../scripts/lib/diaria/roteiro-videos.ts";
import { ROTEIRO_FALAS_FILE } from "../scripts/lib/diaria/roteiro-videos.ts";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const SPEC_H: SequenceSpec = { target: "youtube", name: "H", width: 1920, height: 1080, order: ["comentario"], scales: [50, 62] };
const SOURCE = { fps: 30, durationS: 1000 };
const GRAVADO = "notas equivalentes ao Sonnet cinco da Anthropic";
const PLANEJADO = "no nível dos modelos intermediários da Anthropic";
const words = GRAVADO.split(" ").map((t, i) => w(t, 10 + i * 0.4, 10.3 + i * 0.4));
const seg: Segment = { start: words[0].start, end: words[words.length - 1].end, text: GRAVADO, words };

describe("#13207: roteiro de montagem com id da fala", () => {
  it("falaId passa do blocks.json ao item resolvido e à tabela, com planejado × gravado", () => {
    const file = { edition: "261116", blocks: { comentario: [{ text: GRAVADO, falaId: "H9c" }] } };
    const r = resolveBlocks(file, words, { durationS: 1000 });
    assert.equal(r.blocks.comentario![0].falaId, "H9c");
    const md = roteiroMarkdown("261116", [buildSequencePlan(SPEC_H, r.blocks, [], SOURCE)], r.blocks, 30, { falasPlanejadas: { H9c: PLANEJADO } });
    assert.match(md, /Origem no roteiro de gravação/);
    assert.match(md, new RegExp(`\\| H9c \\| ${PLANEJADO} \\| ${GRAVADO}`));
  });

  it("planejado igual ao gravado não repete o texto; sem id vira 'sem vínculo'", () => {
    const file = { edition: "261116", blocks: { comentario: [{ text: GRAVADO, falaId: "H9c" }] } };
    const r = resolveBlocks(file, words, { durationS: 1000 });
    const md = roteiroMarkdown("261116", [buildSequencePlan(SPEC_H, r.blocks, [], SOURCE)], r.blocks, 30, { falasPlanejadas: { H9c: GRAVADO } });
    assert.match(md, /\| H9c \| igual ao gravado \|/);
    const sem = resolveBlocks({ edition: "261116", blocks: { comentario: [{ text: GRAVADO }] } }, words, { durationS: 1000 });
    const md2 = roteiroMarkdown("261116", [buildSequencePlan(SPEC_H, sem.blocks, [], SOURCE)], sem.blocks, 30, { falasPlanejadas: { H9c: PLANEJADO } });
    assert.match(md2, /\| sem vínculo \| origem não disponível \|/);
  });

  it("sem roteiro de gravação o roteiro.md segue como antes", () => {
    const r = resolveBlocks({ edition: "261116", blocks: { comentario: [{ text: GRAVADO, falaId: "H9c" }] } }, words, { durationS: 1000 });
    const md = roteiroMarkdown("261116", [buildSequencePlan(SPEC_H, r.blocks, [], SOURCE)], r.blocks, 30);
    assert.doesNotMatch(md, /Origem no roteiro de gravação/);
  });

  it("falaId inválido no blocks.json é erro; readRoteiroFalas lê o planejado sem alterá-lo", () => {
    const bad = parseBlocksFile({ edition: "261116", blocks: { comentario: [{ text: GRAVADO, falaId: "" }] } });
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.errors.join("\n"), /falaId precisa ser texto não vazio/);
    assert.equal(parseBlocksFile({ edition: "261116", blocks: { comentario: [{ text: GRAVADO, falaId: "H9c" }] } }).ok, true);
    const dir = mkdtempSync(join(tmpdir(), "r13207-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify({ falas: [{ id: "H9c", texto: PLANEJADO }] }));
    assert.deepEqual({ ...readRoteiroFalas(dir, () => {}) }, { H9c: PLANEJADO });
    assert.deepEqual({ ...readRoteiroFalas(join(dir, "nada"), () => {}) }, {});
  });
});
