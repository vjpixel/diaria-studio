/**
 * #13739 / #13740: a montagem da 261119 no Neo com o Wi-Fi ruim (~0,3 MB/s).
 *
 * - #13739: o upload pela API do Drive estourava o teto e recomeçava do zero
 *   (arquivos até 256 MiB num PUT único, a 2 MB/s); a vinheta achada só no
 *   caminho do config (`I:`) fazia o XML abrir offline no Mac, sem erro.
 * - #13740: bruto ainda copiando ou só na nuvem do Drive for desktop pendurava
 *   o `transcribe`/`inventory`; `UNKNOWN … read` em `data/` virava aviso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CHUNK_RETRIES,
  chunkRetryDelayMs,
  chunkTimeoutMs,
  uploadToFolder,
  type MontageDriveDeps,
} from "../scripts/lib/diaria/video-montage-drive.ts";
import { copyMarcaIntoRoot, loadVinhetaForLocalRoot } from "../scripts/video-montagem.ts";
import {
  BRUTO_MIN_RATE_ENV,
  BRUTO_READER_SCRIPT,
  BRUTO_READ_MIN_BYTES_PER_SEC,
  BrutoNotLocalError,
  WIN_ATTR_RECALL_ON_DATA_ACCESS,
  assertBrutosLocal,
  checkBrutosLocal,
  cloudOnlyAttributes,
  minReadBytesPerSec,
  readWindowsAttributes,
  timedReadBrutos,
  type BrutoLocalDeps,
  type TimedReadOutcome,
} from "../scripts/lib/diaria/video-bruto-local.ts";
import { localBrutoProbe } from "../scripts/check-video-env.ts";
import { SyncReadError, isSyncIoError, readTextOrSyncError } from "../scripts/lib/diaria/sync-read-error.ts";
import { ROTEIRO_FALAS_FILE, readRoteiroBrutoForTest } from "../scripts/lib/diaria/roteiro-videos.ts";
import { main as roteiroBlocosMain } from "../scripts/video-roteiro-blocos.ts";

const ioError = (code: string) => Object.assign(new Error(`${code}: unknown error, read`), { code });

function sparseFile(size: number): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "drive-lento-"));
  const path = join(dir, "trecho.mp4");
  const fd = openSync(path, "w");
  ftruncateSync(fd, size);
  closeSync(fd);
  return { dir, path };
}

/** Drive resumable falso: guarda o quanto recebeu por sessão e deixa o teste derrubar PUTs. */
function fakeResumable(size: number, failPut: (n: number, range: string) => "network" | "404" | "503" | null) {
  let sessions = 0;
  let puts = 0;
  const received = new Map<string, number>();
  const ranges: string[] = [];
  const done = () => Response.json({ id: "ok", name: "trecho.mp4" });
  const deps: MontageDriveDeps = {
    async driveFetch(_url, init) {
      if (!init?.method) return Response.json({ files: [] });
      const loc = `https://upload/s${++sessions}`;
      received.set(loc, 0);
      return new Response(null, { headers: { location: loc } });
    },
    async uploadFetch(url, init) {
      const range = (init!.headers as Record<string, string>)["Content-Range"];
      ranges.push(range ?? "(sem Content-Range)");
      const fail = failPut(++puts, range ?? "");
      if (fail === "network") throw new Error("socket hang up");
      if (fail === "404") return new Response("sessão expirada", { status: 404 });
      if (fail === "503") return new Response("indisponível", { status: 503 });
      const got = received.get(url) ?? 0;
      if (range === `bytes */${size}`) {
        if (got === size) return done();
        return new Response(null, { status: 308, headers: got ? { Range: `bytes=0-${got - 1}` } : {} });
      }
      const body = init!.body as Buffer;
      const now = got + body.length;
      received.set(url, now);
      return now === size ? done() : new Response(null, { status: 308, headers: { Range: `bytes=0-${now - 1}` } });
    },
  };
  return { deps, ranges, received, get sessions() { return sessions; } };
}

const noSleep = { backoffMs: 0, sleep: async () => {} };

describe("#13739 upload retomável em rede lenta", () => {
  it("acima de um bloco (8 MiB) já vai em blocos: o trecho de ~107 MB não sobe mais num PUT único", () => {
    assert.ok(UPLOAD_CHUNK_BYTES < 107e6);
  });

  it("teto do bloco: piso de 2 min, e o dobro do tempo na banda medida quando ela é lenta", () => {
    assert.equal(chunkTimeoutMs(UPLOAD_CHUNK_BYTES, null), 120_000);
    // 0,3 MB/s: 8 MiB em ~28 s, o dobro ainda cabe no piso.
    assert.equal(chunkTimeoutMs(UPLOAD_CHUNK_BYTES, 300_000), 120_000);
    // 0,05 MB/s: ~168 s por bloco; o teto sobe para ~336 s em vez de abortar aos 120 s.
    assert.equal(chunkTimeoutMs(UPLOAD_CHUNK_BYTES, 50_000), Math.ceil(((2 * UPLOAD_CHUNK_BYTES) / 50_000) * 1000));
    assert.equal(chunkTimeoutMs(UPLOAD_CHUNK_BYTES, 0), 120_000);
    assert.equal(chunkTimeoutMs(UPLOAD_CHUNK_BYTES, Number.NaN), 120_000);
  });

  it("espera entre repetições do bloco cresce até 30 s", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => chunkRetryDelayMs(n)), [1000, 2000, 4000, 8000]);
    assert.equal(chunkRetryDelayMs(20), 30_000);
  });

  it("arquivo de 9 MiB vai em blocos com Content-Range (antes: PUT único sem Range)", async () => {
    const size = UPLOAD_CHUNK_BYTES + 1024 * 1024;
    const { dir, path } = sparseFile(size);
    try {
      const d = fakeResumable(size, () => null);
      const r = await uploadToFolder(d.deps, "pasta", path, () => {}, noSleep);
      assert.equal(r.id, "ok");
      assert.deepEqual(d.ranges, [`bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`, `bytes ${UPLOAD_CHUNK_BYTES}-${size - 1}/${size}`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rede caindo além das repetições do bloco: a tentativa seguinte retoma a MESMA sessão de onde o Drive confirmou, sem reenviar o 1º bloco", async () => {
    const size = 3 * UPLOAD_CHUNK_BYTES;
    const { dir, path } = sparseFile(size);
    try {
      // O 1º bloco passa; os PUTs seguintes caem UPLOAD_CHUNK_RETRIES vezes seguidas (esgota a tentativa 1).
      const d = fakeResumable(size, (n) => (n >= 2 && n < 2 + UPLOAD_CHUNK_RETRIES ? "network" : null));
      const lines: string[] = [];
      const r = await uploadToFolder(d.deps, "pasta", path, (l) => lines.push(l), noSleep);
      assert.equal(r.id, "ok");
      assert.equal(d.sessions, 1, "sessão única: nada recomeça do zero");
      assert.equal(d.received.get("https://upload/s1"), size);
      const sentFirst = d.ranges.filter((x) => x === `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`).length;
      assert.equal(sentFirst, 1, "o 1º bloco sobe uma vez só");
      assert.ok(lines.some((l) => /retoma a mesma sessão/.test(l)), lines.join("\n"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("sessão expirada (404) na retomada: abre sessão nova em vez de insistir", async () => {
    const size = 2 * UPLOAD_CHUNK_BYTES;
    const { dir, path } = sparseFile(size);
    try {
      const d = fakeResumable(size, (n) => (n === 1 ? "404" : null));
      const r = await uploadToFolder(d.deps, "pasta", path, () => {}, noSleep);
      assert.equal(r.id, "ok");
      assert.equal(d.sessions, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // #13790: a consulta da retomada zerava `failures` a cada volta enquanto nenhum bloco desse certo.
  // Rede de ~0,05 MB/s: o PUT do bloco 0 sempre estoura e a consulta responde 308 sem Range.
  for (const kind of ["network", "503"] as const) {
    it(`bloco 0 sempre falhando (${kind}) com a consulta em 308 sem Range: desiste depois de UPLOAD_CHUNK_RETRIES falhas por tentativa, sem loop`, async () => {
      const size = 2 * UPLOAD_CHUNK_BYTES;
      const { dir, path } = sparseFile(size);
      // Trava de segurança: se o loop voltar, o fake "aceita" o arquivo e o teste falha no rejects (em vez de pendurar).
      const CAP = 500;
      try {
        const d = fakeResumable(size, (_n, range) => (range === `bytes */${size}` ? null : kind));
        const originalFetch = d.deps.uploadFetch!;
        let calls = 0;
        d.deps.uploadFetch = async (url, init) => {
          if (++calls > CAP) return Response.json({ id: "loop", name: "trecho.mp4" });
          return originalFetch(url, init);
        };
        await assert.rejects(uploadToFolder(d.deps, "pasta", path, () => {}, noSleep), /falhou 3 vezes/);
        assert.equal(d.sessions, 1, "a sessão segue a mesma nas 3 tentativas");
        const blockPuts = d.ranges.filter((x) => x === `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`).length;
        assert.ok(blockPuts <= 3 * UPLOAD_CHUNK_RETRIES, `PUTs do bloco 0: ${blockPuts} (teto ${3 * UPLOAD_CHUNK_RETRIES})`);
        assert.ok(calls < CAP, `chamadas: ${calls}`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it("arquivo pequeno (≤ 8 MiB) segue no PUT único", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-lento-"));
    const path = join(dir, "x.srt");
    writeFileSync(path, "1\n00:00:00,000 --> 00:00:01,000\noi\n");
    try {
      const d = fakeResumable(0, () => null);
      const heads: Array<Record<string, string>> = [];
      const deps: MontageDriveDeps = { ...d.deps, async uploadFetch(_u, init) { heads.push(init!.headers as Record<string, string>); return Response.json({ id: "srt" }); } };
      assert.equal((await uploadToFolder(deps, "pasta", path)).id, "srt");
      assert.equal(heads.length, 1);
      assert.equal(heads[0]["Content-Range"], undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("#13739 vinheta só no caminho do config (I:) com raiz explícita", () => {
  const NEO = "I:/Meu Drive/diaria-studio-video/_marca/vinheta-logo-diaria.mov";
  const config = () => ({ publishing: { video: { vinheta_logo: { path: NEO } } } });
  const probeJson = JSON.stringify({ streams: [{ codec_type: "video", width: 1080, height: 1080 }], format: { duration: "1.7" } });

  it("copia para {raiz}/_marca/ e o XML aponta para a raiz (o premiere_root a troca no Mac), não para o I:", async () => {
    const root = "C:/diaria-video-local";
    const copies: Array<[string, string]> = [];
    const probed: string[] = [];
    const asset = await loadVinhetaForLocalRoot(root, null, {
      readConfig: config,
      exists: (p) => p === NEO,
      probe: (p) => (probed.push(p), probeJson),
      warn: (m) => assert.fail(`sem aviso: ${m}`),
      mkdir: () => {},
      copy: (a, b) => { copies.push([a, b]); },
    });
    assert.equal(asset?.path, `${root}/_marca/vinheta-logo-diaria.mov`);
    assert.deepEqual(copies, [[NEO, `${root}/_marca/vinheta-logo-diaria.mov`]]);
    assert.deepEqual(probed, [`${root}/_marca/vinheta-logo-diaria.mov`]);
  });

  it("cópia falha: [aviso] explícito de que o XML aponta para fora da raiz, em vez de cair no I: em silêncio", async () => {
    const warnings: string[] = [];
    const asset = await loadVinhetaForLocalRoot("C:/diaria-video-local", null, {
      readConfig: config,
      exists: (p) => p === NEO,
      probe: () => probeJson,
      warn: (m) => warnings.push(m),
      mkdir: () => {},
      copy: () => { throw new Error("ENOSPC"); },
    });
    assert.equal(asset?.path, NEO);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /fora da raiz C:\/diaria-video-local/);
    assert.match(warnings[0], /offline/);
    assert.match(warnings[0], /ENOSPC/);
  });

  it("copyMarcaIntoRoot copia de verdade num diretório temporário", () => {
    const dir = mkdtempSync(join(tmpdir(), "marca-"));
    try {
      const src = join(dir, "src.mov");
      writeFileSync(src, "mov");
      assert.equal(copyMarcaIntoRoot(src, join(dir, "raiz", "_marca", "src.mov")), null);
      assert.equal(copyMarcaIntoRoot(join(dir, "nao-existe.mov"), join(dir, "raiz", "_marca", "x.mov"))?.includes("ENOENT"), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** Deps falsas: tamanhos por leitura (1ª e 2ª), atributos opcionais. */
function fakeLocal(sizes: Record<string, [number, number]>, opts: { platform?: NodeJS.Platform; attrs?: Record<string, number> | null } = {}): BrutoLocalDeps & { sleeps: number[] } {
  const reads = new Map<string, number>();
  const sleeps: number[] = [];
  return {
    platform: opts.platform ?? "linux",
    size(p) {
      const s = sizes[p];
      if (!s) throw ioError("EIO");
      const i = reads.get(p) ?? 0;
      reads.set(p, i + 1);
      return s[Math.min(i, 1)];
    },
    sleep: (ms) => { sleeps.push(ms); },
    windowsAttributes: () => (opts.attrs === null ? null : new Map(Object.entries(opts.attrs ?? {}))),
    sleeps,
  };
}

describe("#13740 bruto inteiro e local antes de ler", () => {
  it("atributos de nuvem do Windows (OFFLINE, RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS)", () => {
    assert.equal(cloudOnlyAttributes(0x20), false); // ARCHIVE
    assert.equal(cloudOnlyAttributes(0x1000), true);
    assert.equal(cloudOnlyAttributes(0x40000), true);
    assert.equal(cloudOnlyAttributes(WIN_ATTR_RECALL_ON_DATA_ACCESS | 0x20), true);
    assert.equal(cloudOnlyAttributes(-1), false);
  });

  it("o cenário da 261119: 1 de 7 só na nuvem e outro ainda copiando param o comando nomeando os dois", () => {
    const dir = "I:/Meu Drive/diaria-studio-video/261119";
    const names = ["20261118_163332.mp4", "20261118_150000.mp4", "20261118_151000.mp4"];
    const paths = names.map((n) => `${dir}/${n}`);
    const deps = fakeLocal(
      { [paths[0]]: [9.57e9, 9.57e9], [paths[1]]: [1e9, 1.4e9], [paths[2]]: [2e9, 2e9] },
      { platform: "win32", attrs: { [paths[0]]: WIN_ATTR_RECALL_ON_DATA_ACCESS | 0x20, [paths[1]]: 0x20, [paths[2]]: 0x20 } },
    );
    assert.throws(() => assertBrutosLocal("transcribe", paths, deps, { settleMs: 10 }), (e: unknown) => {
      assert.ok(e instanceof BrutoNotLocalError);
      assert.deepEqual(e.problems.map((p) => [p.path, p.reason]), [[paths[0], "nuvem"], [paths[1], "crescendo"]]);
      assert.match(e.message, /2 brutos não estão inteiros e locais/);
      assert.match(e.message, /20261118_163332\.mp4: só na nuvem/);
      assert.match(e.message, /20261118_150000\.mp4: tamanho mudando/);
      assert.doesNotMatch(e.message, /20261118_151000/);
      assert.match(e.message, /Disponibilizar off-line/);
      return true;
    });
    assert.deepEqual(deps.sleeps, [10], "uma espera só para todos os arquivos");
  });

  it("todos inteiros e locais: passa, sem mensagem", () => {
    const deps = fakeLocal({ "/r/a.mp4": [5, 5], "/r/b.mp4": [7, 7] });
    assert.deepEqual(assertBrutosLocal("inventory", ["/r/a.mp4", "/r/b.mp4"], deps, { settleMs: 1 }).problems, []);
  });

  it("0 bytes e metadado ilegível também param", () => {
    const deps = fakeLocal({ "/r/a.mp4": [0, 0] });
    const c = checkBrutosLocal(["/r/a.mp4", "/r/sumiu.mp4"], deps, { settleMs: 1 });
    assert.deepEqual(c.problems.map((p) => p.reason), ["vazio", "ilegivel"]);
  });

  it("Windows sem o atributo lido (PowerShell falhou): confere só o tamanho e diz isso", () => {
    const deps = fakeLocal({ "/r/a.mp4": [5, 6] }, { platform: "win32", attrs: null });
    const c = checkBrutosLocal(["/r/a.mp4"], deps, { settleMs: 1 });
    assert.equal(c.attributesUnread, true);
    assert.throws(() => assertBrutosLocal("transcribe", ["/r/a.mp4"], fakeLocal({ "/r/a.mp4": [5, 6] }, { platform: "win32", attrs: null }), { settleMs: 1 }), /atributo de nuvem do Windows não lido/);
  });

  it("fora do Windows os atributos nem são consultados", () => {
    let asked = false;
    const deps = { ...fakeLocal({ "/r/a.mp4": [5, 5] }), windowsAttributes: () => { asked = true; return new Map(); } };
    checkBrutosLocal(["/r/a.mp4"], deps, { settleMs: 1 });
    assert.equal(asked, false);
  });

  it("readWindowsAttributes: caminhos por variável de ambiente, uma linha por arquivo; falha do PowerShell = null", () => {
    let env: NodeJS.ProcessEnv | undefined;
    const ok = ((_cmd: string, _args: string[], o: { env?: NodeJS.ProcessEnv }) => { env = o.env; return { status: 0, stdout: "32\r\n4194336\r\n-1\r\n" }; }) as unknown as typeof import("node:child_process").spawnSync;
    const m = readWindowsAttributes(["C:/a b.mp4", "I:/x'y.mp4", "I:/z.mp4"], ok)!;
    assert.deepEqual(JSON.parse(env!.DIARIA_BRUTO_PATHS!), ["C:/a b.mp4", "I:/x'y.mp4", "I:/z.mp4"]);
    assert.equal(m.get("C:/a b.mp4"), 32);
    assert.equal(m.get("I:/x'y.mp4"), 4194336);
    assert.equal(m.has("I:/z.mp4"), false);
    const fail = (() => ({ status: 1, stdout: "" })) as unknown as typeof import("node:child_process").spawnSync;
    assert.equal(readWindowsAttributes(["C:/a.mp4"], fail), null);
  });

  it("check-video-env --montagem: o bruto da pasta da edição ainda copiando reprova o Passo 0 com o nome", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-261119-"));
    try {
      writeFileSync(join(dir, "20261118_163332.mp4"), "x");
      writeFileSync(join(dir, "261119 - previa.mp4"), "x");
      const p = `${dir.replace(/\\/g, "/")}/20261118_163332.mp4`;
      const bad = localBrutoProbe(dir, fakeLocal({ [p]: [1, 2] }), { settleMs: 1 });
      assert.equal(bad.ok, false);
      assert.match(bad.detail ?? "", /20261118_163332\.mp4: tamanho mudando/);
      assert.doesNotMatch(bad.detail ?? "", /previa/);
      assert.ok(bad.fix);
      const good = localBrutoProbe(dir, fakeLocal({ [p]: [2, 2] }), { settleMs: 1 });
      assert.equal(good.ok, true);
      assert.equal(localBrutoProbe(mkdtempSync(join(tmpdir(), "ed-vazia-"))).ok, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("#13740 leitura cronometrada: o Drive for desktop não expõe atributo de nuvem", () => {
  // Investigação no Neo (27/11): os brutos em `I:\Meu Drive` saem todos 0x80, baixados ou não.
  const withReads = (base: BrutoLocalDeps, outcomes: Record<string, TimedReadOutcome> | null, asked: string[][] = []): BrutoLocalDeps => ({
    ...base,
    timedRead: (paths, _t) => { asked.push([...paths]); return outcomes === null ? null : new Map(Object.entries(outcomes)); },
  });

  it("o cenário real: atributo 0x80 e tamanho estável, mas a leitura não termina no prazo, para nomeando o arquivo", () => {
    const dir = "I:/Meu Drive/diaria-studio-video/261119";
    const lento = `${dir}/20261118_163332.mp4`;
    const baixado = `${dir}/20261118_151000.mp4`;
    const deps = withReads(
      fakeLocal({ [lento]: [9.57e9, 9.57e9], [baixado]: [2e9, 2e9] }, { platform: "win32", attrs: { [lento]: 0x80, [baixado]: 0x80 } }),
      { [lento]: "timeout", [baixado]: "ok" },
    );
    assert.throws(() => assertBrutosLocal("inventory", [lento, baixado], deps, { settleMs: 1, readTimeoutMs: 15_000 }), (e: unknown) => {
      assert.ok(e instanceof BrutoNotLocalError);
      assert.deepEqual(e.problems.map((p) => [p.path, p.reason]), [[lento, "lento"]]);
      assert.match(e.message, /20261118_163332\.mp4: ler 8 trechos do início ao fim não terminou em 15 s/);
      assert.match(e.message, /Drive for desktop ainda está baixando/);
      assert.doesNotMatch(e.message, /20261118_151000/);
      return true;
    });
  });

  it("só lê o que passou no metadado (o que já parou por tamanho não é lido de novo)", () => {
    const asked: string[][] = [];
    const deps = withReads(fakeLocal({ "/r/a.mp4": [5, 6], "/r/b.mp4": [7, 7], "/r/c.mp4": [0, 0] }), { "/r/b.mp4": "ok" }, asked);
    const c = checkBrutosLocal(["/r/a.mp4", "/r/b.mp4", "/r/c.mp4"], deps, { settleMs: 1 });
    assert.deepEqual(asked, [["/r/b.mp4"]]);
    assert.deepEqual(c.problems.map((p) => p.reason), ["crescendo", "vazio"]);
  });

  it("erro na leitura para; sonda que falhou por si não bloqueia e a mensagem diz que o conteúdo não foi conferido", () => {
    const err = checkBrutosLocal(["/r/a.mp4"], withReads(fakeLocal({ "/r/a.mp4": [5, 5] }), { "/r/a.mp4": "erro" }), { settleMs: 1 });
    assert.deepEqual(err.problems.map((p) => p.reason), ["ilegivel"]);
    const off = checkBrutosLocal(["/r/a.mp4"], withReads(fakeLocal({ "/r/a.mp4": [5, 5] }), null), { settleMs: 1 });
    assert.deepEqual(off.problems, []);
    assert.equal(off.readUnchecked, true);
    assert.throws(
      () => assertBrutosLocal("transcribe", ["/r/a.mp4", "/r/b.mp4"], withReads(fakeLocal({ "/r/a.mp4": [5, 5], "/r/b.mp4": [1, 2] }), null), { settleMs: 1 }),
      /a leitura cronometrada não rodou/,
    );
  });

  it("timedReadBrutos de verdade: lê o início e o fim de um arquivo local e marca o ausente como erro", () => {
    const dir = mkdtempSync(join(tmpdir(), "bruto-leitura-"));
    try {
      const p = join(dir, "bruto.mp4");
      writeFileSync(p, Buffer.alloc(3 * 1024 * 1024, 1));
      const r = timedReadBrutos([p, join(dir, "sumiu.mp4")], 10_000)!;
      assert.equal(r.get(p), "ok");
      assert.equal(r.get(join(dir, "sumiu.mp4")), "erro");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("timedReadBrutos com leitura lenta simulada: devolve timeout no prazo, sem esperar o leitor preso", () => {
    // Leitor que pendura 20 s no arquivo "lento" (a leitura pela nuvem) e lê na hora o outro.
    const reader = ["-e", "if (process.argv[1].includes('lento')) setTimeout(() => {}, 20000); else process.exit(0);"];
    const t0 = Date.now();
    const r = timedReadBrutos(["/r/lento.mp4", "/r/local.mp4"], 600, { reader })!;
    const elapsed = Date.now() - t0;
    assert.equal(r.get("/r/lento.mp4"), "timeout");
    assert.equal(r.get("/r/local.mp4"), "ok");
    assert.ok(elapsed < 8000, `voltou em ${elapsed} ms, não esperou os 20 s do leitor preso`);
  });

  it("timedReadBrutos: processo filho que falha ou saída ilegível = null (não bloqueia)", () => {
    const fail = (() => ({ status: 1, stdout: "" })) as unknown as typeof import("node:child_process").spawnSync;
    assert.equal(timedReadBrutos(["/r/a.mp4"], 100, { run: fail }), null);
    const lixo = (() => ({ status: 0, stdout: "não é json" })) as unknown as typeof import("node:child_process").spawnSync;
    assert.equal(timedReadBrutos(["/r/a.mp4"], 100, { run: lixo }), null);
    assert.deepEqual(timedReadBrutos([], 100), new Map());
  });
});

describe("#14405 vazão da sonda: o Drive serve leitura parcial rápida de um bruto só na nuvem", () => {
  const withReads = (base: BrutoLocalDeps, outcomes: Record<string, TimedReadOutcome>): BrutoLocalDeps => ({
    ...base,
    timedRead: () => new Map(Object.entries(outcomes)),
  });

  it("o cenário da issue: bruto de 9 GB só na nuvem lido dentro do prazo, mas abaixo do piso de vazão, para nomeando o arquivo", () => {
    const nuvem = "I:/Meu Drive/diaria-studio-video/261119/20261118_163332.mp4";
    const local = "I:/Meu Drive/diaria-studio-video/261119/20261118_151000.mp4";
    const deps = withReads(
      fakeLocal({ [nuvem]: [9.57e9, 9.57e9], [local]: [2e9, 2e9] }, { platform: "win32", attrs: { [nuvem]: 0x80, [local]: 0x80 } }),
      { [nuvem]: "devagar", [local]: "ok" },
    );
    assert.throws(() => assertBrutosLocal("transcribe", [nuvem, local], deps, { settleMs: 1 }), (e: unknown) => {
      assert.ok(e instanceof BrutoNotLocalError);
      assert.deepEqual(e.problems.map((p) => [p.path, p.reason]), [[nuvem, "lento"]]);
      assert.match(e.message, /20261118_163332\.mp4: a leitura de 8 trechos espalhados pelo arquivo ficou abaixo do piso de vazão/);
      assert.match(e.message, new RegExp(BRUTO_MIN_RATE_ENV));
      assert.doesNotMatch(e.message, /20261118_151000/);
      return true;
    });
  });

  it("o leitor de verdade: leitura que termina rápido mas abaixo do piso sai 'devagar' (antes da #14405: 'ok')", () => {
    const dir = mkdtempSync(join(tmpdir(), "bruto-vazao-"));
    try {
      const p = join(dir, "bruto.mp4");
      writeFileSync(p, Buffer.alloc(2 * 1024 * 1024, 1));
      // Piso impossível para qualquer disco: o arquivo responde em milissegundos, como o trecho que o Drive serve sob demanda.
      const t0 = Date.now();
      const r = timedReadBrutos([p], 10_000, { probeBytes: 256 * 1024, minBytesPerSec: 1e15, minRateBytes: 1024 })!;
      assert.equal(r.get(p), "devagar");
      assert.ok(Date.now() - t0 < 8000, "a vazão é julgada sem esperar o prazo");
      // O mesmo arquivo com o piso desligado (0) ou acima do piso real: ok.
      assert.equal(timedReadBrutos([p], 10_000, { probeBytes: 256 * 1024, minBytesPerSec: 0, minRateBytes: 1024 })!.get(p), "ok");
      assert.equal(timedReadBrutos([p], 10_000, { probeBytes: 256 * 1024, minBytesPerSec: 1, minRateBytes: 1024 })!.get(p), "ok");
      // Arquivo menor que o mínimo para julgar a vazão: só o prazo vale.
      assert.equal(timedReadBrutos([p], 10_000, { probeBytes: 256 * 1024, minBytesPerSec: 1e15 })!.get(p), "ok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("o leitor lê trechos espalhados pelo arquivo inteiro, não só o início e o fim", () => {
    // Leitor espião: o script real, com readSync embrulhado para gravar as posições lidas num arquivo.
    const dir = mkdtempSync(join(tmpdir(), "bruto-trechos-"));
    try {
      const p = join(dir, "bruto.mp4");
      const log = join(dir, "pos.json");
      writeFileSync(p, Buffer.alloc(1000 * 1024, 1));
      const spy = [
        // O script real declara `fs`; o espião usa outro nome para o mesmo módulo.
        "const spyFs = require('node:fs'); const orig = spyFs.readSync; const pos = [];",
        "spyFs.readSync = (...a) => { pos.push(a[4]); return orig(...a); };",
        `const exit = process.exit; process.exit = (c) => { spyFs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(pos)); exit(c); };`,
        BRUTO_READER_SCRIPT,
      ].join("\n");
      assert.equal(timedReadBrutos([p], 10_000, { reader: ["-e", spy], probeBytes: 100 * 1024, probeChunks: 8, minBytesPerSec: 0 })!.get(p), "ok");
      const pos = JSON.parse(readFileSync(log, "utf8")) as number[];
      const span = 1000 * 1024 - 100 * 1024;
      assert.deepEqual(pos, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => Math.floor((span * i) / 7)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("um bruto por vez, cada um com o próprio prazo: o preso não leva os outros junto", () => {
    const reader = ["-e", "if (process.argv[1].includes('preso')) setTimeout(() => {}, 20000); else process.exit(0);"];
    const r = timedReadBrutos(["/r/a.mp4", "/r/preso.mp4", "/r/b.mp4"], 500, { reader })!;
    assert.deepEqual([...r.entries()], [["/r/a.mp4", "ok"], ["/r/preso.mp4", "timeout"], ["/r/b.mp4", "ok"]]);
  });

  it("piso pelo ambiente: MB/s, vírgula aceita, 0 desliga, valor inválido volta ao default", () => {
    assert.equal(minReadBytesPerSec({}), BRUTO_READ_MIN_BYTES_PER_SEC);
    assert.equal(minReadBytesPerSec({ [BRUTO_MIN_RATE_ENV]: "5" }), 5 * 1024 * 1024);
    assert.equal(minReadBytesPerSec({ [BRUTO_MIN_RATE_ENV]: "2,5" }), Math.round(2.5 * 1024 * 1024));
    assert.equal(minReadBytesPerSec({ [BRUTO_MIN_RATE_ENV]: "0" }), 0);
    assert.equal(minReadBytesPerSec({ [BRUTO_MIN_RATE_ENV]: "-3" }), BRUTO_READ_MIN_BYTES_PER_SEC);
    assert.equal(minReadBytesPerSec({ [BRUTO_MIN_RATE_ENV]: "abc" }), BRUTO_READ_MIN_BYTES_PER_SEC);
  });
});

describe("#13740 leitura de JSON em data/ com UNKNOWN … read vira erro acionável", () => {
  it("UNKNOWN/EIO/EBUSY são de I/O; ENOENT e SyntaxError não", () => {
    assert.equal(isSyncIoError(ioError("UNKNOWN")), true);
    assert.equal(isSyncIoError(ioError("EIO")), true);
    assert.equal(isSyncIoError(ioError("EBUSY")), true);
    assert.equal(isSyncIoError(ioError("ENOENT")), false);
    assert.equal(isSyncIoError(new SyntaxError("Unexpected token")), false);
  });

  it("readTextOrSyncError: erro de I/O sai SyncReadError com a correção; os demais passam como estão", () => {
    assert.throws(() => readTextOrSyncError("/data/x.json", () => { throw ioError("UNKNOWN"); }), (e: unknown) => {
      assert.ok(e instanceof SyncReadError);
      assert.match(e.message, /Drive for desktop sincronizando/);
      assert.match(e.message, /\/data\/x\.json/);
      return true;
    });
    assert.throws(() => readTextOrSyncError("/data/x.json", () => { throw ioError("ENOENT"); }), (e: unknown) => !(e instanceof SyncReadError));
  });

  it("roteiro-falas.json: falha de I/O para (antes: [aviso] e seguia sem o roteiro); JSON inválido segue ilegível", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-io-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), "{");
      assert.throws(() => readRoteiroBrutoForTest(dir, () => { throw ioError("UNKNOWN"); }), SyncReadError);
      assert.equal(readRoteiroBrutoForTest(dir).estado, "ilegivel");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("video-roteiro-blocos: UNKNOWN … read sai [erro] com o que fazer, nunca o 'não li' cru", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-blocos-io-"));
    try {
      const falas = join(dir, "roteiro-falas.json");
      writeFileSync(falas, "{}");
      const err: string[] = [];
      const code = roteiroBlocosMain(["261119", "--falas", falas], { out: () => {}, err: (s) => err.push(s) }, dir, () => { throw ioError("UNKNOWN"); });
      assert.equal(code, 2);
      assert.equal(err.length, 1);
      assert.match(err[0], /^\[erro\]/);
      assert.match(err[0], /Drive for desktop/);
      assert.doesNotMatch(err[0], /não li/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
