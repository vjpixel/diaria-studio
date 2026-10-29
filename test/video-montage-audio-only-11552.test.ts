/**
 * #11552: na edição 261029 o editor pediu a montagem a partir de um arquivo
 * só de áudio (os comentários gravados, sem vídeo) e o `transcribe` morreu com
 * "ffprobe sem stream de vídeo". Agora o bruto sem vídeo segue no modo áudio
 * (transcrição, decupagem, roteiro) e os passos que precisam de imagem param
 * com exit 3 e o motivo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIO_ONLY_FPS, parseProbe, pickRawSource } from "../scripts/lib/diaria/video-montage.ts";
import { VIDEO_ONLY_COMMANDS, main as videoMontagemMain } from "../scripts/video-montagem.ts";

const probe = (streams: unknown[], duration = "312.5") => JSON.stringify({ streams, format: { duration } });

test("parseProbe: só stream de áudio → modo áudio (antes: 'ffprobe sem stream de vídeo')", () => {
  const s = parseProbe(probe([{ codec_type: "audio", sample_rate: "48000" }]), "G:/261029/comentarios.m4a");
  assert.deepEqual(s, { path: "G:/261029/comentarios.m4a", fps: AUDIO_ONLY_FPS, durationS: 312.5, width: 0, height: 0, mirrored: false, audioOnly: true });
});

test("parseProbe: capa embutida (attached_pic) não é vídeo; sem áudio nem vídeo segue erro", () => {
  const s = parseProbe(probe([{ codec_type: "audio" }, { codec_type: "video", width: 600, height: 600, r_frame_rate: "90000/1", disposition: { attached_pic: 1 } }]), "x.mp3");
  assert.equal(s.audioOnly, true);
  assert.throws(() => parseProbe(probe([{ codec_type: "data" }]), "x"), /sem stream de vídeo/);
  const video = parseProbe(probe([{ codec_type: "video", width: 3840, height: 2160, r_frame_rate: "30/1" }, { codec_type: "audio" }]), "v.mp4");
  assert.equal("audioOnly" in video, false, "bruto de vídeo não ganha o campo");
});

test("pickRawSource: vídeo continua tendo precedência; sem vídeo, o maior áudio", () => {
  assert.equal(pickRawSource([{ name: "a.m4a", size: 9 }, { name: "b.mp4", size: 1 }])?.pick.name, "b.mp4");
  const audio = pickRawSource([{ name: "comentarios.m4a", size: 9 }, { name: "teste.mp3", size: 2 }, { name: "x.xml", size: 99 }]);
  assert.equal(audio?.pick.name, "comentarios.m4a");
  assert.equal(audio?.audioOnly, true);
  assert.equal(audio?.candidates.length, 2);
  assert.equal(pickRawSource([{ name: "x.xml", size: 1 }]), null);
});

test("modo áudio: frame/build/srt/preview/review saem 3 com o motivo, sem tentar ler blocks/plan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vm-11552-"));
  const origLog = console.log;
  const origErr = console.error;
  const out: string[] = [];
  try {
    writeFileSync(join(dir, "source.json"), JSON.stringify({ path: "G:/261029/comentarios.m4a", fps: 30, durationS: 312.5, width: 0, height: 0, mirrored: false, audioOnly: true }));
    console.log = (s: string) => out.push(String(s));
    console.error = () => {};
    for (const cmd of VIDEO_ONLY_COMMANDS) {
      out.length = 0;
      const code = await videoMontagemMain([cmd, "261029", "--state-dir", dir, "--at", "1"]);
      assert.equal(code, 3, cmd);
      const j = JSON.parse(out.join("\n"));
      assert.equal(j.audio_only, true);
      assert.equal(j.command, cmd);
      assert.match(j.reason, /só de áudio/);
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    rmSync(dir, { recursive: true, force: true });
  }
});
