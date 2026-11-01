/**
 * #11385: na edição 261028 o horizontal veio em
 * `{AAMMDD}/Editado/Diaria comentada_Youtube_FINAL.mp4`, não em `Final/`, e o
 * `fetch-drive-video.ts` respondeu `action: none` — a skill concluiu "ainda
 * não subiu" e o editor teve de passar o caminho à mão (`--video G:/…`).
 * Agora: variações do nome de `Final/` ("Finais", "Versão final") valem, e sem
 * `.mp4` nelas a subpasta `Editado/` (e variações) é listada com a mesma regra.
 * `Final/` com `.mp4` continua tendo precedência. Sem rede (Drive mockado).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEditedFolderName, isFinalFolderName, type DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import { runFetchDriveVideo, type FetchDriveVideoDeps, type FetchDriveVideoInput } from "../scripts/fetch-drive-video.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const FOLDER = "application/vnd.google-apps.folder";
const ROOT_ID = "root";
const EDITION_ID = "ed";

const H = (id: string, name: string): DriveVideoFile => ({
  id,
  name,
  mimeType: "video/mp4",
  createdTime: "2026-10-27T22:00:00Z",
  modifiedTime: "2026-10-27T22:00:00Z",
  size: "5",
  videoMediaMetadata: { width: 1920, height: 1080 },
});

/** `subfolders`: nome da subpasta → arquivos dentro dela. */
function mockDrive(subfolders: Record<string, DriveVideoFile[]>) {
  const listed: string[] = [];
  const idOf = (name: string) => `sub-${name.replace(/\W+/g, "_")}`;
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url) {
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        for (const [name, files] of Object.entries(subfolders)) {
          if (q.includes(`'${idOf(name)}'`)) {
            listed.push(name);
            return Response.json({ files });
          }
        }
        if (q.includes(`'${EDITION_ID}'`)) {
          return Response.json({
            files: [
              ...Object.keys(subfolders).map((name) => ({ id: idOf(name), name, mimeType: FOLDER })),
              { id: "bruto", name: "20261027_191548.mp4", mimeType: "video/mp4", videoMediaMetadata: { width: 3840, height: 2160 } },
            ],
          });
        }
        return Response.json({ files: [{ id: EDITION_ID, name: "261028", mimeType: FOLDER }] });
      }
      return Response.json({ id: decodeURIComponent(u.pathname.split("/").pop() ?? ""), mimeType: FOLDER });
    },
  };
  return { deps, listed };
}

async function dryRun(
  subfolders: Record<string, DriveVideoFile[]>,
  opts: Pick<FetchDriveVideoInput, "orientation" | "target"> = { orientation: "horizontal" },
) {
  const dir = mkdtempSync(join(tmpdir(), "fdv-editado-"));
  const logs: string[] = [];
  try {
    const { deps, listed } = mockDrive(subfolders);
    const input: FetchDriveVideoInput = {
      aammdd: "261028",
      ...opts,
      folderId: ROOT_ID,
      editionDir: dir,
      now: NOW,
      windowHours: 36,
      dryRun: true,
      force: false,
    };
    const out = await runFetchDriveVideo(deps, input, (l) => logs.push(l));
    return { out, listed, logs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REAL_261028 = "Diaria comentada_Youtube_FINAL.mp4";

test("nomes: variações de Final/ e de Editado/ (sem caixa, sem acento)", () => {
  for (const n of ["Final", "FINAL", "Finais", "Versão final", "versao_final"]) assert.equal(isFinalFolderName(n), true, n);
  for (const n of ["Finalizando", "Editado", "pre-final"]) assert.equal(isFinalFolderName(n), false, n);
  for (const n of ["Editado", "editados", "Edição", "Exportado", "EXPORT"]) assert.equal(isEditedFolderName(n), true, n);
  for (const n of ["Brutos", "Final", "edit"]) assert.equal(isEditedFolderName(n), false, n);
});

test("caso real 261028: o horizontal em Editado/ (sem Final/) é encontrado, não 'none'", async () => {
  const { out, listed, logs } = await dryRun({ Editado: [H("yt", REAL_261028)] });
  assert.equal(out.exitCode, 0, JSON.stringify(out.output));
  assert.equal(out.output.action, "dry-run", JSON.stringify(out.output));
  if (out.output.action === "dry-run") {
    assert.equal(out.output.file.id, "yt");
    assert.equal(out.output.file.scope, "final-folder", "mesmo tratamento de Final/ (inclusive no Stage 5)");
  }
  assert.deepEqual(listed, ["Editado"]);
  assert.ok(logs.some((l) => /Editado\/.*#11385/.test(l)), logs.join("\n"));
});

test("Final/ com .mp4 tem precedência: Editado/ só contribui com capas", async () => {
  const { out, listed } = await dryRun({
    Final: [H("fin", "Diaria comentada_Youtube_V3.mp4")],
    Editado: [H("edt", REAL_261028)],
  });
  assert.equal(out.output.action, "dry-run");
  if (out.output.action === "dry-run") assert.equal(out.output.file.id, "fin");
  assert.deepEqual(listed, ["Final", "Editado"]);
});

test("Final/ só com os verticais: o horizontal ainda é procurado em Editado/", async () => {
  const V = (id: string, name: string): DriveVideoFile => ({ ...H(id, name), videoMediaMetadata: { width: 1080, height: 1920 } });
  const { out, listed } = await dryRun({
    Final: [V("ig", "Diaria comentada_Instagram_V3.mp4"), V("or", "Diaria comentada_Outras redes_V3.mp4")],
    Editado: [H("edt", REAL_261028)],
  });
  assert.equal(out.output.action, "dry-run", JSON.stringify(out.output));
  if (out.output.action === "dry-run") assert.equal(out.output.file.id, "edt");
  assert.deepEqual(listed, ["Final", "Editado"]);
});

test("#11419: --target instagram com Final/ só com o genérico NÃO pega o _Instagram_V2 antigo de Editado/", async () => {
  const V = (id: string, name: string): DriveVideoFile => ({ ...H(id, name), videoMediaMetadata: { width: 1080, height: 1920 } });
  const { out, listed, logs } = await dryRun(
    {
      Final: [H("yt", "Diaria comentada_Youtube_V3.mp4"), V("or", "Diaria comentada_Outras redes_V3.mp4")],
      Editado: [V("ig-v2", "Diaria comentada_Instagram_V2.mp4")],
    },
    { orientation: "vertical", target: "instagram" },
  );
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "or");
  assert.deepEqual(listed, ["Final", "Editado"], "Editado/ é consultada para capas, sem selecionar o MP4 antigo");

});

test("#11419: --target instagram com Final/ sem .mp4 ainda cai para Editado/", async () => {
  const V = (id: string, name: string): DriveVideoFile => ({ ...H(id, name), videoMediaMetadata: { width: 1080, height: 1920 } });
  const { out, listed } = await dryRun(
    { Final: [], Editado: [V("ig", "Diaria comentada_Instagram_FINAL.mp4")] },
    { orientation: "vertical", target: "instagram" },
  );
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "ig");
  assert.deepEqual(listed, ["Final", "Editado"]);
});

test("Final/ vazia: cai para Editado/", async () => {
  const { out, listed } = await dryRun({ Final: [], Editado: [H("edt", REAL_261028)] });
  assert.equal(out.output.action, "dry-run");
  if (out.output.action === "dry-run") assert.equal(out.output.file.id, "edt");
  assert.deepEqual(listed, ["Final", "Editado"]);
});

test("variação de nome da pasta: 'Versão final' conta como Final/", async () => {
  const { out } = await dryRun({ "Versão final": [H("vf", "Diaria comentada_Youtube_V4.mp4")] });
  assert.equal(out.output.action, "dry-run");
  if (out.output.action === "dry-run") assert.equal(out.output.file.id, "vf");
});

test("skill: Passo A3 é o upload pela API (padrão); o Studio vira fallback (Passo A5)", async () => {
  const { readFileSync } = await import("node:fs");
  const skill = readFileSync(join(import.meta.dirname, "..", ".claude/skills/diaria-publica-video/SKILL.md"), "utf8");
  assert.match(skill, /### Passo A3 — Upload pela API \(`--upload`, o padrão\)/);
  assert.match(skill, /### Passo A5 — Fallback: o editor sobe pelo Studio/);
  assert.doesNotMatch(skill, /só quando o editor pede/, "o upload não depende mais de pedido do editor");
  assert.match(skill, /Editado\//, "documenta a pasta alternativa");
  assert.match(skill, /--captions-only/, "documenta o envio só da legenda (#11384)");
  assert.match(skill, /"Próximo passo" do editor/);
});
