/**
 * #13628: o limiar do XML leve e a espera da nuvem (#13493) testados pelo
 * `main()` inteiro do `video-montagem build`, não por trechos do código-fonte.
 * Bruto sintético de 12 s (ffmpeg), Drive em memória, e o build num modo local
 * cuja raiz faz o papel do Drive for desktop do Neo (`desktopRoot`): sem upload
 * pela API, e com a conferência dos trechos na nuvem no fim, como no I:.
 *
 * O limiar é o do `platform.config.json` (2 GB desde o #13629); só o TAMANHO do
 * bruto é simulado (`brutoStat`), já que o arquivo sintético tem poucos KB e os
 * trechos precisam de um vídeo real para o ffmpeg cortar.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CREDENTIALS_PATH_TEST_OVERRIDE_ENV } from "../scripts/google-auth.ts";
import { FOLDER_MIME, type MontageDriveDeps } from "../scripts/lib/diaria/video-montage-drive.ts";
import { TRECHOS, xmlLeveLimiarFrom } from "../scripts/lib/diaria/video-xml-trechos.ts";
import { main, type MontageMainSeams } from "../scripts/video-montagem.ts";

const ED = "991231";
const GIB = 1024 ** 3;
const XML_NAME = "Diaria comentada_Youtube_V1.xml";
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** O que a pasta `trechos/` da edição mostra no Drive a cada listagem (n = 0, 1, ...), dado o que está no disco. */
type CloudView = (n: number, local: { name: string; size: number }[]) => { name: string; size: number }[];

/** Drive em memória só de leitura: a pasta da edição sob a raiz `yt`, a subpasta `trechos/` e o que `view` mostra nela. */
function fakeCloud(trechosDir: string, view: CloudView): { deps: MontageDriveDeps; listings: () => number } {
  let n = 0;
  const deps: MontageDriveDeps = {
    async driveFetch(url, init) {
      if ((init?.method ?? "GET") !== "GET") throw new Error(`Drive falso é só leitura: ${init?.method} ${url}`);
      const q = new URL(url).searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const folders = q.includes(`mimeType = '${FOLDER_MIME}'`);
      const files = (() => {
        if (parent === "yt" && folders && name === ED) return [{ id: "ed", name: ED, mimeType: FOLDER_MIME }];
        if (parent === "ed" && folders && name === TRECHOS.dirName) return [{ id: "tr", name: TRECHOS.dirName, mimeType: FOLDER_MIME }];
        if (parent === "tr") {
          const local = readdirSync(trechosDir).map((x) => ({ name: x, size: statSync(join(trechosDir, x)).size }));
          return view(n++, local).map((x, i) => ({ id: `t${i}`, name: x.name, mimeType: "video/quicktime", size: String(x.size) }));
        }
        return [];
      })();
      return Response.json({ files });
    },
    async uploadFetch(url) {
      throw new Error(`o build no Drive for desktop não sobe nada pela API: ${url}`);
    },
  };
  return { deps, listings: () => n };
}

interface Run {
  code: number;
  log: string;
  out: string;
  listings: number;
  waitedMs: number;
}

/** O bruto sintético + o estado mínimo do `build` (source, transcript, silences, blocks) numa raiz temporária. */
async function runBuild(brutoGiB: number, view: CloudView, extra: string[] = []): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), "vm-13628-"));
  const state = join(root, "state");
  const work = join(root, "work");
  const out = join(root, ED);
  for (const d of [state, work, out]) mkdirSync(d, { recursive: true });
  const bruto = join(out, "bruto.mp4");
  const gen = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=12", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", bruto]);
  assert.equal(gen.status, 0, String(gen.stderr));
  writeFileSync(join(state, "source.json"), JSON.stringify({ path: bruto, fps: 30, durationS: 12, width: 320, height: 240, mirrored: false }));
  writeFileSync(join(state, "silences.json"), JSON.stringify([{ start: 0, end: 1 }, { start: 5, end: 6 }, { start: 11, end: 12 }]));
  const words = [
    { text: "olá", start: 1.2, end: 1.6 },
    { text: "mundo", start: 1.7, end: 2.2 },
    { text: "isso", start: 6.2, end: 6.6 },
    { text: "funciona", start: 6.7, end: 7.4 },
  ];
  writeFileSync(join(state, "transcript.json"), JSON.stringify({ segments: [{ start: 1, end: 8, text: "olá mundo isso funciona", words }] }));
  writeFileSync(join(state, "blocks.json"), JSON.stringify({
    edition: ED,
    ctaCard: false,
    sequences: [{ target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [100, 110] }],
    blocks: { comentario: [{ start: 1, end: 3 }, { start: 6, end: 8 }] },
  }));
  const creds = join(root, "credentials.json");
  writeFileSync(creds, "{}");
  const cloud = fakeCloud(join(out, TRECHOS.dirName), view);
  let t = 0;
  const seams: MontageMainSeams = {
    desktopRoot: root,
    brutoStat: () => ({ size: brutoGiB * GIB }),
    cloudWait: { sleep: async (ms) => { t += ms; }, now: () => t },
  };
  const lines: string[] = [];
  const prevErr = console.error;
  const prevCreds = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
  process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = creds;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const code = await main([
      "build", ED, "--state-dir", state, "--work-dir", work, "--out-dir", out, "--drive-root", root, "--cache-dir", join(root, "cache"), "--folder-id", "yt",
      "--no-speech-detect", "--no-audio-refine", "--no-audio-gain", "--no-audio-clean", "--title-mode", "off", "--no-archive", ...extra,
    ], cloud.deps, seams);
    const xml = readFileSync(join(out, XML_NAME), "utf8");
    return { code, log: lines.join("\n"), out: xml, listings: cloud.listings(), waitedMs: t };
  } finally {
    console.error = prevErr;
    if (prevCreds === undefined) delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
    else process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = prevCreds;
    rmSync(root, { recursive: true, force: true });
  }
}

const everything: CloudView = (_n, local) => local;

describe("#13628 main build: limiar do XML leve e espera da nuvem, com Drive falso", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
  it("o limiar exercitado é o do config: 2 GB e 8 arquivos (#13629)", () => {
    const real = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    assert.deepEqual(xmlLeveLimiarFrom(real), { minGb: 2, maxArquivos: 8 });
  });

  it("bruto abaixo do limiar (1,9 GB): XML do bruto, sem trechos e sem consultar a nuvem", async () => {
    const r = await runBuild(1.9, everything);
    assert.equal(r.code, 0);
    assert.match(r.log, /\[premissa\] XML do bruto: bruto de 1\.9 GB em 1 arquivo\(s\), dentro do limiar: mais de 2 GB ou de 8 arquivos/);
    assert.match(r.out, /bruto\.mp4/);
    assert.doesNotMatch(r.out, new RegExp(`${TRECHOS.dirName}/`));
    assert.equal(r.listings, 0, "abaixo do limiar não há trecho para conferir na nuvem");
    assert.doesNotMatch(r.log, /XML leve pronto|XML leve AINDA NÃO pronto/);
  });

  it("bruto acima do limiar (2,1 GB; os 11,9 GB da 261118 também, desde o #13629): XML leve, trechos na nuvem, [ok]", async () => {
    const r = await runBuild(2.1, everything);
    assert.equal(r.code, 0);
    assert.match(r.log, /\[premissa\] XML leve \(bruto de 2\.1 GB/);
    assert.match(r.out, new RegExp(`${TRECHOS.dirName}/bruto_q\\d+-\\d+\\.mov`));
    assert.match(r.log, /\[ok\] XML leve pronto: os \d+ trecho\(s\) estão em 991231\/trechos\/ no Drive/);
    assert.equal(r.listings, 1);
    assert.equal(r.waitedMs, 0);
    const r2 = await runBuild(11.9, everything);
    assert.match(r2.log, /\[premissa\] XML leve \(bruto de 11\.9 GB/);
  });

  it("trecho ainda não pronto na nuvem (.part, depois pela metade): espera, relê e segue com [ok]", async () => {
    const view: CloudView = (n, local) =>
      n === 0 ? local.map((x) => ({ name: `${x.name}.part`, size: 0 })) : n === 1 ? local.map((x) => ({ name: x.name, size: Math.floor(x.size / 2) })) : local;
    const r = await runBuild(2.1, view);
    assert.equal(r.code, 0);
    assert.equal(r.listings, 3, "relê até tudo chegar com o tamanho do disco");
    assert.equal(r.waitedMs, 40_000, "duas esperas de 20 s");
    assert.match(r.log, /\[ok\] XML leve pronto/);
    assert.doesNotMatch(r.log, /AINDA NÃO pronto/);
  });

  it("trecho que não chega até o fim da espera: [aviso] AINDA NÃO pronto, e o build segue com exit 0", async () => {
    const r = await runBuild(2.1, (_n, local) => local.map((x) => ({ name: `${x.name}.part`, size: 0 })), ["--esperar-nuvem", "60"]);
    assert.equal(r.code, 0, "a conferência da nuvem nunca muda o exit");
    assert.ok(r.listings >= 2, "esperou e releu antes de desistir");
    assert.ok(r.waitedMs >= 40_000 && r.waitedMs <= 60_000);
    assert.match(r.log, /\[aviso\] XML leve AINDA NÃO pronto: \d+ de \d+ trecho\(s\).*só como \.part/);
  });

  it("--xml-bruto acima do limiar: o bruto, sem trechos e sem nuvem (a CLI vence o limiar)", async () => {
    const r = await runBuild(50, everything, ["--xml-bruto"]);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, new RegExp(`${TRECHOS.dirName}/`));
    assert.equal(r.listings, 0);
  });
});
