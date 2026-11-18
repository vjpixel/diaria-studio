/**
 * #13500 — o trecho inserido (#13437) era reaproveitado só porque o arquivo
 * `{AAMMDD}_trecho_{fala}-{hash}.mov` existia, e o corte ia para `.part`
 * dentro do out dir (a pasta do Drive) com rename depois: o mesmo padrão que a
 * #13488 corrigiu no `renderTrechos`. Um corte interrompido deixava o `.mov`
 * truncado, o hash não muda (fonte + intervalo), todo rebuild o reaproveitava e
 * o `verify-xml` passava, porque só conferia os trechos `_q…-….mov`.
 *
 * Cobre: a conferência dos quadros no reaproveitamento (corta de novo o
 * divergente), a conferência depois do corte e da cópia (tenta de novo e
 * depois desiste, sem deixar o nome final), o corte numa pasta temporária fora
 * do out dir, o `trechoMediaIssues` com os trechos inseridos e, com o ffmpeg
 * real, um trecho inserido truncado de propósito. ffmpeg/ffprobe injetados no
 * resto, sem vídeo real.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";
import { lerTrechoInserido } from "../scripts/lib/diaria/trecho-inserido-formato.ts";
import { cutTrechoInserido, probeTrechoFrames, probeVideoDurationS, trechoMediaIssues } from "../scripts/video-montagem.ts";

const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada horizontal_V1", width: 1920, height: 1080, order: ["comentario"], scales: [100, 115] };
type CutCtx = Parameters<typeof cutTrechoInserido>[0];

const trechoDe = (inicio: string, fim: string) => {
  const r = lerTrechoInserido({ video: "261110", inicio, fim, texto: "perder o cargo" });
  assert.ok(r.ok, JSON.stringify(r));
  return { id: "H5", texto: "Olha", trecho: r.trecho };
};
// 3:42 a 4:00 a 30 fps = 540 quadros.
const T = trechoDe("3:42", "4:00");
const FRAMES = 540;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "trecho-ins-13500-"));
  const tmpRoot = mkdtempSync(join(tmpdir(), "trecho-ins-13500-tmp-"));
  const src = join(dir, "fonte.mp4");
  writeFileSync(src, "x");
  const out = join(dir, "out");
  mkdirSync(out, { recursive: true });
  const ctx = { edition: "261118", outDir: out, stateDir: out, mode: "local", trechoFontes: { H5: src }, trechoDriveRoot: null } as unknown as CutCtx;
  return { dir, tmpRoot, out, ctx, cleanup: () => (rmSync(dir, { recursive: true, force: true }), rmSync(tmpRoot, { recursive: true, force: true })) };
}
const fakeEncode = (calls: string[]) => (args: string[]) => {
  calls.push(args[args.length - 1]);
  writeFileSync(args[args.length - 1], "mov");
};
function captureErr<T>(fn: () => T): { value: T; errs: string[] } {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m: string) => void errs.push(String(m));
  try {
    return { value: fn(), errs };
  } finally {
    console.error = orig;
  }
}

describe("#13500 cutTrechoInserido confere os quadros (ffmpeg e ffprobe injetados)", () => {
  it("o .mov truncado no disco é apagado e cortado de novo, com [aviso]; o corte vai para a pasta temporária", () => {
    const s = setup();
    try {
      // 1º build: corta e grava o nome final.
      const calls: string[] = [];
      const first = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/261118/b.mp4", { probeDurationS: () => 600, probeFrames: () => FRAMES, listEncoders: () => "", encode: fakeEncode(calls), tmpRoot: s.tmpRoot }));
      const c = first.value;
      assert.ok(c);
      assert.ok(calls[0].startsWith(s.tmpRoot), `o ffmpeg gravou em ${calls[0]}, devia ser fora do out dir`);
      assert.ok(!calls[0].startsWith(s.out));
      assert.deepEqual(readdirSync(s.out), [c.path.split(/[\\/]/).pop()], "sem .part no out dir");
      assert.deepEqual(readdirSync(s.tmpRoot), [], "a pasta temporária é apagada");

      // O Drive (ou um corte interrompido) deixa o arquivo com 60 quadros; o hash é o mesmo.
      writeFileSync(c.path, "truncado");
      const probeFrames = (p: string) => (readFileSync(p, "utf8") === "truncado" ? 60 : FRAMES);
      const calls2: string[] = [];
      const again = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/261118/b.mp4", { probeDurationS: () => 600, probeFrames, listEncoders: () => "", encode: fakeEncode(calls2), tmpRoot: s.tmpRoot }));
      assert.equal(again.value?.path, c.path);
      assert.equal(calls2.length, 1, "cortou de novo o truncado (antes: reaproveitava só pelo nome)");
      assert.equal(readFileSync(c.path, "utf8"), "mov");
      assert.ok(again.errs.some((e) => /\[aviso\] .*trecho depois da fala H5 .*261118_trecho_H5-[0-9a-f]{12}\.mov no disco com 60 quadro\(s\), o intervalo pede 540: apagado e cortado de novo \(#13500\)/.test(e)), again.errs.join("\n"));
    } finally {
      s.cleanup();
    }
  });

  it("ffprobe que não conta o .mov existente: reaproveitado com [aviso], nunca apagado (review)", () => {
    const s = setup();
    try {
      const c = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, probeFrames: () => FRAMES, listEncoders: () => "", encode: fakeEncode([]), tmpRoot: s.tmpRoot })).value;
      assert.ok(c);
      const again = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, probeFrames: () => null, encode: () => assert.fail("não corta de novo por falha do ffprobe") }));
      assert.equal(again.value?.path, c.path);
      assert.equal(again.value?.frames, FRAMES);
      assert.equal(readFileSync(c.path, "utf8"), "mov", "o corte existente fica");
      assert.ok(again.errs.some((e) => /\[aviso\] .*os quadros de .* não foram contados \(ffprobe falhou\): reaproveitado sem conferir/.test(e)), again.errs.join("\n"));
    } finally {
      s.cleanup();
    }
  });

  it("o .part órfão do código antigo no out dir é apagado antes do corte (review)", () => {
    const s = setup();
    try {
      const c = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, probeFrames: () => FRAMES, listEncoders: () => "", encode: fakeEncode([]), tmpRoot: s.tmpRoot })).value;
      assert.ok(c);
      rmSync(c.path);
      writeFileSync(`${c.path}.part`, "órfão");
      captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, probeFrames: () => FRAMES, listEncoders: () => "", encode: fakeEncode([]), tmpRoot: s.tmpRoot }));
      assert.deepEqual(readdirSync(s.out), [c.path.split(/[\\/]/).pop()]);
    } finally {
      s.cleanup();
    }
  });

  it("trecho que vai até o fim da fonte (vídeo 0,05 s antes do container): entra com os quadros reais (review)", () => {
    const s = setup();
    try {
      // 3:42 a 4:00 = 540 quadros; o stream de vídeo acaba em 239,95 s, o corte rende 538.
      const calls: string[] = [];
      const r = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 239.95, probeFrames: () => 538, listEncoders: () => "", encode: fakeEncode(calls), tmpRoot: s.tmpRoot }));
      assert.ok(r.value, r.errs.join("\n"));
      assert.equal(r.value.frames, 538, "o XML usa os quadros reais");
      assert.equal(calls.length, 1, "sem 2ª tentativa");
      assert.ok(r.errs.some((e) => /\[premissa\] .*o clipe cortado tem 538 quadro\(s\), 2 a menos que o intervalo/.test(e)), r.errs.join("\n"));
      // Rebuild: reaproveitado com os mesmos quadros reais.
      const again = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 239.95, probeFrames: () => 538, encode: () => assert.fail("reaproveita") }));
      assert.equal(again.value?.frames, 538);
      // Longe do fim da fonte, a mesma falta é recusada.
      const meio = captureErr(() => cutTrechoInserido(s.ctx, trechoDe("3:00", "3:18"), 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 239.95, probeFrames: () => 538, listEncoders: () => "", encode: fakeEncode([]), tmpRoot: s.tmpRoot }));
      assert.equal(meio.value, null);
    } finally {
      s.cleanup();
    }
  });

  it("probeVideoDurationS lê o stream de vídeo e cai no container quando ele não tem duração", () => {
    const seen: string[][] = [];
    const ff = (out: Record<string, string>) => (args: string[]) => (seen.push(args), args.includes("stream=duration") ? out.stream : out.format);
    assert.equal(probeVideoDurationS("/f.mp4", ff({ stream: "239.950000\r\n", format: "240.000000\n" })), 239.95);
    assert.ok(seen[0].includes("v:0"));
    assert.equal(probeVideoDurationS("/f.mp4", ff({ stream: "N/A\n", format: "240.000000\n" })), 240);
    assert.equal(probeVideoDurationS("/f.mp4", () => { throw new Error("ffprobe ausente"); }), null);
  });

  it("ffmpeg que falha: NÃO inserido sem a dica de fonte curta (a dica é só da divergência de quadros)", () => {
    const s = setup();
    try {
      const r = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, listEncoders: () => "", encode: () => { throw new Error("ffmpeg saiu 1: Invalid data"); }, tmpRoot: s.tmpRoot }));
      assert.equal(r.value, null);
      const msg = r.errs.find((e) => /NÃO inserido: o corte de/.test(e)) ?? "";
      assert.match(msg, /\(ffmpeg saiu 1: Invalid data\); fica só o marcador/);
      assert.doesNotMatch(msg, /a fonte acaba antes/);
    } finally {
      s.cleanup();
    }
  });

  it("o .mov íntegro no disco é reaproveitado sem cortar", () => {
    const s = setup();
    try {
      const c = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, probeFrames: () => FRAMES, listEncoders: () => "", encode: fakeEncode([]), tmpRoot: s.tmpRoot })).value;
      assert.ok(c);
      const again = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, probeFrames: () => FRAMES + 1, encode: () => assert.fail("reaproveita o corte íntegro") }));
      assert.equal(again.value?.path, c.path);
    } finally {
      s.cleanup();
    }
  });

  it("corte curto 2 vezes: NÃO inserido, sem nome final e sem temporário", () => {
    const s = setup();
    try {
      const calls: string[] = [];
      const r = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, probeFrames: () => 400, listEncoders: () => "", encode: fakeEncode(calls), tmpRoot: s.tmpRoot }));
      assert.equal(r.value, null);
      assert.equal(calls.length, 2);
      assert.ok(r.errs.some((e) => /\[aviso\] trecho inserido H5: o render saiu com 400 quadro\(s\), o intervalo pede 540; refazendo \(#13500\)/.test(e)), r.errs.join("\n"));
      assert.ok(r.errs.some((e) => /NÃO inserido: o corte de .* falhou \(trecho inserido H5: o render saiu com 400 quadro\(s\), o intervalo pede 540 \(2 tentativas, #13500\)/.test(e)), r.errs.join("\n"));
      assert.deepEqual(readdirSync(s.out), [], "o nome final não fica com o clipe curto");
      assert.deepEqual(readdirSync(s.tmpRoot), []);
    } finally {
      s.cleanup();
    }
  });

  it("cópia para o out dir que fica curta (Drive) é apagada e refeita", () => {
    const s = setup();
    try {
      let outReads = 0;
      const probeFrames = (p: string) => (p.startsWith(s.out) ? (++outReads === 1 ? 10 : FRAMES) : FRAMES);
      const calls: string[] = [];
      const r = captureErr(() => cutTrechoInserido(s.ctx, T, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => 600, probeFrames, listEncoders: () => "", encode: fakeEncode(calls), tmpRoot: s.tmpRoot }));
      assert.ok(r.value);
      assert.equal(calls.length, 2);
      assert.ok(r.errs.some((e) => /a cópia em .* ficou com 10 quadro\(s\), o intervalo pede 540; refazendo/.test(e)), r.errs.join("\n"));
      assert.ok(existsSync(r.value.path));
    } finally {
      s.cleanup();
    }
  });
});

describe("#13500 verify-xml confere os trechos inseridos contra a mídia real", () => {
  it("trechoMediaIssues: inserido truncado e ausente são problema; íntegro não; xmlPath com \\ ou /", () => {
    const dir = mkdtempSync(join(tmpdir(), "trecho-ins-13500-v-"));
    try {
      writeFileSync(join(dir, "261118_trecho_H5-aaaaaaaaaaaa.mov"), "");
      writeFileSync(join(dir, "261118_trecho_H9-bbbbbbbbbbbb.mov"), "");
      const clips = [
        { id: "H5", xmlPath: "I:/v/261118/261118_trecho_H5-aaaaaaaaaaaa.mov", frames: 540 },
        { id: "H5", xmlPath: "I:/v/261118/261118_trecho_H5-aaaaaaaaaaaa.mov", frames: 540 },
        { id: "H9", xmlPath: "I:\\v\\261118\\261118_trecho_H9-bbbbbbbbbbbb.mov", frames: 90 },
        { id: "H12", xmlPath: "I:/v/261118/261118_trecho_H12-cccccccccccc.mov", frames: 30 },
      ];
      const probe = (p: string) => (p.endsWith("H5-aaaaaaaaaaaa.mov") ? 188 : 90);
      const issues = trechoMediaIssues([], join(dir, "trechos"), probe, { dir, clips });
      assert.equal(issues.length, 2, issues.join("\n"));
      assert.match(issues[0], /trecho inserido H5 \(261118_trecho_H5-aaaaaaaaaaaa\.mov\) com 188 quadro\(s\) no disco, o XML pede 540/);
      assert.match(issues[1], /trecho inserido H12 \(261118_trecho_H12-cccccccccccc\.mov\) ausente/);
      assert.deepEqual(trechoMediaIssues([], join(dir, "trechos"), () => 90, null), [], "sem inseridos, nada muda");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o cmdVerifyXml passa os trechos inseridos das sequências escolhidas ao trechoMediaIssues", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    const body = src.slice(src.indexOf("function cmdVerifyXml("), src.indexOf("// ── Rosto automático"));
    assert.match(body, /const inseridosXml = chosen\.flatMap\(\(p\) => pf\.xmlAssets\?\.\[sequenceKey\(p\.spec\)\]\?\.trechosInseridos \?\? \[\]\);/);
    assert.match(body, /trechoMediaIssues\(xmlTexts, join\(ctx\.outDir, TRECHOS\.dirName\), probeTrechoFrames, \{ dir: ctx\.outDir, clips: inseridosXml \}\)/);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe("#13500 com ffmpeg real: trecho inserido truncado de propósito", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
  it("o verify-xml acusa o truncado, e o rebuild corta de novo com os quadros do intervalo", () => {
    const dir = mkdtempSync(join(tmpdir(), "trecho-ins-13500-ff-"));
    try {
      const src = join(dir, "diaria-comentada-261110.mp4");
      const gen = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
      assert.equal(gen.status, 0, String(gen.stderr));
      const out = join(dir, "out");
      mkdirSync(out, { recursive: true });
      const ctx = { edition: "261118", outDir: out, stateDir: out, mode: "local", trechoFontes: { H5: src }, trechoDriveRoot: null } as unknown as CutCtx;
      const t = trechoDe("0:01", "0:04");
      const small: SequenceSpec = { ...spec, width: 320, height: 240 };
      const cut = () => captureErr(() => cutTrechoInserido(ctx, t, 300, small, 30, "I:/v/261118/b.mp4", { listEncoders: () => "" }));
      const c = cut().value;
      assert.ok(c);
      assert.equal(c.frames, 90);
      assert.equal(probeTrechoFrames(c.path), 90);
      assert.deepEqual(trechoMediaIssues([], join(out, "trechos"), probeTrechoFrames, { dir: out, clips: [c] }), []);

      // Truncado com o moov íntegro (20 quadros, como os da 261118): o verify-xml acusa, o rebuild corta de novo.
      const short = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", src, "-frames:v", "20", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "0", "-an", "-f", "mov", c.path]);
      assert.equal(short.status, 0, String(short.stderr));
      assert.equal(probeTrechoFrames(c.path), 20);
      assert.equal(trechoMediaIssues([], join(out, "trechos"), probeTrechoFrames, { dir: out, clips: [c] }).length, 1, "o verify-xml acusa o truncado");
      // Truncado no meio (sem moov): o verify-xml também acusa (ilegível).
      const full = readFileSync(c.path);
      writeFileSync(join(dir, "sem-moov.mov"), full.subarray(0, Math.floor(full.length / 3)));
      assert.equal(trechoMediaIssues([], join(out, "trechos"), probeTrechoFrames, { dir, clips: [{ ...c, xmlPath: "I:/v/sem-moov.mov" }] }).length, 1);
      const again = cut();
      assert.equal(again.value?.path, c.path);
      assert.ok(again.errs.some((e) => /apagado e cortado de novo \(#13500\)/.test(e)), again.errs.join("\n"));
      assert.equal(probeTrechoFrames(c.path), 90, "cortado de novo com os quadros do intervalo");
      assert.deepEqual(readdirSync(out), [c.path.split(/[\\/]/).pop()], "sem .part no out dir");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fonte cujo vídeo acaba 0,05 s antes do container, fim do trecho = fim do container: inserido com os quadros reais (review)", () => {
    const dir = mkdtempSync(join(tmpdir(), "trecho-ins-13500-fim-"));
    try {
      const src = join(dir, "diaria-comentada-261110.mp4");
      // Vídeo de 7,95 s (159 quadros a 20 fps), áudio de 8 s: o container mede 8 s.
      const gen = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=20:duration=7.95", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
      assert.equal(gen.status, 0, String(gen.stderr));
      const container = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], { encoding: "utf8" }).stdout.trim());
      const video = probeVideoDurationS(src);
      assert.ok(video !== null && container - video >= 0.03, `container ${container} s, vídeo ${video} s`);
      const out = join(dir, "out");
      mkdirSync(out, { recursive: true });
      const ctx = { edition: "261118", outDir: out, stateDir: out, mode: "local", trechoFontes: { H5: src }, trechoDriveRoot: null } as unknown as CutCtx;
      const t = trechoDe("0:05", "0:08");
      const r = captureErr(() => cutTrechoInserido(ctx, t, 300, { ...spec, width: 320, height: 240 }, 30, "I:/v/261118/b.mp4", { listEncoders: () => "" }));
      assert.ok(r.value, `inserido, não recusado:\n${r.errs.join("\n")}`);
      const real = probeTrechoFrames(r.value.path);
      assert.ok(real !== null && real < 90 && real >= 87, `quadros reais ${real}`);
      assert.equal(r.value.frames, real, "o XML usa os quadros reais");
      assert.deepEqual(trechoMediaIssues([], join(out, "trechos"), probeTrechoFrames, { dir: out, clips: [r.value] }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
