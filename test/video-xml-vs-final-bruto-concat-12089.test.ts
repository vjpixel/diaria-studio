/**
 * test/video-xml-vs-final-bruto-concat-12089.test.ts
 *
 * #12089 (medir as pausas que o editor ainda corta, comparando o XML gerado
 * com o final exportado) e #13225: a comparação da 261116 saiu pulada porque o
 * bruto tinha 8 arquivos e o cache da montagem já estava podado. O fallback
 * agora concatena o áudio dos arquivos na ordem de `source.files`, cada um com
 * a duração exata dele na linha do tempo (`frames/fps`), ou usa o concatenado
 * que a montagem deixou. Sem cópia local de algum arquivo, segue pulando,
 * dizendo quais faltam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brutoAudioStep, brutoFileName, brutoWav, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";
import { parseWavPcm16 } from "../scripts/lib/diaria/video-cut-refine.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "xml-vs-final-12089-"));

const plan = (files: NonNullable<PlanFileLite["source"]["files"]>, fps = 30): PlanFileLite => ({
  plans: [],
  source: { fps, path: files[0]?.path, files },
});

const has = (paths: string[]) => (p: string) => paths.includes(p);

describe("#12089/#13225: de onde sai o áudio do bruto (brutoAudioStep)", () => {
  const files = [
    { id: "a", path: "I:/Meu Drive/v/261116/a.mp4", frames: 300 },
    { id: "b", path: "I:/Meu Drive/v/261116/b.mp4", frames: 150 },
  ];

  it("o audio.wav do cache da montagem vence tudo", () => {
    const s = brutoAudioStep({ cached: "/w/audio.wav", montageConcat: "/w/m.wav", pf: plan(files), local: [null, null], exists: has(["/w/audio.wav", "/w/m.wav"]) });
    assert.deepEqual(s, { kind: "cached", wav: "/w/audio.wav" });
  });

  it("sem audio.wav, o concatenado da montagem (linha do tempo global) é usado", () => {
    const s = brutoAudioStep({ cached: "/w/audio.wav", montageConcat: "/w/m.wav", pf: plan(files), local: [null, null], exists: has(["/w/m.wav"]) });
    assert.deepEqual(s, { kind: "montage-concat", src: "/w/m.wav" });
  });

  it("com cópia local de todos os arquivos, concatena na ordem com a duração de cada um (frames/fps)", () => {
    const s = brutoAudioStep({ cached: "/w/audio.wav", montageConcat: "/w/m.wav", pf: plan(files), local: ["/c/a.mp4", "/c/b.mp4"], exists: has([]) });
    assert.deepEqual(s, { kind: "concat", parts: [{ src: "/c/a.mp4", durationS: 10 }, { src: "/c/b.mp4", durationS: 5 }] });
  });

  it("arquivo sem cópia local: pula, nomeando o arquivo e o --fetch-bruto", () => {
    const s = brutoAudioStep({ cached: "/w/audio.wav", montageConcat: "/w/m.wav", pf: plan(files), local: ["/c/a.mp4", null], exists: has([]) });
    assert.equal(s.kind, "skip");
    assert.ok(s.kind === "skip" && /bruto em 2 arquivos/.test(s.reason) && /b\.mp4/.test(s.reason) && /--fetch-bruto/.test(s.reason), JSON.stringify(s));
  });

  it("arquivo sem frames no plan.json: pula em vez de concatenar desalinhado", () => {
    const s = brutoAudioStep({ cached: "/w/audio.wav", montageConcat: "/w/m.wav", pf: plan([files[0], { id: "b", path: "/x/b.mp4" }]), local: ["/c/a.mp4", "/c/b.mp4"], exists: has([]) });
    assert.equal(s.kind, "skip");
    assert.ok(s.kind === "skip" && /fps\/frames/.test(s.reason));
  });

  it("bruto único: o próprio arquivo, ou pula fora desta máquina", () => {
    const single: PlanFileLite = { plans: [], source: { fps: 30, path: "/c/x.mp4" } };
    assert.deepEqual(brutoAudioStep({ cached: "/w/audio.wav", montageConcat: "/w/m.wav", pf: single, local: [], exists: has(["/c/x.mp4"]) }), { kind: "single", src: "/c/x.mp4" });
    const s = brutoAudioStep({ cached: "/w/audio.wav", montageConcat: "/w/m.wav", pf: single, local: [], exists: has([]) });
    assert.ok(s.kind === "skip" && /bruto fora desta máquina/.test(s.reason));
  });

  it("brutoFileName: nome do path (com / ou \\) ou o id + .mp4", () => {
    assert.equal(brutoFileName({ path: "I:/Meu Drive/v/261116/20261115_180708.mp4" }), "20261115_180708.mp4");
    assert.equal(brutoFileName({ path: "I:\\Meu Drive\\v\\a.mp4" }), "a.mp4");
    assert.equal(brutoFileName({ id: "20261115_181627" }), "20261115_181627.mp4");
    assert.equal(brutoFileName({}), null);
  });
});

describe("#12089/#13225: concatenação real do áudio do bruto em vários arquivos (ffmpeg)", () => {
  it("o 2º arquivo começa no offset da linha do tempo, mesmo com o 1º mais curto que frames/fps", async () => {
    const dir = tmp();
    const tone = (out: string, s: number, freq: number) => {
      const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:duration=${s}`, "-ac", "2", "-c:a", "pcm_s16le", out]);
      assert.equal(r.status, 0, String(r.stderr));
    };
    const a = join(dir, "a.wav");
    const b = join(dir, "b.wav");
    tone(a, 1.0, 440); // o arquivo tem 1,0 s de áudio, mas 1,2 s (36 quadros a 30 fps) na linha do tempo
    tone(b, 0.5, 880);
    const pf = plan([
      { id: "a", path: "/nao-existe/a.wav", frames: 36 },
      { id: "b", path: "/nao-existe/b.wav", frames: 15 },
    ]);
    const edition = `t${Date.now()}`.slice(-6);
    const local: Record<string, string> = { a, b };
    const res = await brutoWav(edition, join(dir, "work"), pf, async (_e, f) => local[f.id as string] ?? null);
    assert.ok(res.wav, JSON.stringify(res));
    const wav = parseWavPcm16(readFileSync(res.wav as string));
    assert.equal(wav.sampleRate, 16000);
    const durS = wav.samples.length / wav.sampleRate;
    assert.ok(Math.abs(durS - 1.7) < 0.01, `duração ${durS}`);
    const rms = (from: number, to: number) => {
      const xs = wav.samples.subarray(Math.round(from * 16000), Math.round(to * 16000));
      return Math.sqrt(xs.reduce((acc, x) => acc + x * x, 0) / xs.length);
    };
    assert.ok(rms(1.05, 1.15) < 50, "o vão entre o fim do áudio do 1º arquivo e o offset do 2º é silêncio (apad)");
    assert.ok(rms(1.25, 1.65) > 1000, "o 2º arquivo começa em 1,2 s, o offset dele na linha do tempo");
  });

  it("sem resolvedor, um plan multi-arquivo segue pulado com a lista do que falta", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.mp4"), "x");
    const res = await brutoWav("261116", join(dir, "work"), plan([{ id: "a", path: join(dir, "a.mp4"), frames: 30 }, { id: "b", path: join(dir, "b.mp4"), frames: 30 }]));
    assert.equal(res.wav, null);
    assert.ok(res.wav === null && /2 sem cópia/.test(res.reason));
  });
});
