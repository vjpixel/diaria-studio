import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSequences, parseBlocksFile, buildSequencePlan, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";
import { decupagemMarkdown, buildDecupagemDoc, roteiroMarkdown, decupagemPlanTemplate } from "../scripts/lib/diaria/video-montage-docs.ts";
import { selectDriveVideo, videoTargetOf, type DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import { chooseInstagramVideo, interpretInstagramCutLookup } from "../scripts/shorts-instagram-timer.ts";

const file = (suffix: string): DriveVideoFile => ({ id: suffix, name: `Diaria comentada_${suffix}_V3.mp4`, mimeType: "video/mp4", scope: "final-folder", videoMediaMetadata: { width: 1080, height: 1920 } });

test("#11491: todos os destinos preferem Vertical, depois Outras redes, depois Instagram", () => {
  const files = [file("Vertical"), file("Outras redes"), file("Instagram")];
  assert.equal(videoTargetOf(files[0].name), "outras-redes");
  for (const target of [undefined, "outras-redes", "instagram"] as const) {
    for (let i = 0; i < files.length; i++) {
      const picked = selectDriveVideo(files.slice(i), { orientation: "vertical", target, now: new Date("2026-10-29") });
      assert.equal(picked.kind, "found");
      if (picked.kind === "found") assert.equal(picked.file.id, files[i].id);
    }
  }
  const ambiguous = selectDriveVideo([files[0], { ...files[0], id: "duplicate" }, files[1]], { orientation: "vertical", now: new Date() });
  assert.equal(ambiguous.kind, "ambiguous", "não cai no legado se a vertical nova é ambígua");
  assert.equal(videoTargetOf("rascunho vertical.mp4"), null, "não promove rascunho de Editado/");
});

test("#11491: Vertical_FINAL em Editado/ é final para todos os destinos verticais", () => {
  const final = { ...file("Vertical"), name: "Diaria comentada_Vertical_FINAL.mp4", editedFolder: true };
  assert.equal(videoTargetOf(final.name), "outras-redes");
  assert.equal(videoTargetOf("Diaria comentada_Vertical_FINALIZANDO.mp4"), null);
  for (const target of [undefined, "outras-redes", "instagram"] as const) {
    const picked = selectDriveVideo([final, file("Outras redes"), file("Instagram")], {
      orientation: "vertical", target, now: new Date("2026-10-30"),
    });
    assert.equal(picked.kind, "found");
    if (picked.kind === "found") assert.equal(picked.file, final);
  }
});

test("#11491: monólogo e entrevista geram duas sequências, um CTA vertical e duas tabelas", () => {
  for (const format of ["monologo", "entrevista"] as const) {
    const specs = defaultSequences("V7", format);
    assert.equal(specs.length, 2);
    assert.equal(specs[1].name, "Diaria comentada_Vertical_V7");
    assert.ok(specs[1].order.includes("cta_vertical"));
    assert.ok(!specs[1].order.includes("cta_out") && !specs[1].order.includes("cta_ig"));
    const plans = specs.map((s) => buildSequencePlan(s, {}, [], { fps: 30, durationS: 1 }));
    const md = roteiroMarkdown("261030", plans, {}, 30);
    assert.match(md, /Roteiro final 261030 \(2 versões\)/);
    assert.equal(md.match(/\| Bloco \| Fala \| Bruto \|/g)?.length, 2);
    const doc = buildDecupagemDoc({ edition: "261030", blocks: [{ key: "comentario", rows: [] }] }, []);
    assert.equal(decupagemMarkdown("261030", doc, specs).match(/^### /gm)?.length, 2);
  }
  const template = decupagemPlanTemplate("261030", []) as { blocks: { key: string }[] };
  assert.ok(template.blocks.some((b) => b.key === "cta_vertical"));
  assert.ok(!template.blocks.some((b) => b.key === "cta_ig" || b.key === "cta_out"));
});

test("#11491: blocks legado é legível com sequências explícitas; sem elas explica a migração", () => {
  const legacy = { edition: "261029", blocks: { cta_out: [{ start: 0, end: 1 }] } };
  const result = parseBlocksFile(legacy);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(" "), /legado.*cta_vertical.*sequences/);
  const seq: SequenceSpec = { ...defaultSequences()[1], name: "Diaria comentada_Outras redes_V1", order: ["cta_out"] };
  assert.equal(parseBlocksFile({ ...legacy, sequences: [seq] }).ok, true);
  assert.equal(parseBlocksFile({ edition: "261030", blocks: { cta_vertical: [{ start: 0, end: 1 }] } }).ok, true);
});

test("#11491: timer aceita a vertical única devolvida pelo fetch e invalida o cache antigo", () => {
  const lookup = interpretInstagramCutLookup(0, JSON.stringify({ action: "print-id", file: { id: "new", name: file("Vertical").name, modifiedTime: "2026-10-29T12:00:00Z" } }));
  assert.equal(lookup.kind, "found");
  const choice = chooseInstagramVideo({ instagramCutPath: "/tmp/instagram.mp4", instagramCutExists: true, cutSidecar: { fileId: "old", modifiedTime: null }, genericPath: "/tmp/vertical.mp4", genericExists: true, lookup });
  assert.equal(choice.kind, "download");
  if (choice.kind === "download") assert.equal(choice.fileId, "new");
});
