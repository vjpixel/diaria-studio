/**
 * #12209: follow-ups do review consolidado (#12195 × #12196) no video-montagem.
 *  1. legenda do `--from-final` defasada depois de um rebuild do horizontal;
 *  2. comentário do cabeçalho com o nome real da faixa tratada;
 *  3. ganho do XML medido na faixa tratada, não no bruto;
 *  4. no modo API o build garante o bruto antes do render da faixa tratada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyYoutubeSrtCopy,
  audioGainLine,
  buildNeedsLocalBruto,
  exportOriginOf,
  gainLoudnessSource,
  measureTreatedLoudness,
  recordedExportAt,
  youtubeSrtCopyDecision,
} from "../scripts/video-montagem.ts";
import { audioGainFor } from "../scripts/lib/diaria/video-montage.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "vm-12209-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("#12209 item 1: cópia do --from-final defasada depois de um rebuild", () => {
  const T_EXPORT_V1 = Date.parse("2026-11-04T10:00:00Z");
  const T_REBUILD = Date.parse("2026-11-04T11:00:00Z");

  it("regressão: export V1 → rebuild → srt da montagem troca a cópia (replace-stale-export) em vez de mantê-la", () =>
    withDir((dir) => {
      const p = { path: join(dir, "edicao", "diaria-comentada-261104.srt"), recordPath: join(dir, "state", "youtube-srt.json") };
      applyYoutubeSrtCopy({ ...p, srt: "EXPORT V1", force: false, origin: { name: "V1.mp4", size: 10, mtimeMs: T_EXPORT_V1 } });
      const rec = JSON.parse(readFileSync(p.recordPath, "utf8"));
      assert.equal(rec.fromExport, "V1.mp4");
      assert.deepEqual(rec.fromExportFile, { size: 10, mtimeMs: T_EXPORT_V1 }, "a identidade do export fica no registro");
      // sem rebuild: a cópia do export fica (#12078)
      assert.equal(applyYoutubeSrtCopy({ ...p, srt: "MONTAGEM V1", force: false, sequenceBuiltAtMs: T_EXPORT_V1 - 60_000 }), "keep-from-export");
      assert.equal(readFileSync(p.path, "utf8"), "EXPORT V1");
      // rebuild depois do export: a cópia é defasada e sai
      assert.equal(applyYoutubeSrtCopy({ ...p, srt: "MONTAGEM V2", force: false, sequenceBuiltAtMs: T_REBUILD }), "replace-stale-export");
      assert.equal(readFileSync(p.path, "utf8"), "MONTAGEM V2");
      assert.equal(JSON.parse(readFileSync(p.recordPath, "utf8")).fromExport, undefined, "o registro deixa de marcar export");
    }));

  it("o modifiedTime do Drive vence o mtime local (no modo API o mtime é o do download)", () => {
    const rec = {
      fromExport: "V1.mp4",
      writtenAt: "2026-11-04T12:00:00Z",
      fromExportFile: { mtimeMs: Date.parse("2026-11-04T11:30:00Z"), driveModifiedTime: "2026-11-04T10:00:00Z" },
    };
    assert.equal(recordedExportAt(rec), T_EXPORT_V1);
    // baixado depois do rebuild, mas exportado antes dele: defasado
    const existing = "x";
    const decision = youtubeSrtCopyDecision({
      existing,
      recordedSha256: sha256(existing),
      force: false,
      recordedFromExport: true,
      recordedExportAtMs: recordedExportAt(rec),
      sequenceBuiltAtMs: T_REBUILD,
    });
    assert.equal(decision, "replace-stale-export");
  });

  it("registro antigo sem fromExportFile cai no writtenAt; sem fromExport = null", () => {
    assert.equal(recordedExportAt({ fromExport: "a.mp4", writtenAt: "2026-11-04T10:00:00Z" }), T_EXPORT_V1);
    assert.equal(recordedExportAt({ writtenAt: "2026-11-04T10:00:00Z" }), null);
    assert.equal(recordedExportAt(null), null);
  });

  it("sem builtAt ou sem instante do export: continua keep-from-export (#12078)", () => {
    const existing = "x";
    const recordedSha256 = sha256(existing);
    assert.equal(youtubeSrtCopyDecision({ existing, recordedSha256, force: false, recordedFromExport: true }), "keep-from-export");
    assert.equal(youtubeSrtCopyDecision({ existing, recordedSha256, force: false, recordedFromExport: true, recordedExportAtMs: null, sequenceBuiltAtMs: T_REBUILD }), "keep-from-export");
  });

  it("cópia editada à mão continua intocada mesmo com rebuild (keep-edited vence)", () => {
    assert.equal(
      youtubeSrtCopyDecision({ existing: "editada", recordedSha256: sha256("outra"), force: false, recordedFromExport: true, recordedExportAtMs: T_EXPORT_V1, sequenceBuiltAtMs: T_REBUILD }),
      "keep-edited",
    );
  });

  it("exportOriginOf lê tamanho, mtime e o modifiedTime do sidecar do cache do Drive", () =>
    withDir((dir) => {
      const file = join(dir, "Diaria comentada_Youtube_261104.mp4");
      writeFileSync(file, "12345");
      utimesSync(file, new Date(T_REBUILD), new Date(T_REBUILD));
      assert.deepEqual(exportOriginOf(file), { name: "Diaria comentada_Youtube_261104.mp4", size: 5, mtimeMs: T_REBUILD, driveModifiedTime: null });
      writeFileSync(`${file}.drive.json`, JSON.stringify({ id: "x", size: 5, modifiedTime: "2026-11-04T10:00:00Z" }));
      assert.equal(exportOriginOf(file).driveModifiedTime, "2026-11-04T10:00:00Z");
    }));
});

describe("#12209 item 2: cabeçalho com o nome real da faixa tratada", () => {
  it("cita {AAMMDD}_audio_tratado-{chave}.wav, nunca o nome sem a chave", () => {
    const src = readFileSync(new URL("../scripts/video-montagem.ts", import.meta.url), "utf8");
    const header = src.slice(0, src.indexOf("*/"));
    assert.match(header, /\{AAMMDD\}_audio_tratado-\{chave\}\.wav/);
    assert.doesNotMatch(header, /\{AAMMDD\}_audio_tratado\.wav/);
  });
});

describe("#12209 item 3: ganho medido na faixa tratada", () => {
  const bruto = { inputI: -9.87, inputTp: 0.68, inputLra: 5 };
  const tratada = { inputI: -18, inputTp: -4, inputLra: 4 };

  it("com a faixa tratada medida, o ganho sai dela (não do bruto)", () => {
    const src = gainLoudnessSource({ treated: { loudness: tratada }, bruto });
    assert.equal(src.measuredOn, "faixa tratada");
    assert.deepEqual(src.loudness, tratada);
    assert.equal(src.warning, undefined);
    assert.notDeepEqual(audioGainFor(src.loudness), audioGainFor(bruto), "medidas diferentes, ganhos diferentes");
    assert.match(audioGainLine(audioGainFor(src.loudness), tratada.inputI, tratada.inputTp, src.measuredOn), /faixa tratada -18\.00 LUFS/);
  });

  it("medição da faixa falhou: cai no bruto com aviso explícito", () => {
    const src = gainLoudnessSource({ treated: { loudness: null, error: "ffmpeg saiu 1" }, bruto });
    assert.equal(src.measuredOn, "bruto");
    assert.deepEqual(src.loudness, bruto);
    assert.match(src.warning ?? "", /ffmpeg saiu 1.*#12209/);
  });

  it("sem faixa tratada (--no-audio-clean ou render falho): bruto, sem aviso", () => {
    const src = gainLoudnessSource({ treated: null, bruto });
    assert.equal(src.measuredOn, "bruto");
    assert.equal(src.warning, undefined);
  });

  it("measureTreatedLoudness mede uma vez e reaproveita pela identidade do WAV", () =>
    withDir((dir) => {
      const wav = join(dir, "261104_audio_tratado-abcd1234.wav");
      writeFileSync(wav, "RIFF");
      let calls = 0;
      const stderr = `[Parsed_loudnorm_0]\n{\n "input_i" : "-18.00",\n "input_tp" : "-4.00",\n "input_lra" : "4.00",\n "input_thresh" : "-28.0"\n}\n`;
      const measure = () => {
        calls++;
        return stderr;
      };
      const a = measureTreatedLoudness({ path: wav, stateDir: join(dir, "state") }, { measure });
      const b = measureTreatedLoudness({ path: wav, stateDir: join(dir, "state") }, { measure });
      assert.equal(calls, 1);
      assert.equal(a?.inputI, -18);
      assert.deepEqual(a, b);
      writeFileSync(wav, "RIFF-novo");
      measureTreatedLoudness({ path: wav, stateDir: join(dir, "state") }, { measure });
      assert.equal(calls, 2, "WAV novo (tamanho/mtime) mede de novo");
    }));

  it("measureTreatedLoudness propaga o erro do ffmpeg (quem chama faz o fallback)", () =>
    withDir((dir) => {
      const wav = join(dir, "x.wav");
      writeFileSync(wav, "RIFF");
      assert.throws(() => measureTreatedLoudness({ path: wav, stateDir: dir }, { measure: () => { throw new Error("boom"); } }), /boom/);
    }));
});

describe("#12209 item 4: build no modo API garante o bruto antes da faixa tratada", () => {
  it("modo API com a faixa tratada (padrão) = baixa o bruto se faltar", () => {
    assert.equal(buildNeedsLocalBruto({ apiMode: true, audioClean: true }), true);
  });
  it("--no-audio-clean ou modo local: nada a garantir", () => {
    assert.equal(buildNeedsLocalBruto({ apiMode: true, audioClean: false }), false);
    assert.equal(buildNeedsLocalBruto({ apiMode: false, audioClean: true }), false);
  });
  it("o case build chama o guard antes do cmdBuild", () => {
    const src = readFileSync(new URL("../scripts/video-montagem.ts", import.meta.url), "utf8");
    const i = src.indexOf('case "build":');
    const block = src.slice(i, src.indexOf("return cmdBuild(", i));
    assert.match(block, /buildNeedsLocalBruto\(\{ apiMode: d !== null, audioClean: !flags\.has\("no-audio-clean"\) \}\)\) await needLocalBruto\(\)/);
  });
});
