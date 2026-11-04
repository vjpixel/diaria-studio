/**
 * #12133: na 261104 a pasta `{AAMMDD}/Editado/` (sem `Final/`) tinha
 * `Diaria comentada_Youtube_Edição 09_V1.mp4` (achado) e
 * `Diaria comentada_Vertical_Edição 09_V1.mp4`, que o fetch não reconheceu:
 * `videoTargetOf` só aceitava `_Vertical_` colado ao `_V{n}`. A mensagem do
 * `none` ainda chamava `Editado/` de "pasta Final/". Sem rede (Drive mockado).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectDriveVideo,
  verticalInfixOf,
  videoTargetOf,
  type DriveVideoFile,
} from "../scripts/lib/diaria/drive-video-source.ts";
import { runFetchDriveVideo, type FetchDriveVideoDeps, type FetchDriveVideoInput } from "../scripts/fetch-drive-video.ts";

const NOW = new Date("2026-11-04T03:29:00Z");
const FOLDER = "application/vnd.google-apps.folder";
const EDITION_ID = "ed";
const EDITADO_ID = "1zQ2Ft8qQEcd7QAWk3i3zEARthRd2BCei";

const REAL_H = "Diaria comentada_Youtube_Edição 09_V1.mp4";
const REAL_V = "Diaria comentada_Vertical_Edição 09_V1.mp4";

const file = (id: string, name: string, dims?: { width: number; height: number }): DriveVideoFile => ({
  id,
  name,
  mimeType: "video/mp4",
  createdTime: "2026-11-04T02:00:00Z",
  modifiedTime: "2026-11-04T02:00:00Z",
  size: "124500000",
  ...(dims ? { videoMediaMetadata: dims } : {}),
});

test("videoTargetOf: _Vertical_ com texto livre antes do _V{n} é a vertical (acento, número da edição, versão)", () => {
  for (const n of [
    REAL_V,
    "Diaria comentada_Vertical_Edicao 09_V1.mp4",
    "Diaria comentada_Vertical_Edição 9_V12.mp4",
    "Diaria comentada_Vertical_EDIÇÃO 09_v3.mp4",
    "Diaria comentada_Vertical_Edição 09 V2.mp4",
    "Diaria comentada_Vertical_V1.mp4",
    "Diaria comentada_Vertical_FINAL.mp4",
  ]) {
    assert.equal(videoTargetOf(n), "outras-redes", n);
  }
  assert.equal(videoTargetOf(REAL_H), "youtube");
  // Continua de fora: sem versão, final negado, corte pelo sufixo, dois destinos.
  for (const n of [
    "Diaria comentada_Vertical_Edição 09.mp4",
    "Diaria comentada_Vertical_pre-final.mp4",
    "Diaria comentada_Vertical_Edição 09_V1-soberana.mp4",
    "Diaria comentada_Youtube_Vertical_Edição 09_V1.mp4",
  ]) {
    assert.equal(videoTargetOf(n), null, n);
  }
});

test("seleção: a vertical real de Editado/ é achada mesmo sem videoMediaMetadata (Drive ainda processando)", () => {
  for (const dims of [undefined, { width: 1080, height: 1920 }]) {
    const sel = selectDriveVideo(
      [
        { ...file("yt", REAL_H, { width: 1920, height: 1080 }), scope: "final-folder", editedFolder: true, folderName: "Editado" },
        { ...file("1uiqIT4olo1wZQpst7_29xpk57a6Lm3FX", REAL_V, dims), scope: "final-folder", editedFolder: true, folderName: "Editado" },
      ],
      { orientation: "vertical", now: NOW, editionFolderPresent: true },
    );
    assert.equal(sel.kind, "found", JSON.stringify(sel));
    if (sel.kind === "found") assert.equal(sel.file.id, "1uiqIT4olo1wZQpst7_29xpk57a6Lm3FX");
  }
});

test("seleção: V1 e V2 do mesmo nome-base em Editado/ → a mais alta; nome-base diferente (corte sem blocks.json) → ambíguo", () => {
  const ed = (id: string, name: string): DriveVideoFile => ({ ...file(id, name), scope: "final-folder", editedFolder: true });
  const same = selectDriveVideo([ed("v1", REAL_V), ed("v2", "Diaria comentada_Vertical_Edição 09_V2.mp4")], {
    orientation: "vertical",
    now: NOW,
    editionFolderPresent: true,
  });
  assert.equal(same.kind, "found", JSON.stringify(same));
  if (same.kind === "found") assert.equal(same.file.id, "v2");

  // Sem a lista de cortes, o export do corte casaria o mesmo destino e o V2
  // dele venceria a vertical da edição pela versão: nunca escolher sozinho.
  const corte = selectDriveVideo([ed("v1", REAL_V), ed("corte", "Diaria comentada_Vertical_IA Soberana_Edição 09_V2.mp4")], {
    orientation: "vertical",
    now: NOW,
    editionFolderPresent: true,
  });
  assert.equal(corte.kind, "ambiguous", JSON.stringify(corte));

  // Com a lista, o corte sai do pool e a vertical da edição é achada.
  const withCortes = selectDriveVideo([ed("v1", REAL_V), ed("corte", "Diaria comentada_Vertical_IA Soberana_Edição 09_V2.mp4")], {
    orientation: "vertical",
    now: NOW,
    editionFolderPresent: true,
    cortes: [{ corte: "soberana", screenTitle: "IA Soberana" }],
  });
  assert.equal(withCortes.kind, "found", JSON.stringify(withCortes));
  if (withCortes.kind === "found") assert.equal(withCortes.file.id, "v1");
});

test("verticalInfixOf: o texto entre _Vertical_ e o V{n}, sem acento; texto antes do destino não conta", () => {
  assert.equal(verticalInfixOf(REAL_V), "edicao 09");
  assert.equal(verticalInfixOf("Diaria comentada_Vertical_Edicao 09_V7.mp4"), "edicao 09");
  assert.equal(verticalInfixOf("Diaria comentada_Vertical_IA Soberana_Edição 09_V2.mp4"), "ia soberana edicao 09");
  assert.equal(verticalInfixOf("Diaria comentada_Vertical_V1.mp4"), "");
  assert.equal(verticalInfixOf("Diaria comentada edição 6_Instagram_V1.mp4"), null);
});

test("mensagem do none nomeia a pasta real (Editado/), não 'Final/'", () => {
  const sel = selectDriveVideo(
    [{ ...file("yt", REAL_H, { width: 1920, height: 1080 }), scope: "final-folder", editedFolder: true, folderName: "Editado" }],
    { orientation: "vertical", now: NOW, editionFolderPresent: true },
  );
  assert.equal(sel.kind, "none");
  if (sel.kind === "none") {
    assert.match(sel.reason, /a pasta Editado\//);
    assert.doesNotMatch(sel.reason, /Final\//);
    assert.match(sel.reason, /_Vertical_V3\.mp4/);
  }
});

function mockDrive(editado: DriveVideoFile[]): FetchDriveVideoDeps {
  return {
    async driveFetch(url) {
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        if (q.includes(`'${EDITADO_ID}'`)) return Response.json({ files: editado });
        if (q.includes(`'${EDITION_ID}'`)) {
          return Response.json({ files: [{ id: EDITADO_ID, name: "Editado", mimeType: FOLDER }] });
        }
        return Response.json({ files: [{ id: EDITION_ID, name: "261104", mimeType: FOLDER }] });
      }
      return Response.json({ id: decodeURIComponent(u.pathname.split("/").pop() ?? ""), mimeType: FOLDER });
    },
  };
}

test("caso real 261104 (fetch, dry-run): a vertical de Editado/ é encontrada, não 'none'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fdv-12133-"));
  try {
    const input: FetchDriveVideoInput = {
      aammdd: "261104",
      orientation: "vertical",
      folderId: "root",
      editionDir: dir,
      now: NOW,
      windowHours: 36,
      dryRun: true,
      force: false,
      cortes: [],
    };
    const out = await runFetchDriveVideo(
      mockDrive([file("yt", REAL_H, { width: 1920, height: 1080 }), file("1uiqIT4olo1wZQpst7_29xpk57a6Lm3FX", REAL_V)]),
      input,
      () => {},
    );
    // A vertical devolve o id para o `publish-shorts.ts --from-drive` (o contorno manual da 261104).
    assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
    if (out.output.action === "print-id") {
      assert.equal(out.output.file.id, "1uiqIT4olo1wZQpst7_29xpk57a6Lm3FX");
      assert.match(out.output.next_command ?? "", /--from-drive 1uiqIT4olo1wZQpst7_29xpk57a6Lm3FX/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
