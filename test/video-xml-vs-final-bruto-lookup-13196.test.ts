/**
 * test/video-xml-vs-final-bruto-lookup-13196.test.ts
 *
 * Resíduo da #13196/#13197: a 1ª rodada real (backfill de 16/11/2026 no 300)
 * não comparou nenhuma edição de 261104 em diante. Sem o `audio.wav` do cache
 * da montagem, `brutoWav` só tentava o caminho gravado no `plan.json` (G:/I:,
 * do Windows) e pulava o bruto em vários arquivos. O bruto estava no arquivo
 * do HD do 300 (#12548), no cache da montagem ou no Drive.
 *
 * Aqui: a ordem da busca (caminho original, arquivo do HD pela pasta da
 * edição, cache da montagem, Drive), a concatenação do bruto multi-arquivo na
 * linha do tempo (`frames/fps`, com silêncio completando a parte curta), o
 * pulo quando a duração não bate e o rótulo do registro que só pulou.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brutoWav, defaultBrutoLookup, type BrutoLookup, type Finder, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";
import { DEFAULT_MOUNT } from "../scripts/archive-video-brutos.ts";
import { brutoFileName, brutoParts, brutoSearchDirs, brutoTimelineMatches, mergeEditionRecord, type EditionRecord } from "../scripts/lib/diaria/video-xml-vs-final.ts";
import { editionsOfFolder } from "../scripts/lib/diaria/video-bruto-archive.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "xml-vs-final-bruto-13196-"));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
/** Edição falsa e única por teste: o áudio montado fica em `tmpdir()/diaria-video-xml-vs-final/{AAMMDD}` e seria reaproveitado. */
const fakeEdition = () => `9${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;

/** WAV de tom com `seconds` de duração (o bruto de teste: só precisa de `0:a:0`). */
function tone(path: string, seconds: number): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:a", "pcm_s16le", path]);
  assert.equal(r.status, 0, String(r.stderr));
}

function durationS(path: string): number {
  return Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }).stdout.trim());
}

const finderWith = (brutoFile: Finder["brutoFile"]): Finder => ({ mode: "local", list: async () => [], workDir: () => "/nao-existe-work", brutoFile });
const noDrive = finderWith(async () => null);

describe("#13196 resíduo: partes do bruto a partir do plan.json", () => {
  it("bruto único: um arquivo, nome sem a pasta do Windows", () => {
    const r = brutoParts({ path: "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube/261104/20261103_194228.mp4" });
    assert.deepEqual(r, { parts: [{ name: "20261103_194228.mp4", originalPath: "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube/261104/20261103_194228.mp4", durationS: null }] });
  });

  it("bruto em vários arquivos: ordem de offsetFrames e duração frames/fps", () => {
    const r = brutoParts({
      fps: 30,
      path: "I:/x/b.mp4",
      files: [
        { path: "I:/x/b.mp4", frames: 60, offsetFrames: 30 },
        { path: "I:\\x\\a.mp4", frames: 30, offsetFrames: 0 },
      ],
    });
    assert.ok(r.parts);
    assert.deepEqual(r.parts.map((p) => [p.name, p.durationS]), [["a.mp4", 1], ["b.mp4", 2]]);
  });

  it("vários arquivos sem fps ou sem frames: pulo, nunca concatenação com tempos errados", () => {
    assert.equal(brutoParts({ files: [{ path: "a", frames: 1 }, { path: "b", frames: 1 }] }).parts, null);
    assert.equal(brutoParts({ fps: 30, files: [{ path: "a", frames: 1 }, { path: "b" }] }).parts, null);
    assert.equal(brutoParts({}).parts, null);
  });

  it("brutoFileName aceita / e \\", () => {
    assert.equal(brutoFileName("C:\\a\\b\\x.MP4"), "x.MP4");
    assert.equal(brutoFileName("/a/b/y.mp4"), "y.mp4");
  });

  it("pastas de busca: arquivo do HD pela pasta que cobre a edição (inclusive 261109-10), depois o cache da montagem", () => {
    const dirs = brutoSearchDirs({
      edition: "261110",
      archiveRoot: "/hd/arquivo-video",
      archiveFolders: ["261105", "261109-10", "261110", "lixo"],
      montageEditionCache: "/cache/261110",
      join: (...p) => p.join("/"),
      editionsOfFolder,
    });
    assert.deepEqual(dirs, ["/hd/arquivo-video/261109-10", "/hd/arquivo-video/261110", "/cache/261110/bruto"]);
    assert.deepEqual(brutoSearchDirs({ edition: "261110", archiveRoot: null, archiveFolders: ["261110"], montageEditionCache: null, join: (...p) => p.join("/"), editionsOfFolder }), []);
  });

  it("duração da linha do tempo: tolerância de 1 quadro; bruto único não confere", () => {
    const parts = [{ name: "a", originalPath: "a", durationS: 1 }, { name: "b", originalPath: "b", durationS: 2 }];
    assert.equal(brutoTimelineMatches(3.02, parts, 30), true);
    assert.equal(brutoTimelineMatches(2.9, parts, 30), false);
    assert.equal(brutoTimelineMatches(Number.NaN, parts, 30), false);
    assert.equal(brutoTimelineMatches(99, [{ name: "a", originalPath: "a", durationS: null }], 30), true);
  });

  it("a raiz default do arquivo é a mesma do archive-video-brutos.ts (#12548)", () => {
    const l = defaultBrutoLookup(undefined, {});
    assert.equal(l.archiveRoot, join(DEFAULT_MOUNT, "arquivo-video"));
    assert.equal(defaultBrutoLookup(undefined, { VIDEO_ARCHIVE_ROOT: "/outro" }).archiveRoot, "/outro");
  });
});

describe("#13196 resíduo: registro que só pulou não vira #11670", () => {
  it("rodada automática sem sequência medida mantém o método dela", () => {
    const next: EditionRecord = { schema: 1, edition: "261116", method: "audio-envelope-align-v1", generatedAt: "t", sequences: [], skipped: [{ key: "youtube", reason: "x" }] };
    assert.equal(mergeEditionRecord(null, next).method, "audio-envelope-align-v1");
    const prevSkip: EditionRecord = { ...next, method: "11670-manual" };
    assert.equal(mergeEditionRecord(prevSkip, next).method, "audio-envelope-align-v1");
  });
});

describe("#13196 resíduo: brutoWav acha o bruto fora do caminho do plan.json", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
  it("bruto único no arquivo do HD (pasta da edição, nome sem diferenciar maiúsculas)", async () => {
    const ed = fakeEdition();
    const dir = tmp();
    const archive = join(dir, "arquivo-video");
    mkdirSync(join(archive, ed), { recursive: true });
    tone(join(archive, ed, "20261103_194228.MP4.wav"), 0.5);
    const lookup: BrutoLookup = { archiveRoot: archive, montageEditionCache: () => null };
    const pf: PlanFileLite = { plans: [], source: { fps: 30, path: "G:/Meu Drive/YouTube/261904/20261103_194228.mp4.wav" } };
    const res = await brutoWav(ed, join(dir, "work"), pf, noDrive, lookup);
    assert.ok(res.wav, JSON.stringify(res));
    assert.ok(Math.abs(durationS(res.wav) - 0.5) < 0.01);
  });

  it("bruto em 3 arquivos (HD, cache da montagem e Drive): concatena na linha do tempo, parte curta completada com silêncio", async () => {
    const ed = fakeEdition();
    const dir = tmp();
    const archive = join(dir, "arquivo-video");
    const cache = join(dir, "cache", ed);
    const drive = join(dir, "drive");
    mkdirSync(join(archive, ed), { recursive: true });
    mkdirSync(join(cache, "bruto"), { recursive: true });
    mkdirSync(drive, { recursive: true });
    tone(join(archive, ed, "a.wav"), 1);
    tone(join(cache, "bruto", "b.wav"), 0.8); // ocupa 1 s na linha do tempo: 0,2 s de silêncio no fim
    tone(join(drive, "c.wav"), 0.5);
    const asked: string[] = [];
    const finder = finderWith(async (_e, name) => {
      asked.push(name);
      return name === "c.wav" ? join(drive, name) : null;
    });
    const lookup: BrutoLookup = { archiveRoot: archive, montageEditionCache: () => cache };
    const pf: PlanFileLite = {
      plans: [],
      source: {
        fps: 30,
        path: "I:/Meu Drive/diaria-studio-video/261905/a.wav",
        files: [
          { path: "I:/Meu Drive/diaria-studio-video/261905/c.wav", frames: 15, offsetFrames: 60 },
          { path: "I:/Meu Drive/diaria-studio-video/261905/a.wav", frames: 30, offsetFrames: 0 },
          { path: "I:/Meu Drive/diaria-studio-video/261905/b.wav", frames: 30, offsetFrames: 30 },
        ],
      },
    };
    const res = await brutoWav(ed, join(dir, "work"), pf, finder, lookup);
    assert.ok(res.wav, JSON.stringify(res));
    assert.ok(Math.abs(durationS(res.wav) - 2.5) < 1 / 30, `duração ${durationS(res.wav)}`);
    assert.deepEqual(asked, ["c.wav"], "o Drive só é consultado para o que não está nesta máquina");
  });

  it("arquivo do bruto que não está em lugar nenhum: pulo com o nome dele", async () => {
    const ed = fakeEdition();
    const dir = tmp();
    const pf: PlanFileLite = { plans: [], source: { fps: 30, path: "I:/x/a.wav", files: [{ path: "I:/x/a.wav", frames: 30, offsetFrames: 0 }, { path: "I:/x/z.wav", frames: 30, offsetFrames: 30 }] } };
    const res = await brutoWav(ed, join(dir, "work"), pf, noDrive, { archiveRoot: null, montageEditionCache: () => null });
    assert.equal(res.wav, null);
    assert.ok(res.wav === null && /a\.wav não achado/.test(res.reason), JSON.stringify(res));
  });

  it("erro do Drive na busca do bruto vira drive-indisponivel, nunca 'não achado'", async () => {
    const ed = fakeEdition();
    const dir = tmp();
    const finder = finderWith(async () => {
      throw new Error("401 invalid_grant");
    });
    const res = await brutoWav(ed, join(dir, "work"), { plans: [], source: { path: "I:/x/a.wav" } }, finder, { archiveRoot: null, montageEditionCache: () => null });
    assert.equal(res.wav, null);
    assert.ok(res.wav === null && /^drive-indisponivel: bruto a\.wav: 401/.test(res.reason), JSON.stringify(res));
  });
});
