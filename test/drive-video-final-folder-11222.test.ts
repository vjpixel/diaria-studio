/**
 * #11222: fluxo real do vídeo desde a edição 261027 — o vídeo pronto fica em
 * `{AAMMDD}/Final/`, sem "final" no nome e com o destino no nome
 * (`Diaria comentada_{Youtube,Instagram,Outras redes}_V3.mp4`). Antes, o
 * `fetch-drive-video.ts` não descia em `Final/` e exigia "final" no nome do
 * arquivo: a skill concluía "ainda não subiu". Sem rede (Drive mockado).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultVideoTarget,
  isFinalFolderName,
  selectDriveVideo,
  videoTargetOf,
  type DriveVideoFile,
} from "../scripts/lib/diaria/drive-video-source.ts";
import {
  parseFetchDriveVideoArgs,
  runFetchDriveVideo,
  type FetchDriveVideoDeps,
  type FetchDriveVideoInput,
} from "../scripts/fetch-drive-video.ts";

const NOW = new Date("2026-10-27T12:00:00Z");
const T = "2026-10-26T22:00:00Z";
const FOLDER = "application/vnd.google-apps.folder";

function vid(name: string, w: number | null, h: number | null, extra: Partial<DriveVideoFile> = {}): DriveVideoFile {
  return {
    id: `id-${name.replace(/\W+/g, "-")}`,
    name,
    mimeType: "video/mp4",
    createdTime: T,
    modifiedTime: T,
    ...(w !== null && h !== null ? { videoMediaMetadata: { width: w, height: h } } : {}),
    ...extra,
  };
}
const H = (n: string, e: Partial<DriveVideoFile> = {}) => vid(n, 1920, 1080, { scope: "final-folder", ...e });
const V = (n: string, e: Partial<DriveVideoFile> = {}) => vid(n, 1080, 1920, { scope: "final-folder", ...e });

const YT = "Diaria comentada_Youtube_V3.mp4";
const IG = "Diaria comentada_Instagram_V3.mp4";
const OR = "Diaria comentada_Outras redes_V3.mp4";

test("videoTargetOf reconhece os sufixos do editor; isFinalFolderName ignora caixa e espaços", () => {
  assert.equal(videoTargetOf(YT), "youtube");
  assert.equal(videoTargetOf(IG), "instagram");
  assert.equal(videoTargetOf(OR), "outras-redes");
  assert.equal(videoTargetOf("diaria-comentada-outras-redes-v4.mp4"), "outras-redes");
  assert.equal(videoTargetOf("Diaria comentada_V3.mp4"), null);
  assert.equal(videoTargetOf("Youtube_Instagram.mp4"), null, "dois destinos no nome não decide");
  assert.equal(isFinalFolderName(" Final "), true);
  assert.equal(isFinalFolderName("FINAL"), true);
  assert.equal(isFinalFolderName("Finalizando"), false);
  assert.equal(defaultVideoTarget("horizontal"), "youtube");
  assert.equal(defaultVideoTarget("vertical"), "outras-redes");
});

test("pasta Final/: arquivos sem 'final' no nome valem; horizontal = _Youtube_, vertical = _Outras redes_", () => {
  const files = [H(YT), V(IG), V(OR)];
  const h = selectDriveVideo(files, { orientation: "horizontal", now: NOW, editionFolderPresent: true });
  const v = selectDriveVideo(files, { orientation: "vertical", now: NOW, editionFolderPresent: true });
  assert.equal(h.kind, "found");
  if (h.kind === "found") assert.equal(h.file.name, YT);
  // Os DOIS verticais (Instagram e Outras redes) não são ambíguos: a prioridade histórica decide para todos os destinos.
  assert.equal(v.kind, "found");
  if (v.kind === "found") assert.equal(v.file.name, OR);
  const ig = selectDriveVideo(files, { orientation: "vertical", now: NOW, editionFolderPresent: true, target: "instagram" });
  assert.equal(ig.kind, "found");
  if (ig.kind === "found") assert.equal(ig.file.name, OR);
});

test("pasta Final/: o sufixo decide mesmo sem proporção no Drive; proporção contrária exclui", () => {
  const noMeta = [vid(YT, null, null, { scope: "final-folder" }), V(OR)];
  const h = selectDriveVideo(noMeta, { orientation: "horizontal", now: NOW, editionFolderPresent: true });
  assert.equal(h.kind, "found");
  const wrong = [V("Diaria comentada_Youtube_V3.mp4")];
  assert.equal(selectDriveVideo(wrong, { orientation: "horizontal", now: NOW, editionFolderPresent: true }).kind, "none");
});

test("pasta Final/: V2 e V3 do mesmo destino → ambiguous (o editor escolhe)", () => {
  const sel = selectDriveVideo([H("Diaria comentada_Youtube_V2.mp4"), H(YT)], { orientation: "horizontal", now: NOW, editionFolderPresent: true });
  assert.equal(sel.kind, "ambiguous");
});

test("pasta Final/ precede a regra do nome na subpasta; sem o destino pedido → none, sem cair na subpasta", () => {
  const files = [V(IG), vid("antigo - final.mp4", 1920, 1080, { scope: "edition-folder" })];
  const sel = selectDriveVideo(files, { orientation: "horizontal", now: NOW, editionFolderPresent: true });
  assert.equal(sel.kind, "none");
  if (sel.kind === "none") assert.match(sel.reason, /Final\/.*youtube/);
});

test("Final/ sem .mp4: volta à regra antiga da subpasta da edição", () => {
  const files = [{ id: "doc", name: "roteiro.docx", mimeType: "application/pdf", scope: "final-folder" as const }, vid("V3 - final.mp4", 1920, 1080, { scope: "edition-folder" })];
  const sel = selectDriveVideo(files, { orientation: "horizontal", now: NOW, editionFolderPresent: true });
  assert.equal(sel.kind, "found");
});

test("Final/ com .mp4 sem sufixo: escolha pela proporção, como antes", () => {
  const sel = selectDriveVideo([H("Diaria comentada_V3.mp4"), V("Diaria comentada vertical_V3.mp4")], {
    orientation: "vertical",
    now: NOW,
    editionFolderPresent: true,
  });
  assert.equal(sel.kind, "found");
  if (sel.kind === "found") assert.match(sel.file.name, /vertical/);
});

test("destino incompatível com a orientação lança (erro de programação)", () => {
  assert.throws(() => selectDriveVideo([], { orientation: "horizontal", now: NOW, target: "instagram" }), /instagram/);
});

// ── CLI com a Drive API mockada ────────────────────────────────────────────

const ROOT_ID = "root";
const EDITION_ID = "ed";
const FINAL_ID = "fin";

function mockDrive(finalFiles: DriveVideoFile[], media: Record<string, Buffer> = {}) {
  const calls: string[] = [];
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url) {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        if (q.includes(`'${FINAL_ID}'`)) return Response.json({ files: finalFiles });
        if (q.includes(`'${EDITION_ID}'`)) {
          return Response.json({
            files: [
              { id: FINAL_ID, name: "Final", mimeType: FOLDER },
              { id: "bruto", name: "20261026_191548.mp4", mimeType: "video/mp4", videoMediaMetadata: { width: 3840, height: 2160 } },
            ],
          });
        }
        return Response.json({ files: [{ id: EDITION_ID, name: "261027", mimeType: FOLDER }] });
      }
      const id = decodeURIComponent(u.pathname.split("/").pop() ?? "");
      if (u.searchParams.get("alt") !== "media") return Response.json({ id, mimeType: FOLDER });
      const m = media[id];
      if (!m) return new Response("nf", { status: 404 });
      return new Response(new Uint8Array(m), { status: 200, headers: { "content-type": "video/mp4" } });
    },
  };
  return { deps, calls };
}

function input(dir: string, extra: Partial<FetchDriveVideoInput> = {}): FetchDriveVideoInput {
  return { aammdd: "261027", orientation: "horizontal", folderId: ROOT_ID, editionDir: dir, now: NOW, windowHours: 36, dryRun: false, force: false, ...extra };
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "fdv-final-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FINAL_SET = [H(YT, { id: "yt", size: "5" }), V(IG, { id: "ig" }), V(OR, { id: "or" })];

test("CLI horizontal: desce em {AAMMDD}/Final/ e baixa o _Youtube_ (o bruto 4K ao lado não conta)", () =>
  withDir(async (dir) => {
    const { deps, calls } = mockDrive(FINAL_SET, { yt: Buffer.from("12345") });
    const out = await runFetchDriveVideo(deps, input(dir), () => {});
    assert.equal(out.exitCode, 0, JSON.stringify(out.output));
    assert.equal(out.output.action, "downloaded");
    if (out.output.action === "downloaded") {
      assert.equal(out.output.file.id, "yt");
      assert.equal(out.output.file.scope, "final-folder");
      assert.deepEqual(out.output.final_folder_ids, [FINAL_ID]);
      assert.equal(out.output.target, "youtube");
    }
    assert.ok(calls.some((c) => new URL(c).searchParams.get("q")?.includes(`'${FINAL_ID}'`)), "listou a pasta Final/");
  }));

test("CLI vertical: imprime o id do _Outras redes_ e o comando do publish-shorts", () =>
  withDir(async (dir) => {
    const { deps } = mockDrive(FINAL_SET);
    const out = await runFetchDriveVideo(deps, input(dir, { orientation: "vertical" }), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "print-id");
    if (out.output.action === "print-id") {
      assert.equal(out.output.file.id, "or");
      assert.equal(out.output.next_command, "npx tsx scripts/publish-shorts.ts 261027 --from-drive or");
    }
  }));

test("CLI --target instagram: prefere Outras redes para Instagram sem next_command, mesmo com o short local presente", () =>
  withDir(async (dir) => {
    writeFileSync(join(dir, "diaria-comentada-261027-short.mp4"), "outras redes já baixado");
    const { deps } = mockDrive(FINAL_SET);
    const out = await runFetchDriveVideo(deps, input(dir, { orientation: "vertical", target: "instagram" }), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "print-id");
    if (out.output.action === "print-id") {
      assert.equal(out.output.file.id, "or");
      assert.equal(out.output.next_command, null);
    }
  }));

test("parse: --target valida o valor e a orientação; default por orientação", () => {
  const cfg = { folderId: "f", windowHours: 36 };
  const ok = parseFetchDriveVideoArgs(["--edition", "261027", "--orientation", "vertical"], cfg);
  assert.equal(ok.ok && ok.target, "outras-redes");
  const ig = parseFetchDriveVideoArgs(["--edition", "261027", "--orientation", "vertical", "--target", "instagram"], cfg);
  assert.equal(ig.ok && ig.target, "instagram");
  const bad = parseFetchDriveVideoArgs(["--edition", "261027", "--orientation", "horizontal", "--target", "instagram"], cfg);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /não combina/);
  const unknown = parseFetchDriveVideoArgs(["--edition", "261027", "--orientation", "vertical", "--target", "tiktok"], cfg);
  assert.equal(unknown.ok, false);
});
