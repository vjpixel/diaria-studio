/**
 * test/prepare-instagram-guided-11476.test.ts
 *
 * #11476: o passo guiado do Instagram (Passo B3b) na máquina Windows não tinha
 * o arquivo comprimido — o `.mp4` gerado pelo timer do 300 não chega pelo
 * OneDrive e o vertical local não existia. `prepare-instagram-guided.ts`
 * prepara tudo a partir do corte `_Instagram_` do Drive (ou de `--video`):
 * baixa, planeja e comprime, sem publicar nada. Rede, ffmpeg e leitura de
 * duração são injetados; nenhum teste toca rede nem roda ffmpeg.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmInstagramCommand,
  parsePrepareGuidedArgs,
  runPrepareInstagramGuided,
  type PrepareInstagramGuidedDeps,
} from "../scripts/prepare-instagram-guided.ts";
import { INSTAGRAM_CUT_SIDECAR_FILE, type InstagramCutLookup } from "../scripts/shorts-instagram-timer.ts";
import { chromeUploadFileName, type ChromeUploadResult } from "../scripts/lib/diaria/instagram-chrome-upload.ts";
import { shortInstagramVideoFileName, shortVideoFileName } from "../scripts/lib/diaria/short-video.ts";

const AAMMDD = "261110";
const reviewed = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n";
// Janela de horário fixada no teste (nunca o default nem o platform.config.json vivo).
const SCHEDULE = { rotation_times: ["12:00", "19:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
const config = {
  publishing: {
    shorts: {
      facebook_pages: [],
      instagram: true,
      instagram_backend: "timer-300",
      instagram_author_page: null,
      instagram_collaborators: ["vjpixel"],
      instagram_api_max_seconds_by_account: { diaria: 30 },
      schedule: SCHEDULE,
    },
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ig-guided-11476-"));
  writeFileSync(join(dir, "02-reviewed.md"), reviewed);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const found: InstagramCutLookup = { kind: "found", fileId: "drive-cut-id-1234", name: "Diaria comentada_Instagram_V1.mp4", modifiedTime: "2026-11-10T10:00:00Z" };

function fakeDeps(over: Partial<PrepareInstagramGuidedDeps> & { duration?: number | null } = {}) {
  const calls = { lookup: 0, download: [] as Array<{ fileId: string; dest: string }>, compress: [] as Array<{ source: string; output: string; durationSeconds: number }> };
  const deps: PrepareInstagramGuidedDeps = {
    config,
    now: new Date("2026-11-10T13:00:00Z"),
    pages: [],
    lookupInstagramCut: async () => {
      calls.lookup++;
      return found;
    },
    downloadDriveFile: async (fileId, dest) => {
      calls.download.push({ fileId, dest });
      writeFileSync(dest, Buffer.alloc(1000));
    },
    videoDurationSeconds: () => (over.duration === undefined ? 75.3 : over.duration),
    compress: (input): ChromeUploadResult => {
      calls.compress.push(input);
      return { ok: true, path: input.output, sizeBytes: 9_300_000, videoKbps: 914, reused: false };
    },
    log: () => {},
    ...over,
  };
  return { deps, calls };
}

describe("#11476 prepare-instagram-guided", () => {
  it("cenário da issue: baixa o _Instagram_ do Drive, comprime e devolve upload/caption/at sem publicar", async () => {
    const { deps, calls } = fakeDeps();
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.action, "guided");
    if (r.output.action !== "guided") return;
    const cut = join(dir, shortInstagramVideoFileName(AAMMDD));
    assert.deepEqual(calls.download, [{ fileId: found.kind === "found" ? found.fileId : "", dest: cut }]);
    assert.equal(r.output.video.path, cut);
    assert.equal(r.output.video.source, "instagram-cut");
    assert.equal(r.output.video.downloaded, true);
    // A compressão é a do --publish, no mesmo nome de arquivo.
    assert.equal(calls.compress.length, 1);
    assert.equal(calls.compress[0].source, cut);
    assert.equal(calls.compress[0].output, join(dir, "_internal", chromeUploadFileName(AAMMDD)));
    assert.equal(calls.compress[0].durationSeconds, 75.3);
    assert.deepEqual(r.output.upload, { path: join(dir, "_internal", chromeUploadFileName(AAMMDD)), sizeBytes: 9_300_000, fitsChromeUpload: true });
    assert.ok(r.output.caption && r.output.caption.includes("Título do D1"), "legenda pronta");
    assert.ok(r.output.at, "horário do slot");
    assert.equal(r.output.next_command, confirmInstagramCommand(AAMMDD));
    // Sidecar do corte gravado no formato do timer (o 300 reaproveita).
    const sidecar = JSON.parse(readFileSync(join(dir, INSTAGRAM_CUT_SIDECAR_FILE), "utf8"));
    assert.equal(sidecar.fileId, "drive-cut-id-1234");
    // Nenhum registro do vertical gravado: o comando nunca publica.
    assert.equal(existsSync(join(dir, "_internal", "06-shorts-published.json")), false);
    assert.equal(existsSync(join(dir, "_internal", "06-shorts-published.instagram-timer.json")), false);
  });

  it("corte já baixado com o mesmo id/modifiedTime: não baixa de novo", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, shortInstagramVideoFileName(AAMMDD)), Buffer.alloc(10));
    writeFileSync(join(dir, INSTAGRAM_CUT_SIDECAR_FILE), JSON.stringify({ fileId: "drive-cut-id-1234", modifiedTime: "2026-11-10T10:00:00Z" }));
    const { deps, calls } = fakeDeps();
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 0);
    assert.equal(calls.download.length, 0);
    assert.equal(r.output.action, "guided");
  });

  it("--video PATH pula o Drive", async () => {
    const local = join(dir, "local-cut.mp4");
    writeFileSync(local, Buffer.alloc(10));
    const { deps, calls } = fakeDeps();
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir, video: local });
    assert.equal(r.exitCode, 0);
    assert.equal(calls.lookup, 0);
    assert.equal(calls.download.length, 0);
    assert.equal(r.output.action === "guided" && r.output.video.source, "flag");
  });

  it("--video inexistente é erro de uso", async () => {
    const { deps } = fakeDeps();
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir, video: join(dir, "nao-existe.mp4") });
    assert.equal(r.exitCode, 2);
  });

  it("corte dentro do teto da API: nada a preparar (o timer publica), sem compressão", async () => {
    const { deps, calls } = fakeDeps({ duration: 20 });
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.action, "fits-api");
    assert.equal(calls.compress.length, 0);
  });

  it("duração ilegível: exit 1, sem compressão", async () => {
    const { deps, calls } = fakeDeps({ duration: null });
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 1);
    assert.equal(calls.compress.length, 0);
  });

  it("instagram já registrado: não consulta o Drive nem baixa", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "_internal", "06-shorts-published.json"),
      JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "instagram", status: "published", id: "1", url: "https://www.instagram.com/reel/X/", at: "2026-11-10T15:00:00Z" }] }),
    );
    const { deps, calls } = fakeDeps();
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output.action, "already-registered");
    assert.equal(calls.lookup, 0);
    assert.equal(calls.download.length, 0);
  });

  it("Drive ambíguo: exit 3 (o editor escolhe), nada baixado", async () => {
    const { deps, calls } = fakeDeps({ lookupInstagramCut: async () => ({ kind: "needs-editor", reason: "dois _Instagram_", immediate: true }) });
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 3);
    assert.equal(r.output.action, "needs-editor");
    assert.equal(calls.download.length, 0);
  });

  it("Drive fora do ar sem corte no disco: exit 1, sem cair no genérico em silêncio", async () => {
    writeFileSync(join(dir, shortVideoFileName(AAMMDD)), Buffer.alloc(10));
    const { deps } = fakeDeps({ lookupInstagramCut: async () => ({ kind: "error", reason: "401" }) });
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 1);
    assert.equal(r.output.action, "error");
  });

  it("sem corte no Drive: usa o vertical genérico do disco; sem ele, no-video (exit 0)", async () => {
    const none = async (): Promise<InstagramCutLookup> => ({ kind: "none", reason: "nenhum corte _Instagram_ no Drive" });
    const empty = await runPrepareInstagramGuided(fakeDeps({ lookupInstagramCut: none }).deps, { aammdd: AAMMDD, dir });
    assert.equal(empty.exitCode, 0);
    assert.equal(empty.output.action, "no-video");
    writeFileSync(join(dir, shortVideoFileName(AAMMDD)), Buffer.alloc(10));
    const generic = await runPrepareInstagramGuided(fakeDeps({ lookupInstagramCut: none }).deps, { aammdd: AAMMDD, dir });
    assert.equal(generic.exitCode, 0);
    assert.equal(generic.output.action === "guided" && generic.output.video.source, "generic");
  });

  it("download falho: exit 1 e sidecar não gravado", async () => {
    const { deps } = fakeDeps({ downloadDriveFile: async () => { throw new Error("timeout"); } });
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 1);
    assert.equal(existsSync(join(dir, INSTAGRAM_CUT_SIDECAR_FILE)), false);
  });

  it("compressão falha: o upload aponta pro original com fitsChromeUpload false", async () => {
    const { deps } = fakeDeps({ compress: () => ({ ok: false, error: "ffmpeg ausente" }) });
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.output.action, "guided");
    if (r.output.action !== "guided") return;
    assert.equal(r.output.upload.fitsChromeUpload, false);
    assert.equal(r.output.upload.path, join(dir, shortInstagramVideoFileName(AAMMDD)));
    assert.ok(r.output.warnings.some((w) => /ffmpeg ausente/.test(w)));
  });

  it("sem 02-reviewed.md: exit 1 antes de qualquer consulta", async () => {
    rmSync(join(dir, "02-reviewed.md"));
    const { deps, calls } = fakeDeps();
    const r = await runPrepareInstagramGuided(deps, { aammdd: AAMMDD, dir });
    assert.equal(r.exitCode, 1);
    assert.equal(calls.lookup, 0);
  });
});

describe("#11476 parsePrepareGuidedArgs", () => {
  it("aceita AAMMDD posicional ou --edition, com --video", () => {
    assert.deepEqual(parsePrepareGuidedArgs(["261028", "--video", "G:/x.mp4"]), { ok: true, aammdd: "261028", video: "G:/x.mp4", editionDir: null, editionUrl: undefined });
    assert.equal(parsePrepareGuidedArgs(["--edition", "261028"]).ok, true);
  });
  it("recusa edição ausente, ambígua, flag sem valor e flag desconhecida (nunca --publish)", () => {
    assert.equal(parsePrepareGuidedArgs([]).ok, false);
    assert.equal(parsePrepareGuidedArgs(["261028", "--edition", "261029"]).ok, false);
    assert.equal(parsePrepareGuidedArgs(["261028", "--video"]).ok, false);
    assert.equal(parsePrepareGuidedArgs(["261028", "--publish"]).ok, false);
  });
});
