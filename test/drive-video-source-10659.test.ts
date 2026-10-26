/**
 * #10659 (itens 3-4): escolha do vídeo do dia no Drive (".mp4" com "final"
 * como palavra + orientação + subpasta/janela) e o CLI `fetch-drive-video.ts`
 * com a Drive API mockada.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyOrientation,
  hasFinalInName,
  isAcceptableDownloadContentType,
  isMp4VideoFile,
  selectDriveVideo,
  type DriveVideoFile,
} from "../scripts/lib/diaria/drive-video-source.ts";
import {
  parseFetchDriveVideoArgs,
  readYouTubeDriveConfig,
  runFetchDriveVideo,
  type FetchDriveVideoDeps,
  type FetchDriveVideoInput,
} from "../scripts/fetch-drive-video.ts";

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

test('"final" como palavra: aceita separadores e dígito; rejeita negado, prefixado e "finalizando"', () => {
  for (const ok of ["V3 - final.mp4", "x_Final.mp4", "final.mp4", "FINAL V2.mp4", "edição 03 V3final.mp4", "sempre final.mp4", "versão final (2).mp4"]) {
    assert.equal(hasFinalInName(ok), true, ok);
  }
  for (const no of [
    "pre-final.mp4",
    "pré-final.mp4",
    "pre final.mp4",
    "Pré_final.mp4",
    "não final.mp4",
    "nao final.mp4",
    "Nao_Final.mp4",
    "finalizando.mp4",
    "semifinal.mp4",
    "finalv2.mp4",
    "sem a palavra.mp4",
  ]) {
    assert.equal(hasFinalInName(no), false, no);
  }
  // Um "final" negado e outro válido no mesmo nome: vale o válido.
  assert.equal(hasFinalInName("nao final - corrigido final.mp4"), true);
  // Decomposto (NFD) também reconhece o "pré".
  assert.equal(hasFinalInName("pré-final.mp4"), false);
});

test("vídeo único = .mp4 por extensão OU mimeType video/mp4; .mov/.webm fora mesmo com video/*", () => {
  assert.equal(isMp4VideoFile({ name: "x final.mp4", mimeType: "application/octet-stream" }), true);
  assert.equal(isMp4VideoFile({ name: "x final", mimeType: "video/mp4" }), true);
  assert.equal(isMp4VideoFile({ name: "x final.mov", mimeType: "video/quicktime" }), false);
  assert.equal(isMp4VideoFile({ name: "x final.webm", mimeType: "video/webm" }), false);
  assert.equal(isMp4VideoFile({ name: "x final.mov", mimeType: "video/mp4" }), false);
  assert.equal(isMp4VideoFile({ name: "x final", mimeType: "video/quicktime" }), false);
  const sel = selectDriveVideo([H("V3 final.mov", { mimeType: "video/quicktime" }), H("V3 final.webm", { mimeType: "video/webm" })], {
    orientation: "horizontal",
    now: NOW,
  });
  assert.equal(sel.kind, "none");
});

test("content-type do download: video/mp4, ou octet-stream só com nome .mp4", () => {
  assert.equal(isAcceptableDownloadContentType("video/mp4", "x"), true);
  assert.equal(isAcceptableDownloadContentType("video/mp4; charset=binary", "x"), true);
  assert.equal(isAcceptableDownloadContentType("application/octet-stream", "x final.mp4"), true);
  assert.equal(isAcceptableDownloadContentType("application/octet-stream", "x final"), false);
  assert.equal(isAcceptableDownloadContentType("video/quicktime", "x.mp4"), false);
  assert.equal(isAcceptableDownloadContentType("text/html", "x.mp4"), false);
});

test("não-vídeo com final no nome é ignorado", () => {
  const sel = selectDriveVideo([{ id: "x", name: "roteiro final.docx", mimeType: "application/pdf", createdTime: RECENT }], {
    orientation: "horizontal",
    now: NOW,
  });
  assert.equal(sel.kind, "none");
});

test("sem subpasta: arquivo solto na raiz fora da janela de 36h não conta; dentro conta; vale o mais recente entre criado e modificado", () => {
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

test("subpasta da edição existe sem horizontal: none, NUNCA a raiz (vídeo de ontem solto na raiz não sobe como o de hoje)", () => {
  const files = [
    V("Reels final.mp4", { scope: "edition-folder" }),
    H("edição de ontem final.mp4", { scope: "root" }), // recente, dentro da janela
  ];
  const sel = selectDriveVideo(files, { orientation: "horizontal", now: NOW, editionFolderPresent: true });
  assert.equal(sel.kind, "none");
  if (sel.kind === "none") assert.match(sel.reason, /subpasta da edição existe.*raiz não é consultada/);
  // Subpasta vazia (sem rastro na listagem) também bloqueia a raiz quando quem lista diz que ela existe.
  assert.equal(selectDriveVideo([H("solto final.mp4")], { orientation: "horizontal", now: NOW, editionFolderPresent: true }).kind, "none");
  assert.equal(selectDriveVideo([H("solto final.mp4")], { orientation: "horizontal", now: NOW, editionFolderPresent: false }).kind, "found");
});

test("2+ candidatos da mesma orientação → ambiguous com os arquivos inteiros (ids distinguem nomes repetidos)", () => {
  const files = [H("V3 - final.mp4", { id: "a" }), H("V3 - final.mp4", { id: "b" }), V("Reels final.mp4")];
  const sel = selectDriveVideo(files, { orientation: "horizontal", now: NOW });
  assert.equal(sel.kind, "ambiguous");
  if (sel.kind === "ambiguous") assert.deepEqual(sel.candidates.map((f) => f.id).sort(), ["a", "b"]);
  // O vertical único ao lado continua escolhível.
  assert.equal(selectDriveVideo(files, { orientation: "vertical", now: NOW }).kind, "found");
});

test("final sem videoMediaMetadata → orientation-unknown, não chuta", () => {
  const sel = selectDriveVideo([H("V3 - final.mp4"), vid("processando final.mp4", null, null)], { orientation: "horizontal", now: NOW });
  assert.equal(sel.kind, "orientation-unknown");
  if (sel.kind === "orientation-unknown") assert.deepEqual(sel.files.map((f) => f.name), ["processando final.mp4"]);
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
const FOLDER = "application/vnd.google-apps.folder";

interface MockMedia {
  body: Buffer | ReadableStream<Uint8Array>;
  contentType?: string;
}

function mockDrive(opts: {
  root: DriveVideoFile[];
  edition?: DriveVideoFile[];
  /** Listagem da raiz quebrada em páginas (sobrepõe `root`). */
  rootPages?: DriveVideoFile[][];
  media?: Record<string, Buffer | MockMedia>;
  failList?: number;
  folderMeta?: { status: number; mimeType?: string };
}) {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url, init) {
      calls.push(url);
      signals.push(init?.signal);
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        if (opts.failList) return new Response("boom", { status: opts.failList });
        const q = u.searchParams.get("q") ?? "";
        if (q.includes(`'${EDITION_ID}'`)) return Response.json({ files: opts.edition ?? [] });
        if (opts.rootPages) {
          const page = Number(u.searchParams.get("pageToken") ?? "0");
          const next = page + 1 < opts.rootPages.length ? String(page + 1) : undefined;
          return Response.json({ files: opts.rootPages[page], ...(next ? { nextPageToken: next } : {}) });
        }
        return Response.json({ files: opts.root });
      }
      const id = decodeURIComponent(u.pathname.split("/").pop() ?? "");
      if (u.searchParams.get("alt") !== "media") {
        const meta = opts.folderMeta ?? { status: 200, mimeType: FOLDER };
        if (meta.status !== 200) return new Response("nope", { status: meta.status });
        return Response.json({ id, mimeType: meta.mimeType });
      }
      const m = opts.media?.[id];
      if (!m) return new Response("not found", { status: 404 });
      const media: MockMedia = Buffer.isBuffer(m) ? { body: m } : m;
      const body = Buffer.isBuffer(media.body) ? new Uint8Array(media.body) : media.body;
      return new Response(body, { status: 200, headers: { "content-type": media.contentType ?? "video/mp4" } });
    },
  };
  return { deps, calls, signals };
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

const baseInput = (dir: string): FetchDriveVideoInput => ({
  aammdd: "261025",
  orientation: "horizontal",
  folderId: ROOT_ID,
  editionDir: dir,
  now: NOW,
  windowHours: 36,
  dryRun: false,
  force: false,
});

const editionFolder = { id: EDITION_ID, name: "261025", mimeType: FOLDER, modifiedTime: RECENT };
const DEST = (dir: string) => join(dir, "diaria-comentada-261025.mp4");

test(
  "CLI horizontal: lista raiz + subpasta da edição e baixa no caminho do publish-youtube (arquivo antigo da subpasta vale)",
  withDir(async (dir) => {
    const bytes = Buffer.from("fake-mp4-bytes");
    const file = H("Diaria comentada 261025 - final.mp4", { id: "vid1", size: String(bytes.length), createdTime: OLD, modifiedTime: OLD });
    const { deps, calls, signals } = mockDrive({
      root: [editionFolder, { id: "other", name: "261024", mimeType: FOLDER }],
      edition: [file],
      media: { vid1: bytes },
    });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "downloaded");
    if (out.output.action === "downloaded") {
      assert.equal(out.output.file.scope, "edition-folder");
      assert.equal(out.output.file.modifiedTime, OLD);
      assert.equal(out.output.edition_folder_id, EDITION_ID);
      assert.equal(out.output.bytes, bytes.length);
    }
    assert.equal(readFileSync(DEST(dir), "utf8"), "fake-mp4-bytes");
    assert.ok(!existsSync(`${DEST(dir)}.part`));
    // Nunca desce na subpasta de outra edição.
    assert.ok(!calls.some((c) => c.includes("'other'")));
    // Toda chamada à Drive API leva um AbortSignal (timeout).
    assert.ok(signals.every((s) => s instanceof AbortSignal));
  }),
);

test(
  "CLI: subpasta só com vertical + horizontal 'final' recente solto na raiz → pedido horizontal NÃO pega a raiz",
  withDir(async (dir) => {
    const { deps, calls } = mockDrive({
      root: [editionFolder, H("edição anterior - final.mp4", { id: "stale" })],
      edition: [V("Reels - final.mp4", { id: "short" })],
      media: { stale: Buffer.from("x") },
    });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "none");
    assert.ok(!calls.some((c) => c.includes("alt=media")));
    assert.ok(!existsSync(DEST(dir)));
  }),
);

test(
  "CLI: paginação — subpasta da edição só aparece na 2ª página da raiz",
  withDir(async (dir) => {
    const bytes = Buffer.from("abc");
    const { deps, calls } = mockDrive({
      root: [],
      rootPages: [[{ id: "other", name: "261024", mimeType: FOLDER }], [editionFolder]],
      edition: [H("V3 - final.mp4", { id: "v", size: "3" })],
      media: { v: bytes },
    });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "downloaded");
    assert.ok(calls.some((c) => c.includes("pageToken=1")));
  }),
);

test(
  "CLI: arquivo local já existe → no-op sem tocar no Drive",
  withDir(async (dir) => {
    writeFileSync(DEST(dir), "já baixado");
    const { deps, calls } = mockDrive({ root: [] });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "exists");
    assert.equal(calls.length, 0);
  }),
);

test(
  "CLI: --force substitui o arquivo local antigo",
  withDir(async (dir) => {
    writeFileSync(DEST(dir), "versão velha");
    const { deps } = mockDrive({ root: [H("V3 final.mp4", { id: "v" })], media: { v: Buffer.from("versão nova") } });
    const out = await runFetchDriveVideo(deps, { ...baseInput(dir), force: true }, () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "downloaded");
    assert.equal(readFileSync(DEST(dir), "utf8"), "versão nova");
  }),
);

test(
  "CLI: vídeo já registrado em _internal/05-youtube-published.json → already-published sem tocar no Drive",
  withDir(async (dir) => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "_internal", "05-youtube-published.json"),
      JSON.stringify({ aammdd: "261025", videoId: "abc", url: "https://youtu.be/abc" }),
    );
    const { deps, calls } = mockDrive({ root: [H("V3 final.mp4")] });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "already-published");
    if (out.output.action === "already-published") assert.equal(out.output.video_url, "https://youtu.be/abc");
    assert.equal(calls.length, 0);
    // Registro de outra edição não conta.
    writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify({ aammdd: "261024", videoId: "x" }));
    const again = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.notEqual(again.output.action, "already-published");
  }),
);

test(
  "CLI: nenhum candidato → exit 0 (fail-soft), nada gravado",
  withDir(async (dir) => {
    const { deps } = mockDrive({ root: [H("sem a palavra.mp4")] });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "none");
    assert.ok(!existsSync(DEST(dir)));
  }),
);

test(
  "CLI: ambíguo → exit 3 com id/nome/modifiedTime/scope de cada um, nada baixado",
  withDir(async (dir) => {
    const { deps, calls } = mockDrive({ root: [H("V3 final.mp4", { id: "a" }), H("V3 final.mp4", { id: "b", modifiedTime: OLD })] });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 3);
    assert.equal(out.output.action, "needs-editor");
    if (out.output.action === "needs-editor" && out.output.selection === "ambiguous") {
      assert.deepEqual(
        out.output.candidates.map((c) => [c.id, c.name, c.modifiedTime, c.scope]),
        [
          ["a", "V3 final.mp4", RECENT, "root"],
          ["b", "V3 final.mp4", OLD, "root"],
        ],
      );
    } else {
      assert.fail(`esperava ambiguous, veio ${JSON.stringify(out.output)}`);
    }
    assert.ok(!calls.some((c) => c.includes("alt=media")));
  }),
);

test(
  "CLI: final sem proporção → exit 3 com id/nome/modifiedTime/scope",
  withDir(async (dir) => {
    const { deps } = mockDrive({ root: [editionFolder], edition: [vid("proc final.mp4", null, null, { id: "p" })] });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 3);
    if (out.output.action === "needs-editor" && out.output.selection === "orientation-unknown") {
      assert.deepEqual(out.output.files.map((f) => [f.id, f.name, f.modifiedTime, f.scope]), [["p", "proc final.mp4", RECENT, "edition-folder"]]);
    } else {
      assert.fail(`esperava orientation-unknown, veio ${JSON.stringify(out.output)}`);
    }
  }),
);

test(
  "CLI: duas subpastas com o nome da edição → exit 3 com os ids, sem listar dentro",
  withDir(async (dir) => {
    const { deps, calls } = mockDrive({
      root: [editionFolder, { id: "dup", name: "261025 ", mimeType: FOLDER, modifiedTime: OLD }],
      edition: [H("V3 final.mp4")],
    });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 3);
    if (out.output.action === "needs-editor" && out.output.selection === "duplicate-edition-folder") {
      assert.deepEqual(out.output.folders.map((f) => f.id), [EDITION_ID, "dup"]);
    } else {
      assert.fail(`esperava duplicate-edition-folder, veio ${JSON.stringify(out.output)}`);
    }
    assert.ok(!calls.some((c) => c.includes(`'${EDITION_ID}'`)));
  }),
);

test(
  "CLI: pasta inacessível (403/404) ou não-pasta → exit 1, nunca none",
  withDir(async (dir) => {
    for (const folderMeta of [{ status: 404 }, { status: 403 }, { status: 200, mimeType: "video/mp4" }]) {
      const { deps, calls } = mockDrive({ root: [], folderMeta });
      const lines: string[] = [];
      const out = await runFetchDriveVideo(deps, baseInput(dir), (l) => lines.push(l));
      assert.equal(out.exitCode, 1, JSON.stringify(folderMeta));
      assert.equal(out.output.action, "error");
      if (out.output.action === "error") {
        assert.equal(out.output.phase, "folder");
        assert.match(out.output.error, /inacessível pela conta OAuth do projeto \(data\/\.credentials\.json\)/);
      }
      // Nem chega a listar.
      assert.ok(!calls.some((c) => new URL(c).pathname.endsWith("/files")));
    }
  }),
);

test(
  "CLI vertical: só imprime o id e o comando do publish-shorts, sem baixar",
  withDir(async (dir) => {
    const { deps, calls } = mockDrive({ root: [V("Reels V2 - final.mp4", { id: "short1" })] });
    const out = await runFetchDriveVideo(deps, { ...baseInput(dir), orientation: "vertical" }, () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "print-id");
    if (out.output.action === "print-id") {
      assert.equal(out.output.next_command, "npx tsx scripts/publish-shorts.ts 261025 --from-drive short1");
    }
    assert.ok(!calls.some((c) => c.includes("alt=media")));
  }),
);

test(
  "CLI vertical com o short local já no disco: exists COM next_command",
  withDir(async (dir) => {
    writeFileSync(join(dir, "diaria-comentada-261025-short.mp4"), "short");
    const { deps, calls } = mockDrive({ root: [] });
    const out = await runFetchDriveVideo(deps, { ...baseInput(dir), orientation: "vertical" }, () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "exists");
    if (out.output.action === "exists") assert.equal(out.output.next_command, "npx tsx scripts/publish-shorts.ts 261025");
    assert.equal(calls.length, 0);
  }),
);

test(
  "CLI: dry-run escolhe, exit 0, não baixa e não escreve nada",
  withDir(async (dir) => {
    const { deps, calls } = mockDrive({ root: [H("x final.mp4", { id: "v" })], media: { v: Buffer.from("a") } });
    const out = await runFetchDriveVideo(deps, { ...baseInput(dir), dryRun: true }, () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "dry-run");
    assert.ok(!calls.some((c) => c.includes("alt=media")));
    assert.deepEqual(readdirSync(dir), []);
  }),
);

test(
  "CLI: falha da listagem (OAuth/rede) → exit 1 com phase list",
  withDir(async (dir) => {
    const { deps } = mockDrive({ root: [], failList: 401 });
    const lines: string[] = [];
    const out = await runFetchDriveVideo(deps, baseInput(dir), (l) => lines.push(l));
    assert.equal(out.exitCode, 1);
    if (out.output.action === "error") assert.equal(out.output.phase, "list");
    assert.ok(lines.some((l) => l.includes("oauth-setup.ts")));
  }),
);

test(
  "CLI: download com tamanho diferente do Drive → exit 1 e nada gravado",
  withDir(async (dir) => {
    const { deps } = mockDrive({ root: [H("x final.mp4", { id: "v", size: "999" })], media: { v: Buffer.from("curto") } });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 1);
    assert.ok(!existsSync(DEST(dir)));
    assert.ok(!existsSync(`${DEST(dir)}.part`));
  }),
);

test(
  "CLI: content-type não-vídeo e corpo de 0 bytes → exit 1, sem .part órfão",
  withDir(async (dir) => {
    for (const media of [{ body: Buffer.from("<html>"), contentType: "text/html" }, { body: Buffer.alloc(0) }]) {
      const { deps } = mockDrive({ root: [H("x final.mp4", { id: "v" })], media: { v: media } });
      const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
      assert.equal(out.exitCode, 1);
      if (out.output.action === "error") assert.equal(out.output.phase, "download");
      assert.deepEqual(readdirSync(dir), []);
    }
  }),
);

test(
  "CLI: octet-stream com nome .mp4 é aceito no download",
  withDir(async (dir) => {
    const { deps } = mockDrive({
      root: [H("x final.mp4", { id: "v" })],
      media: { v: { body: Buffer.from("ok"), contentType: "application/octet-stream" } },
    });
    const out = await runFetchDriveVideo(deps, baseInput(dir), () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "downloaded");
  }),
);

test(
  "CLI: stream que para de mandar bytes → watchdog de ociosidade aborta, exit 1, sem .part",
  withDir(async (dir) => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("primeiro pedaço"));
        // nunca mais envia nem fecha
      },
    });
    const { deps } = mockDrive({ root: [H("x final.mp4", { id: "v" })], media: { v: { body: stalled } } });
    const out = await runFetchDriveVideo(
      deps,
      { ...baseInput(dir), timeouts: { listMs: 5_000, downloadMs: 10_000, idleMs: 50 } },
      () => {},
    );
    assert.equal(out.exitCode, 1);
    if (out.output.action === "error") assert.match(out.output.error, /ocioso/);
    assert.deepEqual(readdirSync(dir), []);
  }),
);

test("config: lê publishing.youtube.drive_folder_id do platform.config.json real", () => {
  const cfg = readYouTubeDriveConfig(JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8")));
  assert.ok(cfg.folderId && /^[\w-]{10,}$/.test(cfg.folderId));
  assert.equal(cfg.windowHours, 36);
  assert.deepEqual(readYouTubeDriveConfig({}), { folderId: null, windowHours: null });
});

// ── parse do argv (exit 2, antes de qualquer rede) ─────────────────────────

const CFG = { folderId: "cfg-folder", windowHours: 36 };

test("parse: argumentos válidos e defaults da config", () => {
  const p = parseFetchDriveVideoArgs(["--edition", "261025", "--orientation", "horizontal", "--dry-run"], CFG);
  assert.equal(p.ok, true);
  if (p.ok) {
    assert.equal(p.folderId, "cfg-folder");
    assert.equal(p.windowHours, 36);
    assert.equal(p.dryRun, true);
    assert.equal(p.force, false);
  }
});

test("parse: edição/orientação/janela/pasta inválidas e --dry-run com valor → erro (exit 2)", () => {
  const bad: [string[], RegExp][] = [
    [["--edition", "2610", "--orientation", "horizontal"], /--edition/],
    [["--orientation", "horizontal"], /--edition/],
    [["--edition", "261025", "--orientation", "diagonal"], /--orientation/],
    [["--edition", "261025", "--orientation", "horizontal", "--window-hours", "abc"], /--window-hours/],
    [["--edition", "261025", "--orientation", "horizontal", "--window-hours", "0"], /--window-hours/],
    [["--edition", "261025", "--orientation", "horizontal", "--window-hours=-5"], /--window-hours/],
    [["--orientation", "horizontal", "--dry-run", "261025"], /--dry-run não leva valor/],
    [["--edition", "261025", "--orientation", "horizontal", "solto"], /argumentos inválidos/],
  ];
  for (const [argv, re] of bad) {
    const p = parseFetchDriveVideoArgs(argv, CFG);
    assert.equal(p.ok, false, argv.join(" "));
    if (!p.ok) assert.match(p.error, re, argv.join(" "));
  }
  const noFolder = parseFetchDriveVideoArgs(["--edition", "261025", "--orientation", "horizontal"], { folderId: null, windowHours: null });
  assert.equal(noFolder.ok, false);
  if (!noFolder.ok) assert.match(noFolder.error, /sem pasta/);
});

test("main: uso inválido sai 2 antes de qualquer rede", () => {
  const script = fileURLToPath(new URL("../scripts/fetch-drive-video.ts", import.meta.url));
  for (const argv of [["--edition", "abc", "--orientation", "horizontal"], ["--dry-run", "261025"]]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", script, ...argv], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /uso: fetch-drive-video\.ts/);
  }
});
