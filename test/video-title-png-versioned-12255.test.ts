import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { renderVersionedTitlePng, screenTitleXmlFor } from "../scripts/video-montagem.ts";
import { buildSequencePlan, buildXmeml, defaultSequences, isVerticalSpec } from "../scripts/lib/diaria/video-montage.ts";

for (const corte of [undefined, "c2"]) {
  it(`#12255 dois builds preservam PNG e XML próprios (${corte ?? "geral"})`, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "title-12255-"));
    try {
      const source = { path: "G:/edicao/bruto.mp4", fps: 30, durationS: 60, width: 3840, height: 2160, mirrored: false };
      const spec = { ...defaultSequences().find(isVerticalSpec)!, corte, order: ["titulo" as const] };
      const plan = buildSequencePlan(spec, { titulo: [{ interval: { start: 1, end: 5 }, text: "Título", words: [], lastWordEnd: null, holdLimit: 5, how: "explicit" }] }, [], source);
      const build = async (text: string, version: number) => {
        const asset = await renderVersionedTitlePng({ outDir, mediaPath: source.path, edition: "261106", corte, text, width: spec.width, height: spec.height });
        const title = screenTitleXmlFor(text, asset.xmlPath);
        const xml = buildXmeml([{ ...plan, spec: { ...spec, name: `Vertical_V${version}` } }], source, { faceX: 0.5, eyeY: 0.5 }, corte ? { screenTitleByCorte: { [corte]: title } } : { screenTitle: title });
        const path = join(outDir, `V${version}.xml`);
        writeFileSync(path, xml);
        return { ...asset, path, xml };
      };
      const old = await build("Título antigo", 1);
      const oldBytes = readFileSync(old.png);
      const next = await build("Título novo", 2);
      assert.notEqual(old.png, next.png);
      assert.notDeepEqual(oldBytes, readFileSync(next.png));
      assert.deepEqual(readFileSync(old.png), oldBytes);
      assert.equal(readFileSync(old.path, "utf8"), old.xml);
      for (const [own, other] of [[old, next], [next, old]]) {
        assert.ok(own.xml.includes(`<pathurl>file://localhost/${own.xmlPath}</pathurl>`), own.xml);
        assert.ok(!own.xml.includes(basename(other.png)));
      }
      assert.equal((await build("Título novo", 2)).png, next.png, "rebuild idêntico mantém identidade");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
}
