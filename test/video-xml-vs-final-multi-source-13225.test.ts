/**
 * test/video-xml-vs-final-multi-source-13225.test.ts
 *
 * #13225: sem `work/audio.wav` no cache, o fallback de `brutoWav` extraía o
 * áudio de `source.path`, que no bruto em vários arquivos (#12559) é só o do
 * 1º. Os tempos do `plan.json` são globais (linha do tempo concatenada), então
 * a comparação dos clipes a partir do 2º arquivo saía falsa. Agora a
 * sequência é pulada com o motivo; o `audio.wav` do cache segue valendo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brutoWav, compareEdition, type Finder, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";

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
  it("bruto em 2 arquivos sem audio.wav no cache: pula, sem extrair só o 1º", () => {
    const dir = tmp();
    const res = brutoWav("261110", join(dir, "work-sem-cache"), multiPlan(dir));
    assert.equal(res.wav, null);
    assert.ok(res.wav === null && /2 arquivos/.test(res.reason), JSON.stringify(res));
  });

  it("audio.wav do cache da montagem continua valendo no bruto multi-arquivo", () => {
    const dir = tmp();
    writeFileSync(join(dir, "audio.wav"), "");
    const res = brutoWav("261110", dir, multiPlan(dir));
    assert.deepEqual(res, { wav: join(dir, "audio.wav") });
  });

  it("bruto único fora desta máquina segue com o motivo de sempre", () => {
    const res = brutoWav("261110", "/nao-existe", { plans: [], source: { fps: 30, path: "/nao-existe/bruto.mp4" } });
    assert.equal(res.wav, null);
    assert.ok(res.wav === null && /bruto fora desta máquina/.test(res.reason));
  });

  it("compareEdition registra o pulo da sequência com o motivo do multi-arquivo", async () => {
    const dir = tmp();
    const finalPath = join(dir, "261110_Youtube_V1.mp4");
    writeFileSync(finalPath, "nao-e-video");
    const finder: Finder = { mode: "local", list: async () => [], workDir: () => join(dir, "work-sem-cache") };
    const rec = await compareEdition("261110", finder, { plan: multiPlan(dir), finalPath, seq: "youtube" });
    assert.ok(rec);
    assert.equal(rec.sequences.length, 0);
    assert.equal(rec.skipped.length, 1);
    assert.equal(rec.skipped[0].key, "youtube");
    assert.match(rec.skipped[0].reason, /bruto em 2 arquivos/);
  });
});
