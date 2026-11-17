/**
 * #13368 (R1 da #13199): `blackdetect` e `freezedetect` no `review-final`,
 * com a vinheta e o card de CTA (#111111 com fade a partir do preto) fora da
 * janela de checagem. A fixture é a saída real do ffmpeg 8 sobre um export
 * sintético de 16 s: 8 s de imagem, 1 s preto (8–9 s), 3 s congelados
 * (9–12 s) e o card de 4 s (12–16 s), que o `blackdetect` acusa inteiro como
 * preto e o `freezedetect` como congelado até o fim, sem `freeze_end`.
 *
 * #13371 (R4): a prévia normaliza em duas passadas, com o alvo do export.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLACK_FREEZE_FILTER,
  BLACK_FREEZE_MARGIN_S,
  FINAL_MAX_TRUE_PEAK_DBTP,
  FINAL_TARGET_LUFS,
  OPENING_FALLBACK_S,
  blackFreezeWindows,
  checkBlackFreeze,
  parseBlackdetect,
  parseFreezedetect,
  subtractWindows,
} from "../scripts/lib/diaria/video-final-review.ts";
import {
  AUDIO_GAIN_TARGET_LUFS,
  LOUDNORM_TARGET,
  PREVIEW_LOUDNORM,
  PREVIEW_RAW_NAME,
  loudnormSecondPassFilter,
  parseLoudnormFirstPass,
  parseLoudnormJson,
  previewLoudnormApplyArgs,
  previewLoudnormMeasureArgs,
  type SequencePlan,
} from "../scripts/lib/diaria/video-montage.ts";

const FIXTURE = readFileSync(new URL("./fixtures/video-blackfreeze-13368/ffmpeg8-detect.log", import.meta.url), "utf8");
const DURATION_S = 16;
const FPS = 30;
const CTA_S = 4;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Plano mínimo: a montagem termina em 12 s (o card vem depois), sem bloco de abertura (vinheta aos 2 s). */
function planEndingAt(s: number): SequencePlan {
  return { clips: [], durationFrames: Math.round(s * FPS) } as unknown as SequencePlan;
}

describe("#13368 parse do blackdetect e do freezedetect (fixture do ffmpeg 8)", () => {
  it("lê os trechos pretos", () => {
    const black = parseBlackdetect(FIXTURE);
    assert.equal(black.length, 2);
    assert.deepEqual(black[0], { start: 8, end: 9 });
    assert.equal(black[1].start, 12);
    assert.ok(Math.abs(black[1].end - 15.966667) < 1e-6);
  });

  it("lê os congelados e fecha no fim do arquivo o que não tem freeze_end (o card)", () => {
    assert.deepEqual(parseFreezedetect(FIXTURE, DURATION_S), [
      { start: 9, end: 12 },
      { start: 12.5, end: DURATION_S },
    ]);
  });

  it("log sem os detectores não acha nada", () => {
    assert.deepEqual(parseBlackdetect("frame=  480 fps=0.0 q=-0.0 Lsize=N/A"), []);
    assert.deepEqual(parseFreezedetect("", DURATION_S), []);
  });
});

describe("#13368 janelas fora da checagem: vinheta e card de CTA", () => {
  it("com plano: vinheta aos 2 s (sem título) e o card na cauda, com folga", () => {
    const w = blackFreezeWindows({ durationS: DURATION_S, ctaCardS: CTA_S, plan: planEndingAt(12), fps: FPS, vinhetaS: 1.3 });
    const vin = w.find((x) => x.label === "vinheta");
    const card = w.find((x) => x.label === "card de CTA");
    assert.ok(vin && card);
    assert.equal(vin.start, 2 - BLACK_FREEZE_MARGIN_S);
    assert.ok(Math.abs(vin.end - (3.3 + BLACK_FREEZE_MARGIN_S)) < 1e-9);
    assert.equal(card.start, 12 - BLACK_FREEZE_MARGIN_S);
    assert.equal(card.end, DURATION_S);
  });

  it("export que termina onde a montagem termina não tem card: nenhuma janela no fim", () => {
    const w = blackFreezeWindows({ durationS: 12, ctaCardS: CTA_S, plan: planEndingAt(12), fps: FPS });
    assert.equal(w.some((x) => x.label === "card de CTA"), false);
  });

  it("sem plano: a abertura até OPENING_FALLBACK_S e o card presumido na cauda", () => {
    const w = blackFreezeWindows({ durationS: DURATION_S, ctaCardS: CTA_S, plan: null, fps: null });
    assert.deepEqual(w, [
      { label: "abertura", start: 0, end: OPENING_FALLBACK_S },
      { label: "card de CTA", start: DURATION_S - CTA_S - BLACK_FREEZE_MARGIN_S, end: DURATION_S },
    ]);
  });

  it("subtractWindows corta o trecho que entra na janela", () => {
    assert.deepEqual(subtractWindows({ start: 9, end: 14 }, [{ start: 11.5, end: 16 }]), [{ start: 9, end: 11.5 }]);
    assert.deepEqual(subtractWindows({ start: 12, end: 15 }, [{ start: 11.5, end: 16 }]), []);
    assert.deepEqual(subtractWindows({ start: 1, end: 10 }, [{ start: 3, end: 4 }]), [{ start: 1, end: 3 }, { start: 4, end: 10 }]);
  });
});

describe("#13368 achados do export sintético", () => {
  const black = parseBlackdetect(FIXTURE);
  const freeze = parseFreezedetect(FIXTURE, DURATION_S);

  for (const withPlan of [true, false]) {
    it(`${withPlan ? "com" : "sem"} plano: acusa o preto e o congelado do meio, nunca o card de CTA`, () => {
      const plan = withPlan ? planEndingAt(12) : null;
      const fps = withPlan ? FPS : null;
      const exclude = blackFreezeWindows({ durationS: DURATION_S, ctaCardS: CTA_S, plan, fps, vinhetaS: 1.3 });
      const f = checkBlackFreeze({ black, freeze, exclude, plan, fps });
      assert.deepEqual(f.map((x) => [x.kind, x.at]), [["quadro-preto", 8], ["congelado", 9]]);
      assert.match(f[0].what, /1,0 s \(0:08,00 a 0:09,00\) de imagem preta/);
      assert.match(f[1].fix, /reexportar/);
    });
  }

  it("só o card no fim (export limpo): nenhum achado", () => {
    const exclude = blackFreezeWindows({ durationS: DURATION_S, ctaCardS: CTA_S, plan: planEndingAt(12), fps: FPS });
    const f = checkBlackFreeze({ black: [{ start: 12, end: 15.966667 }], freeze: [{ start: 12.5, end: DURATION_S }], exclude });
    assert.deepEqual(f, []);
  });

  it("preto na vinheta não acusa; preto curto que sobra fora da folga também não", () => {
    const exclude = blackFreezeWindows({ durationS: DURATION_S, ctaCardS: CTA_S, plan: planEndingAt(12), fps: FPS, vinhetaS: 1.3 });
    // 2,0–3,9 s: a vinheta (2–3,3 s) + folga até 3,8 s; sobram 0,1 s, abaixo do mínimo de 0,5 s.
    assert.deepEqual(checkBlackFreeze({ black: [{ start: 2, end: 3.9 }], freeze: [], exclude }), []);
  });

  it("sem card no export, preto no fim é achado", () => {
    const exclude = blackFreezeWindows({ durationS: 12, ctaCardS: CTA_S, plan: planEndingAt(12), fps: FPS });
    const f = checkBlackFreeze({ black: [{ start: 10, end: 12 }], freeze: [], exclude });
    assert.deepEqual(f.map((x) => x.kind), ["quadro-preto"]);
  });

  it("o export sintético de verdade, pelo ffmpeg desta máquina, dá os mesmos achados", { skip: !hasFfmpeg }, () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-13368-"));
    try {
      const mp4 = join(dir, "export.mp4");
      const mk = spawnSync("ffmpeg", [
        "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=8",
        "-f", "lavfi", "-i", "color=c=black:size=320x180:rate=30:duration=1",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1",
        "-f", "lavfi", "-i", "color=c=0x111111:size=320x180:rate=30:duration=4",
        "-filter_complex", "[2:v]trim=end_frame=1,loop=loop=89:size=1:start=0,setpts=N/30/TB[fz];[3:v]fade=t=in:st=0:d=0.5[cta];[0:v][1:v][fz][cta]concat=n=4:v=1:a=0,format=yuv420p[v]",
        "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", mp4,
      ]);
      assert.equal(mk.status, 0, String(mk.stderr));
      const log = String(spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", mp4, "-vf", BLACK_FREEZE_FILTER, "-an", "-f", "null", "-"]).stderr);
      const exclude = blackFreezeWindows({ durationS: DURATION_S, ctaCardS: CTA_S, plan: planEndingAt(12), fps: FPS, vinhetaS: 1.3 });
      const f = checkBlackFreeze({ black: parseBlackdetect(log), freeze: parseFreezedetect(log, DURATION_S), exclude });
      assert.deepEqual(f.map((x) => x.kind), ["quadro-preto", "congelado"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13371 prévia: loudnorm em duas passadas com o alvo do export", () => {
  it("o alvo da prévia é o do export (review-final) e o do ganho do XML", () => {
    assert.equal(PREVIEW_LOUDNORM.i, FINAL_TARGET_LUFS);
    assert.equal(PREVIEW_LOUDNORM.i, AUDIO_GAIN_TARGET_LUFS);
    assert.equal(PREVIEW_LOUDNORM.tp, FINAL_MAX_TRUE_PEAK_DBTP);
    assert.equal(LOUDNORM_TARGET, "loudnorm=I=-14:TP=-1:LRA=11");
  });

  const PASS1 = `[Parsed_loudnorm_0 @ 0x1]
{
	"input_i" : "-27.61",
	"input_tp" : "-9.84",
	"input_lra" : "6.20",
	"input_thresh" : "-38.02",
	"output_i" : "-14.23",
	"output_tp" : "-1.00",
	"output_lra" : "5.10",
	"output_thresh" : "-24.60",
	"normalization_type" : "dynamic",
	"target_offset" : "0.23"
}`;

  it("lê a 1ª passada e monta a 2ª com os valores medidos e ganho linear", () => {
    const m = parseLoudnormFirstPass(PASS1);
    assert.deepEqual(m, { inputI: -27.61, inputTp: -9.84, inputLra: 6.2, inputThresh: -38.02, targetOffset: 0.23 });
    assert.equal(
      loudnormSecondPassFilter(m!),
      "loudnorm=I=-14:TP=-1:LRA=11:measured_I=-27.61:measured_TP=-9.84:measured_LRA=6.2:measured_thresh=-38.02:offset=0.23:linear=true",
    );
    // a medida de sempre (bruto) continua lendo o mesmo bloco
    assert.equal(parseLoudnormJson(PASS1)?.inputI, -27.61);
  });

  it("silêncio digital (-inf) ou sem resumo: sem 2ª passada (o CLI cai na passada única)", () => {
    assert.equal(parseLoudnormFirstPass(PASS1.replace('"-27.61"', '"-inf"').replace('"-38.02"', '"-inf"')), null);
    assert.equal(parseLoudnormFirstPass("nada aqui"), null);
  });

  it("medida só do áudio do render; aplicação copia o vídeo", () => {
    assert.deepEqual(previewLoudnormMeasureArgs(PREVIEW_RAW_NAME).slice(-7), [PREVIEW_RAW_NAME, "-vn", "-af", `${LOUDNORM_TARGET}:print_format=json`, "-f", "null", "-"]);
    const a = previewLoudnormApplyArgs({ src: PREVIEW_RAW_NAME, out: "previa.mp4", filter: "anull" });
    assert.ok(a.join(" ").includes("-c:v copy"));
    assert.ok(a.join(" ").includes("-af anull"));
    assert.equal(a.at(-1), "previa.mp4");
  });

  it("o render da prévia não normaliza mais em uma passada; normalizePreviewAudio roda antes da cópia", () => {
    const src = readFileSync(new URL("../scripts/video-montagem.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /loudnorm: LOUDNORM_TARGET/);
    assert.doesNotMatch(src, /"-af", LOUDNORM_TARGET\]/);
    assert.match(src, /normalizePreviewAudio\(dir\);\n\s*copyFileSync\(join\(dir, "previa\.mp4"\), out\);/);
  });

  it("áudio a -30 LUFS sai a -14 LUFS (±1) depois das duas passadas, pelo ffmpeg desta máquina", { skip: !hasFfmpeg }, () => {
    const dir = mkdtempSync(join(tmpdir(), "ln-13371-"));
    try {
      const mk = spawnSync("ffmpeg", [
        "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=12",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12,volume=-36dB",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le", PREVIEW_RAW_NAME,
      ], { cwd: dir });
      assert.equal(mk.status, 0, String(mk.stderr));
      const m = parseLoudnormFirstPass(String(spawnSync("ffmpeg", previewLoudnormMeasureArgs(PREVIEW_RAW_NAME), { cwd: dir }).stderr));
      assert.ok(m, "1ª passada sem medida");
      assert.ok(m.inputI < -20, `entrada deveria estar baixa, mediu ${m.inputI}`);
      const ap = spawnSync("ffmpeg", previewLoudnormApplyArgs({ src: PREVIEW_RAW_NAME, out: "previa.mp4", filter: loudnormSecondPassFilter(m) }), { cwd: dir });
      assert.equal(ap.status, 0, String(ap.stderr));
      const out = parseLoudnormJson(String(spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", "previa.mp4", "-vn", "-af", `${LOUDNORM_TARGET}:print_format=json`, "-f", "null", "-"], { cwd: dir }).stderr));
      assert.ok(out);
      assert.ok(Math.abs(out.inputI - FINAL_TARGET_LUFS) <= 1, `prévia em ${out.inputI} LUFS`);
      assert.ok(out.inputTp <= FINAL_MAX_TRUE_PEAK_DBTP + 0.5, `true peak ${out.inputTp}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
