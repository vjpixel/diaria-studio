/**
 * #13488 — trecho do XML leve truncado no disco era reaproveitado só pelo
 * nome. Na 261118 quatro trechos de `trechos/` tinham bem menos quadros que o
 * nome prometia (780 → 269, 420 → 188, 540 → 332, 300 → 60), o build disse
 * "22 reaproveitado(s)" e o XML saiu com ~27 s de imagem preta no Premiere; o
 * `verify-xml` também não pegou, porque confere in/out contra a `<duration>`
 * do `<file>` (a do nome), não contra a mídia.
 *
 * Cobre: a conferência dos quadros no reaproveitamento (refaz o divergente),
 * a conferência depois do encode (tenta de novo e depois lança, sem deixar o
 * nome final), o render numa pasta temporária fora do out dir (o Drive subia
 * o `.part` vazio), o check de mídia real do `verify-xml` e, com o ffmpeg
 * real, um trecho truncado de propósito.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import {
  parseTrechoFrameProbe,
  parseTrechoName,
  TRECHOS,
  trechoFrameProbeArgs,
  trechoFramesOk,
  trechoNamesInXml,
} from "../scripts/lib/diaria/video-xml-trechos.ts";
import { cachedTrechoProbe, probeTrechoFrames, renderTrechos, TRECHO_FRAMES_CACHE, trechoFramesCachePath, trechoMediaIssues } from "../scripts/video-montagem.ts";

// Clipe 30-60 a 30 fps com folga de 1 s: trecho 0-90 (b_q000000-000090.mov).
const NAME = "b_q000000-000090.mov";
const plans = [{ clips: [{ frameIn: 30, frameOut: 60 }] as never }];
const sourceIn = (dir: string): SourceInfo => ({ path: join(dir, "b.mp4"), fps: 30, durationS: 10, width: 3840, height: 2160, mirrored: false });
const fakeEncode = (calls: string[]) => (args: string[]) => {
  calls.push(args[args.length - 1]);
  writeFileSync(args[args.length - 1], "render");
};

describe("#13488 helpers puros", () => {
  it("parseTrechoName lê início e fim do nome; outro nome = null", () => {
    assert.deepEqual(parseTrechoName("20261117_181712_q003270-004050.mov"), { start: 3270, end: 4050 });
    assert.equal(parseTrechoName("261118_trecho_t1-abc123.mov"), null);
    assert.equal(parseTrechoName("x_q000090-000090.mov"), null, "fim igual ao início não é trecho");
  });

  it("trechoFramesOk: os 4 truncados da 261118 reprovam; exato e ±1 passam; null reprova", () => {
    for (const [want, got] of [[780, 269], [420, 188], [540, 332], [300, 60]]) assert.equal(trechoFramesOk(want, got), false, `${want} x ${got}`);
    assert.equal(trechoFramesOk(780, 780), true);
    assert.equal(trechoFramesOk(780, 779), true);
    assert.equal(trechoFramesOk(780, 778), false);
    assert.equal(trechoFramesOk(780, null), false, "ffprobe que falha (arquivo sem moov) = divergente");
  });

  it("parseTrechoFrameProbe e os argumentos do ffprobe (conta pacotes, sem decodificar)", () => {
    assert.equal(parseTrechoFrameProbe("269\n"), 269);
    assert.equal(parseTrechoFrameProbe("269\r\n"), 269);
    assert.equal(parseTrechoFrameProbe(""), null);
    assert.equal(parseTrechoFrameProbe("N/A"), null);
    const args = trechoFrameProbeArgs("/x/a.mov");
    assert.ok(args.includes("-count_packets") && args.includes("stream=nb_read_packets"));
    assert.equal(args[args.length - 1], "/x/a.mov");
  });

  it("trechoNamesInXml pega o <name> de cada trecho, sem repetir e sem o trecho inserido", () => {
    const xml = `<file id="file-1-t0"><name>b_q000000-000090.mov</name><pathurl>file:///I:/v/trechos/b_q000000-000090.mov</pathurl></file>` +
      `<file id="file-1-t0"/><file id="file-1-t300"><name>b_q000300-000420.mov</name></file>` +
      `<file id="t1"><name>261118_trecho_t1-abc123.mov</name></file><file id="file-2-t0"><name>b_q000000-000090.mov</name></file>`;
    assert.deepEqual(trechoNamesInXml(xml), ["b_q000000-000090.mov", "b_q000300-000420.mov"]);
  });
});

describe("#13488 renderTrechos confere os quadros (encode e probe falsos)", () => {
  it("trecho truncado no disco é apagado e refeito, com [aviso]; nada de 'reaproveitado'", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-"));
    try {
      mkdirSync(join(dir, TRECHOS.dirName));
      const out = join(dir, TRECHOS.dirName, NAME);
      writeFileSync(out, "truncado");
      const calls: string[] = [];
      const lines: string[] = [];
      // O arquivo no disco tem 60 quadros (o "300 → 60" da 261118); o render novo, os 90.
      const probeFrames = (p: string) => (p === out && readFileSync(p, "utf8") === "truncado" ? 60 : 90);
      const r = renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode(calls), probeFrames, log: (m) => lines.push(m) });
      assert.equal(r.reused, 0);
      assert.equal(r.redone, 1);
      assert.equal(r.made, 1);
      assert.equal(calls.length, 1, "recodificou o truncado");
      assert.equal(readFileSync(out, "utf8"), "render", "o nome final tem o render novo");
      assert.match(lines.join("\n"), /\[aviso\] trecho b_q000000-000090\.mov no disco com 60 quadro\(s\), o nome pede 90: apagado e refeito \(#13488\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trecho ilegível no disco (ffprobe sem contagem) também é refeito", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-"));
    try {
      mkdirSync(join(dir, TRECHOS.dirName));
      const out = join(dir, TRECHOS.dirName, NAME);
      writeFileSync(out, "");
      const calls: string[] = [];
      const probeFrames = (p: string) => (readFileSync(p, "utf8") === "" ? null : 90);
      const r = renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode(calls), probeFrames, log: () => {} });
      assert.equal(r.redone, 1);
      assert.equal(calls.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trecho íntegro no disco é reaproveitado sem recodificar", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-"));
    try {
      mkdirSync(join(dir, TRECHOS.dirName));
      writeFileSync(join(dir, TRECHOS.dirName, NAME), "ok");
      const r = renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: () => assert.fail("não devia recodificar"), probeFrames: () => 90 });
      assert.deepEqual([r.reused, r.made, r.redone], [1, 0, 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o render vai para a pasta temporária, fora do out dir, e nenhum .part fica em trechos/", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-"));
    const tmpRoot = mkdtempSync(join(tmpdir(), "trechos-13488-tmp-"));
    try {
      const calls: string[] = [];
      renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode(calls), probeFrames: () => 90, tmpRoot });
      assert.equal(calls.length, 1);
      assert.ok(calls[0].startsWith(tmpRoot), `o ffmpeg gravou em ${calls[0]}`);
      assert.ok(!calls[0].startsWith(join(dir, TRECHOS.dirName)));
      assert.deepEqual(readdirSync(join(dir, TRECHOS.dirName)), [NAME]);
      assert.deepEqual(readdirSync(tmpRoot), [], "a pasta temporária é apagada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("render que sai curto tenta de novo; curto 2 vezes lança, sem nome final e sem temporário", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-"));
    const tmpRoot = mkdtempSync(join(tmpdir(), "trechos-13488-tmp-"));
    try {
      const calls: string[] = [];
      const lines: string[] = [];
      const bad = () => renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode(calls), probeFrames: () => 30, tmpRoot, log: (m) => lines.push(m) });
      assert.throws(bad, /trecho b_q000000-000090\.mov: o render saiu com 30 quadro\(s\), o nome pede 90 \(2 tentativas, #13488\)/);
      assert.equal(calls.length, 2);
      assert.match(lines.join("\n"), /\[aviso\] trecho b_q000000-000090\.mov: o render saiu com 30 quadro\(s\), o nome pede 90; refazendo/);
      assert.ok(!existsSync(join(dir, TRECHOS.dirName, NAME)), "o nome final não pode ficar com o trecho curto");
      assert.deepEqual(readdirSync(tmpRoot), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("render curto na 1ª e certo na 2ª: segue, com [aviso]", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-"));
    try {
      const calls: string[] = [];
      let n = 0;
      const probeFrames = () => (++n === 1 ? 45 : 90);
      const lines: string[] = [];
      const r = renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode(calls), probeFrames, log: (m) => lines.push(m) });
      assert.equal(r.made, 1);
      assert.equal(calls.length, 2);
      assert.match(lines.join("\n"), /refazendo \(#13488\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cópia para o out dir que fica curta (Drive) é apagada e refeita", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-"));
    try {
      const out = join(dir, TRECHOS.dirName, NAME);
      let copies = 0;
      // O render local sempre certo; a 1ª leitura do nome final, curta.
      const probeFrames = (p: string) => (p === out ? (++copies === 1 ? 10 : 90) : 90);
      const lines: string[] = [];
      const calls: string[] = [];
      const r = renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode(calls), probeFrames, log: (m) => lines.push(m) });
      assert.equal(r.made, 1);
      assert.equal(calls.length, 2);
      assert.match(lines.join("\n"), /a cópia em .* ficou com 10 quadro\(s\), o nome pede 90; refazendo/);
      assert.ok(existsSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13488 verify-xml confere os trechos contra a mídia real", () => {
  it("trechoMediaIssues: truncado e ausente são problema; íntegro não", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-"));
    try {
      writeFileSync(join(dir, "b_q000000-000090.mov"), "");
      writeFileSync(join(dir, "b_q000300-000600.mov"), "");
      const xml = `<name>b_q000000-000090.mov</name><name>b_q000300-000600.mov</name><name>b_q000900-001200.mov</name>`;
      const probe = (p: string) => (p.endsWith("b_q000300-000600.mov") ? 60 : 90);
      const issues = trechoMediaIssues([xml, xml], dir, probe);
      assert.equal(issues.length, 2, issues.join("\n"));
      assert.match(issues[0], /trecho b_q000300-000600\.mov com 60 quadro\(s\) no disco, o XML pede 300/);
      assert.match(issues[1], /trecho b_q000900-001200\.mov ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o cmdVerifyXml soma os problemas de mídia em `bad`", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    const body = src.slice(src.indexOf("function cmdVerifyXml("), src.indexOf("// ── Rosto automático"));
    // #13512: a sonda com o cache local (work dir), não a do out dir sincronizado.
    assert.match(body, /const mediaIssues = trechoMediaIssues\(xmlTexts, join\(ctx\.outDir, TRECHOS\.dirName\), cachedTrechoProbe\(trechoFramesCachePath\(ctx\.workDir\)\), \{ dir: ctx\.outDir, clips: inseridosXml \}(?:, \{[^;]*\})?\);/);
    assert.match(body, /bad \+= mediaIssues\.length;/);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe("#13488 com ffmpeg real: trecho truncado de propósito", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
  it("o rebuild acha o trecho curto, refaz com os quadros do nome, e o verify-xml acusa antes", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13488-ff-"));
    try {
      const src = join(dir, "20261117_181712.mp4");
      const gen = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
      assert.equal(gen.status, 0, String(gen.stderr));
      const source: SourceInfo = { path: src, fps: 30, durationS: 8, width: 320, height: 240, mirrored: false };
      const outDir = join(dir, "out");
      const tdir = join(outDir, TRECHOS.dirName);
      mkdirSync(tdir, { recursive: true });
      const name = "20261117_181712_q000000-000090.mov";
      // O truncado: o nome promete 90 quadros, o arquivo tem 20 (como os da 261118).
      const short = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", src, "-frames:v", "20", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "0", "-an", "-f", "mov", join(tdir, name)]);
      assert.equal(short.status, 0, String(short.stderr));
      assert.equal(probeTrechoFrames(join(tdir, name)), 20);
      const xml = `<file id="file-1-t0"><name>${name}</name></file>`;
      assert.equal(trechoMediaIssues([xml], tdir).length, 1, "o verify-xml acusa o truncado");

      const lines: string[] = [];
      const r = renderTrechos({ plans: [{ clips: [{ frameIn: 30, frameOut: 60 }] as never }], source, outDir, mediaPath: "I:/v/261118/20261117_181712.mp4", folgaS: 1, listEncoders: () => "", log: (m) => lines.push(m) });
      assert.deepEqual(r.trechos.map((t) => t.name), [name]);
      assert.deepEqual([r.reused, r.redone, r.made], [0, 1, 1]);
      assert.equal(probeTrechoFrames(join(tdir, name)), 90, "refeito com os quadros do nome");
      assert.deepEqual(trechoMediaIssues([xml], tdir), []);
      assert.deepEqual(readdirSync(tdir), [name], "sem .part em trechos/");

      // Truncado no meio do arquivo (sem o moov no fim): ffprobe não conta, e o rebuild refaz.
      const full = readFileSync(join(tdir, name));
      writeFileSync(join(tdir, name), full.subarray(0, Math.floor(full.length / 3)));
      assert.equal(trechoFramesOk(90, probeTrechoFrames(join(tdir, name))), false);
      const again = renderTrechos({ plans: [{ clips: [{ frameIn: 30, frameOut: 60 }] as never }], source, outDir, mediaPath: "I:/v/261118/20261117_181712.mp4", folgaS: 1, listEncoders: () => "", log: () => {} });
      assert.equal(again.redone, 1);
      assert.equal(probeTrechoFrames(join(tdir, name)), 90);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13512 cache da contagem de quadros", () => {
  it("não reprobe arquivo intacto; reprobe se mudar; null não é guardado", () => {
    const d = mkdtempSync(join(tmpdir(), "t13512-"));
    try {
      const f = join(d, NAME);
      const cp = join(d, TRECHO_FRAMES_CACHE);
      writeFileSync(f, "aaaa");
      const seen: string[] = [];
      let ret: number | null = 90;
      const probe = (p: string) => { seen.push(p); return ret; };
      const c1 = cachedTrechoProbe(cp, probe);
      assert.equal(c1(f), 90);
      assert.equal(cachedTrechoProbe(cp, probe)(f), 90, "nova instância lê o cache em disco");
      assert.equal(seen.length, 1, "segunda leitura veio do cache");
      writeFileSync(f, "aaaaaaaa");
      ret = 20;
      assert.equal(cachedTrechoProbe(cp, probe)(f), 20, "tamanho mudou: reprobe");
      ret = null;
      writeFileSync(f, "bb");
      assert.equal(cachedTrechoProbe(cp, probe)(f), null);
      assert.equal(cachedTrechoProbe(cp, probe)(f), null);
      assert.equal(seen.length, 4, "null nunca é cacheado");
      writeFileSync(cp, "{lixo");
      ret = 7;
      assert.equal(cachedTrechoProbe(cp, probe)(f), 7, "cache corrompido não derruba");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("mudança só de mtime (mesmo tamanho) força nova sonda", () => {
    const d = mkdtempSync(join(tmpdir(), "t13512-"));
    try {
      const f = join(d, NAME);
      const cp = join(d, TRECHO_FRAMES_CACHE);
      writeFileSync(f, "aaaa");
      utimesSync(f, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
      let n = 0;
      const probe = () => { n++; return 90; };
      assert.equal(cachedTrechoProbe(cp, probe)(f), 90);
      assert.equal(cachedTrechoProbe(cp, probe)(f), 90);
      assert.equal(n, 1);
      utimesSync(f, new Date("2026-11-02T00:00:00Z"), new Date("2026-11-02T00:00:00Z"));
      assert.equal(statSync(f).size, 4, "mesmo tamanho");
      assert.equal(cachedTrechoProbe(cp, probe)(f), 90);
      assert.equal(n, 2, "mtime mudou: reprobe");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("entrada de arquivo que não existe mais é podada do cache ao carregar", () => {
    const d = mkdtempSync(join(tmpdir(), "t13512-"));
    try {
      const a = join(d, "a_q000000-000090.mov");
      const b = join(d, "b_q000000-000090.mov");
      const cp = join(d, "work", TRECHO_FRAMES_CACHE);
      writeFileSync(a, "x");
      writeFileSync(b, "y");
      const c = cachedTrechoProbe(cp, () => 90);
      c(a);
      c(b);
      assert.equal(Object.keys(JSON.parse(readFileSync(cp, "utf8"))).length, 2, "cria o diretório do cache");
      rmSync(a);
      cachedTrechoProbe(cp, () => 90);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(cp, "utf8"))), [b]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("o cache fica no work dir: trechoFramesCachePath não aponta a pasta do Drive", () => {
    assert.equal(trechoFramesCachePath("/tmp/diaria-video-montagem/261118"), join("/tmp/diaria-video-montagem/261118", TRECHO_FRAMES_CACHE));
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    assert.match(src, /renderTrechos\(\{[^}]*framesCachePath: trechoFramesCachePath\(ctx\.workDir\)/);
    assert.doesNotMatch(src, /cachedTrechoProbe\(join\([^)]*outDir/);
  });

  it("renderTrechos: o 2º run com o cache não sonda o trecho intacto, e o .part nunca entra no cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13512-"));
    const work = mkdtempSync(join(tmpdir(), "trechos-13512-work-"));
    try {
      const probed: string[] = [];
      const probeFrames = (p: string) => { probed.push(p); return 90; };
      const cp = trechoFramesCachePath(work);
      const run1 = renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: fakeEncode([]), probeFrames, framesCachePath: cp, log: () => {} });
      assert.equal(run1.made, 1);
      assert.equal(probed.length, 2, "o .part e a cópia");
      const cached = Object.keys(JSON.parse(readFileSync(cp, "utf8")));
      assert.deepEqual(cached, [join(dir, TRECHOS.dirName, NAME)], "só o nome final no cache, sem o .part");
      assert.ok(!existsSync(join(dir, TRECHO_FRAMES_CACHE)) && readdirSync(join(dir, TRECHOS.dirName)).length === 1, "nada de cache no out dir");
      probed.length = 0;
      const run2 = renderTrechos({ plans, source: sourceIn(dir), outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: () => assert.fail("não devia recodificar"), probeFrames, framesCachePath: cp, log: () => {} });
      assert.deepEqual([run2.reused, run2.made], [1, 0]);
      assert.deepEqual(probed, [], "2º run sem sonda");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("trechoMediaIssues com o cache: o 2º verify-xml não sonda o trecho intacto", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13512-"));
    const work = mkdtempSync(join(tmpdir(), "trechos-13512-work-"));
    try {
      writeFileSync(join(dir, NAME), "ok");
      const xml = `<name>${NAME}</name>`;
      let n = 0;
      const probe = () => { n++; return 90; };
      assert.deepEqual(trechoMediaIssues([xml], dir, cachedTrechoProbe(trechoFramesCachePath(work), probe)), []);
      assert.deepEqual(trechoMediaIssues([xml], dir, cachedTrechoProbe(trechoFramesCachePath(work), probe)), []);
      assert.equal(n, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
