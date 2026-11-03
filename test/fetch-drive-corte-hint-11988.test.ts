/**
 * Regressão #11988: sem `{edição}/_internal/video-montagem/blocks.json`, o
 * export de corte nomeado só pelo título (`…_Vertical_IA Soberana_Edição 08_V2.mp4`,
 * nomes reais da 261103) volta a disputar com a vertical da edição e o fetch
 * sai `ambiguous` sem dizer por quê. Agora a saída traz `hint` com o padrão
 * `_V{n}-{slug}`; com o `blocks.json` lido (mesmo sem cortes) o hint não aparece.
 * Drive mockado, sem rede.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  corteNamingHint,
  loadCorteRefsWithStatus,
  runFetchDriveVideo,
  type FetchDriveVideoDeps,
} from "../scripts/fetch-drive-video.ts";

const FOLDER = "application/vnd.google-apps.folder";
const VERT = { videoMediaMetadata: { width: 1080, height: 1920 } };
const mp4 = (id: string, name: string) => ({ id, name, mimeType: "video/mp4", modifiedTime: "2026-11-03T20:00:00Z", ...VERT });
const jpg = (id: string, name: string) => ({ id, name, mimeType: "image/jpeg", modifiedTime: "2026-11-03T20:00:00Z" });

const FILES = [
  mp4("main", "Diaria comentada_Vertical_Edição 08_V2.mp4"),
  mp4("sob", "Diaria comentada_Vertical_IA Soberana_Edição 08_V2.mp4"),
  jpg("still-main", "Diaria comentada_Vertical_V1.00_00_06_16.Still002.jpg"),
];

function driveDeps(): FetchDriveVideoDeps {
  return {
    driveFetch: async (url) => {
      const u = new URL(url);
      if (u.searchParams.has("alt")) throw new Error(`download inesperado: ${url}`);
      if (u.pathname.endsWith("/root")) return Response.json({ id: "root", name: "YouTube", mimeType: FOLDER });
      const q = u.searchParams.get("q") ?? "";
      if (q.startsWith("'root'")) return Response.json({ files: [{ id: "edition", name: "261103", mimeType: FOLDER }] });
      if (q.startsWith("'edition'")) return Response.json({ files: [{ id: "final", name: "Final", mimeType: FOLDER }] });
      if (q.startsWith("'final'")) return Response.json({ files: FILES });
      throw new Error(`pasta inesperada: ${url}`);
    },
  };
}

async function fetchVertical(dir: string, lines: string[]) {
  return runFetchDriveVideo(driveDeps(), {
    aammdd: "261103", orientation: "vertical", folderId: "root", editionDir: dir, now: new Date("2026-11-03T21:00:00Z"),
    windowHours: 36, dryRun: true, force: false,
  }, (l) => lines.push(l));
}

function blocksPath(dir: string): string {
  mkdirSync(join(dir, "_internal", "video-montagem"), { recursive: true });
  return join(dir, "_internal", "video-montagem", "blocks.json");
}

test("sem blocks.json: vertical ambiguous traz hint pedindo o nome _V{n}-{slug}", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-11988-"));
  try {
    const lines: string[] = [];
    const out = await fetchVertical(dir, lines);
    assert.equal(out.exitCode, 3, lines.join("\n"));
    assert.equal(out.output.action, "needs-editor");
    if (out.output.action !== "needs-editor" || out.output.selection !== "ambiguous") {
      assert.fail(`esperava ambiguous: ${JSON.stringify(out.output)}`);
    }
    assert.deepEqual(out.output.candidates.map((c) => c.id).sort(), ["main", "sob"]);
    assert.match(out.output.hint ?? "", /sem o blocks\.json[\s\S]*_V\{n\}-\{slug\}[\s\S]*renomeie/);
    assert.ok(lines.some((l) => l.includes("#11988")), lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocks.json ilegível: o hint também aparece e diz que está ilegível", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-11988-"));
  try {
    writeFileSync(blocksPath(dir), "{nope");
    const out = await fetchVertical(dir, []);
    assert.equal(out.output.action === "needs-editor" && out.output.selection === "ambiguous" && /ilegível/.test(out.output.hint ?? ""), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocks.json lido sem cortes: ambiguous genuíno, sem hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-11988-"));
  try {
    writeFileSync(blocksPath(dir), JSON.stringify({ edition: "261103", sequences: [{ name: "Diaria comentada_Vertical_V1" }] }));
    const out = await fetchVertical(dir, []);
    assert.equal(out.output.action, "needs-editor");
    if (out.output.action === "needs-editor" && out.output.selection === "ambiguous") assert.equal(out.output.hint, undefined);
    else assert.fail(JSON.stringify(out.output));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocks.json com o corte: o export pelo título sai da disputa (comportamento #11950 intacto)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-11988-"));
  try {
    writeFileSync(blocksPath(dir), JSON.stringify({ edition: "261103", sequences: [{ name: "x", corte: "soberana", screenTitle: "IA Soberana" }] }));
    const lines: string[] = [];
    const out = await fetchVertical(dir, lines);
    assert.equal(out.exitCode, 0, lines.join("\n"));
    assert.equal(out.output.action === "print-id" && out.output.file.id, "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCorteRefsWithStatus distingue ausente, ilegível e lido; corteNamingHint cita o caminho", () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-11988-"));
  try {
    assert.equal(loadCorteRefsWithStatus(dir, () => {}).status, "missing");
    const p = blocksPath(dir);
    writeFileSync(p, "{nope");
    assert.equal(loadCorteRefsWithStatus(dir, () => {}).status, "unreadable");
    writeFileSync(p, JSON.stringify({ sequences: [] }));
    assert.equal(loadCorteRefsWithStatus(dir, () => {}).status, "read");
    assert.ok(corteNamingHint("missing", p).includes(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
