/**
 * #13234: motor da faixa tratada (ffmpeg atual ou DeepFilterNet), fallback,
 * hash por motor/versão/teto, sonda do ambiente e medidas do A/B, com áudio
 * sintético (fala simulada por harmônicos em rajadas sobre ruído contínuo).
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import {
  assessDeepFilterProbe,
  audioLevelStats,
  deepFilterArgs,
  deepFilterDescriptor,
  deepFilterHelpMissingFlags,
  parseDeepFilterVersion,
  resolveAudioDenoise,
  shuffled,
} from "../scripts/lib/diaria/audio-denoise.ts";
import { audioCleanFilter, audioCleanParams } from "../scripts/lib/diaria/video-montage.ts";
import { assessMontageEnv, formatMontageEnvReport, type MontageEnvProbes } from "../scripts/lib/diaria/video-montage-env.ts";
import { cleanAudioKey, renderCleanAudio } from "../scripts/video-montagem.ts";
import { abVariants, blindAssignment, seededRandom } from "../scripts/video-audio-denoise-ab.ts";

const RATE = 48000;

/** "Fala": rajadas de 1 s de harmônicos de 180 Hz a -20 dBFS, alternando com 1 s de pausa; ruído branco contínuo a `noiseDb`. */
function synth(seconds: number, noiseDb: number, seed = 7): Int16Array {
  const rnd = seededRandom(seed);
  const noiseAmp = Math.sqrt(3) * 10 ** (noiseDb / 20); // uniforme [-a, a] tem RMS a/√3
  const speechAmp = 10 ** (-20 / 20) * Math.SQRT2 / Math.sqrt(3); // 3 harmônicos somando RMS -20 dB
  return Int16Array.from({ length: RATE * seconds }, (_, i) => {
    const t = i / RATE;
    const on = Math.floor(t) % 2 === 0;
    const s = on ? speechAmp * [1, 2, 3].reduce((a, h) => a + Math.sin(2 * Math.PI * 180 * h * t), 0) : 0;
    const n = noiseAmp * (2 * rnd() - 1);
    return Math.max(-32768, Math.min(32767, Math.round(32768 * (s + n))));
  });
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function writeWav(path: string, samples: Int16Array): void {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", "pipe:0", "-c:a", "pcm_s16le", path], { input: Buffer.from(samples.buffer) });
  assert.equal(r.status, 0, String(r.stderr));
}

function readWav(path: string, filter?: string): Int16Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", path, ...(filter ? ["-af", filter] : []), "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, String(r.stderr));
  const b = r.stdout as Buffer;
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
}

function runFfmpeg(args: string[]): void {
  const r = spawnSync("ffmpeg", args);
  if (r.status !== 0) throw new Error(`ffmpeg: ${String(r.stderr)}`);
}

/** `deep-filter` de mentira: copia a entrada para o --output-dir, como o binário grava a saída. */
const copyDeepFilter = (calls: string[][] = []) => (args: string[]) => {
  calls.push(args);
  const outDir = args[args.indexOf("--output-dir") + 1];
  copyFileSync(args[args.length - 1], join(outDir, basename(args[args.length - 1])));
};

describe("#13234: escolha do motor", () => {
  it("padrão ffmpeg; env e flag (flag vence); teto só no deepfilternet", () => {
    assert.deepEqual(resolveAudioDenoise({}), { engine: "ffmpeg", attenDb: null, from: "default" });
    assert.deepEqual(resolveAudioDenoise({ env: " " }), { engine: "ffmpeg", attenDb: null, from: "default" });
    assert.deepEqual(resolveAudioDenoise({ env: "DeepFilterNet", attenEnv: "12" }), { engine: "deepfilternet", attenDb: 12, from: "env" });
    assert.deepEqual(resolveAudioDenoise({ env: "deepfilternet", flag: "ffmpeg", attenFlag: "12" }), { engine: "ffmpeg", attenDb: null, from: "flag" });
    assert.deepEqual(resolveAudioDenoise({ flag: "deepfilternet", attenFlag: "18", attenEnv: "6" }).attenDb, 18);
  });
  it("motor ou teto inválido LANÇA (não cai no padrão em silêncio)", () => {
    assert.throws(() => resolveAudioDenoise({ flag: "rnnoise" }), /não é motor conhecido/);
    assert.throws(() => resolveAudioDenoise({ flag: "" }), /não é motor conhecido/);
    assert.throws(() => resolveAudioDenoise({ flag: "deepfilternet", attenFlag: "0" }), /entre 0 e 100/);
    assert.throws(() => resolveAudioDenoise({ flag: "deepfilternet", attenFlag: "abc" }), /entre 0 e 100/);
  });
});

describe("#13234: CLI do deep-filter", () => {
  it("args com --compensate-delay (sincronia com o vídeo) e teto opcional", () => {
    assert.deepEqual(deepFilterArgs({ wav: "/t/in.wav", outDir: "/t/out", attenDb: null }), ["--compensate-delay", "--output-dir", "/t/out", "/t/in.wav"]);
    assert.deepEqual(deepFilterArgs({ wav: "/t/in.wav", outDir: "/t/out", attenDb: 18 }), ["--compensate-delay", "--atten-lim-db", "18", "--output-dir", "/t/out", "/t/in.wav"]);
  });
  it("versão e flags do --help", () => {
    assert.equal(parseDeepFilterVersion("deep-filter 0.5.6\n"), "0.5.6");
    assert.equal(parseDeepFilterVersion("sem versão"), null);
    assert.deepEqual(deepFilterHelpMissingFlags("--compensate-delay --atten-lim-db <X> -o, --output-dir"), []);
    assert.deepEqual(deepFilterHelpMissingFlags("--compensate-delay -o, --out-dir"), ["--atten-lim-db", "--output-dir"]);
  });
  it("sonda do ambiente: ok só com versão e as 3 flags", () => {
    const help = "--compensate-delay --atten-lim-db --output-dir";
    assert.deepEqual(assessDeepFilterProbe({ bin: "deep-filter", version: "deep-filter 0.5.6", help }), { ok: true, detail: "deep-filter 0.5.6" });
    assert.equal(assessDeepFilterProbe({ bin: "deep-filter", version: null, help: null, error: "ENOENT" }).ok, false);
    assert.match(assessDeepFilterProbe({ bin: "deep-filter", version: "deep-filter 0.5.6", help: "--out-dir" }).detail, /sem --compensate-delay, --atten-lim-db, --output-dir/);
  });
  it("hash da faixa muda com motor, versão e teto", () => {
    const ff = cleanAudioKey(audioCleanFilter(audioCleanParams(-45)));
    const keys = new Set([ff, cleanAudioKey(deepFilterDescriptor("0.5.6", null)), cleanAudioKey(deepFilterDescriptor("0.5.7", null)), cleanAudioKey(deepFilterDescriptor("0.5.6", 18))]);
    assert.equal(keys.size, 4);
  });
});

describe("#13234: check-video-env --montagem", () => {
  const ok = { ok: true };
  const base = { ffmpeg: ok, python: ok, model: ok, opencv: ok, drive: ok, disk: ok };
  it("DeepFilterNet ausente é aviso, nunca falta (o build cai no ffmpeg)", () => {
    const probes: MontageEnvProbes = { ...base, deepfilter: { ok: false, detail: "deep-filter indisponível: ENOENT" } };
    const r = assessMontageEnv(probes, "linux", { python: "py", from: "path" });
    assert.equal(r.ready, true);
    assert.deepEqual(r.warnings, ["deepfilter"]);
    assert.match(formatMontageEnvReport(r), /\[aviso\] deepfilter .*docs\/setup\.md/);
  });
  it("sem a sonda (chamada antiga), o item não aparece", () => {
    const r = assessMontageEnv(base, "linux", { python: "py", from: "path" });
    assert.equal(r.items.some((i) => i.id === "deepfilter"), false);
  });
});

describe("#13234: render da faixa com o DeepFilterNet (deps injetadas)", () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "denoise-13234-"));
    return { root, src: join(root, "bruto.wav"), outDir: join(root, "out"), stateDir: join(root, "state") };
  };
  const input = (d: ReturnType<typeof dirs>, attenDb: number | null = null) => ({
    src: d.src, outDir: d.outDir, stateDir: d.stateDir, edition: "261116", mediaPath: "I:/Meu Drive/diaria-studio-video/261116/bruto.mov", thresholdDb: -45,
    denoise: { engine: "deepfilternet" as const, attenDb, from: "flag" as const },
  });
  const quiet = { info: () => {}, debug: () => {} };
  const fakeFfmpeg = (calls: string[][]) => (args: string[]) => { calls.push(args); runFfmpegFake(args); };
  const runFfmpegFake = (args: string[]) => { const out = args[args.length - 1]; writeFileSync(out, "wav"); };

  it("binário ausente: [aviso] e a faixa sai no ffmpeg atual (não no áudio cru)", () => {
    const d = dirs();
    try {
      const warns: string[] = [];
      const calls: string[][] = [];
      const r = renderCleanAudio(input(d), { ...quiet, ffmpeg: fakeFfmpeg(calls), deepFilterVersion: () => null, warn: (m) => warns.push(m) });
      assert.ok(r);
      assert.equal(r.engine, "ffmpeg");
      assert.equal(r.filter, audioCleanFilter(audioCleanParams(-45)));
      assert.match(warns[0], /DeepFilterNet .*não encontrado.*ffmpeg/);
      assert.ok(calls[0].includes(audioCleanFilter(audioCleanParams(-45))));
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("deep-filter falha no meio: [aviso], cai no ffmpeg, sem temporário sobrando", () => {
    const d = dirs();
    try {
      const warns: string[] = [];
      const r = renderCleanAudio(input(d), {
        ...quiet,
        ffmpeg: fakeFfmpeg([]),
        deepFilterVersion: () => "0.5.6",
        deepFilter: () => { throw new Error("deep-filter saiu 1: model not found"); },
        warn: (m) => warns.push(m),
      });
      assert.ok(r);
      assert.equal(r.engine, "ffmpeg");
      assert.match(warns[0], /DeepFilterNet falhou \(deep-filter saiu 1: model not found\)/);
      assert.equal(existsSync(join(d.stateDir, "deepfilter-tmp")), false);
      assert.deepEqual(readdirSync(d.outDir).filter((f) => f.endsWith(".part")), []);
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("sucesso: motor deepfilternet, nome pelo descritor, reaproveita na 2ª e troca de arquivo com outra versão", () => {
    const d = dirs();
    try {
      const df: string[][] = [];
      const deps = { ...quiet, ffmpeg: fakeFfmpeg([]), deepFilter: copyDeepFilter(df), deepFilterVersion: () => "0.5.6", warn: () => assert.fail("sem aviso") };
      writeFileSync(d.src, "bruto");
      const r = renderCleanAudio(input(d, 18), deps);
      assert.ok(r);
      assert.equal(r.engine, "deepfilternet");
      assert.equal(r.filter, deepFilterDescriptor("0.5.6", 18));
      assert.equal(basename(r.path), `261116_audio_tratado-${cleanAudioKey(deepFilterDescriptor("0.5.6", 18), 5)}.wav`);
      assert.ok(df[0].includes("--compensate-delay") && df[0].includes("18"));
      assert.equal(existsSync(join(d.stateDir, "deepfilter-tmp")), false, "temporário limpo");
      assert.equal(renderCleanAudio(input(d, 18), deps)?.reused, true);
      assert.equal(df.length, 1);
      const other = renderCleanAudio(input(d, 18), { ...deps, deepFilterVersion: () => "0.5.7" });
      assert.notEqual(other?.path, r.path);
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });
});

describe("#13234: medidas com áudio sintético", () => {
  it("piso, fala e separação saem do sinal (sem ffmpeg)", () => {
    const s = audioLevelStats(synth(10, -50), RATE);
    assert.ok(Math.abs(s.floorDb + 50) < 1.5, `piso ${s.floorDb}`);
    assert.ok(Math.abs(s.speechDb + 20) < 1.5, `fala ${s.speechDb}`);
    assert.ok(s.separationDb > 27);
  });

  // Medida que reproduz a queixa da issue: com fundo a -50 dBFS (perto do bruto
  // da 261116, piso a -52 dB), a cadeia atual tira só ~4 dB do piso das pausas
  // (medido: -50,1 -> -53,8). O teste trava a direção (piso cai, fala fica), não
  // a magnitude: um motor melhor tem de passar aqui também.
  it("cadeia atual (afftdn + agate) no ffmpeg real: baixa o piso das pausas sem baixar a fala", { skip: !hasFfmpeg && "ffmpeg ausente" }, (t) => {
    const root = mkdtempSync(join(tmpdir(), "denoise-real-13234-"));
    try {
      const src = join(root, "bruto.wav");
      writeWav(src, synth(10, -50));
      const out = join(root, "tratado.wav");
      runFfmpeg(["-y", "-v", "error", "-i", src, "-af", audioCleanFilter(audioCleanParams(-45)), "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", out]);
      const before = audioLevelStats(readWav(src), RATE);
      const after = audioLevelStats(readWav(out), RATE);
      t.diagnostic(`piso ${before.floorDb.toFixed(1)} -> ${after.floorDb.toFixed(1)} dB; fala ${before.speechDb.toFixed(1)} -> ${after.speechDb.toFixed(1)} dB`);
      assert.ok(after.floorDb < before.floorDb - 2, `piso ${before.floorDb.toFixed(1)} -> ${after.floorDb.toFixed(1)}`);
      assert.ok(Math.abs(after.speechDb - before.speechDb) < 3, `fala ${before.speechDb.toFixed(1)} -> ${after.speechDb.toFixed(1)}`);
      assert.ok(after.separationDb > before.separationDb + 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("caminho do DeepFilterNet no ffmpeg real: mesma duração e formato da faixa (sincronia com o vídeo)", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
    const root = mkdtempSync(join(tmpdir(), "denoise-df-13234-"));
    try {
      const src = join(root, "bruto.wav");
      const samples = synth(6, -50);
      writeWav(src, samples);
      const r = renderCleanAudio(
        { src, outDir: join(root, "out"), stateDir: join(root, "state"), edition: "261116", mediaPath: "/x/bruto.mov", thresholdDb: -45, denoise: { engine: "deepfilternet", attenDb: null, from: "flag" } },
        { info: () => {}, debug: () => {}, warn: (m) => assert.fail(m), ffmpeg: runFfmpeg, deepFilter: copyDeepFilter(), deepFilterVersion: () => "0.5.6" },
      );
      assert.ok(r);
      assert.equal(r.engine, "deepfilternet");
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate", "-of", "csv=p=0", r.path], { encoding: "utf8" });
      assert.equal(probe.stdout.trim(), "pcm_s16le,48000,1");
      assert.equal(readWav(r.path).length, samples.length, "mesmo número de amostras do bruto");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("#13234: A/B cego", () => {
  it("variantes: cru e atual sempre; DeepFilterNet (2) só instalado; Adobe só com referência", () => {
    const ids = (o: { deepFilter: boolean; reference: boolean }) => abVariants({ ...o, thresholdDb: -45, reducedAttenDb: 18 }).map((v) => v.id);
    assert.deepEqual(ids({ deepFilter: false, reference: false }), ["cru", "ffmpeg-atual"]);
    assert.deepEqual(ids({ deepFilter: true, reference: true }), ["cru", "ffmpeg-atual", "deepfilternet", "deepfilternet-reduzido", "adobe"]);
  });
  it("letras A.. numa ordem embaralhada e reproduzível por seed, sem perder variante", () => {
    const v = abVariants({ deepFilter: true, reference: true, thresholdDb: -45, reducedAttenDb: 18 });
    const a = blindAssignment(v, seededRandom(3));
    assert.deepEqual(a.map((x) => x.letter), ["A", "B", "C", "D", "E"]);
    assert.deepEqual(a.map((x) => x.variant.id).sort(), v.map((x) => x.id).sort());
    assert.deepEqual(blindAssignment(v, seededRandom(3)), a);
    assert.deepEqual(shuffled([1, 2, 3], () => 0.999), [1, 2, 3]);
  });
});
