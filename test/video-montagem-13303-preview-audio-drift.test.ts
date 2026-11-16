/**
 * test/video-montagem-13303-preview-audio-drift.test.ts — #13303: a prévia
 * acumulava ~24 ms de atraso de áudio por corte (AAC por clipe + concat copy).
 * O áudio agora sai em PCM com amostras exatas por quadro; com N clipes de
 * `srcIn` fora da grade de quadros a faixa concatenada tem a duração do vídeo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewClipAudioArgs, previewClipArgs } from "../scripts/lib/diaria/video-montage.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const FPS = 30;
const N = 55;

function dur(file: string): number {
  return Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim());
}

describe("previewClipAudioArgs (#13303)", () => {
  it("fixa as amostras do clipe: round(quadros*48000/fps), sem AAC", () => {
    const a = previewClipAudioArgs({ audioSrc: "a.wav", start: 1315.356, frames: 47, fps: FPS, out: "o.wav" });
    const joined = a.join(" ");
    assert.match(joined, /atrim=end_sample=75200/);
    assert.match(joined, /apad=whole_len=75200/);
    assert.ok(a.includes("pcm_s16le"));
    assert.ok(!a.includes("aac"));
  });
  it("recusa clipe vazio", () => {
    assert.throws(() => previewClipAudioArgs({ audioSrc: "a.wav", start: 0, frames: 0, fps: FPS, out: "o.wav" }));
  });
  it("o vídeo segue cortado por quadro (start/end como antes)", () => {
    const v = previewClipArgs({ src: "b.mp4", start: 10, end: 11.5, crop: { x: 0, y: 0, w: 100, h: 100 }, mirrored: false, fps: FPS, out: "o.mp4" });
    assert.ok(v.includes("10.000") && v.includes("11.500"));
  });

  it("55 clipes fora da grade: vídeo e áudio da prévia terminam juntos, na duração dos quadros", { skip: !hasFfmpeg }, () => {
    const dir = mkdtempSync(join(tmpdir(), "drift13303-"));
    const run = (a: string[]) => assert.equal(spawnSync("ffmpeg", a).status, 0);
    try {
      const src = join(dir, "src.mp4");
      run(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=140", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=140", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
      const crop = { x: 0, y: 0, w: 320, h: 240 };
      const build = (videoOnly: boolean) => {
        const vids: string[] = [], auds: string[] = [];
        let totalFrames = 0;
        for (let i = 0; i < N; i++) {
          const frames = 31 + (i % 7) * 13;
          const audioStart = 1.3333 + i * 2.0177; // srcIn fora da grade de 1/30 s
          const fi = Math.round(audioStart * FPS);
          totalFrames += frames;
          const v = join(dir, `${videoOnly ? "n" : "o"}${i}.mp4`);
          run(previewClipArgs({ src, start: fi / FPS, end: (fi + frames) / FPS, crop, mirrored: false, fps: FPS, out: v, width: 320, height: 240, audioSrc: src, audioStart, videoOnly }));
          vids.push(v);
          if (videoOnly) {
            const w = join(dir, `a${i}.wav`);
            run(previewClipAudioArgs({ audioSrc: src, start: audioStart, frames, fps: FPS, out: w }));
            auds.push(w);
          }
        }
        const list = (xs: string[], f: string) => { writeFileSync(f, xs.map((p) => `file '${p}'`).join("\n") + "\n"); return f; };
        const joined = join(dir, `${videoOnly ? "n" : "o"}-j.mp4`);
        run(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list(vids, join(dir, "v.txt")), "-c", "copy", joined]);
        if (!videoOnly) return { joined, totalFrames };
        const wav = join(dir, "exact.wav");
        run(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list(auds, join(dir, "a.txt")), "-c", "copy", wav]);
        const fin = join(dir, "final.mp4");
        run(["-y", "-v", "error", "-i", joined, "-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", fin]);
        return { joined: fin, totalFrames };
      };
      const stream = (f: string, t: string) => Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", t, "-show_entries", "stream=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim());

      const old = build(false);
      const fixed = build(true);
      const expected = fixed.totalFrames / FPS;
      const oldDrift = stream(old.joined, "v:0") - expected;
      assert.ok(oldDrift > 0.5, `controle: o caminho antigo deveria inflar a linha do tempo (inflou ${oldDrift.toFixed(3)} s)`);
      assert.ok(Math.abs(stream(fixed.joined, "v:0") - expected) < 0.05, `vídeo ${stream(fixed.joined, "v:0")} s, esperado ${expected} s`);
      assert.ok(Math.abs(stream(fixed.joined, "a:0") - expected) < 0.05, `áudio ${stream(fixed.joined, "a:0")} s, esperado ${expected} s`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
