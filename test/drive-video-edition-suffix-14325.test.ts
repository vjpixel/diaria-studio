/**
 * #14325: em 30/10 e 09/11 o timer do LinkedIn pessoal do 300 ficou em
 * `missing-video` ("a subpasta da edição existe, mas não tem .mp4 vertical com
 * "final" no nome (0 "final", 2 .mp4 lá dentro)"). Sem `Final/` nem
 * `Editados/`, o `.mp4` com sufixo de destino solto em `{AAMMDD}/` passa a
 * valer como os de `Editados/` (a versão mais alta); o bruto, sem sufixo,
 * continua fora, e `Editados/` continua à frente da raiz da edição.
 * Sem rede (Drive mockado).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectDriveVideo, type DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import { runFetchDriveVideo, type FetchDriveVideoDeps } from "../scripts/fetch-drive-video.ts";

const NOW = new Date("2026-11-09T15:00:00Z");
const FOLDER = "application/vnd.google-apps.folder";
const VERT = { videoMediaMetadata: { width: 1080, height: 1920 } };
const HORIZ = { videoMediaMetadata: { width: 1920, height: 1080 } };

const file = (id: string, name: string, extra: Partial<DriveVideoFile> = {}): DriveVideoFile => ({
  id,
  name,
  mimeType: "video/mp4",
  createdTime: "2026-11-09T12:00:00Z",
  modifiedTime: "2026-11-09T12:00:00Z",
  size: "5",
  scope: "edition-folder",
  ...extra,
});
const bruto = (n: number, dims = VERT) => file(`bruto${n}`, `C000${n}.MP4`, dims);
const vertical = (n: number, extra: Partial<DriveVideoFile> = {}) => file(`v${n}`, `Diaria comentada_Vertical_V${n}.mp4`, { ...VERT, ...extra });
const opts = { orientation: "vertical" as const, now: NOW, editionFolderPresent: true };

test("#14325: só os brutos (sem sufixo, sem final) seguem none, com o motivo dizendo o que falta", () => {
  const sel = selectDriveVideo([bruto(1), bruto(2, HORIZ)], opts);
  assert.equal(sel.kind, "none");
  if (sel.kind === "none") assert.match(sel.reason, /nem com sufixo de destino/);
});

test("#14325: vertical com sufixo solto em {AAMMDD}/ vale, sem promover (sem editedFolder)", () => {
  const sel = selectDriveVideo([bruto(1), vertical(3)], opts);
  assert.equal(sel.kind, "found", JSON.stringify(sel));
  if (sel.kind === "found") {
    assert.equal(sel.file.id, "v3");
    assert.equal(sel.file.editedFolder, undefined, "o fetch só promove o que veio de Editados/");
    assert.match(sel.premise ?? "", /#14325/);
  }
});

test("#14325: 2+ versões soltas em {AAMMDD}/ → a mais alta, premissa sem citar Editados/", () => {
  const sel = selectDriveVideo([vertical(1), vertical(4), vertical(2), bruto(1)], opts);
  assert.equal(sel.kind, "found", JSON.stringify(sel));
  if (sel.kind === "found") {
    assert.equal(sel.file.id, "v4");
    assert.match(sel.premise ?? "", /versão mais alta na subpasta da edição/);
    assert.doesNotMatch(sel.premise ?? "", /Editados\//);
  }
});

test("#14325: versões empatadas sem data que desempate seguem ambiguous (o editor escolhe)", () => {
  const a = file("a", "Diaria comentada_Vertical_V2.mp4", VERT);
  const b = file("b", "Diaria comentada_Outras redes_V2.mp4", VERT);
  const c = file("c", "Diaria comentada_Vertical_V2 (1).mp4", { ...VERT, modifiedTime: "2026-11-09T12:00:00Z" });
  const sel = selectDriveVideo([a, c], opts);
  assert.equal(sel.kind, "ambiguous", JSON.stringify(sel));
  if (sel.kind === "ambiguous") assert.deepEqual(sel.candidates.map((f) => f.editedFolder), [undefined, undefined]);
  // `_Vertical_` vence `_Outras redes_` (mesma ordem de Final/, #11491).
  const ranked = selectDriveVideo([a, b], opts);
  assert.equal(ranked.kind, "found");
  if (ranked.kind === "found") assert.equal(ranked.file.id, "a");
});

test("#14325: \"final\" no nome continua à frente do sufixo", () => {
  const sel = selectDriveVideo([vertical(5), file("fin", "vertical - final.mp4", VERT)], opts);
  assert.equal(sel.kind, "found");
  if (sel.kind === "found") assert.equal(sel.file.id, "fin");
});

test("#14325: editionSuffixFallback: false mantém o none de antes (sondagem do fetch)", () => {
  const sel = selectDriveVideo([vertical(3)], { ...opts, editionSuffixFallback: false });
  assert.equal(sel.kind, "none");
});

test("#14325: horizontal com sufixo não serve como vertical", () => {
  const sel = selectDriveVideo([file("yt", "Diaria comentada_Youtube_V3.mp4", HORIZ)], opts);
  assert.equal(sel.kind, "none");
});

/** Drive com a pasta da edição contendo arquivos soltos e subpastas. */
function mockDrive(editionFiles: DriveVideoFile[], subfolders: Record<string, DriveVideoFile[]>) {
  const idOf = (name: string) => `sub-${name.replace(/\W+/g, "_")}`;
  const strip = ({ scope: _s, ...f }: DriveVideoFile) => f;
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url: string) {
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        for (const [name, files] of Object.entries(subfolders)) {
          if (q.includes(`'${idOf(name)}'`)) return Response.json({ files: files.map(strip) });
        }
        if (q.includes("'ed'")) {
          return Response.json({
            files: [...editionFiles.map(strip), ...Object.keys(subfolders).map((name) => ({ id: idOf(name), name, mimeType: FOLDER }))],
          });
        }
        return Response.json({ files: [{ id: "ed", name: "261109", mimeType: FOLDER }] });
      }
      return Response.json({ id: "root", mimeType: FOLDER });
    },
  };
  return deps;
}

async function fetchVertical(editionFiles: DriveVideoFile[], subfolders: Record<string, DriveVideoFile[]>) {
  const dir = mkdtempSync(join(tmpdir(), "fdv-14325-"));
  try {
    return await runFetchDriveVideo(
      mockDrive(editionFiles, subfolders),
      { aammdd: "261109", orientation: "vertical", folderId: "root", editionDir: dir, now: NOW, windowHours: 36, dryRun: true, force: false },
      () => {},
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#14325 (fetch): cenário da issue — só a raiz da edição com o vertical exportado: acha o vertical", async () => {
  const out = await fetchVertical([bruto(1), vertical(2)], {});
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "v2");
});

test("#14325 (fetch): Editados/ com versão continua à frente do sufixo solto na raiz da edição", async () => {
  const out = await fetchVertical([vertical(9)], { Editados: [file("ed3", "Diaria comentada_Vertical_V3.mp4", VERT)] });
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "ed3");
});
