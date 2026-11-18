/**
 * test/video-xml-vs-final-final-flag-13609.test.ts
 *
 * #13609: `compare --final` restringe a rodada a um arquivo. As outras
 * sequências saíam como "sem final exportado em Final/" mesmo com final em
 * `Editados/` (261118). Agora saem como "fora do --final passado"; sem
 * `--final`, o motivo cita as duas pastas procuradas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareEdition, noFinalReason, type Finder, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";

const plan: PlanFileLite = {
  plans: [
    { spec: { target: "youtube" }, clips: [], durationFrames: 0 },
    { spec: { target: "outras-redes" }, clips: [], durationFrames: 0 },
  ] as unknown as PlanFileLite["plans"],
  source: { fps: 30 },
};

const finder = (list: Finder["list"]): Finder => ({ mode: "local", list, workDir: () => "/nao-existe", brutoFile: async () => null });

describe("#13609 compare --final: motivo das sequências fora do arquivo passado", () => {
  it("com --final do horizontal, a vertical sai como fora do --final, não como sem final exportado", async () => {
    let listed = false;
    const rec = await compareEdition(
      "261118",
      finder(async () => {
        listed = true;
        return [];
      }),
      // `skip` tira o horizontal da comparação de fato (evita ffmpeg/bruto no teste); o --final continua sendo o dele.
      { plan, finalPath: "/drive/261118/Editados/261118_Diaria comentada horizontal_V1.mp4", skip: new Set(["youtube"]) },
    );
    assert.ok(rec);
    assert.equal(listed, false, "com --final o finder não é consultado");
    assert.equal(rec.skipped.length, 1);
    assert.equal(rec.skipped[0].key, "outras-redes");
    assert.match(rec.skipped[0].reason, /^fora do --final passado \(261118_Diaria comentada horizontal_V1\.mp4\)/);
    assert.doesNotMatch(rec.skipped[0].reason, /sem final exportado/);
  });

  it("sem --final e sem mp4 achado, o motivo cita Final/ e Editados/", async () => {
    const rec = await compareEdition("261118", finder(async () => []), { plan });
    assert.ok(rec);
    assert.equal(rec.skipped.length, 2);
    for (const s of rec.skipped) {
      assert.match(s.reason, /^sem final exportado/);
      assert.match(s.reason, /Final\//);
      assert.match(s.reason, /Editados\//);
    }
  });

  it("noFinalReason: as duas formas", () => {
    assert.equal(noFinalReason(undefined), "sem final exportado (procurado em Final/ e Editados/)");
    assert.match(noFinalReason("C:/x/Final/a.mp4"), /^fora do --final passado \(a\.mp4\)/);
  });
});
