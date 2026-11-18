/**
 * #13308 / #13334: `/diaria-video-montagem` no 300 em modo LOCAL com raiz
 * explícita (`DIARIA_VIDEO_DRIVE_ROOT=/mnt/hd-sata/diaria-video-cache/local-root`,
 * edição 261117).
 *
 * - #13308: a vinheta do logo só era procurada no caminho do config
 *   (`I:/Meu Drive/...`, o do Neo): V1 a V8 saíram sem ela. Agora ela é
 *   resolvida em `{raiz}/_marca/{nome}` e, faltando lá, baixada da `_marca/` do
 *   Drive para essa pasta.
 * - #13334: build/srt/preview gravavam no disco local e não subiam nada (o modo
 *   API sobe sozinho); as telas H5/H7/H10b/H13d faltaram no Drive. Agora sobem
 *   pela API (com `trechos/` na subpasta), e o build confere se todo arquivo do
 *   XML está no Drive.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DRIVE_ROOT,
  FOLDER_MIME,
  driveRelativePath,
  localDriveUploadFor,
  missingInDrive,
  snapshotDirWithSubdirs,
  toPosix,
  type DriveEntry,
  type MontageDriveDeps,
} from "../scripts/lib/diaria/video-montage-drive.ts";
import {
  DRIVE_UPLOADS_FILE,
  loadVinhetaForLocalRoot,
  main,
  makeDriveSession,
  outDirSubfolder,
  queueUploadIfMissing,
  uploadAll,
  warnXmlFilesMissingInDrive,
} from "../scripts/video-montagem.ts";
import { CREDENTIALS_PATH_TEST_OVERRIDE_ENV } from "../scripts/google-auth.ts";

const ED = "261117";
const NEO_VINHETA = "I:/Meu Drive/diaria-studio-video/_marca/vinheta-logo-diaria.mov";
const config = () => ({ publishing: { video: { vinheta_logo: { path: NEO_VINHETA } } } });
const probeJson = JSON.stringify({ streams: [{ codec_type: "video", width: 1080, height: 1080 }], format: { duration: "1.7" } });

interface FakeFile extends DriveEntry { parent: string; content?: string }

/** Drive em memória: listagem por `'X' in parents` (+ nome, + só pastas), criação de pasta, upload resumable e download. */
function fakeDrive(initial: FakeFile[]): { deps: MontageDriveDeps; files: FakeFile[]; calls: string[] } {
  const files = [...initial];
  const calls: string[] = [];
  const sessions = new Map<string, { id?: string; name?: string; parent?: string }>();
  let n = 0;
  const deps: MontageDriveDeps = {
    async driveFetch(url, init) {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      const u = new URL(url);
      if (u.searchParams.get("alt") === "media") {
        const id = decodeURIComponent(u.pathname.split("/").pop()!);
        return new Response(files.find((x) => x.id === id)?.content ?? "", { headers: { "Content-Type": "video/quicktime" } });
      }
      if (u.searchParams.get("uploadType") === "resumable") {
        const loc = `https://upload.example/s${++n}`;
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; parents?: string[] };
        const existingId = u.pathname.includes("/files/") ? decodeURIComponent(u.pathname.split("/").pop()!) : undefined;
        sessions.set(loc, { id: existingId, name: body.name, parent: body.parents?.[0] });
        return new Response("", { status: 200, headers: { location: loc } });
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string; mimeType: string; parents: string[] };
        const created: FakeFile = { id: `dir-${++n}`, name: body.name, mimeType: body.mimeType, parent: body.parents[0] };
        files.push(created);
        return Response.json(created);
      }
      const q = u.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const foldersOnly = q.includes(`mimeType = '${FOLDER_MIME}'`);
      return Response.json({ files: files.filter((x) => x.parent === parent && (name === undefined || x.name === name) && (!foldersOnly || x.mimeType === FOLDER_MIME)) });
    },
    async uploadFetch(url) {
      calls.push(`PUT ${url}`);
      const s = sessions.get(url)!;
      if (s.id) return Response.json({ id: s.id, name: files.find((x) => x.id === s.id)!.name });
      const created: FakeFile = { id: `f-${++n}`, name: s.name!, mimeType: "application/octet-stream", parent: s.parent! };
      files.push(created);
      return Response.json({ id: created.id, name: created.name, webViewLink: `https://drive/${created.id}` });
    },
  };
  return { deps, files, calls };
}

const folder = (id: string, name: string, parent: string): FakeFile => ({ id, name, mimeType: FOLDER_MIME, parent });
const file = (id: string, name: string, parent: string, content = "x"): FakeFile => ({ id, name, mimeType: "video/quicktime", parent, size: String(content.length), modifiedTime: "2026-11-16T00:00:00Z", content });

describe("#13308 vinheta do logo no modo local com raiz explícita", () => {
  it("acha {raiz}/_marca/{nome} antes do caminho do Neo, e o path do XML é o da raiz (o premiere_root o troca)", async () => {
    const root = "/mnt/hd-sata/diaria-video-cache/local-root";
    const probed: string[] = [];
    const warnings: string[] = [];
    const asset = await loadVinhetaForLocalRoot(root, null, {
      readConfig: config,
      exists: (p) => p === `${root}/_marca/vinheta-logo-diaria.mov`,
      probe: (p) => (probed.push(p), probeJson),
      warn: (m) => warnings.push(m),
    });
    assert.equal(asset?.path, `${root}/_marca/vinheta-logo-diaria.mov`);
    assert.deepEqual(probed, [`${root}/_marca/vinheta-logo-diaria.mov`]);
    assert.deepEqual(warnings, []);
  });

  it("ausente na raiz e no caminho do config: baixa da _marca/ do Drive para {raiz}/_marca/ e mede lá", async () => {
    const root = mkdtempSync(join(tmpdir(), "vm-local-root-"));
    const { deps } = fakeDrive([folder("brand", "_marca", "yt"), file("logo", "vinheta-logo-diaria.mov", "brand", "mov")]);
    const drive = makeDriveSession(ED, join(root, "cache-nao-usado"), deps, () => "yt");
    const probed: string[] = [];
    const asset = await loadVinhetaForLocalRoot(root, drive, {
      readConfig: config,
      // #13537: o caminho do config é o do Neo, onde a vinheta existe de verdade; o teste não pode ler esse disco.
      exists: (p) => p !== NEO_VINHETA && existsSync(p),
      probe: (p) => (probed.push(p), probeJson),
      warn: (m) => { throw new Error(m); },
    });
    const expected = `${toPosix(root)}/_marca/vinheta-logo-diaria.mov`;
    assert.equal(asset?.path, expected);
    assert.equal(asset?.durationS, 1.7);
    assert.equal(readFileSync(expected, "utf8"), "mov");
    assert.deepEqual(probed, [expected]);
    assert.equal(existsSync(join(root, "cache-nao-usado")), false);
  });

  it("sem a vinheta e sem credenciais: aviso que diz onde copiar o MOV, e o caminho do Neo nunca vai ao ffprobe", async () => {
    const warnings: string[] = [];
    const asset = await loadVinhetaForLocalRoot("/mnt/x/local-root", null, {
      readConfig: config,
      exists: () => false,
      probe: () => { throw new Error("não devia medir"); },
      warn: (m) => warnings.push(m),
    });
    assert.equal(asset, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\/mnt\/x\/local-root\/_marca\/vinheta-logo-diaria\.mov/);
    assert.match(warnings[0], /#13308/);
  });

  it("_marca/ ausente no Drive: aviso, sem vinheta, o build segue", async () => {
    const root = mkdtempSync(join(tmpdir(), "vm-local-root-"));
    const { deps } = fakeDrive([]);
    const warnings: string[] = [];
    const asset = await loadVinhetaForLocalRoot(root, makeDriveSession(ED, root, deps, () => "yt"), { readConfig: config, exists: () => false, warn: (m) => warnings.push(m) });
    assert.equal(asset, null);
    assert.match(warnings[0], /0 pastas _marca/);
  });
});

describe("#13334 saídas do modo local sobem para o Drive", () => {
  it("liga só no modo local com raiz explícita fora do I:, credenciais e sem --no-drive-api", () => {
    const base = { mode: "local" as const, explicitRoot: "/mnt/hd-sata/diaria-video-cache/local-root", noDriveApi: false, credentials: true };
    assert.equal(localDriveUploadFor(base).enabled, true);
    assert.equal(localDriveUploadFor({ ...base, explicitRoot: undefined }).enabled, false);
    assert.equal(localDriveUploadFor({ ...base, mode: "api" }).enabled, false);
    assert.equal(localDriveUploadFor({ ...base, noDriveApi: true }).enabled, false);
    assert.equal(localDriveUploadFor({ ...base, credentials: false }).enabled, false);
    // O Neo com a raiz padrão passada explicitamente: o Drive for desktop já sincroniza.
    assert.equal(localDriveUploadFor({ ...base, explicitRoot: DEFAULT_DRIVE_ROOT }).enabled, false);
    assert.equal(localDriveUploadFor({ ...base, explicitRoot: "i:\\Meu Drive\\diaria-studio-video\\" }).enabled, false);
  });

  it("snapshot inclui trechos/ com o prefixo, e outDirSubfolder reconhece só a subpasta direta", () => {
    const out = mkdtempSync(join(tmpdir(), "vm-out-"));
    mkdirSync(join(out, "trechos"));
    writeFileSync(join(out, "a.xml"), "a");
    writeFileSync(join(out, "trechos", "b_q000001-000100.mov"), "b");
    const snap = snapshotDirWithSubdirs(out, ["trechos"], (d) => readdirSync(d));
    assert.deepEqual([...snap.keys()].sort(), ["a.xml", "trechos/b_q000001-000100.mov"]);
    assert.equal(outDirSubfolder(out, join(out, "trechos", "b.mov")), "trechos");
    assert.equal(outDirSubfolder(out, join(out, "a.xml")), null);
    assert.equal(outDirSubfolder(out, join(out, "x", "y", "z.mov")), null);
    assert.equal(outDirSubfolder(out, "/outro/lugar/z.mov"), null);
    assert.equal(outDirSubfolder(undefined, join(out, "trechos", "b.mov")), null);
  });

  it("uploadAll com outDir: o trecho sobe para trechos/ da edição (criada se falta), registrado como trechos/{nome}", async () => {
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const out = mkdtempSync(join(tmpdir(), "vm-out-"));
    mkdirSync(join(out, "trechos"));
    const xml = join(out, "Diaria comentada_Youtube_V1.xml");
    const trecho = join(out, "trechos", "bruto_q000001-000100.mov");
    writeFileSync(xml, "<xmeml/>");
    writeFileSync(trecho, "mov");
    const fake = fakeDrive([folder("ed", ED, "yt")]);
    const r = await uploadAll({ stateDir: state, edition: ED, outDir: out }, makeDriveSession(ED, out, fake.deps, () => "yt"), [xml, trecho]);
    assert.equal(r.error, null);
    const trechosDir = fake.files.find((x) => x.name === "trechos" && x.mimeType === FOLDER_MIME);
    assert.equal(trechosDir?.parent, "ed");
    assert.equal(fake.files.find((x) => x.name === "bruto_q000001-000100.mov")?.parent, trechosDir!.id);
    assert.equal(fake.files.find((x) => x.name === "Diaria comentada_Youtube_V1.xml")?.parent, "ed");
    const reg = JSON.parse(readFileSync(join(state, DRIVE_UPLOADS_FILE), "utf8"));
    assert.ok(reg.files["trechos/bruto_q000001-000100.mov"]);
    assert.ok(reg.files["Diaria comentada_Youtube_V1.xml"]);
    // Reaproveitado no build seguinte: já registrado pela chave da subpasta, não volta à fila.
    assert.equal(queueUploadIfMissing(join(state, DRIVE_UPLOADS_FILE), trecho, "trechos/bruto_q000001-000100.mov"), false);
  });

  it("conferência do XML: lista o que falta no Drive (as telas da 261117) e o que ficou fora da raiz", async () => {
    const root = "/mnt/hd-sata/diaria-video-cache/local-root";
    const fake = fakeDrive([
      folder("ed", ED, "yt"),
      folder("brand", "_marca", "yt"),
      folder("tr", "trechos", "ed"),
      file("b", "bruto.mp4", "ed"),
      file("v", "vinheta-logo-diaria.mov", "brand"),
      file("t1", "bruto_q000001-000100.mov", "tr"),
      file("h3", `${ED} - tela H3.png`, "ed"),
    ]);
    const warnings: string[] = [];
    const missing = await warnXmlFilesMissingInDrive(makeDriveSession(ED, root, fake.deps, () => "yt"), [
      `${root}/${ED}/bruto.mp4`,
      `${root}/_marca/vinheta-logo-diaria.mov`,
      `${root}/${ED}/trechos/bruto_q000001-000100.mov`,
      `${root}/${ED}/${ED} - tela H3.png`,
      `${root}/${ED}/${ED} - tela H5.png`,
      `${root}/${ED}/trechos/bruto_q000200-000300.mov`,
      "I:/Meu Drive/outra/coisa.mov",
    ], root, (m) => warnings.push(m));
    assert.deepEqual(missing, [`${ED}/${ED} - tela H5.png`, `${ED}/trechos/bruto_q000200-000300.mov`]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /fora de .*coisa\.mov/);
    assert.match(warnings[1], /2 arquivo\(s\) do XML ausente\(s\) no Drive/);
  });

  it("missingInDrive: subpasta ausente conta como arquivo ausente, sem quebrar", async () => {
    const fake = fakeDrive([folder("ed", ED, "yt")]);
    assert.deepEqual(await missingInDrive(fake.deps, "yt", [`${ED}/trechos/x.mov`, `_marca/v.mov`]), [`${ED}/trechos/x.mov`, `_marca/v.mov`]);
  });

  it("driveRelativePath: relativo à raiz (Windows ou POSIX), nulo fora dela ou com ..", () => {
    assert.equal(driveRelativePath("/mnt/r/261117/a.xml", "/mnt/r"), "261117/a.xml");
    assert.equal(driveRelativePath("/mnt/r/261117/a.xml", "/mnt/r/"), "261117/a.xml");
    assert.equal(driveRelativePath("I:\\Meu Drive\\v\\_marca\\l.mov", "i:/Meu Drive/v"), "_marca/l.mov");
    assert.equal(driveRelativePath("/mnt/rr/a.xml", "/mnt/r"), null);
    assert.equal(driveRelativePath("/mnt/r/../a.xml", "/mnt/r"), null);
    assert.equal(driveRelativePath("/mnt/r", "/mnt/r"), null);
  });

  it("main: upload no modo local com raiz explícita e credenciais sobe pela API; sem credenciais, recusa dizendo por quê", async () => {
    const root = mkdtempSync(join(tmpdir(), "vm-local-root-"));
    const state = mkdtempSync(join(tmpdir(), "vm-state-"));
    const doc = join(root, "decupagem.md");
    writeFileSync(doc, "# decupagem");
    const creds = join(mkdtempSync(join(tmpdir(), "vm-creds-")), "creds.json");
    const prev = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
    try {
      const fake = fakeDrive([folder("ed", ED, "yt")]);
      const args = ["upload", ED, "--drive-root", root, "--state-dir", state, "--folder-id", "yt", "--file", doc];
      process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = creds; // ainda não existe
      await assert.rejects(main(args, fake.deps), /modo local com raiz explícita e OAuth/);
      writeFileSync(creds, "{}");
      assert.equal(await main(args, fake.deps), 0);
      assert.equal(fake.files.find((x) => x.name === "decupagem.md")?.parent, "ed");
      // --no-drive-api desliga.
      await assert.rejects(main([...args, "--no-drive-api"], fakeDrive([]).deps), /modo local com raiz explícita e OAuth/);
    } finally {
      if (prev === undefined) delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
      else process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = prev;
    }
  });
});
