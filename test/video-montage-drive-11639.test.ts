/**
 * #11639 / #11640 / #11641 / #11642: `/diaria-video-montagem` fora do Neo (o
 * 300, sem `G:`). Bruto pela API do Drive para um cache em disco, saídas de
 * volta para a pasta da edição, XML apontando o bruto no Neo, e o Python/
 * ambiente da montagem.
 *
 * Caso real que motivou: 261030, bruto `20261029_093444.mp4` de 6,87 GB, que
 * não cabia no teto de 20 min do `drive-download.ts` e cujo caminho no cache
 * (`~/.cache/...`) iria parar no `pathurl` do XML, abrindo offline no Premiere.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DRIVE_ROOT,
  FOLDER_MIME,
  cacheIsFresh,
  changedFiles,
  downloadBudgetMs,
  ensureCachedFile,
  findEditionFolder,
  isAcceptableMediaContentType,
  pickDriveBruto,
  snapshotDir,
  uploadMimeFor,
  uploadToFolder,
  xmlMediaPath,
  youtubeFolderIdFrom,
  type DriveEntry,
  type MontageDriveDeps,
} from "../scripts/lib/diaria/video-montage-drive.ts";
import { assessMontageEnv, montageSetupCommand, montageVenvPython, requiredFreeBytes, resolveVideoPython, type MontageEnvProbes } from "../scripts/lib/diaria/video-montage-env.ts";
import { buildSequencePlan, buildXmeml, defaultSequences, resolveBlocks, type BlocksFile, type SequenceSpec, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { DRIVE_UPLOAD_COMMANDS, driveCacheDir, driveModeFor } from "../scripts/video-montagem.ts";

const GB = 1e9;
const entry = (name: string, size?: number, mimeType = "video/mp4"): DriveEntry => ({
  id: `id-${name}`,
  name,
  mimeType,
  ...(size !== undefined ? { size: String(size) } : {}),
});

interface Call {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Fake da API do Drive: cada chamada consome a próxima resposta. */
function fakeDeps(responses: Array<(c: Call) => Response>): { deps: MontageDriveDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      async driveFetch(url, init) {
        const c: Call = { url, method: init?.method ?? "GET", body: init?.body, headers: init?.headers as Record<string, string> | undefined };
        calls.push(c);
        const next = responses.shift();
        if (!next) throw new Error(`chamada inesperada: ${c.method} ${url}`);
        return next(c);
      },
    },
  };
}

const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("#11639 bruto pela API do Drive", () => {
  it("teto do download escala com o tamanho: 6,87 GB passam de 20 min, arquivo pequeno fica nos 20 min", () => {
    assert.equal(downloadBudgetMs(300e6), 20 * 60_000);
    const big = downloadBudgetMs(6.87 * GB);
    assert.ok(big > 20 * 60_000, `teto ${big} ms deveria passar de 20 min`);
    assert.equal(big, Math.ceil((6.87 * GB / 2_000_000) * 1000));
    assert.equal(downloadBudgetMs(0), 20 * 60_000);
  });

  it("escolhe o bruto como no disco: o maior .mp4 solto, nunca a subpasta Final nem final/previa no nome", () => {
    const raw = pickDriveBruto([
      entry("Final", undefined, FOLDER_MIME),
      entry("20261029_093444.mp4", 6.87 * GB),
      entry("Diaria comentada_Youtube_final.mp4", 9 * GB),
      entry("261030 - previa outras-redes.mp4", 8 * GB),
      entry("take2.mp4", 1 * GB),
    ]);
    assert.equal(raw?.pick.name, "20261029_093444.mp4");
    assert.deepEqual(raw?.candidates.map((c) => c.name), ["20261029_093444.mp4", "take2.mp4"]);
    assert.equal(raw?.audioOnly, undefined);
  });

  it("sem vídeo solto, o áudio vira bruto (modo áudio, #11552)", () => {
    const raw = pickDriveBruto([entry("Diaria comentada_Youtube.wav", 200e6, "audio/wav")]);
    assert.equal(raw?.pick.name, "Diaria comentada_Youtube.wav");
    assert.equal(raw?.audioOnly, true);
    assert.equal(pickDriveBruto([entry("Final", undefined, FOLDER_MIME)]), null);
  });

  it("cache vale só com o tamanho do Drive", () => {
    assert.equal(cacheIsFresh(null, "10"), false);
    assert.equal(cacheIsFresh(0, "10"), false);
    assert.equal(cacheIsFresh(10, "10"), true);
    assert.equal(cacheIsFresh(9, "10"), false);
    assert.equal(cacheIsFresh(9, undefined), true);
  });

  it("aceita vídeo e áudio no download, recusa HTML de página de erro", () => {
    assert.ok(isAcceptableMediaContentType("video/mp4", "x.mp4"));
    assert.ok(isAcceptableMediaContentType("audio/wav", "x.wav"));
    assert.ok(isAcceptableMediaContentType("application/octet-stream", "x.mov"));
    assert.equal(isAcceptableMediaContentType("text/html", "x.mp4"), false);
    assert.equal(isAcceptableMediaContentType("application/octet-stream", "x.txt"), false);
  });

  it("ensureCachedFile reaproveita o cache em dia sem chamar o Drive e baixa quando falta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-drive-"));
    writeFileSync(join(dir, "bruto.mp4"), Buffer.alloc(5));
    const none = fakeDeps([]);
    const hit = await ensureCachedFile(none.deps, entry("bruto.mp4", 5), dir, () => {});
    assert.equal(hit.downloaded, false);
    assert.equal(none.calls.length, 0);

    const body = Buffer.from("conteudo-do-bruto");
    const dl = fakeDeps([() => new Response(body, { status: 200, headers: { "content-type": "video/mp4" } })]);
    const got = await ensureCachedFile(dl.deps, entry("novo.mp4", body.length), dir, () => {});
    assert.equal(got.downloaded, true);
    assert.equal(readFileSync(got.localPath, "utf8"), "conteudo-do-bruto");
    assert.match(dl.calls[0].url, /files\/id-novo\.mp4\?alt=media/);
  });

  it("pasta da edição: nenhuma ou duas é erro, nunca escolhe sozinho", async () => {
    const zero = fakeDeps([() => json({ files: [] })]);
    await assert.rejects(findEditionFolder(zero.deps, "root", "261030"), /não encontrada/);
    const two = fakeDeps([() => json({ files: [entry("261030", undefined, FOLDER_MIME), { ...entry("261030", undefined, FOLDER_MIME), id: "b" }] })]);
    await assert.rejects(findEditionFolder(two.deps, "root", "261030"), /2 pastas/);
    const one = fakeDeps([() => json({ files: [entry("261030", undefined, FOLDER_MIME)] })]);
    assert.equal((await findEditionFolder(one.deps, "root", "261030")).id, "id-261030");
    assert.match(decodeURIComponent(one.calls[0].url.replace(/\+/g, " ")), /'root' in parents and trashed = false and name = '261030'/);
  });

  it("pasta YouTube vem do platform.config.json", () => {
    assert.equal(youtubeFolderIdFrom({ publishing: { youtube: { drive_folder_id: " abc " } } }), "abc");
    assert.equal(youtubeFolderIdFrom({}), null);
  });
});

describe("#11640 saídas sobem para a pasta da edição", () => {
  it("cria quando não existe (sessão resumable + PUT do conteúdo, parents = a pasta da edição)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-up-"));
    const file = join(dir, "261030 - montagem (importar no Premiere).xml");
    writeFileSync(file, "<xmeml/>");
    const { deps, calls } = fakeDeps([
      () => json({ files: [] }),
      () => new Response("", { status: 200, headers: { location: "https://upload.example/session-1" } }),
      () => json({ id: "novo", name: "261030 - montagem (importar no Premiere).xml", webViewLink: "https://drive/novo" }),
    ]);
    const r = await uploadToFolder(deps, "pasta-edicao", file);
    assert.deepEqual(r, { id: "novo", name: "261030 - montagem (importar no Premiere).xml", webViewLink: "https://drive/novo", updated: false });
    assert.equal(calls[1].method, "POST");
    assert.match(calls[1].url, /uploadType=resumable/);
    assert.deepEqual(JSON.parse(String(calls[1].body)), { name: "261030 - montagem (importar no Premiere).xml", parents: ["pasta-edicao"] });
    assert.equal(calls[1].headers?.["X-Upload-Content-Type"], "application/xml");
    assert.equal(calls[2].method, "PUT");
    assert.equal(calls[2].url, "https://upload.example/session-1");
  });

  it("atualiza pelo id o arquivo de mesmo nome (re-execução não duplica)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-up-"));
    const file = join(dir, "Diaria comentada_Instagram_V1 - legendas.srt");
    writeFileSync(file, "1\n00:00:00,000 --> 00:00:01,000\nOi\n");
    const { deps, calls } = fakeDeps([
      () => json({ files: [{ ...entry("Diaria comentada_Instagram_V1 - legendas.srt", 10, "application/x-subrip"), id: "velho", modifiedTime: "2026-10-29T10:00:00Z" }] }),
      () => new Response("", { status: 200, headers: { location: "https://upload.example/s2" } }),
      () => json({ id: "velho", name: "Diaria comentada_Instagram_V1 - legendas.srt" }),
    ]);
    const r = await uploadToFolder(deps, "pasta-edicao", file);
    assert.equal(r.updated, true);
    assert.equal(calls[1].method, "PATCH");
    assert.match(calls[1].url, /files\/velho\?uploadType=resumable/);
    assert.equal(String(calls[1].body), "{}");
  });

  it("sessão recusada é erro com o status, nada é dado como enviado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-up-"));
    const file = join(dir, "x.mp4");
    writeFileSync(file, "x");
    const { deps } = fakeDeps([() => json({ files: [] }), () => new Response("quota", { status: 403 })]);
    await assert.rejects(uploadToFolder(deps, "p", file), /sessão recusada \(403\)/);
  });

  it("sobem só os arquivos que esta execução gravou no out dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-snap-"));
    writeFileSync(join(dir, "a.srt"), "1");
    writeFileSync(join(dir, "b.srt"), "1");
    const before = snapshotDir(dir, (d) => readdirSync(d));
    writeFileSync(join(dir, "b.srt"), "22");
    writeFileSync(join(dir, "c.xml"), "x");
    writeFileSync(join(dir, "d.mp4.part"), "x");
    assert.deepEqual(changedFiles(before, snapshotDir(dir, (d) => readdirSync(d))), ["b.srt", "c.xml"]);
    assert.equal(snapshotDir(join(dir, "nao-existe"), (d) => readdirSync(d)).size, 0);
  });

  it("os subcomandos que sobem são build, srt e preview; MIME por extensão", () => {
    assert.deepEqual([...DRIVE_UPLOAD_COMMANDS], ["build", "srt", "preview"]);
    assert.equal(uploadMimeFor("a.mp4"), "video/mp4");
    assert.equal(uploadMimeFor("a.SRT"), "application/x-subrip");
    assert.equal(uploadMimeFor("decupagem.md"), "text/markdown");
  });
});

describe("#11641 pathurl do XML aponta o bruto no Neo", () => {
  const drive = { name: "20261029_093444.mp4", localPath: "/home/vjpixel/.cache/diaria-video-montagem/261030/bruto/20261029_093444.mp4" };

  it("bruto do cache → caminho G: do Neo; bruto local qualquer → o próprio caminho", () => {
    assert.equal(xmlMediaPath(drive.localPath, { edition: "261030", drive }), `${DEFAULT_DRIVE_ROOT}/261030/20261029_093444.mp4`);
    assert.equal(xmlMediaPath("G:/Meu Drive/x/261027/bruto.mp4", { edition: "261027", drive: null }), "G:/Meu Drive/x/261027/bruto.mp4");
    assert.equal(xmlMediaPath("/outro/bruto.mp4", { edition: "261030", drive }), "/outro/bruto.mp4");
    assert.equal(xmlMediaPath("/outro/bruto.mp4", { edition: "261030", xmlMediaRoot: "D:/YouTube/" }), "D:/YouTube/261030/bruto.mp4");
  });

  it("buildXmeml grava o caminho do Neo no pathurl e o nome do Drive, nunca o cache", () => {
    const words: Word[] = [];
    for (let t = 10; t < 20; t += 0.5) words.push({ start: t, end: t + 0.4, text: ` w${t}` });
    const file: BlocksFile = { edition: "261030", blocks: { comentario: [{ start: 10, end: 20 }] } };
    const { blocks } = resolveBlocks(file, words, { durationS: 60 });
    const [yt] = defaultSequences() as [SequenceSpec];
    const plan = buildSequencePlan({ ...yt, order: ["comentario"] }, blocks, [], { fps: 30, durationS: 60 });
    const source: SourceInfo = { path: drive.localPath, fps: 30, durationS: 60, width: 3840, height: 2160, mirrored: true };
    const xml = buildXmeml([plan], source, { faceX: 0.5, eyeY: 0.5 }, { mediaPath: xmlMediaPath(source.path, { edition: "261030", drive }) });
    assert.match(xml, /<pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/Work\/Mentoria%20Fluxo%20VTSD\/YouTube\/261030\/20261029_093444\.mp4<\/pathurl>/);
    assert.match(xml, /<name>20261029_093444\.mp4<\/name>/);
    assert.ok(!xml.includes(".cache"), "o caminho do cache local não pode ir para o XML");
    // Sem mediaPath, o de sempre: o caminho de leitura (o Neo lê de G:).
    assert.ok(buildXmeml([plan], source, { faceX: 0.5, eyeY: 0.5 }).includes(".cache"));
  });
});

describe("#11639 modo de acesso ao Drive", () => {
  it("G: ausente sem raiz explícita → API; pasta local → local; flags forçam", () => {
    const base = { driveDirExists: false, fromDrive: false, noDriveApi: false, explicitRoot: false };
    assert.equal(driveModeFor(base), "api");
    assert.equal(driveModeFor({ ...base, driveDirExists: true }), "local");
    assert.equal(driveModeFor({ ...base, explicitRoot: true }), "local");
    assert.equal(driveModeFor({ ...base, noDriveApi: true }), "local");
    assert.equal(driveModeFor({ ...base, driveDirExists: true, fromDrive: true }), "api");
    assert.throws(() => driveModeFor({ ...base, fromDrive: true, noDriveApi: true }), /juntos/);
  });

  it("cache em disco: --cache-dir > DIARIA_VIDEO_CACHE_DIR > ~/.cache, por edição", () => {
    assert.equal(driveCacheDir("261030", undefined, undefined, "/home/u"), "/home/u/.cache/diaria-video-montagem/261030");
    assert.equal(driveCacheDir("261030", undefined, "/mnt/big", "/home/u"), "/mnt/big/261030");
    assert.equal(driveCacheDir("261030", "/x", "/mnt/big", "/home/u"), "/x/261030");
  });
});

describe("#11642 Python e ambiente da montagem", () => {
  it("Python: --python > DIARIA_VIDEO_PYTHON > ~/.venv-video-montagem > python do PATH", () => {
    const venv = montageVenvPython("linux", "/home/u");
    assert.equal(venv, "/home/u/.venv-video-montagem/bin/python");
    assert.equal(montageVenvPython("win32", "C:/Users/u"), "C:/Users/u/.venv-video-montagem/Scripts/python.exe");
    const has = (p: string) => p === venv;
    assert.deepEqual(resolveVideoPython({ flag: "/x/py", env: "/y/py", platform: "linux", home: "/home/u", exists: has }), { python: "/x/py", from: "flag" });
    assert.deepEqual(resolveVideoPython({ env: "/y/py", platform: "linux", home: "/home/u", exists: has }), { python: "/y/py", from: "env" });
    assert.deepEqual(resolveVideoPython({ platform: "linux", home: "/home/u", exists: has }), { python: venv, from: "venv" });
    assert.deepEqual(resolveVideoPython({ platform: "linux", home: "/home/u", exists: () => false }), { python: "python", from: "path" });
  });

  it("modelo fora do cache (o 300 em 29/10/2026) = não roda, com o comando que baixa", () => {
    const ok = { ok: true };
    const probes: MontageEnvProbes = { ffmpeg: ok, python: ok, model: { ok: false, detail: "LocalEntryNotFoundError" }, drive: ok, disk: ok };
    const r = assessMontageEnv(probes, "linux", "/home/u/.venv-video-montagem/bin/python");
    assert.equal(r.ready, false);
    assert.deepEqual(r.missing, ["model"]);
    assert.match(r.items.find((i) => i.id === "model")!.fix!, /large-v3-turbo/);
    assert.equal(assessMontageEnv({ ...probes, model: ok }, "linux", "py").ready, true);
  });

  it("setup instala pelo lock, que fixa o PyAV 18 (o 19 quebra o decode do faster-whisper 1.2.1, 261030)", () => {
    for (const p of ["linux", "win32"]) assert.match(montageSetupCommand(p), /-r scripts\/video\/montagem-requirements\.txt/);
    const lock = readFileSync(new URL("../scripts/video/montagem-requirements.txt", import.meta.url), "utf8");
    assert.match(lock, /^faster-whisper==1\.2\.1$/m);
    assert.match(lock, /^av==18\./m);
  });

  it("espaço exigido: 3x o bruto, 25 GB sem bruto conhecido", () => {
    assert.equal(requiredFreeBytes(6.87 * GB), 3 * 6.87 * GB);
    assert.equal(requiredFreeBytes(null), 25 * GB);
  });
});
