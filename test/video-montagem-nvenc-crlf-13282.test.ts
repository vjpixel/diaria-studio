/**
 * #13282 — o aviso de falha do NVENC em `renderTrechos` pega só a 1ª linha da
 * mensagem do ffmpeg. No Windows a saída vem com `\r\n`; o split por `\n`
 * deixava o `\r` no aviso. Não depende do ffmpeg: o `encode` é injetado.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { renderTrechos } from "../scripts/video-montagem.ts";

describe("#13282 aviso do NVENC com \\r\\n", () => {
  it("o aviso leva só a 1ª linha da mensagem, sem \\r", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13282-"));
    try {
      const source: SourceInfo = { path: join(dir, "b.mp4"), fps: 30, durationS: 10, width: 3840, height: 2160, mirrored: false };
      const lines: string[] = [];
      const encode = (args: string[]) => {
        if (args[args.indexOf("-c:v") + 1] === "h264_nvenc") throw new Error("ffmpeg saiu 1: No capable devices found\r\nsegunda linha\r\n");
        writeFileSync(args[args.length - 1], "");
      };
      renderTrechos({
        plans: [{ clips: [{ frameIn: 30, frameOut: 60 }] as never }],
        source,
        outDir: dir,
        mediaPath: "I:/v/b.mp4",
        folgaS: 1,
        listEncoders: () => " V....D h264_nvenc NVIDIA NVENC H.264 encoder",
        encode,
        log: (m) => lines.push(m),
      });
      const aviso = lines.find((l) => l.includes("h264_nvenc falhou"));
      assert.ok(aviso, "esperava o [aviso] do NVENC");
      assert.ok(!aviso.includes("\r"), `aviso com \\r: ${JSON.stringify(aviso)}`);
      assert.ok(!aviso.includes("segunda linha"));
      assert.match(aviso, /\(ffmpeg saiu 1: No capable devices found\): os trechos seguem em libx264/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
