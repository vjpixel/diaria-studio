/**
 * #11950: na 261103 os exports vieram em `Final/` fora do padrão
 * (`Diaria comentada_Vertical_Edição 08_V2.mp4`,
 * `Diaria comentada_Vertical_IA Soberana_Edição 08_V2.mp4`) com duas Stills
 * (`…_Vertical_V1.00_00_06_16.Still002.jpg` e
 * `…_Vertical_V1-soberana.00_00_00_00.Still002.jpg`). O fetch da vertical saiu
 * `needs-editor`/`ambiguous-cover` (a Still do corte contou como capa da
 * vertical da edição), e `--corte soberana` não achava o export do corte.
 * Nomes reais da 261103; Drive mockado, sem rede.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  corteCoverCandidates,
  corteOfName,
  driveCoverCandidates,
  selectCorteExport,
  selectDriveVideo,
  type CorteRef,
  type DriveVideoFile,
} from "../scripts/lib/diaria/drive-video-source.ts";
import { loadCorteRefs, runFetchCorteExports, runFetchDriveVideo, type FetchDriveVideoDeps } from "../scripts/fetch-drive-video.ts";

const FOLDER = "application/vnd.google-apps.folder";
const VERT = { videoMediaMetadata: { width: 1080, height: 1920 } };

const mp4 = (id: string, name: string): DriveVideoFile => ({
  id, name, mimeType: "video/mp4", modifiedTime: "2026-11-03T20:00:00Z", scope: "final-folder", ...VERT,
});
const jpg = (id: string, name: string): DriveVideoFile => ({
  id, name, mimeType: "image/jpeg", modifiedTime: "2026-11-03T20:00:00Z", scope: "final-folder",
});

// Nomes reais da 261103.
const MAIN = mp4("main", "Diaria comentada_Vertical_Edição 08_V2.mp4");
const SOB = mp4("sob", "Diaria comentada_Vertical_IA Soberana_Edição 08_V2.mp4");
const STILL_MAIN = jpg("still-main", "Diaria comentada_Vertical_V1.00_00_06_16.Still002.jpg");
const STILL_SOB = jpg("still-sob", "Diaria comentada_Vertical_V1-soberana.00_00_00_00.Still002.jpg");
const REFS: CorteRef[] = [{ corte: "soberana", screenTitle: "IA Soberana" }];
const FILES = [MAIN, SOB, STILL_MAIN, STILL_SOB];

test("corteOfName: Still com -{slug} antes do timecode, export pelo screenTitle ou slug, vertical da edição fica null", () => {
  assert.equal(corteOfName(STILL_SOB.name), "soberana", "a Still do corte é reconhecida mesmo sem o blocks.json");
  assert.equal(corteOfName(STILL_MAIN.name), null);
  assert.equal(corteOfName(SOB.name, REFS), "soberana");
  assert.equal(corteOfName(SOB.name, [{ corte: "soberana" }]), "soberana", "só o slug, como palavra, também serve");
  assert.equal(corteOfName(MAIN.name, REFS), null);
  assert.equal(corteOfName("Diaria comentada_Vertical_V1-soberana.mp4"), "soberana", "padrão #11900 continua");
});

test("corteOfName: palavra inteira, e slug/título igual a palavra de destino é ignorado", () => {
  assert.equal(corteOfName("Diaria comentada_Vertical_Soberanamente_V2.mp4", REFS), null);
  assert.equal(corteOfName(MAIN.name, [{ corte: "vertical" }, { corte: "x", screenTitle: "Final" }]), null);
});

test("capa: a Still do corte não conta como capa da vertical da edição e vira capa do corte", () => {
  assert.deepEqual(driveCoverCandidates(FILES, "vertical").map((f) => f.id), ["still-main"]);
  assert.deepEqual(corteCoverCandidates(FILES, "soberana", REFS).map((f) => f.id), ["still-sob"]);
});

test("vídeo: o export do corte não concorre com a vertical da edição, e o modo corte o acha pelo título", () => {
  const sel = selectDriveVideo(FILES, { orientation: "vertical", now: new Date(), editionFolderPresent: true, cortes: REFS });
  assert.equal(sel.kind, "found");
  assert.equal(sel.kind === "found" && sel.file.id, "main");
  const corte = selectCorteExport(FILES, "soberana", REFS);
  assert.equal(corte.kind === "found" && corte.file.id, "sob");
});

test("loadCorteRefs: lê slug e screenTitle do blocks.json; ausente ou ilegível = nenhum corte, sem lançar", () => {
  const dir = mkdtempSync(join(tmpdir(), "corte-refs-11950-"));
  try {
    const lines: string[] = [];
    assert.deepEqual(loadCorteRefs(dir, (l) => lines.push(l)), []);
    mkdirSync(join(dir, "_internal", "video-montagem"), { recursive: true });
    const path = join(dir, "_internal", "video-montagem", "blocks.json");
    writeFileSync(path, JSON.stringify({ edition: "261103", sequences: [{ name: "Diaria comentada_Vertical_V1" }, { name: "x", corte: "soberana", screenTitle: "IA Soberana" }, { corte: "Não Slug" }] }));
    assert.deepEqual(loadCorteRefs(dir, (l) => lines.push(l)), REFS);
    writeFileSync(path, "{nope");
    assert.deepEqual(loadCorteRefs(dir, (l) => lines.push(l)), []);
    assert.ok(lines.some((l) => l.includes("ilegível")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function driveDeps(): FetchDriveVideoDeps {
  return {
    driveFetch: async (url) => {
      const u = new URL(url);
      if (u.searchParams.has("alt")) throw new Error(`download inesperado: ${url}`);
      if (u.pathname.endsWith("/root")) return Response.json({ id: "root", name: "YouTube", mimeType: FOLDER });
      const q = u.searchParams.get("q") ?? "";
      if (q.startsWith("'root'")) return Response.json({ files: [{ id: "edition", name: "261103", mimeType: FOLDER }] });
      if (q.startsWith("'edition'")) return Response.json({ files: [{ id: "final", name: "Final", mimeType: FOLDER }] });
      if (q.startsWith("'final'")) return Response.json({ files: FILES.map(({ scope: _s, ...rest }) => rest) });
      throw new Error(`pasta inesperada: ${url}`);
    },
  };
}

test("cenário real 261103: fetch --orientation vertical acha a vertical e a capa da edição (não ambiguous-cover)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-11950-"));
  try {
    mkdirSync(join(dir, "_internal", "video-montagem"), { recursive: true });
    writeFileSync(join(dir, "_internal", "video-montagem", "blocks.json"), JSON.stringify({ edition: "261103", sequences: [{ name: "Diaria comentada_Vertical_V1-soberana", corte: "soberana", screenTitle: "IA Soberana" }] }));
    const lines: string[] = [];
    const out = await runFetchDriveVideo(driveDeps(), {
      aammdd: "261103", orientation: "vertical", folderId: "root", editionDir: dir, now: new Date("2026-11-03T21:00:00Z"),
      windowHours: 36, dryRun: true, force: false,
    }, (l) => lines.push(l));
    assert.equal(out.exitCode, 0, lines.join("\n"));
    assert.equal(out.output.action, "print-id");
    if (out.output.action === "print-id") assert.equal(out.output.file.id, "main");
    assert.equal(out.output.cover?.file?.id, "still-main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cenário real 261103: --corte soberana acha o export pelo screenTitle e a Still do corte", async () => {
  const out = await runFetchCorteExports(driveDeps(), { aammdd: "261103", folderId: "root", cortes: ["soberana"], corteRefs: REFS }, () => {});
  assert.equal(out.exitCode, 0);
  assert.equal(out.output.action, "cortes");
  if (out.output.action !== "cortes") return;
  const [r] = out.output.cortes;
  assert.equal(r.selection, "found");
  assert.equal(r.file?.id, "sob");
  assert.deepEqual(r.cover.selection === "found" ? r.cover.file.id : null, "still-sob");
  assert.equal(out.output.drive_ids, "soberana=sob");
});
