/**
 * #12935: legenda de vídeo avulso (`video-montagem.ts legendar`) e a
 * conferência da fala que o VAD descarta.
 *
 * Caso real (vídeo `20261112_200050.mp4`, 2:12): a transcrição com VAD omitiu
 * 6 s de fala (1:39–1:45) e a legenda ficou dessincronizada a partir de 1:41,
 * com uma cue de 11 s na tela. As funções puras aqui reproduzem esse desenho:
 * fala contínua entre pausas, palavras faltando na janela 99–105 s e a cue que
 * estica sobre ela.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interval, Word } from "../scripts/lib/diaria/video-montage.ts";
import {
  captionCoverageFindings,
  speechIntervals,
  speechWithoutWords,
  speechWithoutWordsWarnings,
  subtractIntervals,
} from "../scripts/lib/diaria/video-caption-coverage.ts";
import { SUBCOMMANDS, legendarIsVertical, legendarOutputPaths, main } from "../scripts/video-montagem.ts";

/** Palavras de 0,3 s cobrindo [a, b), sem buraco. */
const wordsBetween = (a: number, b: number): Word[] => {
  const out: Word[] = [];
  for (let t = a; t + 0.3 <= b + 1e-9; t += 0.3) out.push({ start: +t.toFixed(3), end: +(t + 0.3).toFixed(3), text: "x" });
  return out;
};

// Fala de 95 a 110 s (pausas em volta), duração 132 s.
const DURATION = 132;
const SILENCES: Interval[] = [{ start: 0, end: 95 }, { start: 110, end: DURATION }];

describe("#12935 intervalos", () => {
  it("speechIntervals é o complemento dos silêncios", () => {
    assert.deepEqual(speechIntervals(SILENCES, DURATION), [{ start: 95, end: 110 }]);
    assert.deepEqual(speechIntervals([], 10), [{ start: 0, end: 10 }]);
    assert.deepEqual(speechIntervals([{ start: 2, end: 3 }, { start: 1, end: 2.5 }], 5), [{ start: 0, end: 1 }, { start: 3, end: 5 }]);
  });

  it("subtractIntervals com folga", () => {
    assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 3 }], 0.5), [{ start: 0, end: 1.5 }, { start: 3.5, end: 10 }]);
    assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: -1, end: 11 }]), []);
  });
});

describe("#12935 speechWithoutWords (transcribe do bruto com VAD)", () => {
  it("regressão: a frase que o VAD descartou (99–105 s) vira aviso com o retranscribe da janela", () => {
    const words = [...wordsBetween(95, 99), ...wordsBetween(105, 110)];
    const gaps = speechWithoutWords({ words, silences: SILENCES, durationS: DURATION });
    assert.equal(gaps.length, 1);
    assert.ok(gaps[0].start > 99 && gaps[0].start < 99.5 && gaps[0].end > 104.5 && gaps[0].end < 105, JSON.stringify(gaps));
    const [line] = speechWithoutWordsWarnings(gaps, "261112", 60, DURATION);
    assert.match(line, /retranscribe 261112 --from 98 --to 106/);
    assert.match(line, /01:39/);
  });

  it("transcript completo: nenhum aviso; buraco curto (< 2 s) também não", () => {
    assert.deepEqual(speechWithoutWords({ words: wordsBetween(95, 110), silences: SILENCES, durationS: DURATION }), []);
    const words = [...wordsBetween(95, 100), ...wordsBetween(101.5, 110)];
    assert.deepEqual(speechWithoutWords({ words, silences: SILENCES, durationS: DURATION }), []);
  });

  it("a janela do retranscribe respeita o teto e o fim do vídeo", () => {
    const [line] = speechWithoutWordsWarnings([{ start: 10, end: 100 }], "261112", 60, 95);
    assert.match(line, /--from 9 --to 69/);
    const [end] = speechWithoutWordsWarnings([{ start: 90, end: 94.6 }], "261112", 60, 95);
    assert.match(end, /--from 89 --to 95/);
  });
});

describe("#12935 captionCoverageFindings (autorrevisão do legendar)", () => {
  it("regressão: a cue que esticou 11 s sobre a fala perdida é acusada", () => {
    const cues = [
      { start: 95, end: 98.9, text: "o Buffett investe em empresas" },
      { start: 99, end: 110, text: "boom de IA" },
    ];
    const findings = captionCoverageFindings({ cues, silences: SILENCES, durationS: DURATION });
    assert.deepEqual(findings.map((x) => x.kind), ["legenda-longa"]);
    assert.match(findings[0].line, /legenda de 11\.0 s/);
  });

  it("fala sem legenda nenhuma por 1,5 s ou mais é acusada; legenda boa passa limpa", () => {
    const ok = [
      { start: 95, end: 99, text: "a" },
      { start: 99, end: 103, text: "b" },
      { start: 103, end: 110, text: "c" },
    ];
    assert.deepEqual(captionCoverageFindings({ cues: ok, silences: SILENCES, durationS: DURATION }), []);
    const holed = [
      { start: 95, end: 99, text: "a" },
      { start: 105, end: 110, text: "c" },
    ];
    const f = captionCoverageFindings({ cues: holed, silences: SILENCES, durationS: DURATION });
    assert.deepEqual(f.map((x) => x.kind), ["fala-sem-legenda"]);
    assert.match(f[0].line, /som de fala e sem legenda em 01:39/);
  });
});

describe("#12935 legendar: saídas e CLI", () => {
  it("legendarOutputPaths: ao lado do vídeo, ou no --out-dir; nunca o próprio vídeo", () => {
    const p = legendarOutputPaths("/v/261112/20261112_200050.mp4");
    assert.equal(p.srt, "/v/261112/20261112_200050.srt");
    assert.equal(p.burned, "/v/261112/20261112_200050 - legendado.mp4");
    assert.equal(legendarOutputPaths("/v/a.b.mov", "/out").srt, "/out/a.b.srt");
  });

  it("legendarIsVertical considera a rotação do celular", () => {
    assert.equal(legendarIsVertical({ width: 1080, height: 1920 }), true);
    assert.equal(legendarIsVertical({ width: 1920, height: 1080 }), false);
    assert.equal(legendarIsVertical({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }), true);
    assert.equal(legendarIsVertical({ width: 1920, height: 1080, tags: { rotate: "90" } }), true);
  });

  let dir: string;
  const origErr = console.error;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vm-12935-"));
    console.error = () => {};
  });
  afterEach(() => {
    console.error = origErr;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = () => ["legendar", "261112", "--state-dir", dir, "--work-dir", dir, "--no-drive-api", "--drive-root", dir];

  it("é subcomando; sem --video ou com vídeo inexistente, recusa antes de transcrever", async () => {
    assert.ok((SUBCOMMANDS as readonly string[]).includes("legendar"));
    await assert.rejects(main(base()), /legendar exige --video/);
    await assert.rejects(main([...base(), "--video", join(dir, "nao-existe.mp4")]), /vídeo não encontrado/);
  });
});
