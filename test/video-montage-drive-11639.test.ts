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
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DRIVE_ROOT,
  FOLDER_MIME,
  cacheState,
  parseDriveSize,
  spaceShortfall,
  listChildren,
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
import { explicitDriveRoot } from "../scripts/check-video-env.ts";
import { assessMontageEnv, montageSetupCommand, montageVenvPython, requiredFreeBytes, resolveVideoPython, type MontageEnvProbes } from "../scripts/lib/diaria/video-montage-env.ts";
import { buildSequencePlan, buildXmeml, defaultSequences, resolveBlocks, type BlocksFile, type SequenceSpec, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import {
  BRUTO_DRIVE_FILE,
  DRIVE_UPLOADS_FILE,
  DRIVE_UPLOAD_COMMANDS,
  driveCacheDir,
  driveModeFor,
  ensureBrutoLocal,
  fetchBruto,
  localBrutoMissing,
  makeDriveSession,
  transcribePrecheck,
  uploadAll,
  workDirDefault,
} from "../scripts/video-montagem.ts";

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

  it("cache: sem arquivo = missing; tamanho diferente = stale; com sidecar, id e modifiedTime têm de bater", () => {
    const file = { id: "A", name: "b.mp4", size: "10", modifiedTime: "2026-10-29T12:47:21Z" };
    assert.equal(cacheState(null, null, file), "missing");
    assert.equal(cacheState(0, null, file), "missing");
    assert.equal(cacheState(10, null, file), "fresh");
    assert.equal(cacheState(9, null, file), "stale");
    assert.equal(cacheState(9, null, { ...file, size: undefined }), "fresh");
    assert.equal(cacheState(10, { id: "A", size: 10, modifiedTime: file.modifiedTime }, file), "fresh");
    // bruto trocado no Drive com o mesmo nome e tamanho
    assert.equal(cacheState(10, { id: "A", size: 10, modifiedTime: "2026-10-28T00:00:00Z" }, file), "stale");
    assert.equal(cacheState(10, { id: "OUTRO", size: 10, modifiedTime: file.modifiedTime }, file), "stale");
  });

  it("size da API: string int64 → número; ausente ou lixo = null, nunca NaN", () => {
    assert.equal(parseDriveSize("6872647306"), 6872647306);
    assert.equal(parseDriveSize(undefined), null);
    assert.equal(parseDriveSize(""), null);
    assert.equal(parseDriveSize("abc"), null);
  });

  it("espaço: tamanho + 10%, sem descontar o arquivo velho (o .part coexiste com ele até o rename); sem medida = não confere", () => {
    assert.equal(spaceShortfall(20 * GB, 6.87 * GB), 0);
    assert.ok((spaceShortfall(7 * GB, 6.87 * GB) ?? 0) > 0);
    assert.equal(spaceShortfall(null, 6.87 * GB), null);
    assert.equal(spaceShortfall(1, null), null);
  });

  it("nomes repetidos entre os candidatos saem em duplicateNames, e o id é o do maior", () => {
    const raw = pickDriveBruto([{ ...entry("b.mp4", 2 * GB), id: "pequeno" }, { ...entry("b.mp4", 7 * GB), id: "grande" }]);
    assert.equal(raw?.pick.id, "grande");
    assert.deepEqual(raw?.duplicateNames, ["b.mp4"]);
  });

  it("aceita vídeo e áudio no download, recusa HTML de página de erro", () => {
    assert.ok(isAcceptableMediaContentType("video/mp4", "x.mp4"));
    assert.ok(isAcceptableMediaContentType("audio/wav", "x.wav"));
    assert.ok(isAcceptableMediaContentType("application/octet-stream", "x.mov"));
    assert.equal(isAcceptableMediaContentType("text/html", "x.mp4"), false);
    assert.equal(isAcceptableMediaContentType("application/octet-stream", "x.txt"), false);
  });

  it("ensureCachedFile recusa sem espaço antes de chamar o Drive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-drive-"));
    const none = fakeDeps([]);
    await assert.rejects(ensureCachedFile(none.deps, entry("big.mp4", 7 * GB), dir, () => {}, { freeBytes: () => 1 * GB }), /sem espaço/);
    assert.equal(none.calls.length, 0);
  });

  it("ensureCachedFile grava o sidecar e baixa de novo quando o arquivo do Drive mudou", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-drive-"));
    const body = Buffer.from("v1");
    const first = fakeDeps([() => new Response(body, { status: 200, headers: { "content-type": "video/mp4" } })]);
    const f1 = { id: "X", name: "b.mp4", size: "2", modifiedTime: "2026-10-29T10:00:00Z" };
    await ensureCachedFile(first.deps, f1, dir, () => {}, { freeBytes: () => 100 * GB });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "b.mp4.drive.json"), "utf8")), { id: "X", size: 2, modifiedTime: "2026-10-29T10:00:00Z" });
    const second = fakeDeps([() => new Response(Buffer.from("v2"), { status: 200, headers: { "content-type": "video/mp4" } })]);
    const got = await ensureCachedFile(second.deps, { ...f1, modifiedTime: "2026-10-29T11:00:00Z" }, dir, () => {}, { freeBytes: () => 100 * GB });
    assert.equal(got.downloaded, true);
    assert.equal(readFileSync(got.localPath, "utf8"), "v2");
  });

  it("listChildren pagina até o fim", async () => {
    const { deps, calls } = fakeDeps([() => json({ files: [entry("a.mp4", 1)], nextPageToken: "p2" }), () => json({ files: [entry("b.mp4", 2)] })]);
    const all = await listChildren(deps, "pasta");
    assert.deepEqual(all.map((x) => x.name), ["a.mp4", "b.mp4"]);
    assert.match(calls[1].url, /pageToken=p2/);
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

  it("5xx no PUT abre sessão NOVA e reenvia; o PUT vai por uploadFetch (sem retry), sem Content-Length manual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-up-"));
    const file = join(dir, "261030 - previa outras-redes.mp4");
    writeFileSync(file, "mp4");
    const puts: Call[] = [];
    const { deps, calls } = fakeDeps([
      () => json({ files: [] }),
      () => new Response("", { status: 200, headers: { location: "https://upload.example/s1" } }),
      () => json({ files: [] }), // procura de novo: o 503 não gravou nada
      () => new Response("", { status: 200, headers: { location: "https://upload.example/s2" } }),
    ]);
    const putResponses = [() => new Response("oops", { status: 503 }), () => json({ id: "ok", name: "261030 - previa outras-redes.mp4" })];
    deps.uploadFetch = async (url, init) => {
      puts.push({ url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string> });
      return putResponses.shift()!();
    };
    const r = await uploadToFolder(deps, "p", file);
    assert.equal(r.id, "ok");
    assert.deepEqual(puts.map((p) => p.url), ["https://upload.example/s1", "https://upload.example/s2"]);
    assert.equal(calls.filter((c) => c.method === "POST").length, 2, "uma sessão por tentativa");
    assert.equal(puts[0].headers?.["Content-Length"], undefined);
  });

  it("falha de rede no PUT de arquivo NOVO: a nova tentativa acha o arquivo que o Drive gravou e atualiza, não duplica", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-up-"));
    const file = join(dir, "novo.xml");
    writeFileSync(file, "<x/>");
    const { deps, calls } = fakeDeps([
      () => json({ files: [] }),
      () => new Response("", { status: 200, headers: { location: "https://u/s1" } }),
      () => json({ files: [{ ...entry("novo.xml", 4, "application/xml"), id: "gravado" }] }),
      () => new Response("", { status: 200, headers: { location: "https://u/s2" } }),
    ]);
    const outcomes: Array<() => Response> = [
      () => {
        throw new Error("socket hang up");
      },
      () => json({ id: "gravado", name: "novo.xml" }),
    ];
    deps.uploadFetch = async () => outcomes.shift()!();
    const r = await uploadToFolder(deps, "p", file);
    assert.equal(r.id, "gravado");
    assert.equal(calls[3].method, "PATCH");
    assert.match(calls[3].url, /files\/gravado\?uploadType=resumable/);
  });

  it("3 tentativas esgotadas: erro com a última causa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-up-"));
    const file = join(dir, "a.mp4");
    writeFileSync(file, "x");
    const session = () => new Response("", { status: 200, headers: { location: "https://u/s" } });
    const { deps } = fakeDeps([() => json({ files: [] }), session, () => json({ files: [] }), session, () => json({ files: [] }), session]);
    deps.uploadFetch = async () => new Response("down", { status: 503 });
    await assert.rejects(uploadToFolder(deps, "p", file), /falhou 3 vezes \(HTTP 503/);
  });

  it("4xx no PUT é erro na hora, sem nova tentativa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-up-"));
    const file = join(dir, "a.srt");
    writeFileSync(file, "1");
    const { deps } = fakeDeps([() => json({ files: [] }), () => new Response("", { status: 200, headers: { location: "https://u/s" } })]);
    let n = 0;
    deps.uploadFetch = async () => {
      n++;
      return new Response("bad", { status: 400 });
    };
    await assert.rejects(uploadToFolder(deps, "p", file), /falhou \(400\)/);
    assert.equal(n, 1);
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

  it("MIME por extensão; build, srt e preview são os que sobem", () => {
    assert.equal(uploadMimeFor("a.mp4"), "video/mp4");
    assert.equal(uploadMimeFor("a.SRT"), "application/x-subrip");
    assert.equal(uploadMimeFor("decupagem.md"), "text/markdown");
  });
});

describe("#11641 pathurl do XML aponta o bruto no Neo", () => {
  const drive = { name: "20261029_093444.mp4", localPath: "/home/vjpixel/.cache/diaria-video-montagem/261030/bruto/20261029_093444.mp4" };

  it("bruto do cache → caminho G: do Neo; bruto local qualquer → o próprio caminho", () => {
    assert.deepEqual(xmlMediaPath(drive.localPath, { edition: "261030", drive }), { path: `${DEFAULT_DRIVE_ROOT}/261030/20261029_093444.mp4`, how: "cache" });
    assert.deepEqual(xmlMediaPath("G:/Meu Drive/x/261027/bruto.mp4", { edition: "261027", drive: null }), { path: "G:/Meu Drive/x/261027/bruto.mp4", how: "source" });
    assert.deepEqual(xmlMediaPath("/outro/bruto.mp4", { edition: "261030", drive }), { path: "/outro/bruto.mp4", how: "source" });
    assert.deepEqual(xmlMediaPath("/outro/bruto.mp4", { edition: "261030", xmlMediaRoot: "D:/YouTube/" }), { path: "D:/YouTube/261030/bruto.mp4", how: "root" });
    // modo API com --source fora do cache: o caminho Linux nunca vai para o XML
    assert.deepEqual(xmlMediaPath("/home/u/bruto.mp4", { edition: "261030", drive, apiMode: true }), { path: `${DEFAULT_DRIVE_ROOT}/261030/bruto.mp4`, how: "api-guess" });
  });

  it("#11653 build no Neo com --drive-root: o XML usa essa raiz, não a padrão; --xml-media-root ainda vence", () => {
    assert.deepEqual(xmlMediaPath(drive.localPath, { edition: "261030", drive, driveRoot: "H:/Drive/YouTube/" }), { path: "H:/Drive/YouTube/261030/20261029_093444.mp4", how: "cache" });
    assert.deepEqual(xmlMediaPath(drive.localPath, { edition: "261030", drive, driveRoot: "H:/Drive/YouTube", xmlMediaRoot: "D:/YT" }), { path: "D:/YT/261030/20261029_093444.mp4", how: "cache" });
  });

  it("#11653 check-video-env: --drive-root vence DIARIA_VIDEO_DRIVE_ROOT", () => {
    assert.deepEqual(explicitDriveRoot("D:/a", "E:/b"), { root: "D:/a", via: "--drive-root" });
    assert.deepEqual(explicitDriveRoot(undefined, "E:/b"), { root: "E:/b", via: "DIARIA_VIDEO_DRIVE_ROOT" });
    assert.equal(explicitDriveRoot(undefined, undefined), null);
  });

  it("buildXmeml grava o caminho do Neo no pathurl e o nome do Drive, nunca o cache", () => {
    const words: Word[] = [];
    for (let t = 10; t < 20; t += 0.5) words.push({ start: t, end: t + 0.4, text: ` w${t}` });
    const file: BlocksFile = { edition: "261030", blocks: { comentario: [{ start: 10, end: 20 }] } };
    const { blocks } = resolveBlocks(file, words, { durationS: 60 });
    const [yt] = defaultSequences() as [SequenceSpec];
    const plan = buildSequencePlan({ ...yt, order: ["comentario"] }, blocks, [], { fps: 30, durationS: 60 });
    const source: SourceInfo = { path: drive.localPath, fps: 30, durationS: 60, width: 3840, height: 2160, mirrored: true };
    const xml = buildXmeml([plan], source, { faceX: 0.5, eyeY: 0.5 }, { mediaPath: xmlMediaPath(source.path, { edition: "261030", drive }).path });
    assert.match(xml, /<pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/Work\/Mentoria%20Fluxo%20VTSD\/YouTube\/261030\/20261029_093444\.mp4<\/pathurl>/);
    assert.match(xml, /<name>20261029_093444\.mp4<\/name>/);
    assert.ok(!xml.includes(".cache"), "o caminho do cache local não pode ir para o XML");
    // Sem mediaPath, o de sempre: o caminho de leitura (o Neo lê de G:).
    assert.ok(buildXmeml([plan], source, { faceX: 0.5, eyeY: 0.5 }).includes(".cache"));
  });
});

describe("#11639 modo de acesso ao Drive", () => {
  it("decide a RAIZ, não a pasta da edição: G: montado com {AAMMDD}/ ainda sem sincronizar continua local", () => {
    const base = { driveRootExists: false, fromDrive: false, noDriveApi: false, explicitRoot: false };
    assert.equal(driveModeFor(base), "api");
    assert.equal(driveModeFor({ ...base, driveRootExists: true }), "local");
    assert.equal(driveModeFor({ ...base, explicitRoot: true }), "local");
    assert.equal(driveModeFor({ ...base, noDriveApi: true }), "local");
    assert.equal(driveModeFor({ ...base, driveRootExists: true, fromDrive: true }), "api");
    assert.throws(() => driveModeFor({ ...base, fromDrive: true, noDriveApi: true }), /juntos/);
  });

  it("work dir no modo API fica no cache em disco (o /tmp do 300 é tmpfs); no Neo, o tmp de sempre", () => {
    assert.equal(workDirDefault("api", "/home/u/.cache/diaria-video-montagem/261030", "/tmp", "261030"), "/home/u/.cache/diaria-video-montagem/261030/work");
    assert.equal(workDirDefault("local", "/x", "/tmp", "261030"), "/tmp/diaria-video-montagem/261030");
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
    const r = assessMontageEnv(probes, "linux", { python: "/home/u/.venv-video-montagem/bin/python", from: "venv" });
    assert.equal(r.ready, false);
    assert.deepEqual(r.missing, ["model"]);
    const fix = r.items.find((i) => i.id === "model")!.fix!;
    assert.match(fix, /large-v3-turbo/);
    // o comando sai executável: o executável puro, sem o rótulo de origem no meio
    assert.match(fix, /^baixar o modelo uma vez, com rede: \/home\/u\/\.venv-video-montagem\/bin\/python -c /);
    assert.equal(assessMontageEnv({ ...probes, model: ok }, "linux", { python: "py", from: "path" }).ready, true);
  });

  it("correção específica da sonda vence a genérica do item (pasta da edição ausente não é problema de OAuth)", () => {
    const ok = { ok: true };
    const r = assessMontageEnv({ ffmpeg: ok, python: ok, model: ok, drive: { ok: false, fix: "subir o bruto" }, disk: ok }, "linux", { python: "py", from: "path" });
    assert.equal(r.items.find((i) => i.id === "drive")!.fix, "subir o bruto");
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

describe("#11639/#11640 wiring do modo API (Drive falso)", () => {
  const ED = "261030";
  const folderList = () => json({ files: [{ ...entry(ED, undefined, FOLDER_MIME), id: "pasta-ed" }] });

  it("fetchBruto baixa o maior .mp4 solto e grava bruto.drive.json com a procedência", async () => {
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const cache = mkdtempSync(join(tmpdir(), "vm-cache-"));
    const body = Buffer.from("bruto!");
    const { deps } = fakeDeps([
      folderList,
      () => json({ files: [{ ...entry("20261029_093444.mp4", body.length), id: "bruto-id", modifiedTime: "2026-10-29T12:47:21Z" }, entry("Final", undefined, FOLDER_MIME)] }),
      () => new Response(body, { status: 200, headers: { "content-type": "video/mp4" } }),
    ]);
    const d = makeDriveSession(ED, cache, deps, () => "root");
    const local = await fetchBruto({ stateDir: state, edition: ED }, d);
    assert.equal(readFileSync(local, "utf8"), "bruto!");
    const info = JSON.parse(readFileSync(join(state, BRUTO_DRIVE_FILE), "utf8"));
    assert.deepEqual(info, {
      edition: ED,
      id: "bruto-id",
      name: "20261029_093444.mp4",
      size: body.length,
      modifiedTime: "2026-10-29T12:47:21Z",
      folderId: "pasta-ed",
      localPath: local.replace(/\\/g, "/"),
    });
  });

  it("ensureBrutoLocal baixa de novo o bruto que sumiu do cache, e recusa se ele mudou no Drive", async () => {
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const cache = mkdtempSync(join(tmpdir(), "vm-cache-"));
    const localPath = join(cache, "bruto", "b.mp4").replace(/\\/g, "/");
    writeFileSync(join(state, "source.json"), JSON.stringify({ path: localPath, fps: 30, durationS: 10, width: 1920, height: 1080, mirrored: false }));
    writeFileSync(join(state, BRUTO_DRIVE_FILE), JSON.stringify({ edition: ED, id: "B", name: "b.mp4", size: 3, modifiedTime: "t1", folderId: "p", localPath }));
    const ok = fakeDeps([() => json({ id: "B", name: "b.mp4", mimeType: "video/mp4", size: "3", modifiedTime: "t1" }), () => new Response(Buffer.from("abc"), { status: 200, headers: { "content-type": "video/mp4" } })]);
    await ensureBrutoLocal({ stateDir: state, edition: ED }, makeDriveSession(ED, cache, ok.deps, () => "root"));
    assert.equal(readFileSync(localPath, "utf8"), "abc");

    const state2 = mkdtempSync(join(tmpdir(), "vm-state-"));
    const lp2 = join(cache, "bruto", "c.mp4").replace(/\\/g, "/");
    writeFileSync(join(state2, "source.json"), JSON.stringify({ path: lp2, fps: 30, durationS: 10, width: 1920, height: 1080, mirrored: false }));
    writeFileSync(join(state2, BRUTO_DRIVE_FILE), JSON.stringify({ edition: ED, id: "C", name: "c.mp4", size: 3, modifiedTime: "t1", folderId: "p", localPath: lp2 }));
    const changed = fakeDeps([() => json({ id: "C", name: "c.mp4", mimeType: "video/mp4", size: "3", modifiedTime: "t2" })]);
    await assert.rejects(ensureBrutoLocal({ stateDir: state2, edition: ED }, makeDriveSession(ED, cache, changed.deps, () => "root")), /mudou no Drive/);
  });

  it("no Neo (modo local) com source.json do cache do 300: mensagem clara, não o erro do ffmpeg", () => {
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const lp = "/home/outra-maquina/.cache/diaria-video-montagem/261030/bruto/20261029_093444.mp4";
    writeFileSync(join(state, "source.json"), JSON.stringify({ path: lp, fps: 30, durationS: 10, width: 1920, height: 1080, mirrored: false }));
    writeFileSync(join(state, BRUTO_DRIVE_FILE), JSON.stringify({ edition: ED, id: "B", name: "20261029_093444.mp4", size: 3, modifiedTime: null, folderId: "p", localPath: lp }));
    assert.match(localBrutoMissing({ stateDir: state, edition: ED }) ?? "", /cache do modo API de outra máquina.*--from-drive/);
  });

  it("uploadAll: falha no 2º arquivo deixa o 2º pendente, e a próxima rodada o sobe mesmo sem mudança", async () => {
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const out = mkdtempSync(join(tmpdir(), "vm-out-"));
    const a = join(out, "a.srt");
    const b = join(out, "b.srt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    const session = () => new Response("", { status: 200, headers: { location: "https://u/s" } });
    const fail = fakeDeps([folderList, () => json({ files: [] }), session, () => json({ files: [] }), () => new Response("quota", { status: 403 })]);
    fail.deps.uploadFetch = async () => json({ id: "id-a", name: "a.srt" });
    const r1 = await uploadAll({ stateDir: state, edition: ED }, makeDriveSession(ED, out, fail.deps, () => "root"), [a, b]);
    assert.deepEqual(r1.uploaded, [a]);
    assert.deepEqual(r1.pending, [b]);
    assert.match(r1.error ?? "", /403/);
    const reg1 = JSON.parse(readFileSync(join(state, DRIVE_UPLOADS_FILE), "utf8"));
    assert.deepEqual(reg1.pending, [b]);
    assert.equal(reg1.files["a.srt"].id, "id-a");

    const retry = fakeDeps([folderList, () => json({ files: [] }), session]);
    retry.deps.uploadFetch = async () => json({ id: "id-b", name: "b.srt" });
    const r2 = await uploadAll({ stateDir: state, edition: ED }, makeDriveSession(ED, out, retry.deps, () => "root"), []);
    assert.deepEqual(r2.uploaded, [b]);
    assert.equal(r2.error, null);
    assert.deepEqual(JSON.parse(readFileSync(join(state, DRIVE_UPLOADS_FILE), "utf8")).pending, []);
  });

  it("a sessão só lê a pasta YouTube quando vai à rede", async () => {
    let read = 0;
    const d = makeDriveSession(ED, "/tmp/x", fakeDeps([]).deps, () => {
      read++;
      throw new Error("sem config");
    });
    assert.equal(read, 0);
    await assert.rejects(d.folder(), /sem config/);
    assert.equal(read, 1);
  });

  it("#11653 transcribe com source.json de outro bruto: recusa sem baixar nem gravar bruto.drive.json", async () => {
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const cache = mkdtempSync(join(tmpdir(), "vm-cache-"));
    const work = mkdtempSync(join(tmpdir(), "vm-work-"));
    const brutoA = join(cache, "bruto", "A.mp4").replace(/\\/g, "/");
    writeFileSync(join(state, "source.json"), JSON.stringify({ path: brutoA, fps: 30, durationS: 10, width: 1920, height: 1080, mirrored: false }));
    // O editor pôs B, maior, na pasta: o fake só responde à listagem; um download quebraria com "chamada inesperada".
    const { deps, calls } = fakeDeps([folderList, () => json({ files: [{ ...entry("B.mp4", 7 * GB), id: "B" }, { ...entry("A.mp4", 6 * GB), id: "A" }] })]);
    const d = makeDriveSession(ED, cache, deps, () => "root");
    await assert.rejects(fetchBruto({ stateDir: state, edition: ED, workDir: work, force: false }, d), /source\.json aponta para outro bruto.*A\.mp4.*--force/);
    assert.equal(calls.length, 2, "só a pasta e a listagem; nenhum download");
    assert.equal(existsSync(join(state, BRUTO_DRIVE_FILE)), false, "bruto.drive.json não é gravado");
    assert.equal(existsSync(join(cache, "bruto", "B.mp4")), false);
  });

  it("#11653 transcrição pronta para o mesmo bruto: não baixa de novo (cache limpo), --force baixa", async () => {
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const cache = mkdtempSync(join(tmpdir(), "vm-cache-"));
    const work = mkdtempSync(join(tmpdir(), "vm-work-"));
    const brutoA = join(cache, "bruto", "A.mp4").replace(/\\/g, "/");
    writeFileSync(join(state, "source.json"), JSON.stringify({ path: brutoA, fps: 30, durationS: 10, width: 1920, height: 1080, mirrored: false }));
    const reg = JSON.stringify({ edition: ED, id: "A", name: "A.mp4", size: 3, modifiedTime: null, folderId: "pasta-ed", localPath: brutoA });
    writeFileSync(join(state, BRUTO_DRIVE_FILE), reg);
    for (const p of [join(work, "audio.wav"), join(state, "loudness.json"), join(state, "transcript.json")]) writeFileSync(p, "{}");
    const listing = () => json({ files: [{ ...entry("A.mp4", 3), id: "A" }] });
    const ready = fakeDeps([folderList, listing]);
    const got = await fetchBruto({ stateDir: state, edition: ED, workDir: work, force: false }, makeDriveSession(ED, cache, ready.deps, () => "root"));
    assert.equal(got.replace(/\\/g, "/"), brutoA);
    assert.equal(ready.calls.length, 2);
    assert.equal(readFileSync(join(state, BRUTO_DRIVE_FILE), "utf8"), reg, "registro intocado");

    // --force refaz tudo: baixa.
    const forced = fakeDeps([folderList, listing, () => new Response(Buffer.from("abc"), { status: 200, headers: { "content-type": "video/mp4" } })]);
    await fetchBruto({ stateDir: state, edition: ED, workDir: work, force: true }, makeDriveSession(ED, cache, forced.deps, () => "root"));
    assert.equal(readFileSync(brutoA, "utf8"), "abc");
  });

  it("#11653 --from-audio com source.json no áudio: troca para o vídeo sem --force, baixa", async () => {
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const cache = mkdtempSync(join(tmpdir(), "vm-cache-"));
    const audio = join(cache, "bruto", "fala.wav").replace(/\\/g, "/");
    writeFileSync(join(state, "source.json"), JSON.stringify({ path: audio, fps: 0, durationS: 10, width: 0, height: 0, mirrored: false, audioOnly: true }));
    assert.deepEqual(transcribePrecheck({ stateDir: state, force: false }, join(cache, "bruto", "V.mp4"), audio), { action: "fetch" });
    assert.equal(transcribePrecheck({ stateDir: state, force: false }, join(cache, "bruto", "V.mp4")).action, "conflict");
  });

  it("DRIVE_UPLOAD_COMMANDS", () => {
    assert.deepEqual([...DRIVE_UPLOAD_COMMANDS], ["build", "srt", "preview"]);
  });
});

describe("#11639 bruto na lixeira e cache sem procedência", () => {
  it("cache de antes do sidecar, conferido pelo tamanho, ganha o sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-drive-"));
    writeFileSync(join(dir, "b.mp4"), Buffer.alloc(3));
    await ensureCachedFile(fakeDeps([]).deps, { id: "B", name: "b.mp4", size: "3", modifiedTime: "t" }, dir, () => {});
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "b.mp4.drive.json"), "utf8")), { id: "B", size: 3, modifiedTime: "t" });
  });
});
