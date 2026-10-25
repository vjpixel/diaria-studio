/**
 * #10659 (itens 3-4): escolha do vídeo do dia no Drive ("final" no nome +
 * orientação + janela) e o CLI `fetch-drive-video.ts` com a Drive API mockada.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyOrientation,
  selectDriveVideo,
  type DriveVideoFile,
} from "../scripts/lib/diaria/drive-video-source.ts";
import { readYouTubeDriveConfig, runFetchDriveVideo, type FetchDriveVideoDeps } from "../scripts/fetch-drive-video.ts";

const NOW = new Date("2026-10-25T20:00:00Z");
const RECENT = "2026-10-25T10:00:00Z";
const OLD = "2026-10-20T10:00:00Z";

function vid(name: string, w: number | null, h: number | null, extra: Partial<DriveVideoFile> = {}): DriveVideoFile {
  return {
    id: `id-${name.replace(/\W+/g, "-")}`,
    name,
    mimeType: "video/mp4",
    createdTime: RECENT,
    modifiedTime: RECENT,
    ...(w !== null && h !== null ? { videoMediaMetadata: { width: w, height: h } } : {}),
    ...extra,
  };
}

const H = (name: string, extra: Partial<DriveVideoFile> = {}) => vid(name, 1920, 1080, extra);
const V = (name: string, extra: Partial<DriveVideoFile> = {}) => vid(name, 1080, 1920, extra);

test("classifyOrientation: largura > altura é horizontal, o contrário vertical, sem metadado null", () => {
  assert.equal(classifyOrientation(H("a")), "horizontal");
  assert.equal(classifyOrientation(V("a")), "vertical");
  assert.equal(classifyOrientation(vid("a", 1080, 1080)), "square");
  assert.equal(classifyOrientation(vid("a", null, null)), null);
});

test("separa horizontal e vertical pela proporção, cada um com seu final", () => {
  const files = [H("Diaria comentada edição 03_V3 - final.mp4"), V("Diaria comentada_Edição 03_Reels_V2 - final.mp4")];
  const h = selectDriveVideo(files, { orientation: "horizontal", now: NOW });
  const v = selectDriveVideo(files, { orientation: "vertical", now: NOW });
  assert.equal(h.kind, "found");
  assert.equal(v.kind, "found");
  if (h.kind === "found") assert.match(h.file.name, /_V3 - final/);
  if (v.kind === "found") assert.match(v.file.name, /Reels/);
});

test('"final" sem diferenciar maiúsculas e minúsculas; sem "final" não entra', () => {
  const sel = selectDriveVideo([H("Diar.ia.br comentada_01_Final.mp4"), H("Diaria comentada edição 03_v2.mp4")], {
    orientation: "horizontal",
    now: NOW,
  });
  assert.equal(sel.kind, "found");
  if (sel.kind === "found") assert.equal(sel.file.name, "Diar.ia.br comentada_01_Final.mp4");
});

test("não-vídeo com final no nome é ignorado", () => {
  const sel = selectDriveVideo([{ id: "x", name: "roteiro final.docx", mimeType: "application/pdf", createdTime: RECENT }], {
    orientation: "horizontal",
    now: NOW,
  });
  assert.equal(sel.kind, "none");
});

test("arquivo solto na raiz fora da janela de 36h não conta; dentro conta; vale o mais recente entre criado e modificado", () => {
  assert.equal(selectDriveVideo([H("x final.mp4", { createdTime: OLD, modifiedTime: OLD })], { orientation: "horizontal", now: NOW }).kind, "none");
  // modifiedTime antigo (arquivo copiado preserva) mas criado agora: dentro.
  assert.equal(selectDriveVideo([H("x final.mp4", { createdTime: RECENT, modifiedTime: OLD })], { orientation: "horizontal", now: NOW }).kind, "found");
  assert.equal(selectDriveVideo([H("x final.mp4", { createdTime: OLD, modifiedTime: OLD })], { orientation: "horizontal", now: NOW, windowHours: 24 * 7 }).kind, "found");
});

test("subpasta da edição vale sem janela e tem precedência sobre a raiz", () => {
  const files = [
    H("antigo final.mp4", { createdTime: OLD, modifiedTime: OLD, scope: "edition-folder" }),
    H("solto final.mp4", { scope: "root" }),
  ];
  const sel = selectDriveVideo(files, { orientation: "horizontal", now: NOW });
  assert.equal(sel.kind, "found");
  if (sel.kind === "found") assert.equal(sel.file.name, "antigo final.mp4");
});

test("2+ candidatos da mesma orientação → ambiguous com os nomes, nunca escolhe", () => {
  const sel = selectDriveVideo([H("V2 - final.mp4"), H("V3 - final.mp4"), V("Reels final.mp4")], { orientation: "horizontal", now: NOW });
  assert.equal(sel.kind, "ambiguous");
  if (sel.kind === "ambiguous") assert.deepEqual(sel.candidates.sort(), ["V2 - final.mp4", "V3 - final.mp4"]);
  // O vertical único ao lado continua escolhível.
  assert.equal(selectDriveVideo([H("V2 - final.mp4"), H("V3 - final.mp4"), V("Reels final.mp4")], { orientation: "vertical", now: NOW }).kind, "found");
});

test("final sem videoMediaMetadata → orientation-unknown, não chuta", () => {
  const sel = selectDriveVideo([H("V3 - final.mp4"), vid("processando final.mp4", null, null)], { orientation: "horizontal", now: NOW });
  assert.equal(sel.kind, "orientation-unknown");
  if (sel.kind === "orientation-unknown") assert.deepEqual(sel.files, ["processando final.mp4"]);
});

test("nenhum candidato → none com motivo", () => {
  const sel = selectDriveVideo([], { orientation: "vertical", now: NOW });
  assert.equal(sel.kind, "none");
  if (sel.kind === "none") assert.match(sel.reason, /final/);
  assert.equal(selectDriveVideo([H("só horizontal final.mp4")], { orientation: "vertical", now: NOW }).kind, "none");
});

// ── CLI com a Drive API mockada ───────────────────────────────────────────

const ROOT_ID = "root-folder";
const EDITION_ID = "edition-folder";

function mockDrive(opts: { root: DriveVideoFile[]; edition?: DriveVideoFile[]; media?: Record<string, Buffer>; failList?: number }) {
  const calls: string[] = [];
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url) {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        if (opts.failList) return new Response("boom", { status: opts.failList });
        const q = u.searchParams.get("q") ?? "";
        const files = q.includes(`'${EDITION_ID}'`) ? opts.edition ?? [] : opts.root;
        return Response.json({ files });
      }
      const id = decodeURIComponent(u.pathname.split("/").pop() ?? "");
      const buf = opts.media?.[id];
      if (!buf) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(buf), { status: 200, headers: { "content-type": "video/mp4" } });
    },
  };
  return { deps, calls };
}

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-drive-video-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const baseInput = (dir: string) => ({
  aammdd: "261025",
  orientation: "horizontal" as const,
  folderId: ROOT_ID,
  editionDir: dir,
  now: NOW,
  windowHours: 36,
  dryRun: false,
  force: false,
});

test(
  "CLI horizontal: lista raiz + subpasta da edição e baixa no caminho do publish-youtube",
  withDir(async (dir) => {
    const bytes = Buffer.from("fake-mp4-bytes");
    const file = H("Diaria comentada 261025 - final.mp4", { id: "vid1", size: String(bytes.length) });
    const { deps, calls } = mockDrive({
      root: [{ id: EDITION_ID, name: "261025", mimeType: "application/vnd.google-apps.folder" }, { id: "other", name: "261024", mimeType: "application/vnd.google-apps.folder" }],
      edition: [file],
      media: { vid1: bytes },
    });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "downloaded");
    const dest = join(dir, "diaria-comentada-261025.mp4");
    assert.equal(readFileSync(dest, "utf8"), "fake-mp4-bytes");
    assert.ok(!existsSync(`${dest}.part`));
    // Nunca desce na subpasta de outra edição.
    assert.ok(!calls.some((c) => c.includes("'other'")));
  }),
);

test(
  "CLI: arquivo local já existe → no-op sem tocar no Drive",
  withDir(async (dir) => {
    writeFileSync(join(dir, "diaria-comentada-261025.mp4"), "já baixado");
    const { deps, calls } = mockDrive({ root: [] });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "exists");
    assert.equal(calls.length, 0);
  }),
);

test(
  "CLI: nenhum candidato → exit 0 (fail-soft), nada gravado",
  withDir(async (dir) => {
    const { deps } = mockDrive({ root: [H("sem a palavra.mp4")] });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "none");
    assert.ok(!existsSync(join(dir, "diaria-comentada-261025.mp4")));
  }),
);

test(
  "CLI: ambíguo → exit 3 com os nomes, nada baixado",
  withDir(async (dir) => {
    const { deps, calls } = mockDrive({ root: [H("V2 final.mp4"), H("V3 final.mp4")] });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 3);
    assert.deepEqual(out.output.candidates, ["V2 final.mp4", "V3 final.mp4"]);
    assert.ok(!calls.some((c) => c.includes("alt=media")));
  }),
);

test(
  "CLI vertical: só imprime o id e o comando do publish-shorts, sem baixar",
  withDir(async (dir) => {
    const { deps, calls } = mockDrive({ root: [V("Reels V2 - final.mp4", { id: "short1" })] });
    const out = await runFetchDriveVideo(deps, { ...baseInput(dir), orientation: "vertical" }, () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "print-id");
    assert.equal(out.output.next_command, "npx tsx scripts/publish-shorts.ts 261025 --from-drive short1");
    assert.ok(!calls.some((c) => c.includes("alt=media")));
  }),
);

test(
  "CLI: dry-run escolhe mas não baixa",
  withDir(async (dir) => {
    const { deps, calls } = mockDrive({ root: [H("x final.mp4", { id: "v" })], media: { v: Buffer.from("a") } });
    const out = await runFetchDriveVideo(deps, { ...baseInput(dir), dryRun: true }, () => {});
    assert.equal(out.output.action, "dry-run");
    assert.ok(!calls.some((c) => c.includes("alt=media")));
  }),
);

test(
  "CLI: falha da listagem (OAuth/rede) → exit 1",
  withDir(async (dir) => {
    const { deps } = mockDrive({ root: [], failList: 401 });
    const lines: string[] = [];
    const out = await runFetchDriveVideo(deps, baseInput(dir), (l) => lines.push(l));
    assert.equal(out.exitCode, 1);
    assert.ok(lines.some((l) => l.includes("oauth-setup.ts")));
  }),
);

test(
  "CLI: download com tamanho diferente do Drive → exit 1 e nada gravado",
  withDir(async (dir) => {
    const { deps } = mockDrive({ root: [H("x final.mp4", { id: "v", size: "999" })], media: { v: Buffer.from("curto") } });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 1);
    assert.ok(!existsSync(join(dir, "diaria-comentada-261025.mp4")));
    assert.ok(!existsSync(join(dir, "diaria-comentada-261025.mp4.part")));
  }),
);

test("config: lê publishing.youtube.drive_folder_id do platform.config.json real", () => {
  const cfg = readYouTubeDriveConfig(JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8")));
  assert.ok(cfg.folderId && /^[\w-]{10,}$/.test(cfg.folderId));
  assert.equal(cfg.windowHours, 36);
  assert.deepEqual(readYouTubeDriveConfig({}), { folderId: null, windowHours: null });
});
