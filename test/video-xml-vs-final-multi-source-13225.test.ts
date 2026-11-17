/**
 * test/video-xml-vs-final-multi-source-13225.test.ts
 *
 * #13225: sem `work/audio.wav` no cache, o fallback de `brutoWav` extraía o
 * áudio de `source.path`, que no bruto em vários arquivos (#12559) é só o do
 * 1º. Os tempos do `plan.json` são globais (linha do tempo concatenada), então
 * a comparação dos clipes a partir do 2º arquivo saía falsa. Desde o resíduo
 * da #13196/#13197 o bruto multi-arquivo é concatenado na linha do tempo
 * (test/video-xml-vs-final-bruto-lookup-13196.test.ts); o que segue aqui é o
 * pulo quando o `plan.json` não traz os frames de cada arquivo (sem eles a
 * concatenação deslocaria os tempos) e o `audio.wav` do cache valendo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brutoWav, compareEdition, type BrutoLookup, type Finder, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";

/** Nada fora do teste: sem arquivo do HD, sem cache da montagem. */
const NO_LOOKUP: BrutoLookup = { archiveRoot: null, montageEditionCache: () => null };
const noDrive: Finder["brutoFile"] = async () => null;

const tmp = () => mkdtempSync(join(tmpdir(), "xml-vs-final-13225-"));

function multiPlan(dir: string): PlanFileLite {
  const a = join(dir, "bruto-1.mp4");
  const b = join(dir, "bruto-2.mp4");
  writeFileSync(a, "nao-e-video");
  writeFileSync(b, "nao-e-video");
  return {
    plans: [{ spec: { target: "youtube" }, clips: [], durationFrames: 0 } as unknown as PlanFileLite["plans"][number]],
    source: { fps: 30, path: a, files: [{ path: a }, { path: b }] },
  };
}

describe("#13225: fallback do áudio do bruto em vários arquivos", () => {
  it("bruto em 2 arquivos sem frames no plan.json e sem audio.wav no cache: pula, sem extrair só o 1º", async () => {
    const dir = tmp();
    const finder: Finder = { mode: "local", list: async () => [], workDir: () => dir, brutoFile: noDrive };
    const res = await brutoWav("261110", join(dir, "work-sem-cache"), multiPlan(dir), finder, NO_LOOKUP);
    assert.equal(res.wav, null);
    assert.ok(res.wav === null && /vários arquivos sem caminho ou frames/.test(res.reason), JSON.stringify(res));
  });

  it("audio.wav do cache da montagem continua valendo no bruto multi-arquivo", async () => {
    const dir = tmp();
    // WAV de verdade com som: desde o #13417 o audio.wav também passa pela conferência de zeros digitais.
    const pcm = Buffer.alloc(44 + 3200);
    pcm.write("RIFF", 0);
    pcm.writeUInt32LE(36 + 3200, 4);
    pcm.write("WAVEfmt ", 8);
    pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20);
    pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(16000, 24);
    pcm.writeUInt32LE(32000, 28);
    pcm.writeUInt16LE(2, 32);
    pcm.writeUInt16LE(16, 34);
    pcm.write("data", 36);
    pcm.writeUInt32LE(3200, 40);
    for (let i = 0; i < 1600; i++) pcm.writeInt16LE(100 + (i % 7), 44 + 2 * i);
    writeFileSync(join(dir, "audio.wav"), pcm);
    const finder: Finder = { mode: "local", list: async () => [], workDir: () => dir, brutoFile: noDrive };
    const res = await brutoWav("261110", dir, multiPlan(dir), finder, NO_LOOKUP);
    assert.deepEqual(res, { wav: join(dir, "audio.wav") });
  });

  it("bruto único que não está em lugar nenhum: pula dizendo onde procurou", async () => {
    const finder: Finder = { mode: "local", list: async () => [], workDir: () => "/nao-existe", brutoFile: noDrive };
    const res = await brutoWav("261110", "/nao-existe", { plans: [], source: { fps: 30, path: "/nao-existe/bruto.mp4" } }, finder, NO_LOOKUP);
    assert.equal(res.wav, null);
    assert.ok(res.wav === null && /bruto\.mp4 não achado \(caminho do plan\.json, arquivo do HD, cache da montagem, Drive\)/.test(res.reason), JSON.stringify(res));
  });

  it("compareEdition registra o pulo da sequência com o motivo do multi-arquivo", async () => {
    const dir = tmp();
    const finalPath = join(dir, "261110_Youtube_V1.mp4");
    writeFileSync(finalPath, "nao-e-video");
    const finder: Finder = { mode: "local", list: async () => [], workDir: () => join(dir, "work-sem-cache"), brutoFile: noDrive };
    const rec = await compareEdition("261110", finder, { plan: multiPlan(dir), finalPath, seq: "youtube", brutoLookup: NO_LOOKUP });
    assert.ok(rec);
    assert.equal(rec.sequences.length, 0);
    assert.equal(rec.skipped.length, 1);
    assert.equal(rec.skipped[0].key, "youtube");
    assert.match(rec.skipped[0].reason, /vários arquivos sem caminho ou frames/);
  });
});
