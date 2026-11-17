/**
 * test/video-tela-falaid-13309.test.ts
 *
 * #13309 — na 261117 o roteiro planejou 6 textos de tela no horizontal e o
 * build pôs só 2: os itens do `blocks.json` tinham só `falaId` (gravado pela
 * decupagem), sem `fala`, e o texto gravado diferia do roteiro ("E não é caso
 * isolado" × "Não é caso isolado"). O casamento por texto falhou em silêncio, e
 * as falas sumidas apareceram como `[premissa] fora desta versão`. O box H13b
 * também saiu só na 1ª metade da fala, e sumia justo no "o endereço está aqui
 * na tela".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telaMarkersFor, telaSemMarcador, type ResolvedItem, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";
import { readRoteiroTelas, ROTEIRO_FALAS_FILE } from "../scripts/lib/diaria/roteiro-videos.ts";

const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] };
const item = (start: number, end: number, text: string, ids: { fala?: string; falaId?: string } = {}): ResolvedItem =>
  ({ interval: { start, end }, text, words: [], lastWordEnd: end, holdLimit: end, how: "explicit", ...ids }) as ResolvedItem;
const clip = (srcIn: number, srcOut: number, seqStart: number) => ({
  block: "comentario" as const, srcIn, srcOut, frameIn: srcIn * 30, frameOut: srcOut * 30, seqStart, seqEnd: seqStart + (srcOut - srcIn) * 30, scale: 60,
});

describe("#13309: falaId é fallback de fala no casamento do texto de tela", () => {
  const telas = [
    { id: "H5", texto: "Não é caso isolado.", tela: "Caso 1" },
    { id: "H13b", texto: "Chama-se Diabetes Fato ou Fake. O endereço está aqui na tela.", tela: "diabetes.org.br/fake" },
  ];

  it("o cenário da 261117: texto gravado com 'E ' na frente e só falaId no item; sem o fallback, nenhum marcador", () => {
    const clips = [clip(10, 12, 0)];
    const gravado = "E não é caso isolado.";
    assert.equal(telaMarkersFor({ spec, clips }, { comentario: [item(10, 12, gravado)] }, 30, telas).length, 0, "sem id, o texto não casa");
    const ms = telaMarkersFor({ spec, clips }, { comentario: [item(10, 12, gravado, { falaId: "H5" })] }, 30, telas);
    assert.deepEqual(ms.map((m) => [m.id, m.in, m.out]), [["H5", 0, 60]]);
  });

  it("fala dividida em 2 itens com o mesmo falaId: o box cobre a fala inteira, inclusive o 'aqui na tela'", () => {
    const clips = [clip(20, 23, 0), clip(30, 33, 90)];
    const its = [item(20, 23, "Chama Diabetes Fato ou Fake,", { falaId: "H13b" }), item(30, 33, "e o endereço está aqui na tela.", { falaId: "H13b" })];
    const ms = telaMarkersFor({ spec, clips }, { comentario: its }, 30, telas);
    assert.deepEqual(ms.map((m) => [m.id, m.in, m.out]), [["H13b", 0, 180]]);
  });

  it("fala vence falaId quando os dois existem (o editor corrigiu à mão)", () => {
    const clips = [clip(10, 12, 0)];
    const ms = telaMarkersFor({ spec, clips }, { comentario: [item(10, 12, "x", { falaId: "H5", fala: "H13b" })] }, 30, telas);
    assert.deepEqual(ms.map((m) => m.id), ["H13b"]);
  });

  it("falaId de outra fala não casa, mesmo com o texto igual ao roteiro", () => {
    const clips = [clip(10, 12, 0)];
    assert.equal(telaMarkersFor({ spec, clips }, { comentario: [item(10, 12, telas[0].texto, { falaId: "H9" })] }, 30, telas).length, 0);
  });
});

describe("#13309: fala do horizontal sem marcador é aviso, não premissa", () => {
  it("separa a fala do horizontal sem item (aviso) da fala de outro vídeo (premissa)", () => {
    const telas = [
      { id: "H5", videos: ["horizontal"] },
      { id: "H7", videos: ["horizontal", "vertical1"] },
      { id: "V3", videos: ["vertical1"] },
      { id: "X1" },
      { id: "H11a", videos: ["horizontal"] },
    ];
    assert.deepEqual(telaSemMarcador(telas, [{ id: "H11a" }]), { semCasamento: ["H5", "H7"], foraDaVersao: ["V3", "X1"] });
    assert.deepEqual(telaSemMarcador(telas.slice(0, 1), [{ id: "H5" }]), { semCasamento: [], foraDaVersao: [] });
  });

  it("readRoteiroTelas traz os vídeos da fala do roteiro-falas.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "tela-13309-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify({ falas: [{ id: "H5", texto: "Não é caso isolado.", tela: "Caso 1", videos: ["horizontal"] }, { id: "H6", texto: "x", tela: "y" }] }));
      const telas = readRoteiroTelas(dir, () => {});
      assert.deepEqual(telas.map((t) => [t.id, t.videos]), [["H5", ["horizontal"]], ["H6", undefined]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
