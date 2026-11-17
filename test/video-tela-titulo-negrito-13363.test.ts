/**
 * test/video-tela-titulo-negrito-13363.test.ts — o título do box de tela sai
 * em negrito (#13363).
 *
 * `readRoteiroTelas` tira o `**` do texto de tela para o marcador do XML
 * (#13180), e o build passava esse mesmo texto ao `telaBoxSvg`: `telaLines`
 * nunca via o `**`, e nenhum título saía com `font-weight="700"` (H6 da
 * 261117). Os testes do #13204 e do #13180 cobriam cada metade em separado;
 * este percorre o caminho do build inteiro: roteiro em disco, leitura,
 * marcador, clamp e SVG do box.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRoteiroTelas, ROTEIRO_FALAS_FILE } from "../scripts/lib/diaria/roteiro-videos.ts";
import { telaMarkersFor, telaMarkersXml, type ResolvedItem, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";
import { clampTelaOverlaps, telaBoxSvgForMarker } from "../scripts/lib/diaria/video-tela.ts";

const H6_TELA = "**Artificial Analysis Intelligence Index**\nHydrogen: 51\nArgon: 50";

function lerTelas(): ReturnType<typeof readRoteiroTelas> {
  const dir = mkdtempSync(join(tmpdir(), "tela-13363-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, ROTEIRO_FALAS_FILE),
      JSON.stringify({ falas: [{ id: "H6", texto: "No índice da Artificial Analysis, o Hydrogen marcou 51 pontos.", tela: H6_TELA, videos: ["horizontal"] }] }),
    );
    return readRoteiroTelas(dir, () => {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#13363: o título do box de tela chega em negrito ao PNG", () => {
  const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada horizontal_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] };
  const item = { interval: { start: 10, end: 20 }, text: "qualquer", words: [], lastWordEnd: 20, holdLimit: 20, how: "explicit", fala: "H6" } as unknown as ResolvedItem;
  const clips = [{ block: "comentario" as const, srcIn: 10, srcOut: 20, frameIn: 300, frameOut: 600, seqStart: 0, seqEnd: 300, scale: 60 }];

  it("roteiro → readRoteiroTelas → telaMarkersFor → clamp → SVG: a 1ª linha sai com font-weight 700", () => {
    const telas = lerTelas();
    assert.equal(telas.length, 1);
    const { items } = clampTelaOverlaps(telaMarkersFor({ spec, clips }, { comentario: [item] }, 30, telas));
    assert.equal(items.length, 1);
    const svg = telaBoxSvgForMarker(items[0], 1920, 1080);
    assert.match(svg, /font-weight="700">Artificial Analysis/);
    assert.ok(!svg.includes("**"), "o ** é marcação, não texto desenhado");
    assert.ok(!/font-weight="700">Hydrogen/.test(svg), "só o título em negrito");
  });

  it("o marcador do XML segue sem o ** (#13180)", () => {
    const telas = lerTelas();
    assert.equal(telas[0].tela, "Artificial Analysis Intelligence Index\nHydrogen: 51\nArgon: 50");
    const ms = telaMarkersFor({ spec, clips }, { comentario: [item] }, 30, telas);
    assert.ok(!telaMarkersXml(ms).includes("**"));
  });

  it("marcador sem telaBox (chamada antiga) cai no tela", () => {
    assert.match(telaBoxSvgForMarker({ tela: "**Título**\nx" }, 1920, 1080), /font-weight="700">Título/);
    assert.doesNotMatch(telaBoxSvgForMarker({ tela: "Título\nx" }, 1920, 1080), /font-weight="700"/);
  });

  it("o build desenha o box pelo helper, nunca pelo texto do marcador", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    // #13333: o vertical passa a posição abaixo da legenda (`placement`); o horizontal, `{}`.
    assert.ok(src.includes("telaBoxSvgForMarker(m, p.spec.width, p.spec.height, placement)"));
    assert.ok(!/telaBoxSvg\(m\.tela\b/.test(src));
  });
});
