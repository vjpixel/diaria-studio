/**
 * #13643 — o trecho do XML leve que chega ao fim do arquivo do bruto falhava a
 * conferência de quadros. Os quadros do bruto saem da duração do CONTAINER, e
 * o `trechoEndFor` prende o fim do trecho nela; o stream de vídeo acaba 1 a 3
 * quadros antes (padding do AAC, o mesmo efeito do #13500 no trecho inserido).
 * O `renderTrechos` conferia com ±1 quadro, lançava `TrechoFramesError` e o
 * build caía inteiro no XML do bruto.
 *
 * Cobre: o render e o reaproveitamento do trecho do fim com uns quadros a
 * menos (aceitos, com [premissa]); o trecho do meio do arquivo segue exato
 * (±1); além da folga, o do fim também é recusado; o `verify-xml`
 * (`trechoMediaIssues`) com os quadros do bruto aceita o do fim.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { TRECHO_END_SHORT_TOL_S, TRECHOS, trechoFileFramesByStem, trechoMinFrames, trechoSourceStem } from "../scripts/lib/diaria/video-xml-trechos.ts";
import { renderTrechos, TrechoFramesError, trechoMediaIssues } from "../scripts/video-montagem.ts";

// Bruto de 10 s a 30 fps (300 quadros pelo container). Clipe 270-300 (a última fala até o fim do arquivo),
// folga de 1 s: trecho 240-300, 60 quadros pelo nome; o encode rende 57 a 59 (o stream acaba antes).
const sourceIn = (dir: string): SourceInfo => ({ path: join(dir, "b.mp4"), fps: 30, durationS: 10, width: 3840, height: 2160, mirrored: false });
const TAIL = "b_q000240-000300.mov";
const tailPlans = [{ clips: [{ frameIn: 270, frameOut: 300 }] as never }];
// Clipe do meio: trecho 0-90.
const MID = "b_q000000-000090.mov";
const midPlans = [{ clips: [{ frameIn: 30, frameOut: 60 }] as never }];
const fakeEncode = (args: string[]) => writeFileSync(args[args.length - 1], "render");

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "trechos-13643-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#13643 helpers puros", () => {
  it("trechoMinFrames: folga só no trecho que termina no fim do arquivo", () => {
    const tol = Math.ceil(TRECHO_END_SHORT_TOL_S * 30);
    assert.equal(trechoMinFrames({ start: 240, end: 300 }, 300, 30), 60 - tol);
    assert.equal(trechoMinFrames({ start: 0, end: 90 }, 300, 30), 90, "meio do arquivo: os do nome");
    assert.equal(trechoMinFrames({ start: 240, end: 300 }, undefined, 30), 60, "arquivo desconhecido: os do nome");
  });

  it("trechoSourceStem e trechoFileFramesByStem casam o nome do trecho com o arquivo do bruto", () => {
    assert.equal(trechoSourceStem("20261117_181712_q003270-004050.mov"), "20261117_181712");
    assert.equal(trechoSourceStem("261118_trecho_t1-abc123.mov"), null);
    const m = trechoFileFramesByStem([{ path: "I:/v/20261117_181712.mp4", frames: 4050 }, { path: "C:\\v\\b.MP4", frames: 300 }]);
    assert.equal(m.get("20261117_181712"), 4050);
    assert.equal(m.get("b"), 300);
  });
});

describe("#13643 renderTrechos com o trecho até o fim do bruto", () => {
  it("cenário da issue: o render com 58 de 60 quadros é aceito, com [premissa]; antes lançava", () => {
    withDir((dir) => {
      const lines: string[] = [];
      const r = renderTrechos({ plans: tailPlans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode, probeFrames: () => 58, log: (m) => lines.push(m) });
      assert.deepEqual(r.trechos.map((t) => t.name), [TAIL]);
      assert.deepEqual([r.made, r.reused, r.redone], [1, 0, 0]);
      const out = lines.join("\n");
      assert.doesNotMatch(out, /refazendo/, "nada de 2ª tentativa");
      assert.match(out, /\[premissa\] trecho b_q000240-000300\.mov: o render tem 58 quadro\(s\), 2 a menos que o nome .*\(#13643\)/);
    });
  });

  it("o trecho do fim já no disco com 57 quadros é reaproveitado", () => {
    withDir((dir) => {
      mkdirSync(join(dir, TRECHOS.dirName));
      writeFileSync(join(dir, TRECHOS.dirName, TAIL), "ok");
      const r = renderTrechos({ plans: tailPlans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: () => assert.fail("não devia recodificar"), probeFrames: () => 57, log: () => {} });
      assert.deepEqual([r.reused, r.made, r.redone], [1, 0, 0]);
    });
  });

  it("além da folga, o trecho do fim também é recusado (truncado de verdade)", () => {
    withDir((dir) => {
      const bad = () => renderTrechos({ plans: tailPlans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode, probeFrames: () => 40, log: () => {} });
      assert.throws(bad, TrechoFramesError);
    });
  });

  it("o trecho do meio do arquivo segue exato (±1): 88 de 90 é refeito e depois lança", () => {
    withDir((dir) => {
      const bad = () => renderTrechos({ plans: midPlans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode, probeFrames: () => 88, log: () => {} });
      assert.throws(bad, TrechoFramesError);
    });
  });
});

describe("#13643 trechoMediaIssues (verify-xml) com os quadros do bruto", () => {
  const xml = `<file id="file-1-t240"><name>${TAIL}</name></file><file id="file-1-t0"><name>${MID}</name></file>`;
  const probe = (p: string) => (p.endsWith(TAIL) ? 58 : 90);

  it("o trecho do fim com uns quadros a menos não é erro quando o bruto é conhecido", () => {
    withDir((dir) => {
      writeFileSync(join(dir, TAIL), "x");
      writeFileSync(join(dir, MID), "x");
      assert.deepEqual(trechoMediaIssues([xml], dir, probe, null, { fps: 30, framesByStem: trechoFileFramesByStem([{ path: join(dir, "b.mp4"), frames: 300 }]) }), []);
      // Sem os quadros do bruto, a conferência exata de antes.
      assert.equal(trechoMediaIssues([xml], dir, probe).length, 1);
    });
  });

  it("o cmdVerifyXml passa os quadros do bruto (senão o verify-xml acusaria o trecho do fim que o build aceitou)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    const body = src.slice(src.indexOf("function cmdVerifyXml("), src.indexOf("bad += mediaIssues.length;"));
    assert.match(body, /framesByStem: trechoFileFramesByStem\(sourceFiles\(pf\.source\)\)/);
  });
});
