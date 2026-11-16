/**
 * test/video-xml-vs-final-bruto-concat-12089.test.ts
 *
 * #12089 (medir as pausas que o editor ainda corta, comparando o XML gerado
 * com o final exportado) e #13225: a comparação da 261116 saiu pulada porque o
 * bruto tinha 8 arquivos e o cache da montagem já estava podado. Sem o
 * `audio.wav`, o bruto multi-arquivo usa o concatenado que a montagem deixou
 * (`MULTI_AUDIO_FILE`) ou concatena os arquivos, cada um com a duração exata
 * dele na linha do tempo (`frames/fps`). No modo API, o Drive só é baixado com
 * `--fetch-bruto`, e o motivo do pulo diz isso. A busca em várias fontes (HD,
 * cache, Drive) está em test/video-xml-vs-final-bruto-lookup-13196.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brutoWav, type BrutoLookup, type Finder, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";
import { MULTI_AUDIO_FILE } from "../scripts/video-montagem.ts";
import { brutoParts } from "../scripts/lib/diaria/video-xml-vs-final.ts";
import { parseWavPcm16 } from "../scripts/lib/diaria/video-cut-refine.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "xml-vs-final-12089-"));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
/** Edição falsa e única por teste: o áudio montado fica em `tmpdir()/diaria-video-xml-vs-final/{AAMMDD}` e seria reaproveitado. */
const fakeEdition = () => `8${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
const NO_LOOKUP: BrutoLookup = { archiveRoot: null, montageEditionCache: () => null };
const finderWith = (mode: Finder["mode"], brutoFile: Finder["brutoFile"]): Finder => ({ mode, list: async () => [], workDir: () => "/nao-existe-work", brutoFile });

const plan = (files: NonNullable<PlanFileLite["source"]["files"]>, fps = 30): PlanFileLite => ({
  plans: [],
  source: { fps, path: files[0]?.path, files },
});

function tone(out: string, s: number, freq: number): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:duration=${s}`, "-ac", "2", "-c:a", "pcm_s16le", out]);
  assert.equal(r.status, 0, String(r.stderr));
}

describe("#12089: nome do arquivo do bruto sem path", () => {
  it("arquivo só com id no plan.json: nome `{id}.mp4`", () => {
    const r = brutoParts({ fps: 30, files: [{ id: "20261115_180708", frames: 30, offsetFrames: 0 }, { id: "20261115_181627", frames: 30, offsetFrames: 30 }] });
    assert.ok(r.parts, JSON.stringify(r));
    assert.deepEqual(r.parts.map((p) => p.name), ["20261115_180708.mp4", "20261115_181627.mp4"]);
  });
});

describe("#12089/#13225: áudio do bruto em vários arquivos (ffmpeg)", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
  it("o 2º arquivo começa no offset da linha do tempo, mesmo com o 1º mais curto que frames/fps", async () => {
    const dir = tmp();
    const a = join(dir, "a.wav");
    const b = join(dir, "b.wav");
    tone(a, 1.0, 440); // o arquivo tem 1,0 s de áudio, mas 1,2 s (36 quadros a 30 fps) na linha do tempo
    tone(b, 0.5, 880);
    const pf = plan([
      { id: "a", path: "/nao-existe/a.wav", frames: 36, offsetFrames: 0 },
      { id: "b", path: "/nao-existe/b.wav", frames: 15, offsetFrames: 36 },
    ]);
    const local: Record<string, string> = { "a.wav": a, "b.wav": b };
    const res = await brutoWav(fakeEdition(), join(dir, "work"), pf, finderWith("local", async (_e, name) => local[name] ?? null), NO_LOOKUP);
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

  it("sem audio.wav, o concatenado da montagem (bruto-audio-48k.wav) é usado sem procurar os arquivos", async () => {
    const dir = tmp();
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    tone(join(work, MULTI_AUDIO_FILE), 1.5, 440);
    const asked: string[] = [];
    const pf = plan([
      { id: "a", path: "/nao-existe/a.wav", frames: 30, offsetFrames: 0 },
      { id: "b", path: "/nao-existe/b.wav", frames: 15, offsetFrames: 30 },
    ]);
    const res = await brutoWav(fakeEdition(), work, pf, finderWith("local", async (_e, name) => (asked.push(name), null)), NO_LOOKUP);
    assert.ok(res.wav, JSON.stringify(res));
    const wav = parseWavPcm16(readFileSync(res.wav as string));
    assert.equal(wav.sampleRate, 16000);
    assert.ok(Math.abs(wav.samples.length / wav.sampleRate - 1.5) < 0.01);
    assert.deepEqual(asked, [], "o concatenado da montagem dispensa a busca dos arquivos");
  });

  it("modo API sem cópia de algum arquivo: pula nomeando o arquivo e o --fetch-bruto", async () => {
    const dir = tmp();
    const pf = plan([
      { id: "a", path: "/nao-existe/a.wav", frames: 30, offsetFrames: 0 },
      { id: "b", path: "/nao-existe/b.wav", frames: 30, offsetFrames: 30 },
    ]);
    const res = await brutoWav(fakeEdition(), join(dir, "work"), pf, finderWith("api", async () => null), NO_LOOKUP);
    assert.equal(res.wav, null);
    assert.ok(res.wav === null && /a\.wav não achado/.test(res.reason) && /--fetch-bruto/.test(res.reason), JSON.stringify(res));
  });
});
