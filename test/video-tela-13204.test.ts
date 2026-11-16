/**
 * test/video-tela-13204.test.ts — texto de tela no horizontal (#13204): o
 * `tela` de cada fala do roteiro vira um box (PNG) numa faixa do XML, no tempo
 * da fala, e não só o marcador do #13140. O item do `blocks.json` diz de qual
 * fala vem (`fala: "H6"`), porque a fala gravada difere do texto do roteiro
 * (261116: "o Hydrogen ficou com nota 51" × "o Hydrogen marcou 51 pontos").
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TELA_BOX, previewTelaArgs, telaBoxLayout, telaBoxSvg, telaFileName, telaLineWidth, telaLines, telaTrack } from "../scripts/lib/diaria/video-tela.ts";
import { telaMarkersFor, type ResolvedItem, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";

const H6 = "**Artificial Analysis Intelligence Index**\nHydrogen: 51\nArgon: 50\nClaude Sonnet 5.5: 55\nGPT-6.1 Terra: 51";

describe("#13204: box de tela", () => {
  it("linhas: uma por \\n; **x** na linha inteira é o título do box", () => {
    assert.deepEqual(telaLines(H6).slice(0, 2), [
      { text: "Artificial Analysis Intelligence Index", head: true },
      { text: "Hydrogen: 51", head: false },
    ]);
    assert.equal(telaLines("App do Gemini\n\nAPI").length, 2);
  });

  it("o box cabe no quadro, no terço da direita, centrado na altura", () => {
    const { box } = telaBoxLayout(H6, 1920, 1080);
    assert.ok(box.x >= 1920 / 2, `começa na metade direita (x=${box.x})`);
    assert.ok(box.x + box.w <= 1920, "não passa da borda");
    assert.ok(box.y > 0 && box.y + box.h < 1080);
    assert.ok(Math.abs(box.y + box.h / 2 - 540) <= 1);
  });

  it("(review) toda linha cabe na largura de texto do box: a longa quebra nas palavras", () => {
    const { lines, fontPx, box, k } = telaBoxLayout(H6, 1920, 1080);
    const textMax = box.w - (2 * TELA_BOX.padX + TELA_BOX.barPx) * k;
    for (const l of lines) assert.ok(telaLineWidth(l, fontPx) <= textMax + 1, `"${l.text}" cabe (${telaLineWidth(l, fontPx).toFixed(0)} ≤ ${textMax.toFixed(0)})`);
    assert.ok(lines.length > telaLines(H6).length, "o título longo virou 2 linhas");
    assert.ok(lines.filter((l) => l.head).length >= 2, "a continuação segue em negrito");
  });

  it("(review) **A** e **B** na mesma linha não vira título", () => {
    assert.deepEqual(telaLines("**A** e **B**"), [{ text: "A e B", head: false }]);
  });

  it("SVG: transparente fora do box, texto escapado, título em negrito", () => {
    const svg = telaBoxSvg("**A & B**\nC < D", 1920, 1080);
    assert.match(svg, /width="1920" height="1080"/);
    assert.match(svg, /font-weight="700">A &amp; B</);
    assert.match(svg, />C &lt; D</);
    assert.ok(!/<rect x="0" y="0" width="1920"/.test(svg), "sem fundo no quadro inteiro");
  });

  it("nome do PNG com o id da fala e o hash", () => {
    assert.equal(telaFileName("261116", "H6", "abc123"), "261116_tela_H6-abc123.png");
  });

  it("faixa do xmeml: um clipe por box no tempo da fala, <file> definido uma vez", () => {
    const seen = new Map<string, string>();
    const fileIdOf = (xp: string) => (seen.has(xp) ? { id: seen.get(xp)!, defined: true } : (seen.set(xp, `file-tela-${seen.size + 1}`), { id: seen.get(xp)!, defined: false }));
    const ov = (id: string, i: number, o: number) => ({ id, tela: "x", path: `/l/${id}.png`, xmlPath: `/m/${id}.png`, width: 1920, height: 1080, in: i, out: o });
    const xml = telaTrack({ overlays: [ov("H4", 300, 420), ov("H6", 900, 1150)], rate: "<rate><timebase>30</timebase></rate>", idPrefix: "tela-1", fileIdOf, url: (p) => `file://${p}` });
    assert.equal((xml.match(/<clipitem /g) ?? []).length, 2);
    assert.match(xml, /<name>tela H6<\/name>[\s\S]*<start>900<\/start><end>1150<\/end><in>0<\/in><out>250<\/out>/);
    assert.match(xml, /<pathurl>file:\/\/\/m\/H4\.png<\/pathurl>/);
    assert.equal(telaTrack({ overlays: [], rate: "", idPrefix: "t", fileIdOf, url: (p) => p }), "");
  });

  it("prévia: overlay de cada box só no trecho dele", () => {
    const args = previewTelaArgs({ input: "j.mp4", out: "o.mp4", width: 960, height: 540, overlays: [{ png: "a.png", in: 10, out: 20 }, { png: "b.png", in: 30, out: 40 }] });
    const fc = args[args.indexOf("-filter_complex") + 1];
    assert.match(fc, /enable='between\(n,10,19\)'/);
    assert.match(fc, /enable='between\(n,30,39\)'\[v\]$/);
  });
});

describe("#13204: telaMarkersFor casa pelo id da fala no item", () => {
  const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada horizontal_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] };
  const item = (start: number, end: number, text: string, fala?: string): ResolvedItem =>
    ({ interval: { start, end }, text, words: [], lastWordEnd: end, holdLimit: end, how: "explicit", ...(fala ? { fala } : {}) }) as ResolvedItem;
  const clips = [{ block: "comentario" as const, srcIn: 10, srcOut: 20, frameIn: 300, frameOut: 600, seqStart: 0, seqEnd: 300, scale: 60 }];
  const telas = [{ id: "H6", texto: "No índice da Artificial Analysis, o Hydrogen marcou 51 pontos.", tela: H6 }];

  it("a fala gravada difere do roteiro: sem o id, nenhum marcador; com fala: \"H6\", o marcador no tempo do item", () => {
    const said = "No índice artificial análises, o Hydrogen ficou com nota 51.";
    assert.equal(telaMarkersFor({ spec, clips }, { comentario: [item(10, 20, said)] }, 30, telas).length, 0);
    const ms = telaMarkersFor({ spec, clips }, { comentario: [item(10, 20, said, "H6")] }, 30, telas);
    assert.deepEqual(ms.map((m) => [m.id, m.in, m.out]), [["H6", 0, 300]]);
  });

  it("(review) fala do roteiro sem texto ainda casa pelo id do item", () => {
    const semTexto = [{ id: "H6", texto: "", tela: H6 }];
    assert.equal(telaMarkersFor({ spec, clips }, { comentario: [item(10, 20, "qualquer", "H6")] }, 30, semTexto).length, 1);
  });

  it("(review) a pausa da vinheta (filler) dentro do intervalo do item não puxa o marcador", () => {
    const comFiller = [{ ...clips[0], srcIn: 9.2, srcOut: 9.8, frameIn: 276, frameOut: 294, seqStart: 0, seqEnd: 18, filler: true as const }, { ...clips[0], seqStart: 18, seqEnd: 318 }];
    const ms = telaMarkersFor({ spec, clips: comFiller }, { comentario: [item(9, 20, "x", "H6")] }, 30, telas);
    assert.equal(ms[0].in, 18);
  });

  it("id de outra fala não casa, mesmo com o texto igual", () => {
    assert.equal(telaMarkersFor({ spec, clips }, { comentario: [item(10, 20, telas[0].texto, "H9")] }, 30, telas).length, 0);
  });
});
