/**
 * Lote video-montagem (#13464): #13505 (cache das bordas pelo hash do áudio),
 * #13507 (decode pela GPU com queda para a CPU, frames em lote) e #13508
 * (proxy 1440p na leitura do transcribe). Nada aqui depende de GPU: o ffmpeg é
 * simulado (o 300 está sem NVML funcional, #13505 Parte 1).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioIdentity, fileSha256, sameAudio } from "../scripts/lib/diaria/video-audio-identity.ts";
import { batchFrameArgs, chunkFrameJobs, createHwDecoder, ffmpegListsCuda, HWACCEL_ENV, withHwDecode } from "../scripts/lib/diaria/video-hwaccel.ts";
import { PROXY, proxyOutputArgs, proxyScaleFilter, proxyUsable, runExtractWithProxy } from "../scripts/lib/diaria/video-proxy.ts";
import { verifyEdgeWords } from "../scripts/video-montagem.ts";
import { trechoEncodeArgs } from "../scripts/lib/diaria/video-xml-trechos.ts";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("#13505 identidade do audio.wav pelo conteúdo", () => {
  it("cópia do work dir (mtime novo, mesmos bytes): o hash é o mesmo e o cache vale", () => {
    const dir = mkdtempSync(join(tmpdir(), "aid-13505-"));
    const a = join(dir, "audio.wav");
    const b = join(dir, "copia.wav");
    writeFileSync(a, Buffer.alloc(9 * 1024 * 1024, 7));
    writeFileSync(b, Buffer.alloc(9 * 1024 * 1024, 7));
    utimesSync(b, new Date(2030, 0, 1), new Date(2030, 0, 1));
    const ia = audioIdentity(a);
    const ib = audioIdentity(b);
    assert.notEqual(ia.mtimeMs, ib.mtimeMs);
    assert.equal(ia.sha256, ib.sha256);
    assert.equal(ia.sha256, fileSha256(a));
    assert.deepEqual(sameAudio({ size: ia.size, mtimeMs: ia.mtimeMs, sha256: ia.sha256 }, ib), { same: true, legacy: false });
  });

  it("mesmo tamanho e mtime mas conteúdo diferente: o hash recusa o cache", () => {
    const cur = { size: 10, mtimeMs: 5, sha256: "b".repeat(64) };
    assert.equal(sameAudio({ size: 10, mtimeMs: 5, sha256: "a".repeat(64) }, cur).same, false);
  });

  it("cache anterior ao #13505 (só tamanho + mtime) segue valendo quando os dois batem, marcado para regravar", () => {
    const cur = { size: 10, mtimeMs: 5, sha256: "a".repeat(64) };
    assert.deepEqual(sameAudio({ size: 10, mtimeMs: 5 }, cur), { same: true, legacy: true });
    assert.deepEqual(sameAudio({ size: 10, mtimeMs: 6 }, cur), { same: false, legacy: false });
    assert.deepEqual(sameAudio(null, cur), { same: false, legacy: false });
  });

  it("verify-xml: edge-retranscribe.json com o hash do áudio vale mesmo com o mtime trocado pela cópia", () => {
    const planClips = [{ srcIn: 2, srcOut: 4 }];
    const key = "1.400-2.300";
    const words = { [key]: [w("veja", 1.95, 2.2)] };
    const cache = { audio: { size: 1000, mtimeMs: 1, sha256: "c".repeat(64) }, windows: words };
    const copied = { size: 1000, mtimeMs: 999, sha256: "c".repeat(64) };
    const r = verifyEdgeWords({ transcript: [w("cair.", 4.5, 5)], cache, audio: copied, planClips, durationS: 10 });
    assert.ok(!r.warnings.some((x) => /outro audio\.wav/.test(x)), r.warnings.join("; "));
    const other = verifyEdgeWords({ transcript: [w("cair.", 4.5, 5)], cache, audio: { ...copied, sha256: "d".repeat(64) }, planClips, durationS: 10 });
    assert.ok(other.warnings.some((x) => /outro audio\.wav/.test(x)));
  });
});

describe("#13507 decode pela GPU com queda para a CPU", () => {
  it("ffmpegListsCuda lê a lista do -hwaccels", () => {
    assert.equal(ffmpegListsCuda("Hardware acceleration methods:\nvdpau\ncuda\nvaapi\n"), true);
    assert.equal(ffmpegListsCuda("Hardware acceleration methods:\nvaapi\nqsv\n"), false);
  });

  it("withHwDecode: antes do 1º -i (ou de todos), sem duplicar", () => {
    assert.deepEqual(withHwDecode(["-y", "-ss", "1", "-i", "v.mov", "-i", "a.wav", "o.mp4"]), ["-y", "-ss", "1", "-hwaccel", "cuda", "-i", "v.mov", "-i", "a.wav", "o.mp4"]);
    assert.deepEqual(withHwDecode(["-i", "a", "-i", "b"], { all: true }), ["-hwaccel", "cuda", "-i", "a", "-hwaccel", "cuda", "-i", "b"]);
    assert.deepEqual(withHwDecode(["-hwaccel", "cuda", "-i", "a"]), ["-hwaccel", "cuda", "-i", "a"]);
  });

  it("GPU que falha (o 300 com o NVML quebrado): refaz na CPU, [aviso] uma vez e o resto da execução segue na CPU", () => {
    const calls: string[][] = [];
    const warns: string[] = [];
    const hw = createHwDecoder({ listHwaccels: () => "cuda\n", env: {}, warn: (l) => warns.push(l) });
    const exec = (a: string[]) => {
      calls.push(a);
      if (a.includes("-hwaccel")) throw new Error("Failed to initialize NVML: Driver/library version mismatch\nmais");
    };
    assert.equal(hw.run(["-i", "x", "o1"], exec, "frame"), "cpu");
    assert.equal(hw.run(["-i", "x", "o2"], exec, "frame"), "cpu");
    assert.deepEqual(calls, [["-hwaccel", "cuda", "-i", "x", "o1"], ["-i", "x", "o1"], ["-i", "x", "o2"]]);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /^\[aviso\] decode pela GPU \(-hwaccel cuda\) falhou em frame \(Failed to initialize NVML: Driver\/library version mismatch\): segue na CPU/);
  });

  it("falha que não é da GPU (a CPU também falha): o erro sobe e a GPU segue ligada", () => {
    const hw = createHwDecoder({ listHwaccels: () => "cuda", env: {}, warn: () => assert.fail("sem aviso") });
    assert.throws(() => hw.run(["-i", "x"], (a) => { throw new Error(a.includes("-hwaccel") ? "gpu" : "arquivo ausente"); }, "frame"), /arquivo ausente/);
    assert.equal(hw.state(), "cuda");
    assert.equal(hw.run(["-i", "x"], () => {}, "frame"), "cuda");
  });

  it("sem cuda no ffmpeg, -hwaccels que falha, ou DIARIA_VIDEO_HWACCEL=0: só a CPU, sem tentar a GPU", () => {
    for (const hw of [
      createHwDecoder({ listHwaccels: () => "vaapi\n", env: {}, warn: () => {} }),
      createHwDecoder({ listHwaccels: () => { throw new Error("ffmpeg ausente"); }, env: {}, warn: () => {} }),
      createHwDecoder({ listHwaccels: () => "cuda\n", env: { [HWACCEL_ENV]: "0" }, warn: () => {} }),
    ]) {
      const calls: string[][] = [];
      assert.equal(hw.run(["-i", "x"], (a) => { calls.push(a); }, "frame"), "cpu");
      assert.deepEqual(calls, [["-i", "x"]]);
    }
  });

  it("frames em lote: uma entrada e uma saída por frame, cada uma com o próprio espelhamento", () => {
    const a = batchFrameArgs([
      { src: "b.mov", atS: 1.23456, mirrored: true, out: "f0.png" },
      { src: "b.mov", atS: 9, mirrored: false, out: "f1.png" },
    ], { width: 720 });
    assert.deepEqual(a, [
      "-hide_banner", "-v", "error", "-y",
      "-ss", "1.235", "-i", "b.mov", "-ss", "9.000", "-i", "b.mov",
      "-map", "0:v:0", "-frames:v", "1", "-vf", "hflip,scale=720:-2", "f0.png",
      "-map", "1:v:0", "-frames:v", "1", "-vf", "scale=720:-2", "f1.png",
    ]);
    assert.deepEqual(chunkFrameJobs([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.throws(() => batchFrameArgs([], { width: 720 }));
  });

  it("trecho do XML leve: os argumentos de encode seguem os mesmos (o -hwaccel entra só no decode, pelo runDecode)", () => {
    const a = trechoEncodeArgs({ src: "in.mp4", out: "o.mov.part", start: 30, end: 90, fps: 30, encoder: "h264_nvenc" });
    assert.ok(!a.includes("-hwaccel"));
    assert.deepEqual(withHwDecode(a).slice(4, 9), ["-ss", "1.000000", "-hwaccel", "cuda", "-i"]);
  });
});

describe("#13508 proxy 1440p", () => {
  it("escala pelo lado menor; bruto que já cabe não ganha proxy", () => {
    assert.equal(proxyScaleFilter(3840, 2160), "scale=-2:1440");
    assert.equal(proxyScaleFilter(2160, 3840), "scale=1440:-2");
    assert.equal(proxyScaleFilter(1920, 1080), null);
    assert.equal(proxyOutputArgs({ width: 1920, height: 1080, out: "p" }), null);
    const a = proxyOutputArgs({ width: 3840, height: 2160, out: "p.part" })!;
    assert.deepEqual(a.slice(0, 4), ["-map", "0:v:0", "-an", "-vf"]);
    assert.ok(a.includes("h264_nvenc"));
    assert.deepEqual(a.slice(-3), ["-f", "mp4", "p.part"]);
  });

  it("proxy só vale para o MESMO bruto (caminho, bytes, duração) de um arquivo só", () => {
    const meta = { version: PROXY.version, src: "/d/b.mov", size: 100, durationS: 60, width: 3840, height: 2160 };
    const src = { path: "/d/b.mov", durationS: 60.2 };
    assert.equal(proxyUsable(meta, src, 100), true);
    assert.equal(proxyUsable(meta, src, 101), false, "bruto trocado com o mesmo nome");
    assert.equal(proxyUsable(meta, { ...src, path: "/d/outro.mov" }, 100), false);
    assert.equal(proxyUsable(meta, { ...src, durationS: 61 }, 100), false);
    assert.equal(proxyUsable(meta, { ...src, files: [{}, {}] }, 100), false);
    assert.equal(proxyUsable({ ...meta, version: 0 }, src, 100), false);
    assert.equal(proxyUsable(null, src, 100), false);
    assert.equal(proxyUsable(meta, src, null), false);
  });

  it("extração com proxy: um ffmpeg só, com a GPU no decode", () => {
    const calls: string[][] = [];
    const finished: string[] = [];
    const r = runExtractWithProxy({
      baseArgs: ["-y", "-i", "b.mov", "audio.wav"],
      proxy: { args: ["-map", "0:v:0", "p.part"], part: "p.part" },
      exec: (a) => { calls.push(a); return "loud"; },
      finish: (p) => finished.push(p),
      discard: () => assert.fail("nada a descartar"),
      warn: () => assert.fail("sem aviso"),
    });
    assert.deepEqual(r, { stderr: "loud", proxy: "made" });
    assert.deepEqual(calls, [["-y", "-hwaccel", "cuda", "-i", "b.mov", "audio.wav", "-map", "0:v:0", "p.part"]]);
    assert.deepEqual(finished, ["p.part"]);
  });

  it("GPU/NVENC que falha: descarta o proxy parcial e extrai só o áudio, como antes, com [aviso]", () => {
    const calls: string[][] = [];
    const discarded: string[] = [];
    const warns: string[] = [];
    const r = runExtractWithProxy({
      baseArgs: ["-y", "-i", "b.mov", "audio.wav"],
      proxy: { args: ["p.part"], part: "p.part" },
      exec: (a) => { calls.push(a); if (a.includes("-hwaccel")) throw new Error("ffmpeg saiu 1: Error while opening encoder"); return "loud"; },
      finish: () => assert.fail("não chega"),
      discard: (p) => discarded.push(p),
      warn: (l) => warns.push(l),
    });
    assert.deepEqual(r, { stderr: "loud", proxy: "failed" });
    assert.deepEqual(calls[1], ["-y", "-i", "b.mov", "audio.wav"]);
    assert.deepEqual(discarded, ["p.part"]);
    assert.match(warns[0], /\[aviso\] proxy 1440p.*Error while opening encoder.*áudio extraído sem ele/);
  });

  it("proxy gravado que não confere (duração): descartado, sem refazer o áudio", () => {
    const calls: string[][] = [];
    const warns: string[] = [];
    const r = runExtractWithProxy({
      baseArgs: ["-i", "b.mov"],
      proxy: { args: ["p.part"], part: "p.part" },
      exec: (a) => { calls.push(a); return "loud"; },
      finish: () => { throw new Error("proxy com 12.00 s, o bruto tem 60.00 s"); },
      discard: () => {},
      warn: (l) => warns.push(l),
    });
    assert.equal(r.proxy, "failed");
    assert.equal(calls.length, 1);
    assert.match(warns[0], /descartado \(proxy com 12\.00 s/);
  });

  it("sem plano de proxy (sem GPU, bruto em vários arquivos, só áudio): a extração de antes, intacta", () => {
    const calls: string[][] = [];
    const r = runExtractWithProxy({ baseArgs: ["-i", "b.mov", "a.wav"], proxy: null, exec: (a) => { calls.push(a); return "s"; }, finish: () => {}, discard: () => {}, warn: () => {} });
    assert.deepEqual(r, { stderr: "s", proxy: "skipped" });
    assert.deepEqual(calls, [["-i", "b.mov", "a.wav"]]);
  });
});
