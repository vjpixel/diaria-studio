/**
 * scripts/video-bordas-13587.ts (#13587)
 *
 * Mede quanto cada detector de borda de início (palavra do transcript longo,
 * palavra da retranscrição curta, energia de janela curta, ilha do Silero,
 * ilha de energia + F0 do `build`, pré-rolagem fixa e condicional) erra o
 * início que o editor aprovou no `blocks.json`. Só medição, só leitura.
 *
 *   npx tsx scripts/video-bordas-13587.ts AAMMDD [AAMMDD...] --audio WAV[,WAV...]
 *     [--vad-probs JSON[,JSON...]] [--state-dir DIR[,DIR...]] [--template ARQ[,ARQ...]] [--out JSON]
 *
 * Uma entrada por edição em cada lista, na mesma ordem. `--audio` é o bruto
 * em WAV PCM 16 bits mono, na linha do tempo do `transcript.json` (bruto de
 * dois arquivos: concatenados no `offsetFrames` do `source.json`).
 * `--vad-probs` sai de `python -P scripts/video/vad_probs.py AUDIO PROBS`.
 * `--state-dir` default: `{edição}/_internal/video-montagem`. `--template`
 * default: `blocks.template.json` do state dir (a 261118 usa o
 * `blocks.template.defasado.json`, do mesmo transcript do `blocks.json`).
 * Com mais de uma edição, imprime também o placar do conjunto.
 * Procedimento e resultado: docs/video-montagem-resolucao-tomadas-13463.md.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { energyEnvelope, extendIslandAttacks, frameEnergies, parseWavPcm16, speechIslands, speechThresholds } from "./lib/diaria/video-cut-refine.ts";
import { vadIslands, type VadProbs } from "./lib/diaria/video-vad-vs-energy.ts";
import { approvedStarts, borderReport, measureBorder, mergeReports, type BorderMeasure, type BorderReport, type MethodScore } from "./lib/diaria/video-border-onset.ts";
import type { BlocksFile, Transcript } from "./lib/diaria/video-montage.ts";

const USAGE = "uso: npx tsx scripts/video-bordas-13587.ts AAMMDD [AAMMDD...] --audio WAV[,WAV...] [--vad-probs JSON[,...]] [--state-dir DIR[,...]] [--template ARQ[,...]] [--out JSON]";

const list = (v: string | undefined): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

function templateStarts(path: string): number[] {
  const t = readJson<{ blocks?: Record<string, Array<{ start?: number }>> } & Record<string, unknown>>(path);
  const blocks = (t.blocks ?? t) as Record<string, unknown>;
  return Object.values(blocks)
    .flatMap((v) => (Array.isArray(v) ? v : []))
    .map((x) => (x as { start?: unknown }).start)
    .filter((s): s is number => typeof s === "number");
}

export function measureEdition(edition: string, o: { audio: string; vadProbs?: string; stateDir?: string; template?: string }): BorderReport {
  const dir = o.stateDir ?? join(editionDir(edition), "_internal", "video-montagem");
  const blocks = readJson<BlocksFile>(join(dir, "blocks.json"));
  const transcript = readJson<Transcript>(join(dir, "transcript.json"));
  const retranscriptions = readdirSync(dir)
    .filter((f) => /^retranscribe-.*\.json$/.test(f))
    .map((f) => readJson<Transcript>(join(dir, f)));
  const template = o.template ?? join(dir, "blocks.template.json");
  if (!existsSync(template)) throw new Error(`molde não encontrado: ${template} (passe --template)`);
  const { samples, sampleRate } = parseWavPcm16(readFileSync(o.audio));
  const env = energyEnvelope(samples, sampleRate, { hopS: 0.01, winS: 0.02 });
  const energy = frameEnergies(samples, sampleRate);
  const th = speechThresholds(energy);
  const energyIslands = extendIslandAttacks(energy, speechIslands(energy, { thresholds: th }), { speechFullDb: th.fullDb });
  const sileroIslands = o.vadProbs ? vadIslands(readJson<VadProbs>(o.vadProbs)) : undefined;
  const rows = approvedStarts({ blocks, transcript, retranscriptions, templateStarts: templateStarts(template) })
    .map((a) => measureBorder(a, { env, sileroIslands, energyIslands }))
    .filter((r): r is BorderMeasure => r !== null);
  return borderReport(edition, rows);
}

function table(label: string, scores: readonly MethodScore[], n: number): string {
  const f = (x: number | null) => (x === null ? "-" : x.toFixed(2));
  const lines = [`== ${label} (${n} bordas)`, "método | n | <=0,6 s | <=1,5 s | mediana | p90 | máx"];
  for (const s of scores) lines.push(`${s.method} | ${s.n} | ${s.withinCriterion} | ${s.withinTolerance} | ${f(s.medianAbsErrS)} | ${f(s.p90AbsErrS)} | ${f(s.maxAbsErrS)}`);
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)): number {
  const { values, positional } = parseArgs(argv);
  const audios = list(values["audio"]);
  if (!positional.length || positional.some((e) => !/^\d{6}$/.test(e)) || audios.length !== positional.length) {
    console.error(USAGE);
    return 2;
  }
  const vads = list(values["vad-probs"]), dirs = list(values["state-dir"]), tpls = list(values["template"]);
  try {
    const reports = positional.map((ed, i) => measureEdition(ed, { audio: audios[i], vadProbs: vads[i], stateDir: dirs[i], template: tpls[i] }));
    const all = reports.length > 1 ? [...reports, mergeReports(reports)] : reports;
    for (const r of all) {
      const hand = r.rows.filter((x) => x.handSet).length;
      console.log(table(`${r.edition}: bordas acertadas à mão`, r.handSet, hand));
      console.log(table(`${r.edition}: todas as bordas explícitas`, r.all, r.rows.length));
    }
    if (values["out"]) writeFileSync(values["out"], JSON.stringify(all, null, 2) + "\n");
    return 0;
  } catch (e) {
    console.error(`video-bordas-13587: ${(e as Error).message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exit(main());
