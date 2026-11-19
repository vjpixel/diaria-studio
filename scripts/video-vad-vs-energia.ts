/**
 * scripts/video-vad-vs-energia.ts (#13598)
 *
 * Mede o Silero VAD contra o detector de energia + F0 do `build`, por edição,
 * contra o corte do editor (registro do `video-xml-vs-final`). Só medição.
 *
 *   npx tsx scripts/video-vad-vs-energia.ts AAMMDD --audio WAV --vad-probs JSON [--silero-cpu-s N] [--record JSON] [--out JSON]
 *
 * `probs.json` sai de `python -P scripts/video/vad_probs.py AUDIO PROBS`; o
 * CPU do Silero (user+sys do processo Python) é medido por quem o roda
 * (`time`) e passado em `--silero-cpu-s`. O de energia + F0 é medido aqui.
 * Procedimento e resultado: docs/video-vad-vs-energia-13598.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { extendIslandAttacks, frameEnergies, parseWavPcm16, speechIslands, speechThresholds, voiceAnchorDb } from "./lib/diaria/video-cut-refine.ts";
import { voicedFrames } from "./lib/diaria/video-voice.ts";
import { applyVoiceFilter } from "./video-montagem.ts";
import { compareDetectors, vadIslands, type VadProbs } from "./lib/diaria/video-vad-vs-energy.ts";
import type { EditionRecord } from "./lib/diaria/video-xml-vs-final.ts";

export function main(argv = process.argv.slice(2)): number {
  const { values, positional } = parseArgs(argv);
  const edition = positional[0];
  if (!edition || !/^\d{6}$/.test(edition) || !values["audio"] || !values["vad-probs"]) {
    console.error("uso: npx tsx scripts/video-vad-vs-energia.ts AAMMDD --audio WAV --vad-probs JSON [--silero-cpu-s N] [--record JSON] [--out JSON]");
    return 2;
  }
  try {
    const record = JSON.parse(readFileSync(values["record"] ?? join("data", "video-xml-vs-final", `${edition}.json`), "utf8")) as EditionRecord;
    const probs = JSON.parse(readFileSync(values["vad-probs"], "utf8")) as VadProbs;
    const { samples, sampleRate } = parseWavPcm16(readFileSync(values["audio"]));
    const t0 = process.cpuUsage();
    const energy = frameEnergies(samples, sampleRate);
    const th = speechThresholds(energy);
    applyVoiceFilter(energy, th, () => {
      const anchor = voiceAnchorDb(th.fullDb);
      return voicedFrames(samples, sampleRate, energy.hopS, energy.fullDb.length, (i) => energy.fullDb[i] > anchor);
    });
    const energyIslands = extendIslandAttacks(energy, speechIslands(energy, { thresholds: th }), { speechFullDb: th.fullDb });
    const cpu = process.cpuUsage(t0);
    const report = compareDetectors({
      record,
      energyIslands,
      sileroIslands: vadIslands(probs),
      durationS: Math.round((samples.length / sampleRate) * 10) / 10,
      cpuS: { energia: Math.round((cpu.user + cpu.system) / 1e4) / 100, silero: values["silero-cpu-s"] ? Number(values["silero-cpu-s"]) : null },
    });
    const text = JSON.stringify(report, null, 2) + "\n";
    if (values["out"]) writeFileSync(values["out"], text);
    process.stdout.write(text);
    return 0;
  } catch (e) {
    console.error(`video-vad-vs-energia: ${(e as Error).message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exit(main());
